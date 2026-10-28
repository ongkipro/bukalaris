import { timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { buyerFingerprintsAllKeys } from "../buyer/fingerprint.ts";
import { normalizePhone } from "../buyer/normalize.ts";
import { calculateOrderFinance, type OrderFinance } from "../ledger/finance.ts";
import { DomainError } from "../platform/scoped.ts";
import { collectionProduct } from "../schema.ts";
import { discount, discountBuyerUsage, discountRedemption, flashSale, flashSaleItem, flashSaleRedemption, promoHub } from "./schema-promotions.ts";
import { lockPromotions, voucherDigest } from "./manage.ts";

export const VOUCHER_REDEEM_LIMITS = {
  ip: { limit: 20, windowSec: 600 }, phone: { limit: 10, windowSec: 600 },
} as const;
export const VOUCHER_UNAVAILABLE = "Voucher tidak dapat dipakai: kode tidak valid, belum berlaku, berakhir, atau kuota habis.";
export const PROMOTION_PERCENT_ROUNDING_DEFAULT = "floor" as const;
export type PromotionLine = { variantId: number; productId: number; price: number; quantity: number };
export type PromotionFee = { buyerFee: number; providerCost: number; margin: number };
export type PromotionPlan = {
  finance: OrderFinance;
  voucher: { id: number; goodsDiscount: number; shippingDiscount: number } | null;
  flashes: { itemId: number; quantity: number; goodsDiscount: number }[];
};
/** Percentages are integer basis points; the seller's named setting controls rounding, default floor (D-22). */
export function percentDiscount(base: number, rateBps: number, rounding: "floor" | "half_up" | "ceil") {
  if (!Number.isSafeInteger(base) || base < 0 || !Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) throw new DomainError("bad_amount", "Diskon harus bilangan bulat.");
  const n = BigInt(base) * BigInt(rateBps), d = BigInt(10000);
  return Number(rounding === "ceil" ? (n + d - BigInt(1)) / d : rounding === "half_up" ? (BigInt(2) * n + d) / (BigInt(2) * d) : n / d);
}

/** Called inside the order transaction. Counter reservations roll back with any failed order. Never accept a caller's clock. */
export async function checkoutPromotions(tx: Executor, storeId: number, lines: readonly PromotionLine[], fee: PromotionFee, code: string | undefined, buyerPhone: string, reserve: boolean): Promise<PromotionPlan> {
  // Shared with configuration writes; fixed acquisition order across carts prevents time/stock edits racing checkout.
  await lockPromotions(tx, storeId, "shared");
  const [{ at }] = await tx.execute(sql`select clock_timestamp() as at`) as unknown as { at: string }[];
  const now = new Date(at!).getTime();
  const [hub] = await tx.select().from(promoHub).where(eq(promoHub.storeId, storeId));
  const candidates = await tx.select({ item: flashSaleItem, sale: flashSale }).from(flashSaleItem)
    .innerJoin(flashSale, and(eq(flashSale.storeId, flashSaleItem.storeId), eq(flashSale.id, flashSaleItem.flashSaleId)))
    .where(and(eq(flashSaleItem.storeId, storeId), inArray(flashSaleItem.variantId, lines.map((l) => l.variantId)), eq(flashSale.status, "active")))
    .orderBy(asc(flashSale.createdAt), asc(flashSale.id), asc(flashSaleItem.id));
  // A flash sale is a price override (PR-26): it always applies first, per line; vouchers then act on what remains (BILL-4: creation time, then id).
  const discounts: { amount: number; lineNos: number[] }[] = [];
  const flashes: PromotionPlan["flashes"] = [];
  const financeLines = lines.map((l, i) => ({ lineNo: i + 1, unitPrice: l.price, quantity: l.quantity }));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Overlap policy: oldest active flash wins; base price is never mutated. A depleted flash is no longer advertised/applied.
    const candidate = candidates.find(({ item, sale }) => item.variantId === line.variantId && sale.startsAt.getTime() <= now && now <= sale.endsAt.getTime() && item.salePriceIdr < line.price && (item.stockCap === null || item.soldCount < item.stockCap));
    if (!candidate) continue;
    const { item, sale } = candidate;
    if (item.stockCap !== null && item.soldCount + line.quantity > item.stockCap) throw new DomainError("flash_stock", "Kuota flash sale tidak cukup untuk jumlah ini. Kurangi jumlah dan coba lagi.");
    const amount = (line.price - item.salePriceIdr) * line.quantity;
    discounts.push({ amount, lineNos: [i + 1] });
    flashes.push({ itemId: item.id, quantity: line.quantity, goodsDiscount: amount });
    if (reserve) {
      const rows = await tx.update(flashSaleItem).set({ soldCount: sql`${flashSaleItem.soldCount} + ${line.quantity}` })
        .where(and(eq(flashSaleItem.storeId, storeId), eq(flashSaleItem.id, item.id), sql`(${flashSaleItem.stockCap} is null or ${flashSaleItem.soldCount} + ${line.quantity} <= ${flashSaleItem.stockCap})`, sql`exists (select 1 from public.flash_sale s where s.store_id = ${storeId} and s.id = ${item.flashSaleId} and s.status = 'active' and clock_timestamp() between s.starts_at and s.ends_at)`)).returning({ id: flashSaleItem.id });
      if (!rows.length) throw new DomainError("flash_stock", "Flash sale berubah atau kuotanya habis. Muat ulang ringkasan pesanan.");
    }
  }
  let voucher: PromotionPlan["voucher"] = null;
  let shippingDiscount = 0;
  // Wave 4 review: when the automatic free-shipping threshold already covers the courier cost with the discounts known so far (flash sales), a free-shipping voucher
  // would only be replaced by it: it is then not consumed at all (no use, no buyer quota, no redemption row that disagrees with the order).
  const pre = calculateOrderFinance({ lines: financeLines, goodsDiscounts: discounts, checkoutShipping: fee.buyerFee, shippingDiscount: fee.providerCost });
  const thresholdCovers = !!hub?.freeShipEnabled && pre.subtotal - pre.goodsDiscount >= hub.freeShipThresholdIdr && pre.saleAmount >= fee.providerCost && pre.payable >= 0;
  if (code?.trim()) {
    const digest = voucherDigest(code);
    const [v] = await tx.select().from(discount).where(and(eq(discount.storeId, storeId), eq(discount.codeSha256, digest)));
    // Always compare equal-length digests, including an unknown code; no expired/unknown existence oracle.
    const matches = timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(v?.codeSha256 ?? "0".repeat(64), "hex"));
    if (!matches || !v || v.status !== "active" || v.startsAt.getTime() > now || v.endsAt.getTime() < now || (v.usageLimit !== null && v.usedCount >= v.usageLimit)) throw new DomainError("voucher_unavailable", VOUCHER_UNAVAILABLE);
    const members = v.scope === "collection" ? await tx.select({ productId: collectionProduct.productId }).from(collectionProduct).where(and(eq(collectionProduct.storeId, storeId), eq(collectionProduct.collectionId, v.collectionId!))) : [];
    const eligible = lines.map((l, i) => ({ line: l, i })).filter(({ line }) => v.scope === "all" || (v.scope === "product" ? line.productId === v.productId : members.some((m) => m.productId === line.productId)));
    const prior = [...discounts];
    const beforeVoucher = calculateOrderFinance({ lines: financeLines, goodsDiscounts: prior, checkoutShipping: fee.buyerFee });
    const base = eligible.reduce((s, { i }) => s + beforeVoucher.lines[i]!.netGoods, 0);
    if (!eligible.length || base === 0) throw new DomainError("voucher_scope", "Voucher tidak berlaku untuk barang dalam keranjang ini.");
    if (base < v.minPurchaseIdr) throw new DomainError("voucher_minimum", "Belanja barang dalam cakupan voucher belum mencapai minimum pembelian.");
    // The canonical key (`normalizePhone`), so every spelling of one number shares the per-buyer count (wave 4 review); an identity that is not a canonical Indonesian number is refused.
    const phone = normalizePhone(buyerPhone);
    if (!phone) throw new DomainError("voucher_phone", "Isi nomor HP yang valid sebelum memakai voucher.");
    const keys = buyerFingerprintsAllKeys("promotion.buyer_usage", "phone", phone);
    const usage = await tx.select().from(discountBuyerUsage).where(and(eq(discountBuyerUsage.storeId, storeId), eq(discountBuyerUsage.discountId, v.id), inArray(discountBuyerUsage.phoneFingerprint, keys)));
    if (v.buyerUsageLimit !== null && usage.reduce((s, u) => s + u.usedCount, 0) >= v.buyerUsageLimit) throw new DomainError("voucher_unavailable", VOUCHER_UNAVAILABLE);
    const value = v.kind === "free_shipping" ? fee.providerCost : v.kind === "fixed" ? v.value : percentDiscount(base, v.value, hub?.percentRounding ?? PROMOTION_PERCENT_ROUNDING_DEFAULT);
    const amount = Math.min(value, v.maxDiscountIdr ?? Number.MAX_SAFE_INTEGER, v.kind === "free_shipping" ? fee.providerCost : base);
    if (v.kind === "free_shipping") shippingDiscount = amount;
    else discounts.push({ amount, lineNos: eligible.map(({ i }) => i + 1) });
    const replacedByThreshold = v.kind === "free_shipping" && thresholdCovers;
    voucher = replacedByThreshold ? null : { id: v.id, goodsDiscount: v.kind === "free_shipping" ? 0 : amount, shippingDiscount };
    if (reserve && !replacedByThreshold) {
      const used = await tx.update(discount).set({ usedCount: sql`${discount.usedCount} + 1` }).where(and(eq(discount.storeId, storeId), eq(discount.id, v.id), sql`(${discount.usageLimit} is null or ${discount.usedCount} < ${discount.usageLimit})`, sql`${discount.status} = 'active' and clock_timestamp() between ${discount.startsAt} and ${discount.endsAt}`)).returning({ id: discount.id });
      if (!used.length) throw new DomainError("voucher_unavailable", VOUCHER_UNAVAILABLE);
      const key = usage[0]?.phoneFingerprint ?? keys[0]!;
      const buyer = await tx.insert(discountBuyerUsage).values({ storeId, discountId: v.id, phoneFingerprint: key }).onConflictDoUpdate({ target: [discountBuyerUsage.storeId, discountBuyerUsage.discountId, discountBuyerUsage.phoneFingerprint], set: { usedCount: sql`${discountBuyerUsage.usedCount} + 1` }, setWhere: v.buyerUsageLimit === null ? sql`true` : sql`${discountBuyerUsage.usedCount} < ${v.buyerUsageLimit}` }).returning({ count: discountBuyerUsage.usedCount });
      if (!buyer.length) throw new DomainError("voucher_unavailable", VOUCHER_UNAVAILABLE);
    }
  }
  // Store-funded free shipping never spends a rupiah of the platform's margin. The margin remains payable and is explained in both UIs.
  const financeInput = { lines: financeLines, goodsDiscounts: discounts, checkoutShipping: fee.buyerFee };
  const goods = calculateOrderFinance(financeInput);
  // The automatic threshold never blocks a checkout: when the sale amount cannot carry the courier cost it is simply not applied (a voucher the buyer chose still is, or is refused visibly below).
  if (hub?.freeShipEnabled && goods.subtotal - goods.goodsDiscount >= hub.freeShipThresholdIdr) {
    const trial = calculateOrderFinance({ ...financeInput, shippingDiscount: fee.providerCost });
    if (trial.saleAmount >= fee.providerCost && trial.payable >= 0) shippingDiscount = fee.providerCost;
    else if (voucher === null) shippingDiscount = 0;
  }
  const finance = calculateOrderFinance({ ...financeInput, shippingDiscount });
  if (finance.payable < 0 || finance.saleAmount < shippingDiscount) throw new DomainError("promotion_negative_proceeds", "Promo diblokir: hasil bersih penjual tidak cukup menutup diskon ongkir. Kurangi diskon barang atau ongkir.");
  return { finance, voucher, flashes };
}

export async function recordPromotionRedemptions(tx: Executor, storeId: number, orderId: number, plan: PromotionPlan) {
  if (plan.voucher) await tx.insert(discountRedemption).values({ storeId, orderId, discountId: plan.voucher.id, goodsDiscountIdr: plan.voucher.goodsDiscount, shippingDiscountIdr: plan.voucher.shippingDiscount });
  if (plan.flashes.length) await tx.insert(flashSaleRedemption).values(plan.flashes.map((f) => ({ storeId, orderId, itemId: f.itemId, quantity: f.quantity, goodsDiscountIdr: f.goodsDiscount })));
}
