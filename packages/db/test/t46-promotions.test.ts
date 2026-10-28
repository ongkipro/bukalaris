import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { checkoutPromotionPreview, placeOrder } from "../src/seller/commerce/checkout.ts";
import { createProduct } from "../src/seller/commerce/catalog.ts";
import { createCollection } from "../src/storefront/content.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { saveFlashSale, savePromoHub, saveVoucher, sellerPromotions } from "../src/promotions/manage.ts";
import { storefrontPromotions } from "../src/promotions/storefront.ts";
import { discount, discountBuyerUsage, discountRedemption, flashSale, flashSaleItem, flashSaleRedemption, promoHub } from "../src/promotions/schema-promotions.ts";
import { createDb } from "../src/client.ts";
import { localRoleUrl } from "../src/local-roles.ts";
import { withStore } from "../src/platform/tenant.ts";
import { auditLog, order, orderFinancials, orderLineFinancials, variant } from "../src/schema.ts";
import { admin, buyer, db, DESTINATION, makeStore, makeUser, platform, seller } from "./helpers.ts";
import { billingStore, billingTestSetup, setSubscription } from "./t50-fixtures.ts";

// T-46: atomic voucher and flash-sale enforcement, the exact discount split in order_financials, store isolation and the named invariants.
// Every cap, window, allocation-sum and negative-total invariant below is mutation-checked (docs/tracks/t46.md).
billingTestSetup();
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
const HOUR = 3_600_000;
const window = () => ({ startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + HOUR) });
let phoneSeq = 0;
const phone = () => `0813${String(++phoneSeq).padStart(8, "0")}`;
type S = Awaited<ReturnType<typeof makeStore>>;
const cart = (s: S, variantId = s.variantId, quantity = 1) => setCartLine(s.sf, undefined, { variantId, quantity }, "add");
const percent = (over: Record<string, unknown> = {}) => ({ kind: "percent", scope: "all", value: 1_000, ...window(), ...over });
const buy = async (_s: S, cartId: string, over: Record<string, unknown> = {}) => (await placeOrder(db, cartId, buyer({ buyerPhone: phone(), ...over }))).orderId;
const fin = async (orderId: number) => (await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId)))[0]!;
const lines = (orderId: number) => platform.select().from(orderLineFinancials).where(eq(orderLineFinancials.orderId, orderId)).orderBy(orderLineFinancials.lineNo);
const used = async (id: number) => (await platform.select({ n: discount.usedCount }).from(discount).where(eq(discount.id, id)))[0]!.n;
const orders = async () => (await platform.select({ id: order.id }).from(order)).length;
async function second(s: S, price: number) {
  const productId = await createProduct(s.owner, { title: "Topi", status: "active", variant: { title: "All", price, stock: 20, weightGrams: 500 } });
  return { productId, variantId: (await platform.query.variant.findFirst({ where: (v, { eq }) => eq(v.productId, productId) }))!.id };
}
beforeEach(() => {
  phoneSeq = 0;
});

