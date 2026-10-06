import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addVariant } from "../src/catalog.ts";
import {
  CART_MAX_LINES,
  checkoutShippingOptions,
  checkoutSummary,
  cleanupIdleCarts,
  enforceLimits,
  getBuyerOrder,
  hit,
  LIMITS,
  limitCartMutation,
  placeOrder,
  searchDestinationAreas,
} from "../src/checkout.ts";
import { MengantarError } from "../src/mengantar/client.ts";
import { FAKE_NO_COD_AREA, fakeMengantar, fakeProviders, type Providers, type ShippingAdapter } from "../src/providers.ts";
import { addressIncomplete, getOrder, transitionOrder } from "../src/orders.ts";
import { cart, cartLine, membership, order, rateLimit, stockAdjustment, variant } from "../src/schema.ts";
import { defaultShippingAdapter } from "../src/shipping.ts";
import { getCart, setCartLine } from "../src/storefront.ts";
import { buyer, db, DESTINATION, makeStore, makeUser, PICKUP_AREA, seller } from "./helpers.ts";

const row = async (id: number) => (await db.select().from(order).where(eq(order.id, id)))[0]!;

describe("checkout shipping wiring (T-34 phase 2, Q-12)", () => {
  it("snapshots courier code + label, route area ids and the fee split from the server-side quote", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const cod = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cod, buyer());
    expect(await row(orderId)).toMatchObject({
      courierCode: "JNE",
      courier: "JNE Express (simulasi)",
      originAreaId: PICKUP_AREA.areaId,
      destinationAreaId: DESTINATION.destinationAreaId,
      destinationAreaLabel: DESTINATION.destinationAreaLabel,
      weightKg: 1,
      shippingProviderCost: 15_494, // fake COD cost incl. provider COD fee
      shippingMargin: 2_006, // default rule: + Rp 2.000, rounded up to Rp 500
      shippingFee: 17_500,
      subtotal: 100_000,
      total: 117_500,
    });
    expect(await getBuyerOrder(db, orderId, cod)).toMatchObject({ courier: "JNE Express (simulasi)", destinationAreaLabel: DESTINATION.destinationAreaLabel, shippingFee: 17_500 });

    // Prepaid uses the prepaid cost basis; a second cart line adds a kilogram.
    const v2 = await addVariant(s.owner, s.productId, { title: "L", price: 50_000, stock: 5 });
    const transfer = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await setCartLine(s.sf, transfer, { variantId: v2, quantity: 2 }, "add");
    const r2 = await placeOrder(db, transfer, buyer({ paymentMethod: "manual_transfer" }));
    expect(await row(r2.orderId)).toMatchObject({ weightKg: 2, shippingProviderCost: 15_500, shippingMargin: 2_000, shippingFee: 17_500, subtotal: 200_000, total: 217_500 });
  });

  it("rejects an unoffered courier, COD on a courier that refuses it, and bad or unserved destinations", async () => {
    const s = await makeStore("toko-a");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await expect(placeOrder(db, cartId, buyer({ courier: "pos" }))).rejects.toMatchObject({ code: "courier" }); // unsupported → hidden
    await expect(placeOrder(db, cartId, buyer({ courier: "SiCepat" }))).rejects.toMatchObject({ code: "courier_cod" });
    await expect(placeOrder(db, cartId, buyer({ courier: "JNE", destinationAreaId: FAKE_NO_COD_AREA }))).rejects.toMatchObject({ code: "courier_cod" });
    await expect(placeOrder(db, cartId, buyer({ destinationAreaId: "f".repeat(24) }))).rejects.toMatchObject({ code: "courier" }); // no route
    await expect(placeOrder(db, cartId, buyer({ destinationAreaId: "not-an-area" }))).rejects.toMatchObject({ name: "ZodError" });
    await expect(placeOrder(db, cartId, buyer({ destinationAreaId: undefined }))).rejects.toMatchObject({ name: "ZodError" });
    // The quote itself hides COD per courier and never carries a client amount.
    const q = await checkoutShippingOptions(s.sf, FAKE_NO_COD_AREA, { items: 1, subtotal: 100_000 }, fakeMengantar);
    expect(q.options.map((o) => [o.courier, o.cod])).toEqual([["SiCepat", null], ["JNE", null]]);
    // SiCepat prepaid is fine: 8_000 + 2_000 → 10_000.
    const { orderId } = await placeOrder(db, cartId, buyer({ courier: "SiCepat", paymentMethod: "manual_transfer" }));
    expect(await row(orderId)).toMatchObject({ courierCode: "SiCepat", shippingProviderCost: 8_000, shippingMargin: 2_000, shippingFee: 10_000 });
    expect(await db.select().from(order)).toHaveLength(1);
  });

  it("a store without a pickup area cannot take orders and the summary says so", async () => {
    const s = await makeStore("toko-a", { pickupArea: false });
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    expect(await checkoutSummary(db, cartId)).toMatchObject({ canShip: false, subtotal: 100_000 });
    await expect(placeOrder(db, cartId, buyer())).rejects.toMatchObject({ code: "no_pickup_area" });
    const ok = await makeStore("toko-b");
    const c2 = await setCartLine(ok.sf, undefined, { variantId: ok.variantId, quantity: 1 }, "add");
    expect(await checkoutSummary(db, c2)).toMatchObject({ canShip: true });
  });

  it("the database refuses a fee split that does not add up or negative parts", async () => {
    const s = await makeStore("toko-a");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer());
    for (const bad of [{ shippingMargin: 2_007 }, { shippingProviderCost: -1, shippingMargin: 17_501 }, { weightKg: 0 }]) {
      await expect(db.update(order).set(bad).where(eq(order.id, orderId))).rejects.toMatchObject({ cause: { constraint_name: "order_shipping_fee_chk" } });
    }
    await expect(db.update(order).set({ destinationAreaId: "x" }).where(eq(order.id, orderId))).rejects.toMatchObject({ cause: { constraint_name: "order_area_chk" } });
  });

  it("a provider outage is one retryable buyer message; area search validates the keyword", async () => {
    const s = await makeStore("toko-a");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const down: ShippingAdapter = {
      searchArea: () => Promise.reject(new MengantarError("timeout", "timed out")),
      estimate: () => Promise.reject(new MengantarError("http", "502", 502)),
    };
    const providers: Providers = { ...fakeProviders, shipping: down };
    await expect(placeOrder(db, cartId, buyer(), providers)).rejects.toMatchObject({ code: "provider", cause: { code: "http" } });
    await expect(searchDestinationAreas("bandung", down)).rejects.toMatchObject({ code: "provider" });
    await expect(searchDestinationAreas("ba", fakeMengantar)).rejects.toMatchObject({ code: "keyword" });
    expect(await searchDestinationAreas("jakarta", fakeMengantar)).toEqual([{ id: DESTINATION.destinationAreaId, label: DESTINATION.destinationAreaLabel }]);
    expect(await db.select().from(order)).toHaveLength(0);
    // Nothing selects the real client here: no MENGANTAR_API_KEY in the test process.
    expect(process.env.MENGANTAR_API_KEY).toBeUndefined();
    expect(defaultShippingAdapter()).toBe(fakeMengantar);
  });
});

