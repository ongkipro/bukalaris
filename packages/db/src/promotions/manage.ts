import { randomBytes, createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLog, collection, media, product, variant } from "../schema.ts";
import { DomainError, requireCap, type SellerScope } from "../platform/scoped.ts";
import { withStore } from "../platform/tenant.ts";
import type { Executor } from "../client.ts";
import { discount, flashSale, flashSaleItem, promoHub, promoHubCollection, PROMOTION_KINDS, PROMOTION_SCOPES } from "./schema-promotions.ts";

const amount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ident = z.number().int().positive().safe();
const nullableId = ident.nullable().default(null);
const windowFields = { startsAt: z.coerce.date(), endsAt: z.coerce.date() };
export const voucherInput = z.strictObject({
  kind: z.enum(PROMOTION_KINDS), scope: z.enum(PROMOTION_SCOPES), productId: nullableId, collectionId: nullableId,
  value: amount, minPurchaseIdr: amount.default(0), maxDiscountIdr: amount.nullable().default(null),
  usageLimit: ident.nullable().default(null), buyerUsageLimit: ident.nullable().default(null), public: z.boolean().default(true),
  status: z.enum(["active", "disabled"]).default("active"), ...windowFields,
}).superRefine((v, c) => {
  if (v.endsAt <= v.startsAt) c.addIssue({ code: "custom", path: ["endsAt"], message: "Waktu selesai harus setelah waktu mulai (WIB)." });
  if ((v.scope === "all" && (v.productId !== null || v.collectionId !== null)) || (v.scope === "product" && (v.productId === null || v.collectionId !== null)) || (v.scope === "collection" && (v.collectionId === null || v.productId !== null))) c.addIssue({ code: "custom", path: ["scope"], message: "Pilih satu target sesuai cakupan voucher." });
  if ((v.kind === "percent" && (v.value < 1 || v.value > 10000)) || (v.kind === "fixed" && v.value < 1) || (v.kind === "free_shipping" && v.value !== 0)) c.addIssue({ code: "custom", path: ["value"], message: "Persen memakai 1–10000 basis poin; potongan tetap positif; gratis ongkir bernilai 0." });
});
export const flashInput = z.strictObject({
  title: z.string().trim().min(2).max(120), ...windowFields, status: z.enum(["active", "disabled"]).default("active"),
  items: z.array(z.strictObject({ variantId: ident, salePriceIdr: amount, stockCap: ident.nullable().default(null) })).min(1).max(100),
}).superRefine((v, c) => {
  if (v.endsAt <= v.startsAt) c.addIssue({ code: "custom", path: ["endsAt"], message: "Waktu selesai harus setelah waktu mulai (WIB)." });
  if (new Set(v.items.map((i) => i.variantId)).size !== v.items.length) c.addIssue({ code: "custom", path: ["items"], message: "Varian tidak boleh berulang." });
});
export const hubInput = z.strictObject({
  enabled: z.boolean(), title: z.string().trim().min(2).max(120), subtitle: z.string().trim().max(400), bannerMediaId: nullableId,
  bannerCtaLabel: z.string().trim().max(80), bannerCtaHref: z.string().trim().max(200),
  freeShipEnabled: z.boolean(), freeShipThresholdIdr: amount, percentRounding: z.enum(["floor", "half_up", "ceil"]).default("floor"),
  featuredCollectionIds: z.array(ident).max(20).default([]),
}).superRefine((v, c) => {
  if (v.bannerCtaHref && !/^\/(?:products|collections)\/[a-z0-9-]+$/.test(v.bannerCtaHref)) c.addIssue({ code: "custom", path: ["bannerCtaHref"], message: "Gunakan alamat produk atau koleksi dalam toko, mis. /collections/promo." });
  if (Boolean(v.bannerCtaHref) !== Boolean(v.bannerCtaLabel)) c.addIssue({ code: "custom", path: ["bannerCtaLabel"], message: "Label dan tujuan tombol harus diisi bersama." });
});

/** A datetime-local is explicitly a Jakarta wall clock, never the host's timezone. */
export function jakartaInstant(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new DomainError("promotion_window", "Isi tanggal dan jam WIB yang valid.");
  const d = new Date(`${value}+07:00`);
  if (!Number.isFinite(d.getTime()) || new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, value.length) !== value) throw new DomainError("promotion_window", "Isi tanggal dan jam WIB yang valid.");
  return d;
}
export const voucherDigest = (code: string) => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
export const PROMOTION_LOCK = "bukalaris.promotions";
/** Configuration writes take the exclusive lock, checkouts the shared one: edits never interleave with a checkout, checkouts never serialise each other. */
export async function lockPromotions(tx: Executor, storeId: number, mode: "shared" | "exclusive" = "exclusive") {
  const key = sql`hashtext(${PROMOTION_LOCK}), hashtext(${String(storeId)})`;
  await tx.execute(mode === "shared" ? sql`select pg_advisory_xact_lock_shared(${key})` : sql`select pg_advisory_xact_lock(${key})`);
}
const record = (tx: Executor, s: SellerScope, action: string, subjectId: number | string) => tx.insert(auditLog).values({ storeId: s.storeId, actorUserId: s.userId, action, subjectKind: "promotion", subjectId: String(subjectId) });