describe("T-46 voucher caps are atomic: no check-then-insert (PR-26, DATA-8)", () => {
  it("concurrent redemption of the LAST use yields exactly one success; the losers see the one generic refusal and leave nothing behind", async () => {
    const s = await makeStore("toko-a", { stock: 50 });
    const v = await saveVoucher(s.owner, percent({ usageLimit: 1 }));
    const carts = await Promise.all(Array.from({ length: 8 }, () => cart(s)));
    const settled = await Promise.allSettled(carts.map((c) => buy(s, c, { voucherCode: v.code })));
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const losers = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(losers.map((r) => r.reason.code)).toEqual(Array(7).fill("voucher_unavailable"));
    expect(await used(v.id)).toBe(1);
    expect(await orders()).toBe(1);
    expect(await platform.select().from(discountRedemption)).toHaveLength(1);
    expect((await platform.select({ stock: variant.stock }).from(variant).where(eq(variant.id, s.variantId)))[0]!.stock).toBe(49); // a refused redemption restored nothing and took nothing
  });

  it("wave 4 review: a concurrent double submit of ONE request (same idempotency key) returns the one order for every caller, never a voucher refusal", async () => {
    const s = await makeStore("toko-a", { stock: 50 });
    const v = await saveVoucher(s.owner, percent({ buyerUsageLimit: 1 }));
    const cartId = await cart(s);
    const input = buyer({ buyerPhone: phone(), voucherCode: v.code, idempotencyKey: "7f2b6f0e-3a54-4c5e-9d1a-2b6f0e3a54aa" });
    const results = await Promise.all(Array.from({ length: 4 }, () => placeOrder(db, cartId, input)));
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(await orders()).toBe(1);
    expect(await used(v.id)).toBe(1); // consumed once
  });

  it("the per-buyer cap counts every spelling of one phone number (canonical key) and holds under concurrency", async () => {
    const s = await makeStore("toko-a", { stock: 50 });
    const v = await saveVoucher(s.owner, percent({ buyerUsageLimit: 1 }));
    const spellings = ["081234567890", "+6281234567890", "6281234567890", "006281234567890"];
    const carts = await Promise.all(spellings.map(() => cart(s)));
    const settled = await Promise.allSettled(carts.map((c, i) => placeOrder(db, c, buyer({ buyerPhone: spellings[i], voucherCode: v.code }))));
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason.code ?? r.reason.cause?.code ?? String(r.reason))).toEqual(Array(3).fill("voucher_unavailable"));
    const usage = await platform.select().from(discountBuyerUsage);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usedCount).toBe(1);
    expect(JSON.stringify(usage)).not.toMatch(/8123|0812/); // a keyed fingerprint, never the number
    expect(await used(v.id)).toBe(1);
    // a different buyer still redeems
    expect(await buy(s, await cart(s), { voucherCode: v.code })).toBeGreaterThan(0);
  });

  it("the database refuses what the service would never do: a counter above its cap or moved backwards, by the app login itself", async () => {
    const s = await makeStore("toko-a");
    const v = await saveVoucher(s.owner, percent({ usageLimit: 1 }));
    await buy(s, await cart(s), { voucherCode: v.code });
    const asApp = (stmt: ReturnType<typeof sql>) => withStore(db, s.storeId, (tx) => tx.execute(stmt));
    expect(await code(asApp(sql`update discount set used_count = 2 where id = ${v.id}`))).toBe("23514");
    expect(await code(asApp(sql`update discount set used_count = 0 where id = ${v.id}`))).toBe("23514");
    expect(await code(asApp(sql`update discount set code_sha256 = repeat('a', 64) where id = ${v.id}`))).toBe("23514");
    expect(await code(asApp(sql`update discount set used_count = used_count + 1, starts_at = now() + interval '1 day', ends_at = now() + interval '2 days' where id = ${v.id}`))).toBe("23514");
    expect(await code(asApp(sql`delete from discount where id = ${v.id}`))).toBe("42501");
    expect(await code(platform.execute(sql`delete from discount_redemption`))).toBe("42501");
    expect(await code(admin.execute(sql`update discount_redemption set goods_discount_idr = 0`))).not.toBe("ok"); // append-only for the owner too
  });
});

