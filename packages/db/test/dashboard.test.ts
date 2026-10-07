import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addVariant, createProduct } from "../src/catalog.ts";
import { placeOrder } from "../src/checkout.ts";
import { PERIODS, periodRange, sellerDashboard, startOfJakartaDay, type Period } from "../src/dashboard.ts";
import { transitionOrder } from "../src/orders.ts";
import { membership, order, orderLine, signalEvent } from "../src/schema.ts";
import { collectFunnelEvent, saveDestination } from "../src/signals.ts";
import { setCartLine } from "../src/storefront.ts";
import { buyer, db, makeStore, makeUser, platform, seller } from "./helpers.ts";

process.env.INTEGRATION_TOKEN_KEY ??= Buffer.alloc(32, 9).toString("base64");

const MIN = 60_000;
let phoneSeq = 0;
const DAY = 24 * 60 * MIN;
type Store = Awaited<ReturnType<typeof makeStore>>;

/** A COD order (awaiting_confirmation) or transfer order (awaiting_payment) for `qty` units of `variantId`, created at `at`. */
async function orderAt(s: Store, at: Date, over: Record<string, unknown> = {}, lines: { variantId: number; qty: number }[] = [{ variantId: s.variantId, qty: 1 }]) {
  let cartId: string | undefined;
  for (const l of lines) cartId = await setCartLine(s.sf, cartId, { variantId: l.variantId, quantity: l.qty }, "add");
  const { orderId } = await placeOrder(db, cartId, buyer({ buyerPhone: `0812${String(phoneSeq++).padStart(8, "0")}`, ...over }));
  await platform.update(order).set({ createdAt: at }).where(eq(order.id, orderId));
  return orderId;
}

/** The dashboard's definitions applied in plain TS over raw rows, so every SQL aggregate has an independent witness. */
async function expected(storeId: number, range: { from: Date; to: Date }) {
  const rows = (await platform.select().from(order).where(eq(order.storeId, storeId))).filter((o) => o.createdAt >= range.from && o.createdAt < range.to);
  const counted = rows.filter((o) => o.status !== "cancelled");
  const cod = rows.filter((o) => o.paymentMethod === "cod");
  const goodsRevenue = counted.reduce((s, o) => s + o.subtotal, 0);
  return {
    total: rows.length,
    orders: counted.length,
    cancelled: rows.length - counted.length,
    goodsRevenue,
    shippingCollected: counted.reduce((s, o) => s + o.shippingFee, 0),
    averageOrderValue: counted.length ? Math.round(goodsRevenue / counted.length) : null,
    cod: { total: cod.length, confirmed: cod.filter((o) => o.confirmedAt !== null).length, cancelled: cod.filter((o) => o.status === "cancelled").length },
  };
}

describe("period boundaries (Asia/Jakarta)", () => {
  it("starts the day at 00:00 WIB = 17:00 UTC the day before, for every period", () => {
    // 2026-10-07 02:30 WIB is still 2026-10-06 19:30 UTC: the Jakarta day wins.
    const now = new Date("2026-10-06T19:30:00Z");
    expect(startOfJakartaDay(now).toISOString()).toBe("2026-10-06T17:00:00.000Z");
    expect(periodRange("today", now)).toEqual({ from: new Date("2026-10-06T17:00:00Z"), to: new Date("2026-10-07T17:00:00Z") });
    expect(periodRange("7d", now).from.toISOString()).toBe("2026-09-30T17:00:00.000Z");
    expect(periodRange("30d", now).from.toISOString()).toBe("2026-09-07T17:00:00.000Z");
    // 23:59 WIB stays in the same Jakarta day as 00:01 WIB of that day.
    const late = new Date("2026-10-07T16:59:00Z"); // 23:59 WIB on 7 Oct
    expect(startOfJakartaDay(late).toISOString()).toBe("2026-10-06T17:00:00.000Z");
    expect(PERIODS).toEqual(["today", "7d", "30d"]);
  });
});