export async function saveVoucher(scope: SellerScope, raw: unknown, id?: number) {
  requireCap(scope, "promotions.manage");
  const input = voucherInput.parse(raw);
  return withStore(scope.exec, scope.storeId, async (tx) => {
    await lockPromotions(tx, scope.storeId);
    if (id) {
      const [row] = await tx.update(discount).set(input).where(and(eq(discount.storeId, scope.storeId), eq(discount.id, id))).returning();
      if (!row) throw new DomainError("not_found", "Voucher tidak ditemukan.");
      await record(tx, scope, "promotion.voucher.update", id);
      return row;
    }
    const code = randomBytes(12).toString("hex").toUpperCase();
    const [row] = await tx.insert(discount).values({ ...input, storeId: scope.storeId, code, codeSha256: voucherDigest(code) }).returning();
    await record(tx, scope, "promotion.voucher.create", row!.id);
    return row!;
  });
}
export async function saveFlashSale(scope: SellerScope, raw: unknown, id?: number) {
  requireCap(scope, "promotions.manage");
  const { items, ...input } = flashInput.parse(raw);
  return withStore(scope.exec, scope.storeId, async (tx) => {
    await lockPromotions(tx, scope.storeId);
    const [sale] = id ? await tx.update(flashSale).set(input).where(and(eq(flashSale.storeId, scope.storeId), eq(flashSale.id, id))).returning() : await tx.insert(flashSale).values({ ...input, storeId: scope.storeId }).returning();
    if (!sale) throw new DomainError("not_found", "Flash sale tidak ditemukan.");
    const existing = await tx.select().from(flashSaleItem).where(and(eq(flashSaleItem.storeId, scope.storeId), eq(flashSaleItem.flashSaleId, sale.id)));
    if (existing.some((i) => !items.some((v) => v.variantId === i.variantId))) throw new DomainError("promotion_items", "Varian lama harus tetap ada; nonaktifkan flash sale untuk menghentikannya.");
    for (const item of items) {
      const [v] = await tx.select().from(variant).where(and(eq(variant.storeId, scope.storeId), eq(variant.id, item.variantId)));
      if (!v || item.salePriceIdr >= v.price) throw new DomainError("promotion_price", "Harga flash sale harus lebih rendah dari harga varian toko ini.");
      await tx.insert(flashSaleItem).values({ ...item, storeId: scope.storeId, flashSaleId: sale.id, productId: v.productId }).onConflictDoUpdate({ target: [flashSaleItem.flashSaleId, flashSaleItem.variantId], set: { salePriceIdr: item.salePriceIdr, stockCap: item.stockCap } });
    }
    await record(tx, scope, "promotion.flash.save", sale.id);
    return sale;
  });
}
export async function savePromoHub(scope: SellerScope, raw: unknown) {
  requireCap(scope, "promotions.manage");
  const { featuredCollectionIds, ...input } = hubInput.parse(raw);
  return withStore(scope.exec, scope.storeId, async (tx) => {
    await lockPromotions(tx, scope.storeId);
    await tx.insert(promoHub).values({ storeId: scope.storeId, ...input }).onConflictDoUpdate({ target: promoHub.storeId, set: input });
    await tx.delete(promoHubCollection).where(eq(promoHubCollection.storeId, scope.storeId));
    if (featuredCollectionIds.length) await tx.insert(promoHubCollection).values([...new Set(featuredCollectionIds)].map((collectionId, position) => ({ storeId: scope.storeId, collectionId, position })));
    await record(tx, scope, "promotion.hub.save", scope.storeId);
  });
}
export async function sellerPromotions(scope: SellerScope) {
  requireCap(scope, "promotions.read");
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const [hub] = await tx.select().from(promoHub).where(eq(promoHub.storeId, scope.storeId));
    return {
      hub: hub ?? null,
      vouchers: await tx.select().from(discount).where(eq(discount.storeId, scope.storeId)).orderBy(asc(discount.id)),
      sales: await tx.select().from(flashSale).where(eq(flashSale.storeId, scope.storeId)).orderBy(asc(flashSale.id)),
      items: await tx.select().from(flashSaleItem).where(eq(flashSaleItem.storeId, scope.storeId)).orderBy(asc(flashSaleItem.id)),
      products: await tx.select({ id: product.id, title: product.title }).from(product).where(eq(product.storeId, scope.storeId)),
      variants: await tx.select({ id: variant.id, productId: variant.productId, title: variant.title, price: variant.price }).from(variant).where(eq(variant.storeId, scope.storeId)),
      collections: await tx.select({ id: collection.id, title: collection.title }).from(collection).where(eq(collection.storeId, scope.storeId)),
      featured: await tx.select().from(promoHubCollection).where(eq(promoHubCollection.storeId, scope.storeId)).orderBy(asc(promoHubCollection.position)),
      images: await tx.select({ id: media.id, alt: media.alt }).from(media).where(eq(media.storeId, scope.storeId)),
    };
  });
}