describe("T-46 flash-sale windows and stock caps are enforced by the server, never by the client", () => {
  const flash = (s: S, over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) =>
    saveFlashSale(s.owner, { title: "Kilat", ...window(), items: [{ variantId: s.variantId, salePriceIdr: 80_000, stockCap: null, ...item }], ...over });

  it("price override applies only inside [starts_at, ends_at] and never touches the base price; after the window the order is at base price", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 30 });
    const sale = await flash(s);
    const live = await buy(s, await cart(s, s.variantId, 2));
    expect(await fin(live)).toMatchObject({ subtotalIdr: 200_000, goodsDiscountIdr: 40_000, goodsProceedsIdr: 160_000 });
    expect((await platform.select().from(variant).where(eq(variant.id, s.variantId)))[0]!.price).toBe(100_000);
    await admin.update(flashSale).set({ startsAt: new Date(Date.now() - 2 * HOUR), endsAt: new Date(Date.now() - 1_000) }).where(eq(flashSale.id, sale.id)); // ended a second ago
    const after = await buy(s, await cart(s, s.variantId, 2));
    expect(await fin(after)).toMatchObject({ subtotalIdr: 200_000, goodsDiscountIdr: 0 });
    await admin.update(flashSale).set({ startsAt: new Date(Date.now() + 5_000), endsAt: new Date(Date.now() + HOUR) }).where(eq(flashSale.id, sale.id)); // not started yet
    expect((await fin(await buy(s, await cart(s)))).goodsDiscountIdr).toBe(0);
    await admin.update(flashSale).set({ ...window(), status: "disabled" }).where(eq(flashSale.id, sale.id));
    expect((await fin(await buy(s, await cart(s)))).goodsDiscountIdr).toBe(0);
  });

  it("concurrent checkouts never sell more flash units than stock_cap; sold_count equals the evidence rows", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 40 });
    await flash(s, {}, { stockCap: 3 });
    const carts = await Promise.all(Array.from({ length: 9 }, () => cart(s)));
    const settled = await Promise.allSettled(carts.map((c) => buy(s, c)));
    const failures = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(failures.every((r) => r.reason.code === "flash_stock")).toBe(true);
    const [item] = await platform.select().from(flashSaleItem);
    const sold = (await platform.select().from(flashSaleRedemption)).reduce((n, r) => n + r.quantity, 0);
    expect(item!.soldCount).toBeLessThanOrEqual(3);
    expect(item!.soldCount).toBe(sold);
    expect(item!.soldCount).toBe(3);
    // a unit beyond the cap is a base-price unit or a refusal, never a flash price
    const discounted = (await platform.select().from(orderFinancials)).filter((f) => f.goodsDiscountIdr > 0);
    expect(discounted).toHaveLength(3);
  });

  it("a quantity above the remaining cap is refused outright and consumes nothing; the database also refuses sold_count above the cap and a sale outside its window", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 40 });
    await flash(s, {}, { stockCap: 3 });
    expect(await code(buy(s, await cart(s, s.variantId, 4)))).toBe("flash_stock");
    expect((await platform.select().from(flashSaleItem))[0]!.soldCount).toBe(0);
    const asApp = (stmt: ReturnType<typeof sql>) => withStore(db, s.storeId, (tx) => tx.execute(stmt));
    expect(await code(asApp(sql`update flash_sale_item set sold_count = 4`))).toBe("23514");
    await admin.execute(sql`update flash_sale set ends_at = now() - interval '1 second', starts_at = now() - interval '1 hour'`);
    expect(await code(asApp(sql`update flash_sale_item set sold_count = 1`))).toBe("23514"); // a reservation outside the window
  });

  it("a flash price at or above the variant price, or a variant of another store, cannot be configured", async () => {
    const a = await makeStore("toko-a", { price: 100_000 });
    const b = await makeStore("toko-b", { price: 100_000 });
    await expect(flash(a, {}, { salePriceIdr: 100_000 })).rejects.toMatchObject({ code: "promotion_price" });
    await expect(flash(a, {}, { variantId: b.variantId })).rejects.toMatchObject({ code: "promotion_price" });
  });
});