describe("COD confirmation and risk (T-35, PR-19)", () => {
  const cartFor = (s: Awaited<ReturnType<typeof makeStore>>, qty = 1) => setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: qty }, "add");
  const codOrder = async (s: Awaited<ReturnType<typeof makeStore>>, over: Record<string, unknown> = {}, qty = 1) =>
    (await placeOrder(db, await cartFor(s, qty), buyer(over))).orderId;
  const stockOf = async (id: number) => (await db.select().from(variant).where(eq(variant.id, id)))[0]!.stock;

  it("COD starts in awaiting_confirmation (transfer does not); confirm and hold move it, with actor and notes", async () => {
    const s = await makeStore("toko-a");
    const id = await codOrder(s);
    const transfer = await codOrder(s, { paymentMethod: "manual_transfer" });
    expect((await getOrder(s.owner, id))!).toMatchObject({ status: "awaiting_confirmation", actions: ["confirm", "hold", "reject"], confirmedAt: null });
    expect((await getOrder(s.owner, transfer))!).toMatchObject({ status: "awaiting_payment", actions: ["pay", "cancel"], risk: [] });
    // Nothing else is allowed before confirmation (no booking/processing of an unconfirmed COD order).
    for (const a of ["process", "ship", "cancel", "pay"] as const) {
      await expect(transitionOrder(s.owner, id, a, a === "ship" ? { trackingNumber: "X-1" } : { reason: "uji aksi lain" })).rejects.toMatchObject({ code: "invalid_transition" });
    }
    await expect(transitionOrder(s.owner, id, "hold", { reason: "" })).rejects.toMatchObject({ name: "ZodError" });
    expect(await transitionOrder(s.owner, id, "hold", { reason: "Nomor belum bisa dihubungi" })).toBe("on_hold");
    expect((await getOrder(s.owner, id))!.actions).toEqual(["confirm", "reject"]);
    await expect(transitionOrder(s.owner, id, "hold", { reason: "dua kali" })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await transitionOrder(s.owner, id, "confirm")).toBe("placed");
    const o = (await getOrder(s.owner, id))!;
    expect(o.confirmedAt).toBeInstanceOf(Date);
    expect(o.actions).toEqual(["process", "cancel"]);
    expect(o.risk).toEqual([]); // only shown while confirming
    expect(o.history.map((h) => [h.fromStatus, h.toStatus, h.note])).toEqual([
      ["awaiting_confirmation", "on_hold", "Nomor belum bisa dihubungi"],
      ["on_hold", "placed", "Pesanan COD dikonfirmasi oleh penjual"],
    ]);
    // The database refuses a confirmation state on a transfer order.
    await expect(db.update(order).set({ status: "awaiting_confirmation" }).where(eq(order.id, transfer))).rejects.toMatchObject({ cause: { constraint_name: "order_cod_state_chk" } });
  });

  it("reject cancels and restocks exactly once, also when it races a confirm; staff may do it, another store may not", async () => {
    const s = await makeStore("toko-a", { stock: 10 });
    const other = await makeStore("toko-b");
    const id = await codOrder(s, {}, 3);
    expect(await stockOf(s.variantId)).toBe(7);
    await expect(transitionOrder(other.owner, id, "reject", { reason: "bukan pesanan saya" })).rejects.toMatchObject({ code: "not_found" });
    await expect(transitionOrder(s.owner, id, "reject", { reason: "" })).rejects.toMatchObject({ name: "ZodError" });

    const settled = await Promise.allSettled([
      transitionOrder(s.owner, id, "reject", { reason: "Pembeli tidak mengakui pesanan" }),
      transitionOrder(s.owner, id, "confirm"),
      transitionOrder(s.owner, id, "reject", { reason: "Ditolak dua kali" }),
    ]);
    const ok = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value as string] : []));
    // Either reject wins (confirm + other reject rejected) or confirm wins and both rejects are invalid from `placed`.
    expect(ok.length).toBe(1);
    expect(settled.filter((r) => r.status === "rejected").every((r) => r.reason.code === "invalid_transition")).toBe(true);
    const final = (await getOrder(s.owner, id))!;
    if (ok[0] === "cancelled") {
      expect(final.status).toBe("cancelled");
      expect(await stockOf(s.variantId)).toBe(10);
      const moves = await db.select().from(stockAdjustment).where(eq(stockAdjustment.orderId, id));
      expect(moves).toEqual([expect.objectContaining({ delta: 3, reason: expect.stringMatching(/^Penolakan pesanan COD #\d+: /) })]);
      expect(final.actions).toEqual([]);
    } else {
      expect(final.status).toBe("placed");
      expect(await stockOf(s.variantId)).toBe(7);
    }
    expect(final.history).toHaveLength(1);

    // Staff can reject too; a rejected order cannot be cancelled again (single restock).
    const staffId = await makeUser("staff");
    await db.insert(membership).values({ storeId: s.storeId, userId: staffId, role: "staff" });
    const id2 = await codOrder(s, {}, 2);
    expect(await transitionOrder(await seller(staffId), id2, "reject", { reason: "Alamat palsu" })).toBe("cancelled");
    await expect(transitionOrder(s.owner, id2, "cancel", { reason: "batal lagi" })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await stockOf(s.variantId)).toBe(ok[0] === "cancelled" ? 10 : 7);
  });

  it("risk reasons: repeat cancelled/unconfirmed phone (store-scoped), address completeness, amount vs store median", async () => {
    const a = await makeStore("toko-a", { price: 100_000, stock: 100 });
    const b = await makeStore("toko-b", { price: 100_000, stock: 100 });
    const phone = "+6281299990000"; // same number as 081299990000 after normalisation
    // Store A history: three confirmed COD orders at 100k set the median; two orders of the risky phone rejected.
    for (let i = 0; i < 3; i++) await transitionOrder(a.owner, await codOrder(a, { buyerPhone: `08123400000${i}` }), "confirm");
    for (let i = 0; i < 2; i++) await transitionOrder(a.owner, await codOrder(a, { buyerPhone: "081299990000" }), "reject", { reason: "Pembeli menolak paket" });
    // Store B: the same phone cancelled there must not leak into A (Q-14).
    await transitionOrder(b.owner, await codOrder(b, { buyerPhone: phone }), "reject", { reason: "uji isolasi" });
    expect(addressIncomplete("Jl. Merdeka No. 1 RT 02 RW 05, Bandung 40111")).toBe(false);
    expect(addressIncomplete("Gang Mawar dekat masjid, Bandung")).toBe(true); // no number
    expect(addressIncomplete("Jl. Kenanga 5")).toBe(true); // too short

    const risky = await codOrder(a, { buyerPhone: phone, shippingAddress: "Gang Mawar dekat masjid, Bandung" }, 3); // 300k vs median 100k
    const pending = await codOrder(a, { buyerPhone: "081299990000" }); // another unconfirmed order of the same phone
    const r = (await getOrder(a.owner, risky))!.risk;
    expect(r.map((x) => x.code)).toEqual(["repeat_cancelled", "repeat_unconfirmed", "address_incomplete", "high_amount"]);
    expect(r[0]!.message).toContain("2 pesanan sebelumnya");
    expect(r[1]!.message).toContain("1 pesanan lain");
    expect(r[3]!.message).toContain("Rp 317.500"); // 300_000 + 17_500 ongkir
    expect(r[3]!.message).toContain("Rp 117.500"); // median of the store's other COD orders

    // A clean order shows nothing; a non-COD order has no risk block at all.
    const clean = await codOrder(a, { buyerPhone: "081200001111" });
    expect((await getOrder(a.owner, clean))!.risk).toEqual([]);
    expect((await getOrder(a.owner, pending))!.risk.map((x) => x.code)).toEqual(["repeat_cancelled", "repeat_unconfirmed"]);
    // Store B sees only its own history for the same phone.
    const inB = await codOrder(b, { buyerPhone: "081299990000" });
    expect((await getOrder(b.owner, inB))!.risk.map((x) => x.code)).toEqual(["repeat_cancelled"]);
    expect((await getOrder(b.owner, inB))!.risk[0]!.message).toContain("1 pesanan sebelumnya");
  });
});

describe("abuse controls (T-30, SEC-16)", () => {
  const cartFor = (s: Awaited<ReturnType<typeof makeStore>>, qty = 1) => setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: qty }, "add");

  it("fixed-window counter: exact boundary, independent keys, a new window after the old one ends", async () => {
    const rule = { limit: 3, windowSec: 60 };
    for (let i = 1; i <= 3; i++) expect((await hit(db, "t:a", rule)).count).toBe(i);
    const fourth = await hit(db, "t:a", rule);
    expect(fourth.count).toBe(4);
    expect(fourth.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(fourth.retryAfterSec).toBeLessThanOrEqual(60);
    expect((await hit(db, "t:b", rule)).count).toBe(1); // other key untouched
    await expect(enforceLimits(db, [{ key: "t:a", rule }])).rejects.toMatchObject({ code: "rate_limited", message: expect.stringMatching(/^Terlalu banyak percobaan\. Coba lagi dalam \d+ detik\.$/) });
    await expect(enforceLimits(db, [{ key: "t:b", rule }])).resolves.toBeUndefined();
    // Time travel: move the window into the past → the next hit opens a fresh window.
    await db.update(rateLimit).set({ windowStart: sql`${rateLimit.windowStart} - interval '2 minutes'` });
    expect((await hit(db, "t:a", rule)).count).toBe(1);
    // The IP rule boundary (60 per 10 min) holds exactly.
    for (let i = 1; i <= LIMITS.orderIp.limit; i++) await enforceLimits(db, [{ key: "order:ip:203.0.113.7", rule: LIMITS.orderIp }]);
    await expect(enforceLimits(db, [{ key: "order:ip:203.0.113.7", rule: LIMITS.orderIp }])).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("order submission is limited per cart (attempts) and per phone (across carts); failures count, invalid input does not", async () => {
    const s = await makeStore("toko-a", { stock: 50 });
    const cartId = await cartFor(s);
    // 5 failing attempts on one cart (COD on a courier that refuses it), then the 6th is refused before quoting.
    for (let i = 0; i < LIMITS.orderCart.limit; i++) await expect(placeOrder(db, cartId, buyer({ courier: "SiCepat" }))).rejects.toMatchObject({ code: "courier_cod" });
    await expect(placeOrder(db, cartId, buyer())).rejects.toMatchObject({ code: "rate_limited" });
    // Garbage input never reaches the counters.
    await expect(placeOrder(db, cartId, buyer({ buyerPhone: "abc" }))).rejects.toMatchObject({ name: "ZodError" });
    expect(await db.select().from(rateLimit).where(eq(rateLimit.key, `order:cart:${cartId}`))).toMatchObject([{ count: 6 }]);
    expect(await db.select().from(order)).toHaveLength(0);

    // Same phone on fresh carts: 10 orders are fine, the 11th is refused.
    const phone = "0812-7777-0000".replaceAll("-", "");
    for (let i = 0; i < LIMITS.orderPhone.limit; i++) await placeOrder(db, await cartFor(s), buyer({ buyerPhone: i % 2 ? phone : `+62${phone.slice(1)}` }));
    await expect(placeOrder(db, await cartFor(s), buyer({ buyerPhone: phone }))).rejects.toMatchObject({ code: "rate_limited" });
    expect(await db.select().from(order)).toHaveLength(LIMITS.orderPhone.limit);
    // A different phone still gets through; with a known client IP the IP key is counted too.
    await expect(placeOrder(db, await cartFor(s), buyer({ buyerPhone: "081200009999" }), fakeProviders, { clientIp: "203.0.113.9" })).resolves.toMatchObject({ replayed: false });
    expect(await db.select().from(rateLimit).where(eq(rateLimit.key, "order:ip:203.0.113.9"))).toMatchObject([{ count: 1 }]);
    expect((await db.select().from(rateLimit)).some((r) => r.key.startsWith("order:ip:") && r.key !== "order:ip:203.0.113.9")).toBe(false); // no IP → no IP key
    // Cart mutation limiter: per IP and per cart keys.
    for (let i = 0; i < LIMITS.cartCart.limit; i++) await limitCartMutation(db, { clientIp: "198.51.100.1", cartId });
    await expect(limitCartMutation(db, { clientIp: "198.51.100.1", cartId })).rejects.toMatchObject({ code: "rate_limited" });
    await expect(limitCartMutation(db, { clientIp: "198.51.100.1" })).resolves.toBeUndefined();
    await expect(limitCartMutation(db, {})).resolves.toBeUndefined(); // nothing to count without IP or cart
  });

  it("a cart holds at most 30 distinct variants; existing lines still change; quantity stays capped at 99", async () => {
    const s = await makeStore("toko-a", { stock: 100 });
    const variants = [s.variantId];
    for (let i = 0; i < CART_MAX_LINES; i++) variants.push(await addVariant(s.owner, s.productId, { title: `V${i}`, price: 1_000, stock: 100 }));
    let cartId: string | undefined;
    for (const v of variants.slice(0, CART_MAX_LINES)) cartId = await setCartLine(s.sf, cartId, { variantId: v, quantity: 1 }, "add");
    await expect(setCartLine(s.sf, cartId, { variantId: variants[CART_MAX_LINES], quantity: 1 }, "add")).rejects.toMatchObject({ code: "cart_full" });
    expect((await getCart(s.sf, cartId)).lines).toHaveLength(CART_MAX_LINES);
    // Changing or removing an existing line is still allowed; a freed slot can be used again.
    await setCartLine(s.sf, cartId, { variantId: s.variantId, quantity: 7 }, "set");
    await setCartLine(s.sf, cartId, { variantId: variants[1], quantity: 0 }, "set");
    await setCartLine(s.sf, cartId, { variantId: variants[CART_MAX_LINES], quantity: 1 }, "add");
    expect((await getCart(s.sf, cartId)).lines).toHaveLength(CART_MAX_LINES);
    await expect(setCartLine(s.sf, cartId, { variantId: s.variantId, quantity: 100 }, "set")).rejects.toMatchObject({ name: "ZodError" });
    // "add" saturates at 99 (existing rule).
    await setCartLine(s.sf, cartId, { variantId: s.variantId, quantity: 99 }, "add");
    expect((await getCart(s.sf, cartId)).lines.find((l) => l.variantId === s.variantId)!.quantity).toBe(99);
  });

  it("cleanup deletes only open carts older than the idle age (lines cascade) and old counters; checked-out carts stay", async () => {
    const s = await makeStore("toko-a");
    const oldOpen = await cartFor(s);
    const oldOrdered = await cartFor(s);
    const fresh = await cartFor(s);
    const edge = await cartFor(s);
    await placeOrder(db, oldOrdered, buyer());
    const age = (id: string, hours: number) => db.update(cart).set({ createdAt: sql`now() - ${hours} * interval '1 hour'` }).where(eq(cart.id, id));
    await age(oldOpen, 169);
    await age(oldOrdered, 500);
    await age(edge, 167);
    await hit(db, "old", { limit: 1, windowSec: 60 });
    await db.update(rateLimit).set({ windowStart: sql`now() - interval '25 hours'` }).where(eq(rateLimit.key, "old"));
    await hit(db, "recent", { limit: 1, windowSec: 60 });

    await expect(cleanupIdleCarts(db, { idleHours: 0 })).rejects.toMatchObject({ code: "idle_hours" });
    expect(await cleanupIdleCarts(db, { idleHours: 168 })).toEqual({ carts: 1, counters: 1 });
    const remaining = (await db.select({ id: cart.id }).from(cart)).map((c) => c.id).sort();
    expect(remaining).toEqual([oldOrdered, fresh, edge].sort());
    expect(await db.select().from(cartLine).where(eq(cartLine.cartId, oldOpen))).toEqual([]);
    const keys = (await db.select().from(rateLimit)).map((r) => r.key);
    expect(keys).not.toContain("old");
    expect(keys).toContain("recent"); // current-window counters (incl. the order's own) stay
    // The order and its lines are intact; the buyer can still open the outcome.
    expect(await getBuyerOrder(db, (await db.select().from(order))[0]!.id, oldOrdered)).not.toBeNull();
    // Idempotent: nothing left to delete.
    expect(await cleanupIdleCarts(db, { idleHours: 168 })).toEqual({ carts: 0, counters: 0 });
  });
});