describe("seller dashboard (T-41, PR-22)", () => {
  it("reconciles every KPI with the order rows, across the 23:59 / 00:01 WIB boundary and excluding cancelled revenue", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 100 });
    const now = new Date();
    const today = startOfJakartaDay(now);
    const t = (ms: number) => new Date(today.getTime() + ms);

    // Today: 00:01 WIB COD confirmed, 12:00 COD rejected, 13:00 COD still awaiting, 14:00 transfer (prepaid, not COD).
    const confirmed = await orderAt(s, t(1 * MIN), {}, [{ variantId: s.variantId, qty: 2 }]);
    await transitionOrder(s.owner, confirmed, "confirm");
    const rejected = await orderAt(s, t(12 * 60 * MIN));
    await transitionOrder(s.owner, rejected, "reject", { reason: "alamat tidak lengkap, pembeli tidak bisa dihubungi" });
    await orderAt(s, t(13 * 60 * MIN));
    await orderAt(s, t(14 * 60 * MIN), { paymentMethod: "manual_transfer" });
    // Yesterday 23:59 WIB: outside "today", inside "7d" and "30d".
    const yesterday = await orderAt(s, t(-1 * MIN));
    await transitionOrder(s.owner, yesterday, "confirm");
    // 7 days ago 23:59 WIB: outside "7d" (which starts at today − 6 days 00:00), inside "30d".
    await orderAt(s, t(-6 * DAY - 1 * MIN));
    // 30 days ago 23:59 WIB: outside every period.
    await orderAt(s, t(-29 * DAY - 1 * MIN));

    const all = await platform.select().from(order).where(eq(order.storeId, s.storeId));
    expect(all).toHaveLength(7);

    for (const period of PERIODS) {
      const d = await sellerDashboard(s.owner, period, now);
      const want = await expected(s.storeId, periodRange(period, now));
      expect(d.kpi, period).toEqual(want);
      expect(d.awaiting, period).toBe(all.filter((o) => o.status === "awaiting_confirmation" || o.status === "on_hold").length);
    }
    const today0 = await sellerDashboard(s.owner, "today", now);
    expect(today0.kpi).toMatchObject({ total: 4, orders: 3, cancelled: 1, goodsRevenue: 400_000, cod: { total: 3, confirmed: 1, cancelled: 1 } });
    // Shipping is reported apart from goods (fees differ per weight and payment method; `expected` above sums the rows).
    expect(today0.kpi.shippingCollected).toBeGreaterThan(0);
    expect(today0.kpi.averageOrderValue).toBe(Math.round(400_000 / 3));
    expect((await sellerDashboard(s.owner, "7d", now)).kpi).toMatchObject({ total: 5, orders: 4, cod: { total: 4, confirmed: 2 } });
    expect((await sellerDashboard(s.owner, "30d", now)).kpi).toMatchObject({ total: 6, orders: 5 });
    // The rejected order's goods are not revenue in any period.
    const [rej] = await platform.select().from(order).where(eq(order.id, rejected));
    expect(rej!.status).toBe("cancelled");
    expect((await sellerDashboard(s.owner, "30d", now)).kpi.goodsRevenue).toBe(6 * 100_000); // 5 counted orders, 6 units
  });

  it("empty period: zero totals, null average, work queue still counted; staff may read", async () => {
    const s = await makeStore("toko-a");
    const staffId = await makeUser("staff");
    await platform.insert(membership).values({ storeId: s.storeId, userId: staffId, role: "staff" });
    const staff = await seller(staffId);
    const now = new Date();
    await orderAt(s, new Date(startOfJakartaDay(now).getTime() - 40 * DAY)); // old, still awaiting
    const d = await sellerDashboard(staff, "today", now);
    expect(d.kpi).toEqual({ total: 0, orders: 0, cancelled: 0, goodsRevenue: 0, shippingCollected: 0, averageOrderValue: null, cod: { total: 0, confirmed: 0, cancelled: 0 } });
    expect(d.awaiting).toBe(1);
    expect(d.topProducts).toEqual([]);
    expect(d.funnel).toEqual({ enabled: false, steps: ["ViewContent", "AddToCart", "InitiateCheckout", "Purchase"].map((event) => ({ event, count: 0 })) });
  });

  it("top products: grouped per product across variants, ranked by goods revenue, cancelled excluded, five at most", async () => {
    const s = await makeStore("toko-a", { price: 50_000, stock: 100 });
    const now = new Date();
    const at = new Date(startOfJakartaDay(now).getTime() + 60 * MIN);
    const second = await addVariant(s.owner, s.productId, { title: "L", price: 60_000, stock: 100 });
    const others: number[] = [];
    for (let i = 0; i < 6; i++) {
      const pid = await createProduct(s.owner, { title: `Produk ${i}`, status: "active", variant: { title: "U", price: 10_000 * (i + 1), stock: 100 } });
      const [v] = await platform.query.variant.findMany({ where: (v, { eq }) => eq(v.productId, pid) });
      others.push(v!.id);
    }
    // Kaos: 2 × M (100 000) + 1 × L (60 000) = 160 000 over 3 units, in two orders.
    await orderAt(s, at, {}, [{ variantId: s.variantId, qty: 2 }]);
    await orderAt(s, at, {}, [{ variantId: second, qty: 1 }]);
    // One order each for the six other products: revenue 10k…60k; the 60k one is rejected → excluded.
    for (const [i, v] of others.entries()) {
      const id = await orderAt(s, at, {}, [{ variantId: v, qty: 1 }]);
      if (i === 5) await transitionOrder(s.owner, id, "reject", { reason: "pembeli membatalkan lewat telepon" });
    }
    const d = await sellerDashboard(s.owner, "today", now);
    expect(d.topProducts.map((p) => [p.title, p.units, p.revenue])).toEqual([
      ["Kaos toko-a", 3, 160_000],
      ["Produk 4", 1, 50_000],
      ["Produk 3", 1, 40_000],
      ["Produk 2", 1, 30_000],
      ["Produk 1", 1, 20_000],
    ]);
    // Goods revenue is the sum of every counted line, so the table and the KPI agree.
    const lines = await platform.select().from(orderLine).where(eq(orderLine.storeId, s.storeId));
    const allTop = d.topProducts.reduce((n, p) => n + p.revenue, 0);
    expect(d.kpi.goodsRevenue).toBe(allTop + 10_000); // + Produk 0, outside the top 5
    expect(lines.reduce((n, l) => n + l.lineTotal, 0)).toBe(d.kpi.goodsRevenue + 60_000); // + the rejected one
  });

  it("funnel: distinct event ids per step from signal_event, within the period, only when a destination is enabled", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const now = new Date();
    const at = new Date(startOfJakartaDay(now).getTime() + 60 * MIN);
    await saveDestination(s.owner, "meta", { pixelId: "123456789012345", token: "EAAB-tok", enabled: true });
    await saveDestination(s.owner, "tiktok", { pixelId: "C0FAKEPIXEL0001", token: "tt-tok", enabled: true });
    const [v] = await platform.query.variant.findMany({ where: (v, { eq }) => eq(v.id, s.variantId) });
    const req = { cookies: {}, clientIp: "203.0.113.7", userAgent: "test", url: "https://toko-a.localhost/" };
    const uuid = (n: number) => `11111111-2222-4333-8444-${String(n).padStart(12, "0")}`;
    for (let i = 0; i < 3; i++) await collectFunnelEvent(s.sf, { event: "ViewContent", eventId: uuid(i), items: [{ id: v!.catalogId, quantity: 1 }] }, req);
    for (let i = 10; i < 12; i++) await collectFunnelEvent(s.sf, { event: "AddToCart", eventId: uuid(i), items: [{ id: v!.catalogId, quantity: 1 }] }, req);
    await collectFunnelEvent(s.sf, { event: "InitiateCheckout", eventId: uuid(20), items: [{ id: v!.catalogId, quantity: 1 }] }, req);
    await orderAt(s, at); // COD → one Purchase per destination
    // Two destinations → two rows per event; the funnel counts each event once.
    expect(await platform.select().from(signalEvent).where(eq(signalEvent.storeId, s.storeId))).toHaveLength(2 * 7);
    const d = await sellerDashboard(s.owner, "today", now);
    expect(d.funnel.enabled).toBe(true);
    expect(d.funnel.steps).toEqual([
      { event: "ViewContent", count: 3 },
      { event: "AddToCart", count: 2 },
      { event: "InitiateCheckout", count: 1 },
      { event: "Purchase", count: 1 },
    ]);
    // Events dated before the period are not in "today" but are in "7d".
    await platform.update(signalEvent).set({ createdAt: new Date(startOfJakartaDay(now).getTime() - 2 * MIN) }).where(eq(signalEvent.eventName, "ViewContent"));
    expect((await sellerDashboard(s.owner, "today", now)).funnel.steps[0]).toEqual({ event: "ViewContent", count: 0 });
    expect((await sellerDashboard(s.owner, "7d", now)).funnel.steps[0]).toEqual({ event: "ViewContent", count: 3 });
  });

  it("cross-store isolation under RLS: another store's orders never move this store's numbers", async () => {
    const a = await makeStore("toko-a", { price: 100_000 });
    const b = await makeStore("toko-b", { price: 999_000 });
    const now = new Date();
    const at = new Date(startOfJakartaDay(now).getTime() + 60 * MIN);
    await orderAt(a, at);
    await orderAt(b, at, {}, [{ variantId: b.variantId, qty: 3 }]);
    const da = await sellerDashboard(a.owner, "30d", now);
    const dbb = await sellerDashboard(b.owner, "30d", now);
    expect(da.kpi).toMatchObject({ total: 1, goodsRevenue: 100_000 });
    expect(dbb.kpi).toMatchObject({ total: 1, goodsRevenue: 2_997_000 });
    expect(da.topProducts.map((p) => p.title)).toEqual(["Kaos toko-a"]);
    expect(dbb.topProducts.map((p) => p.title)).toEqual(["Kaos toko-b"]);
    expect(da.awaiting).toBe(1);
    expect(dbb.awaiting).toBe(1);
  });

  it("rejects an unknown period before touching the database", async () => {
    const s = await makeStore("toko-a");
    await expect(sellerDashboard(s.owner, "year" as Period)).rejects.toThrow(/period/);
  });
});