describe("T-46 goods and shipping discounts are recorded separately and every line share sums exactly", () => {
  it("a percent voucher over a collection: out-of-scope lines get nothing, line shares sum to goods_discount_idr (floor is the default rounding)", async () => {
    const s = await makeStore("toko-a", { price: 99_999, stock: 10 });
    const hat = await second(s, 50_001);
    const shoe = await second(s, 33_333);
    const collectionId = await createCollection(s.owner, { title: "Promo", slug: "promo", description: "", status: "published", productIds: [String(s.productId), String(hat.productId)] });
    const v = await saveVoucher(s.owner, percent({ scope: "collection", collectionId, value: 1_234 }));
    const cartId = await cart(s);
    await setCartLine(s.sf, cartId, { variantId: hat.variantId, quantity: 1 }, "add");
    await setCartLine(s.sf, cartId, { variantId: shoe.variantId, quantity: 1 }, "add");
    const id = await buy(s, cartId, { voucherCode: v.code });
    const f = await fin(id);
    const l = await lines(id);
    expect(f.goodsDiscountIdr).toBe(Math.floor(((99_999 + 50_001) * 1_234) / 10_000)); // 18 510 (floor)
    expect(l.reduce((n, x) => n + x.discountAllocIdr, 0)).toBe(f.goodsDiscountIdr);
    expect(l.find((x) => x.lineGrossIdr === 33_333)!.discountAllocIdr).toBe(0);
    expect(l.reduce((n, x) => n + x.shippingDiscountIdr, 0)).toBe(f.shippingDiscountIdr);
    const [o] = await platform.select().from(order).where(eq(order.id, id));
    expect(o!.total).toBe(f.payableIdr);
    expect(f.payableIdr).toBe(f.goodsProceedsIdr + f.shippingChargedIdr);
  });

  it("a flash price is a price override: it applies first even when the voucher was created earlier, and the voucher acts on the remaining net (committed numbers)", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 10 });
    const v = await saveVoucher(s.owner, percent({ value: 1_000 })); // the OLDER promotion
    await saveFlashSale(s.owner, { title: "Kilat", ...window(), items: [{ variantId: s.variantId, salePriceIdr: 80_000, stockCap: null }] });
    const id = await buy(s, await cart(s, s.variantId, 2), { voucherCode: v.code });
    // 2 x 100 000 = 200 000; flash -40 000 -> 160 000; voucher 10% of 160 000 = 16 000
    expect(await fin(id)).toMatchObject({ subtotalIdr: 200_000, goodsDiscountIdr: 56_000, goodsProceedsIdr: 144_000 });
    expect((await lines(id))[0]).toMatchObject({ lineGrossIdr: 200_000, discountAllocIdr: 56_000, netGoodsIdr: 144_000 });
  });

  it("a free-shipping voucher is store-funded and covers only the courier cost: the platform margin is never discounted", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const v = await saveVoucher(s.owner, { kind: "free_shipping", scope: "all", value: 0, ...window() });
    const plain = await buy(s, await cart(s));
    const id = await buy(s, await cart(s), { voucherCode: v.code });
    const [o] = await platform.select().from(order).where(eq(order.id, id));
    const [p] = await platform.select().from(order).where(eq(order.id, plain));
    const f = await fin(id);
    expect(f.shippingDiscountIdr).toBe(o!.shippingProviderCost);
    expect(f.shippingChargedIdr).toBe(o!.shippingMargin);
    expect(o!.shippingMargin).toBe(p!.shippingMargin); // the margin is exactly what it was without the promotion
    expect(f.goodsDiscountIdr).toBe(0);
    expect(o!.total).toBe(100_000 + o!.shippingMargin);
    expect((await lines(id)).reduce((n, x) => n + x.shippingDiscountIdr, 0)).toBe(f.shippingDiscountIdr);
  });

  it("wave 4 review: every spelling of one phone counts once for the per-buyer cap, and a number without a country or trunk prefix is refused for a capped voucher", async () => {
    const s = await makeStore("toko-a", { stock: 50 });
    const v = await saveVoucher(s.owner, percent({ buyerUsageLimit: 1 }));
    await buy(s, await cart(s), { voucherCode: v.code, buyerPhone: "081234567891" });
    for (const spelled of ["+6281234567891", "6281234567891", "006281234567891"]) {
      expect(await code(buy(s, await cart(s), { voucherCode: v.code, buyerPhone: spelled })), spelled).toBe("voucher_unavailable");
    }
    // A number that is not a canonical Indonesian mobile identity cannot carry a capped voucher at all.
    expect(await code(buy(s, await cart(s), { voucherCode: v.code, buyerPhone: "81234567891" }))).toBe("voucher_phone");
  });

  it("wave 4 review: the free-shipping threshold never blocks checkout, and a free-shipping voucher it replaces is not consumed", async () => {
    const cheap = await makeStore("toko-a", { price: 5_000, stock: 10 });
    await savePromoHub(cheap.owner, { enabled: true, title: "Promo", subtitle: "", bannerMediaId: null, bannerCtaLabel: "", bannerCtaHref: "", freeShipEnabled: true, freeShipThresholdIdr: 0, percentRounding: "floor", featuredCollectionIds: [] });
    // Threshold 0, goods 5 000, courier cost above that: the order is placed with no shipping discount instead of being refused.
    const placed = await buy(cheap, await cart(cheap));
    expect((await fin(placed)).shippingDiscountIdr).toBe(0);
    const s = await makeStore("toko-b", { price: 100_000, stock: 10 });
    await savePromoHub(s.owner, { enabled: true, title: "Promo", subtitle: "", bannerMediaId: null, bannerCtaLabel: "", bannerCtaHref: "", freeShipEnabled: true, freeShipThresholdIdr: 50_000, percentRounding: "floor", featuredCollectionIds: [] });
    const v = await saveVoucher(s.owner, { kind: "free_shipping", scope: "all", value: 0, usageLimit: 1, ...window() });
    const id = await buy(s, await cart(s), { voucherCode: v.code });
    const [o] = await platform.select().from(order).where(eq(order.id, id));
    expect((await fin(id)).shippingDiscountIdr).toBe(o!.shippingProviderCost); // the threshold gave the free shipping
    expect(await used(v.id)).toBe(0); // the voucher was not consumed
    expect(await platform.select().from(discountRedemption)).toHaveLength(0);
  });

  it("the automatic free-shipping threshold uses the net goods after discounts and does not stack on a shipping voucher", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 10 });
    await savePromoHub(s.owner, { enabled: true, title: "Promo", subtitle: "", bannerMediaId: null, bannerCtaLabel: "", bannerCtaHref: "", freeShipEnabled: true, freeShipThresholdIdr: 150_000, percentRounding: "floor", featuredCollectionIds: [] });
    const v = await saveVoucher(s.owner, { kind: "free_shipping", scope: "all", value: 0, ...window() });
    const below = await fin(await buy(s, await cart(s)));
    expect(below.shippingDiscountIdr).toBe(0);
    const at = await buy(s, await cart(s, s.variantId, 2));
    const [o] = await platform.select().from(order).where(eq(order.id, at));
    expect((await fin(at)).shippingDiscountIdr).toBe(o!.shippingProviderCost);
    const both = await buy(s, await cart(s, s.variantId, 2), { voucherCode: v.code });
    const [ob] = await platform.select().from(order).where(eq(order.id, both));
    expect((await fin(both)).shippingDiscountIdr).toBe(ob!.shippingProviderCost); // once, not twice
    const cut = await saveVoucher(s.owner, percent({ value: 5_000 })); // 50%: 2 x 100 000 -> 100 000 net, below the threshold
    const lowered = await buy(s, await cart(s, s.variantId, 2), { voucherCode: cut.code });
    expect((await fin(lowered)).shippingDiscountIdr).toBe(0);
  });

  it("the total never goes negative: a fixed voucher larger than the goods is capped to them, and a subsidy the seller's proceeds cannot cover is BLOCKED visibly and consumes nothing", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const big = await saveVoucher(s.owner, { kind: "fixed", scope: "all", value: 900_000, ...window() });
    const id = await buy(s, await cart(s), { voucherCode: big.code });
    const [o] = await platform.select().from(order).where(eq(order.id, id));
    expect(await fin(id)).toMatchObject({ goodsDiscountIdr: 100_000, goodsProceedsIdr: 0, saleAmountIdr: 0 });
    expect(o!.total).toBe(o!.shippingFee);
    await savePromoHub(s.owner, { enabled: true, title: "Promo", subtitle: "", bannerMediaId: null, bannerCtaLabel: "", bannerCtaHref: "", freeShipEnabled: true, freeShipThresholdIdr: 0, percentRounding: "floor", featuredCollectionIds: [] });
    // Wave 4 review: the AUTOMATIC threshold never blocks a checkout. With the goods fully discounted the sale amount cannot carry the courier cost, so the
    // threshold is simply not applied and the order is placed with no shipping discount.
    const again = await saveVoucher(s.owner, { kind: "fixed", scope: "all", value: 900_000, ...window() });
    const placed = await buy(s, await cart(s), { voucherCode: again.code });
    expect((await fin(placed)).shippingDiscountIdr).toBe(0);
    // A free-shipping VOUCHER the buyer chose, on goods too cheap to carry the courier cost, is still blocked visibly and consumes nothing.
    const cheap = await makeStore("toko-b", { price: 5_000 });
    const free = await saveVoucher(cheap.owner, { kind: "free_shipping", scope: "all", value: 0, ...window() });
    const before = await orders();
    expect(await code(buy(cheap, await cart(cheap), { voucherCode: free.code }))).toBe("promotion_negative_proceeds");
    expect(await orders()).toBe(before);
    expect(await used(free.id)).toBe(0); // rolled back with the refused order
  });

  it("the database itself refuses a snapshot whose shipping shares do not sum, whose shipping discount exceeds the courier cost, or any later edit of the shares", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const v = await saveVoucher(s.owner, { kind: "free_shipping", scope: "all", value: 0, ...window() });
    const id = await buy(s, await cart(s), { voucherCode: v.code });
    const [o] = await platform.select().from(order).where(eq(order.id, id));
    expect(await code(admin.execute(sql`update order_line_financials set shipping_discount_idr = 0 where order_id = ${id}`))).toBe("42501");
    type Fin = typeof orderFinancials.$inferInsert;
    type Line = typeof orderLineFinancials.$inferInsert;
    // The demo-reset marker is the one door the snapshot guard leaves open; the harness uses it to put a (possibly wrong) snapshot back in the same transaction.
    const rewrite = async (fix: (f: Fin) => Fin, fixLines: (l: Line[]) => Line[]) => {
      const f = await fin(id);
      const l = await lines(id);
      return admin.transaction(async (tx) => {
        await tx.execute(sql`set local bukalaris.ledger_reset = 'demo'`);
        await tx.delete(orderLineFinancials).where(eq(orderLineFinancials.orderId, id));
        await tx.delete(orderFinancials).where(eq(orderFinancials.orderId, id));
        await tx.insert(orderFinancials).values(fix(f));
        await tx.insert(orderLineFinancials).values(fixLines(l));
      });
    };
    expect(await code(rewrite((f) => f, (l) => l))).toBe("ok"); // the harness itself is sound
    expect(await code(rewrite((f) => f, (l) => l.map((x, i) => (i === 0 ? { ...x, shippingDiscountIdr: x.shippingDiscountIdr! + 1 } : x))))).toBe("23514"); // shares do not sum (deferred, at commit)
    expect(await code(rewrite((f) => ({ ...f, shippingDiscountIdr: o!.shippingProviderCost + 1 }), (l) => l.map((x) => ({ ...x, shippingDiscountIdr: o!.shippingProviderCost + 1 }))))).toBe("23514"); // more than the courier cost
    expect(await code(rewrite((f) => ({ ...f, saleAmountIdr: 0, goodsProceedsIdr: 0 }), (l) => l))).not.toBe("ok");
  });
});

describe("T-46 voucher codes are not enumerable and are bound to their store", () => {
  it("unknown, expired, not-yet-started, disabled and exhausted codes all give the same message; wrong store never redeems", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const expired = await saveVoucher(a.owner, percent({ startsAt: new Date(Date.now() - 2 * HOUR), endsAt: new Date(Date.now() - HOUR) }));
    const future = await saveVoucher(a.owner, percent({ startsAt: new Date(Date.now() + HOUR), endsAt: new Date(Date.now() + 2 * HOUR) }));
    const off = await saveVoucher(a.owner, percent({ status: "disabled" }));
    const full = await saveVoucher(a.owner, percent({ usageLimit: 1 }));
    await buy(a, await cart(a), { voucherCode: full.code });
    const good = await saveVoucher(a.owner, percent());
    const messages = new Set<string>();
    for (const c of [expired.code, future.code, off.code, full.code, "A".repeat(24), "tidak-ada", good.code.toLowerCase().replace(/./, "x")]) {
      await placeOrder(db, await cart(a), buyer({ buyerPhone: phone(), voucherCode: c })).catch((e) => messages.add(`${e.code}: ${e.message}`));
    }
    expect(messages.size).toBe(1);
    expect([...messages][0]).toMatch(/^voucher_unavailable: Voucher tidak dapat dipakai/);
    // another store's valid code is simply unknown here
    await expect(placeOrder(db, await cart(b), buyer({ buyerPhone: phone(), voucherCode: good.code }))).rejects.toMatchObject({ code: "voucher_unavailable" });
    expect(await orders()).toBe(1);
  });

  it("redeem attempts are rate limited per phone even when each attempt fails, and a failed attempt costs nothing but the budget", async () => {
    const s = await makeStore("toko-a");
    const c = await cart(s);
    const input = { buyerPhone: "081299990001", voucherCode: "SALAH", ...DESTINATION, courier: "JNE", paymentMethod: "cod" };
    const results: string[] = [];
    for (let i = 0; i < 12; i++) results.push((await code(checkoutPromotionPreview(db, c, input))) ?? "ok");
    expect(results.slice(0, 10)).toEqual(Array(10).fill("voucher_unavailable"));
    expect(results.slice(10)).toEqual(["rate_limited", "rate_limited"]);
    // another phone has its own budget; the rate limit key holds a fingerprint, not the number
    expect(await code(checkoutPromotionPreview(db, c, { ...input, buyerPhone: "081299990002" }))).toBe("voucher_unavailable");
    const keys = (await platform.execute(sql`select key from rate_limit where key like 'voucher:%'`)) as unknown as { key: string }[];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => !/0812999900/.test(k.key))).toBe(true);
  });

  it("the buyer preview shows the same split as the order it would create and reserves nothing", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 10 });
    const v = await saveVoucher(s.owner, percent({ usageLimit: 5, buyerUsageLimit: 1 }));
    const c = await cart(s, s.variantId, 2);
    const phoneNo = phone();
    const preview = await checkoutPromotionPreview(db, c, { buyerPhone: phoneNo, voucherCode: v.code, ...DESTINATION, courier: "JNE", paymentMethod: "cod" });
    expect(await used(v.id)).toBe(0);
    expect(await platform.select().from(discountBuyerUsage)).toHaveLength(0);
    const id = await buy(s, c, { buyerPhone: phoneNo, voucherCode: v.code });
    const f = await fin(id);
    expect(preview).toMatchObject({ goodsDiscount: f.goodsDiscountIdr, shippingDiscount: f.shippingDiscountIdr, payable: f.payableIdr });
  });
});

describe("T-46 store isolation, capabilities and billing", () => {
  it("RLS: another store's seller and an unscoped connection see none of a store's vouchers, flash sales or hub", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    await saveVoucher(a.owner, percent());
    await saveFlashSale(a.owner, { title: "Kilat", ...window(), items: [{ variantId: a.variantId, salePriceIdr: 50_000, stockCap: 5 }] });
    const seen = await sellerPromotions(b.owner);
    expect([seen.vouchers.length, seen.sales.length, seen.items.length]).toEqual([0, 0, 0]);
    expect(await withStore(db, b.storeId, async (tx) => (await tx.select().from(discount)).length)).toBe(0);
    expect(((await db.execute(sql`select count(*)::int as n from discount`)) as unknown as { n: number }[])[0]!.n).toBe(0);
    await expect(saveVoucher(b.owner, percent({ scope: "product", productId: a.productId }))).rejects.toBeTruthy(); // the compound FK refuses another store's product
    await expect(saveFlashSale(b.owner, { title: "Kilat", ...window(), items: [{ variantId: a.variantId, salePriceIdr: 50_000, stockCap: 5 }] })).rejects.toMatchObject({ code: "promotion_price" });
  });

  it("only the owner writes (staff read); writes are refused while the subscription is unpaid but reads work; checkout and the storefront are not affected", async () => {
    const s = await billingStore("toko-a");
    const owner = await s.sellerAt();
    const v = await saveVoucher(owner, percent());
    const staffId = await makeUser("staf");
    await admin.execute(sql`insert into membership (store_id, user_id, role) values (${s.storeId}, ${staffId}, 'staff')`);
    const staff = await seller(staffId, s.storeId);
    await expect(sellerPromotions(staff)).resolves.toMatchObject({ vouchers: [{ id: v.id }] });
    for (const write of [saveVoucher(staff, percent()), saveFlashSale(staff, { title: "x", ...window(), items: [{ variantId: s.variantId, salePriceIdr: 1, stockCap: null }] }), savePromoHub(staff, { enabled: true, title: "Promo", subtitle: "", bannerMediaId: null, bannerCtaLabel: "", bannerCtaHref: "", freeShipEnabled: false, freeShipThresholdIdr: 0, percentRounding: "floor", featuredCollectionIds: [] })])
      expect(await code(write)).toBe("forbidden");
    const late = await s.sellerAt(new Date(Date.now() + 4 * 86_400_000));
    expect(late.billing.writable).toBe(false);
    for (const write of [saveVoucher(late, percent()), savePromoHub(late, { enabled: true, title: "Promo", subtitle: "", bannerMediaId: null, bannerCtaLabel: "", bannerCtaHref: "", freeShipEnabled: false, freeShipThresholdIdr: 0, percentRounding: "floor", featuredCollectionIds: [] })])
      expect(await code(write)).toBe("billing_read_only");
    await expect(sellerPromotions(late)).resolves.toMatchObject({ vouchers: [{ id: v.id }] });
    // billing is not consulted by the buyer path: with the trial long over the seller is read-only, yet the voucher still redeems
    await setSubscription(s.storeId, { trialEndsAt: new Date(Date.now() - 20 * 86_400_000) });
    expect((await s.sellerAt()).billing.writable).toBe(false);
    expect(await buy(s, await cart(s), { voucherCode: v.code })).toBeGreaterThan(0);
    expect((await platform.select().from(auditLog).where(eq(auditLog.storeId, s.storeId))).map((a) => a.action)).toContain("promotion.voucher.create");
  });

  it("the storefront projection lists only live, usable offers and exposes no counters or buyer data; a disabled hub is absent", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 10 });
    expect(await storefrontPromotions(s.sf)).toBeNull();
    await savePromoHub(s.owner, { enabled: true, title: "Promo Oktober", subtitle: "Hemat", bannerMediaId: null, bannerCtaLabel: "", bannerCtaHref: "", freeShipEnabled: false, freeShipThresholdIdr: 0, percentRounding: "half_up", featuredCollectionIds: [] });
    const live = await saveVoucher(s.owner, percent({ usageLimit: 1 }));
    await saveVoucher(s.owner, percent({ public: false }));
    await saveVoucher(s.owner, percent({ startsAt: new Date(Date.now() - 2 * HOUR), endsAt: new Date(Date.now() - HOUR) }));
    await saveFlashSale(s.owner, { title: "Kilat", ...window(), items: [{ variantId: s.variantId, salePriceIdr: 70_000, stockCap: 1 }] });
    const before = (await storefrontPromotions(s.sf))!;
    expect(before.vouchers.map((v) => v.code)).toEqual([live.code]);
    expect(before.flashes).toHaveLength(1);
    expect(before.products).toHaveLength(1);
    expect(JSON.stringify(before)).not.toMatch(/usedCount|phone|fingerprint/);
    await buy(s, await cart(s), { voucherCode: live.code }); // uses the last voucher use and the last flash unit
    const after = (await storefrontPromotions(s.sf))!;
    expect(after.vouchers).toEqual([]);
    expect(after.flashes).toEqual([]);
    expect(((await platform.select().from(flashSaleItem))[0]!).soldCount).toBe(1);
  });

  it("the local demo reset removes the promotion rows of demo-* stores only, and only on the owner connection", async () => {
    const demo = await makeStore("demo-uji", { price: 100_000, stock: 20 });
    const real = await makeStore("toko-nyata", { price: 100_000, stock: 20 });
    for (const s of [demo, real]) {
      await savePromoHub(s.owner, { enabled: true, title: "Promo", subtitle: "", bannerMediaId: null, bannerCtaLabel: "", bannerCtaHref: "", freeShipEnabled: false, freeShipThresholdIdr: 0, percentRounding: "floor", featuredCollectionIds: [] });
      await saveFlashSale(s.owner, { title: "Kilat", ...window(), items: [{ variantId: s.variantId, salePriceIdr: 70_000, stockCap: 5 }] });
      const v = await saveVoucher(s.owner, percent({ buyerUsageLimit: 2 }));
      await buy(s, await cart(s), { voucherCode: v.code });
    }
    const owner = createDb(localRoleUrl(process.env.TEST_DATABASE_URL!, "bukalaris_owner"));
    try {
      const ids = sql`array[${demo.storeId}, ${real.storeId}]::bigint[]`;
      expect(await code(platform.execute(sql`select reset_demo_promotions(${ids})`))).toBe("42501"); // no login role may call it
      expect(await code(db.execute(sql`select reset_demo_promotions(${ids})`))).toBe("42501");
      const removed = ((await owner.execute(sql`select reset_demo_promotions(${ids}) as n`)) as unknown as { n: string }[])[0]!.n;
      expect(Number(removed)).toBe(7); // redemption x2 (voucher, flash), buyer usage, hub, flash item, flash sale, voucher
    } finally {
      await owner.$client.end();
    }
    const left = async (id: number) => ({
      discounts: (await platform.select().from(discount).where(eq(discount.storeId, id))).length,
      redemptions: (await platform.select().from(discountRedemption).where(eq(discountRedemption.storeId, id))).length + (await platform.select().from(flashSaleRedemption).where(eq(flashSaleRedemption.storeId, id))).length,
      hubs: (await platform.select().from(promoHub).where(eq(promoHub.storeId, id))).length,
    });
    expect(await left(demo.storeId)).toEqual({ discounts: 0, redemptions: 0, hubs: 0 });
    expect(await left(real.storeId)).toEqual({ discounts: 1, redemptions: 2, hubs: 1 }); // another store's evidence is untouched
  });
});
