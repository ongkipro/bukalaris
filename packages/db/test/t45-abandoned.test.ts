import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sweepCheckoutSessions } from "../src/seller/commerce/abandoned.ts";
import {
  abandonRates,
  ABANDON_WINDOW_DAYS,
  captureCheckoutSession,
  CAPTURE_LIMITS,
  CHECKOUT_SESSION_IDLE_MINUTES,
  CHECKOUT_SESSION_PURGE_DAYS,
  decayedValue,
  getAbandonedCarts,
  openWhatsAppRecovery,
  rankAbandoned,
  recoveryMessage,
  RESUME_LINK_DAYS,
  resumeCheckout,
  resumeKeyring,
  signResumeToken,
  verifyResumeToken,
} from "../src/seller/commerce/abandoned.ts";
import { cleanupIdleCarts, placeOrder } from "../src/seller/commerce/checkout.ts";
import { exportBuyerData, findBuyerOrders, REDACTED, redactCheckoutSessions, redactOrders } from "../src/seller/commerce/privacy.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import { cart, checkoutSession, membership, rateLimit } from "../src/schema.ts";
import { BILLING_READ_ONLY_ALLOWED, SELLER_CAPABILITIES, can } from "../src/platform/scoped.ts";
import { withStore } from "../src/platform/tenant.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { deliver } from "./deliver.ts";
import { admin, buyer, db, makeStore, makeUser, platform, seller } from "./helpers.ts";
import { billingStore, billingTestSetup } from "./t50-fixtures.ts";

// T-45 (PR-25, DATA-8, UX-15, PRIV-1): capture, sweep, recovery, rates, ranking, signed resume link, seller queue, export and redaction.
// Services run as bukalaris_app inside the store's RLS context; `platform` is the cleanup/worker pool; `admin` only ages rows (time travel).

billingTestSetup();
const DAY = 86_400_000;
const PHONE = "081234567890";
type Store = Awaited<ReturnType<typeof makeStore>>;

async function newCart(s: Store, quantity = 2) {
  return setCartLine(s.sf, undefined, { variantId: s.variantId, quantity }, "add");
}
const typed = (over: Record<string, string> = {}) => ({ buyerName: "Budi Santoso", buyerPhone: PHONE, buyerEmail: "budi@example.com", shippingAddress: "Jl. Merdeka No. 1, Bandung 40111", ...over });
async function session(s: Store, over: Record<string, string> = {}, quantity = 2) {
  const cartId = await newCart(s, quantity);
  const r = await captureCheckoutSession(db, cartId, typed(over));
  expect(r.saved).toBe(true);
  const [row] = await platform.select().from(checkoutSession).where(eq(checkoutSession.cartId, cartId));
  return { cartId, row: row! };
}
const rowOf = async (id: number) => (await platform.select().from(checkoutSession).where(eq(checkoutSession.id, id)))[0]!;
const age = (id: number, minutes: number) => admin.execute(sql`update checkout_session set updated_at = now() - ${minutes} * interval '1 minute' where id = ${id}`);
/** Time travel of `created_at` (immutable under the guard): the owner-side fixture disables the trigger for one statement. */
async function backdateCreated(ids: number[], interval: string) {
  await admin.execute(sql`alter table checkout_session disable trigger checkout_session_guard`);
  try {
    await admin.execute(sql`update checkout_session set created_at = now() - ${interval}::interval where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  } finally {
    await admin.execute(sql`alter table checkout_session enable trigger checkout_session_guard`);
  }
}
async function abandon(id: number, minutes = CHECKOUT_SESSION_IDLE_MINUTES + 1) {
  await age(id, minutes);
  await sweepCheckoutSessions(platform);
  return rowOf(id);
}
const code = (p: Promise<unknown>) => p.then(() => "allowed", (e: { code?: string; cause?: { code?: string; message?: string }; message?: string }) => e.code ?? e.cause?.code ?? e.message);
const origin = "https://checkout.example.test";

describe("rates math (UX-15)", () => {
  const table: { name: string; in: { abandoned: number; rescued: number; orders: number }; out: { abandonBps: number | null; recoveryBps: number | null } }[] = [
    { name: "no data at all is not 0 %", in: { abandoned: 0, rescued: 0, orders: 0 }, out: { abandonBps: null, recoveryBps: null } },
    { name: "only straight-through orders: nothing abandoned, no recovery denominator", in: { abandoned: 0, rescued: 0, orders: 40 }, out: { abandonBps: 0, recoveryBps: null } },
    { name: "abandoned / (abandoned + orders)", in: { abandoned: 10, rescued: 0, orders: 30 }, out: { abandonBps: 2500, recoveryBps: 0 } },
    { name: "rescued / (rescued + abandoned)", in: { abandoned: 6, rescued: 2, orders: 10 }, out: { abandonBps: 3750, recoveryBps: 2500 } },
    { name: "every abandoned checkout rescued", in: { abandoned: 0, rescued: 5, orders: 9 }, out: { abandonBps: 0, recoveryBps: 10_000 } },
    { name: "rounds half up to a basis point (1/3, 2/3)", in: { abandoned: 1, rescued: 0, orders: 2 }, out: { abandonBps: 3333, recoveryBps: 0 } },
    { name: "2/3", in: { abandoned: 2, rescued: 0, orders: 1 }, out: { abandonBps: 6667, recoveryBps: 0 } },
    { name: "all abandoned, none ordered", in: { abandoned: 7, rescued: 0, orders: 0 }, out: { abandonBps: 10_000, recoveryBps: 0 } },
  ];
  it.each(table)("$name", ({ in: i, out }) => expect(abandonRates(i)).toEqual(out));

  it("the task's constants: 60 idle minutes, 30-day purge, 30-day rate window, 7-day link", () => {
    expect([CHECKOUT_SESSION_IDLE_MINUTES, CHECKOUT_SESSION_PURGE_DAYS, ABANDON_WINDOW_DAYS, RESUME_LINK_DAYS]).toEqual([60, 30, 30, 7]);
  });
});

describe("ranking (UX-15: phone presence, then subtotal / (1 + minutes_ago / 1440))", () => {
  it.each([
    [100_000, 0, 100_000],
    [100_000, 1440, 50_000],
    [100_000, 2880, 100_000 / 3],
    [100_000, -30, 100_000], // a future timestamp is "just now"
    [0, 500, 0],
  ])("decayedValue(%i, %i min) = %d", (subtotal, minutes, expected) => expect(decayedValue(subtotal, minutes)).toBeCloseTo(expected, 6));

  const now = new Date("2026-10-28T12:00:00Z");
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
  it("a row with a usable phone outranks any row without one; within a group the decayed value decides; ties fall to the newest id", () => {
    const rows = [
      { id: 1, buyerPhone: null, subtotalIdr: 5_000_000, updatedAt: at(10) }, // big but no phone
      { id: 2, buyerPhone: "081234567890", subtotalIdr: 100_000, updatedAt: at(10) },
      { id: 3, buyerPhone: "081234567891", subtotalIdr: 100_000, updatedAt: at(10 + 1440) }, // half the value after one day
      { id: 4, buyerPhone: "081234567892", subtotalIdr: 150_000, updatedAt: at(10 + 1440) }, // 150k decayed to 75k, beats id 3 (50k)
      { id: 5, buyerPhone: "123", subtotalIdr: 9_000_000, updatedAt: at(10) }, // not a usable number: counts as no phone
      { id: 6, buyerPhone: REDACTED, subtotalIdr: 9_000_000, updatedAt: at(10) },
      { id: 7, buyerPhone: "081234567893", subtotalIdr: 100_000, updatedAt: at(10) }, // same score as id 2
    ];
    const ranked = rankAbandoned(rows, now);
    expect(ranked.map((r) => r.id)).toEqual([7, 2, 4, 3, 6, 5, 1]);
    expect(ranked.map((r) => r.hasPhone)).toEqual([true, true, true, true, false, false, false]);
  });
});

describe("capture from hosted checkout (PR-25, PRIV-1)", () => {
  it("stores nothing until the buyer typed something: an empty form, an empty cart and an unknown cart create no row", async () => {
    const s = await makeStore("cap-empty");
    const cartId = await newCart(s);
    expect(await captureCheckoutSession(db, cartId, { buyerName: "", buyerPhone: "  ", buyerEmail: "", shippingAddress: "" })).toEqual({ saved: false });
    expect(await captureCheckoutSession(db, cartId, {})).toEqual({ saved: false });
    expect(await captureCheckoutSession(db, undefined, typed())).toEqual({ saved: false });
    expect(await captureCheckoutSession(db, "not-a-cart", typed())).toEqual({ saved: false });
    expect(await captureCheckoutSession(db, "11111111-1111-4111-8111-111111111111", typed())).toEqual({ saved: false });
    const emptyCart = (await platform.insert(cart).values({ storeId: s.storeId }).returning({ id: cart.id }))[0]!.id;
    expect(await captureCheckoutSession(db, emptyCart, typed())).toEqual({ saved: false });
    expect(await platform.select().from(checkoutSession)).toEqual([]);
    // Only the four contact fields cross the boundary.
    await expect(captureCheckoutSession(db, cartId, { ...typed(), subtotalIdr: 1, storeId: 99 })).rejects.toThrow();
  });

  it("one row per cart, updated in place; the subtotal comes from the cart rows (never the client); invalid phone and e-mail are NULL while the buyer is still typing", async () => {
    const s = await makeStore("cap-upsert");
    const cartId = await newCart(s, 3);
    expect((await captureCheckoutSession(db, cartId, { buyerName: "Bu", buyerPhone: "0812" })).saved).toBe(true);
    let [row] = await platform.select().from(checkoutSession);
    expect(row).toMatchObject({ storeId: s.storeId, cartId, status: "active", buyerName: "Bu", buyerPhone: null, buyerEmail: null, shippingAddress: null, subtotalIdr: 300_000, abandonedAt: null, recoveredAt: null, waOpenedAt: null });
    const first = row!.updatedAt;
    await captureCheckoutSession(db, cartId, typed({ buyerEmail: "Budi@Example.COM" }));
    await setCartLine(s.sf, cartId, { variantId: s.variantId, quantity: 4 }, "set");
    await captureCheckoutSession(db, cartId, typed({ buyerEmail: "Budi@Example.COM" }));
    const all = await platform.select().from(checkoutSession);
    expect(all.length).toBe(1);
    row = all[0];
    expect(row).toMatchObject({ buyerName: "Budi Santoso", buyerPhone: PHONE, buyerEmail: "budi@example.com", subtotalIdr: 400_000 });
    expect(row!.updatedAt.getTime()).toBeGreaterThan(first.getTime());
    // Clearing every field is a capture too (the buyer withdrew what they typed).
    await captureCheckoutSession(db, cartId, {});
    expect(await rowOf(row!.id)).toMatchObject({ buyerName: null, buyerPhone: null, buyerEmail: null, shippingAddress: null });
  });

  it("is store-scoped: the session carries the cart's store, never a caller's; a session cannot be written for another store under RLS", async () => {
    const a = await makeStore("cap-a");
    const b = await makeStore("cap-b");
    const inB = await session(b);
    expect(inB.row.storeId).toBe(b.storeId);
    expect((await platform.select().from(checkoutSession).where(eq(checkoutSession.storeId, a.storeId))).length).toBe(0);
    // Store A's context sees nothing of B, cannot update B's row and cannot insert a row for B.
    await withStore(db, a.storeId, async (tx) => {
      expect(await tx.select().from(checkoutSession)).toEqual([]);
      expect(await tx.update(checkoutSession).set({ buyerName: "x" }).where(eq(checkoutSession.id, inB.row.id)).returning({ id: checkoutSession.id })).toEqual([]);
    });
    await expect(withStore(db, a.storeId, (tx) => tx.insert(checkoutSession).values({ storeId: b.storeId, cartId: inB.cartId }))).rejects.toThrow();
    // No store context at all: the app role sees no session (fail closed).
    expect(await db.select().from(checkoutSession)).toEqual([]);
    expect((await rowOf(inB.row.id)).buyerName).toBe("Budi Santoso");
  });

  it("is rate limited per cart and a refused capture is dropped silently", async () => {
    const s = await makeStore("cap-limit");
    const cartId = await newCart(s);
    expect((await captureCheckoutSession(db, cartId, typed())).saved).toBe(true);
    await platform.update(rateLimit).set({ count: CAPTURE_LIMITS.cart.limit }).where(eq(rateLimit.key, `capture:cart:${cartId}`));
    expect(await captureCheckoutSession(db, cartId, typed({ buyerName: "Lain" }))).toEqual({ saved: false });
    expect((await platform.select().from(checkoutSession))[0]!.buyerName).toBe("Budi Santoso");
  });

  it("a store that is not active takes no capture", async () => {
    const s = await makeStore("cap-susp");
    const cartId = await newCart(s);
    await admin.execute(sql`update store set status = 'suspended' where id = ${s.storeId}`);
    expect(await captureCheckoutSession(db, cartId, typed())).toEqual({ saved: false });
  });
});

describe("sweep, purge and the transition guard (60 minutes, 30 days)", () => {
  it("sweeps only sessions idle for >= 60 minutes, stamps abandoned_at once and changes nothing on a second run", async () => {
    const s = await makeStore("sw-a");
    const fresh = await session(s);
    const edge = await session(s, { buyerPhone: "081234567891" });
    const idle = await session(s, { buyerPhone: "081234567892" });
    await age(fresh.row.id, 30);
    await age(edge.row.id, 59);
    await age(idle.row.id, 60);
    const out = await sweepCheckoutSessions(platform);
    expect(out).toEqual({ abandoned: 1, purged: 0 });
    expect((await rowOf(fresh.row.id)).status).toBe("active");
    expect((await rowOf(edge.row.id)).status).toBe("active");
    const swept = await rowOf(idle.row.id);
    expect(swept).toMatchObject({ status: "abandoned", recoveredAt: null });
    expect(swept.abandonedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(swept.updatedAt.getTime()).toBeLessThan(Date.now() - 59 * 60_000); // the sweep is not buyer activity
    expect(await sweepCheckoutSessions(platform)).toEqual({ abandoned: 0, purged: 0 });
    expect(await rowOf(idle.row.id)).toEqual(swept);
  });

  it("the database refuses an abandonment before 60 idle minutes, whoever asks", async () => {
    const s = await makeStore("sw-guard");
    const { row } = await session(s);
    expect(await code(Promise.resolve(admin.execute(sql`update checkout_session set status = 'abandoned' where id = ${row.id}`)))).toBe("23514");
    expect(await code(Promise.resolve(platform.update(checkoutSession).set({ status: "abandoned" }).where(eq(checkoutSession.id, row.id))))).toBe("23514");
    await age(row.id, 59);
    expect(await code(Promise.resolve(platform.update(checkoutSession).set({ status: "abandoned" }).where(eq(checkoutSession.id, row.id))))).toBe("23514");
    await age(row.id, 61);
    expect(await code(Promise.resolve(platform.update(checkoutSession).set({ status: "abandoned" }).where(eq(checkoutSession.id, row.id))))).toBe("allowed");
    expect((await rowOf(row.id)).abandonedAt).not.toBeNull();
  });

  it("stamps are monotonic and written by the database: a caller cannot set, move or clear them, and recovered is final", async () => {
    const s = await makeStore("sw-stamps");
    const { row } = await session(s);
    const swept = await abandon(row.id);
    const t = new Date("2020-01-01T00:00:00Z");
    for (const patch of [{ abandonedAt: t }, { abandonedAt: null }, { recoveredAt: t }, { createdAt: t }, { publicId: "11111111-1111-4111-8111-111111111111" }, { cartId: "22222222-2222-4222-8222-222222222222" }]) {
      expect(await code(Promise.resolve(platform.update(checkoutSession).set(patch).where(eq(checkoutSession.id, row.id))))).not.toBe("allowed");
    }
    expect(await rowOf(row.id)).toEqual(swept);
    // an active session cannot be given an abandonment stamp directly
    const other = await session(s, { buyerPhone: "081234567891" });
    expect(await code(Promise.resolve(platform.update(checkoutSession).set({ abandonedAt: t }).where(eq(checkoutSession.id, other.row.id))))).toBe("23514");
    // returning buyer: a new capture reopens the session and keeps the stamp
    expect((await captureCheckoutSession(db, swept.cartId, typed())).saved).toBe(true);
    const back = await rowOf(row.id);
    expect(back).toMatchObject({ status: "active", abandonedAt: swept.abandonedAt });
    // ...but a bare status flip without activity does not
    await abandon(row.id);
    expect(await code(Promise.resolve(platform.update(checkoutSession).set({ status: "active" }).where(eq(checkoutSession.id, row.id))))).toBe("23514");
    // recovery: the real path is the order transaction (covered by the recovery tests); a login role without an order of the cart is refused (wave 5 review), the owner fixture is not
    expect(await code(Promise.resolve(platform.update(checkoutSession).set({ status: "recovered" }).where(eq(checkoutSession.id, row.id))))).toBe("23514");
    await admin.update(checkoutSession).set({ status: "recovered" }).where(eq(checkoutSession.id, row.id));
    const done = await rowOf(row.id);
    expect(done.recoveredAt).not.toBeNull();
    expect(done.abandonedAt).toEqual(swept.abandonedAt);
    for (const patch of [{ status: "active" as const }, { status: "abandoned" as const }, { recoveredAt: null }, { abandonedAt: null }]) {
      expect(await code(Promise.resolve(platform.update(checkoutSession).set(patch).where(eq(checkoutSession.id, row.id))))).not.toBe("allowed");
    }
    // a new session starts active and unstamped
    const cartId = await newCart(s);
    expect(await code(Promise.resolve(admin.insert(checkoutSession).values({ storeId: s.storeId, cartId, status: "abandoned", abandonedAt: t })))).toBe("23514");
    expect(await code(Promise.resolve(platform.insert(checkoutSession).values({ storeId: s.storeId, cartId })))).toBe("42501"); // the platform role never inserts: only checkout capture does, as the app role
  });

  it("purges sessions created more than 30 days ago (and only those), in any state; the app role can never delete", async () => {
    const s = await makeStore("sw-purge");
    const young = await session(s);
    const old = await session(s, { buyerPhone: "081234567891" });
    const oldAbandoned = await session(s, { buyerPhone: "081234567892" });
    await abandon(oldAbandoned.row.id);
    await backdateCreated([young.row.id], "29 days 23 hours");
    await backdateCreated([old.row.id, oldAbandoned.row.id], "30 days 1 hour");
    const out = await sweepCheckoutSessions(platform);
    expect(out.purged).toBe(2);
    expect((await platform.select({ id: checkoutSession.id }).from(checkoutSession)).map((r) => r.id)).toEqual([young.row.id]);
    expect(await code(withStore(db, s.storeId, (tx) => tx.delete(checkoutSession).where(eq(checkoutSession.id, young.row.id))))).toBe("42501");
    expect((await rowOf(young.row.id)).id).toBe(young.row.id);
  });

  it("an idle cart cleanup keeps a cart that a session still references and removes it once the session is purged", async () => {
    const s = await makeStore("sw-cart");
    const { cartId, row } = await session(s);
    await admin.execute(sql`update cart set created_at = now() - interval '40 days'`);
    expect((await cleanupIdleCarts(platform, { idleHours: 24 })).carts).toBe(0);
    expect((await platform.select().from(cart).where(eq(cart.id, cartId))).length).toBe(1);
    await backdateCreated([row.id], "31 days");
    await sweepCheckoutSessions(platform);
    expect((await cleanupIdleCarts(platform, { idleHours: 24 })).carts).toBe(1);
  });
});

describe("recovery marks the session when the order completes", () => {
  it("a swept session becomes recovered with recovered_at set, abandoned_at kept and the typed copy dropped; a straight-through one is recovered but never rescued", async () => {
    const s = await makeStore("rec-a");
    const swept = await session(s);
    const sweptRow = await abandon(swept.row.id);
    const direct = await session(s, { buyerPhone: "081234567891" });
    for (const c of [swept.cartId, direct.cartId]) await placeOrder(db, c, buyer({ buyerPhone: PHONE }));

    const r1 = await rowOf(swept.row.id);
    expect(r1).toMatchObject({ status: "recovered", abandonedAt: sweptRow.abandonedAt, buyerName: null, buyerPhone: null, buyerEmail: null, shippingAddress: null });
    expect(r1.recoveredAt!.getTime()).toBeGreaterThan(sweptRow.abandonedAt!.getTime() - 1);
    const r2 = await rowOf(direct.row.id);
    expect(r2).toMatchObject({ status: "recovered", abandonedAt: null });
    expect(r2.recoveredAt).not.toBeNull();

    // Honest rates: two orders, one swept-then-rescued session; the straight-through session is no rescue.
    const view = await getAbandonedCarts(s.owner);
    expect(view.counts).toEqual({ abandoned: 0, rescued: 1, orders: 2 });
    expect(view.rates).toEqual({ abandonBps: 0, recoveryBps: 10_000 });
    expect(view.queue).toEqual([]);
  });

  it("only the order's own cart is matched: another buyer's session (same store, same phone) stays abandoned", async () => {
    const s = await makeStore("rec-b");
    const ours = await session(s);
    const theirs = await session(s, { buyerName: "Orang Lain" });
    await abandon(ours.row.id);
    await abandon(theirs.row.id);
    await placeOrder(db, ours.cartId, buyer());
    expect((await rowOf(ours.row.id)).status).toBe("recovered");
    expect((await rowOf(theirs.row.id)).status).toBe("abandoned");
  });

  it("an idempotent replay of the same order changes nothing", async () => {
    const s = await makeStore("rec-c");
    const a = await session(s);
    const input = buyer();
    await placeOrder(db, a.cartId, input);
    const first = await rowOf(a.row.id);
    expect((await placeOrder(db, a.cartId, input)).replayed).toBe(true);
    expect(await rowOf(a.row.id)).toEqual(first);
  });
});

describe("Seller Admin queue and WhatsApp recovery (SC-26)", () => {
  it("shows this store's rates and ranked queue; active sessions are in neither count; a foreign store sees none of it", async () => {
    const a = await makeStore("q-a");
    const b = await makeStore("q-b");
    const noPhone = await session(a, { buyerPhone: "" }, 5);
    const small = await session(a, { buyerPhone: "081234567891" }, 1);
    const big = await session(a, { buyerPhone: "081234567892" }, 4);
    const active = await session(a, { buyerPhone: "081234567893" });
    const foreign = await session(b, { buyerPhone: "081234567894" });
    for (const x of [noPhone, small, big, foreign]) await abandon(x.row.id);
    await placeOrder(db, await newCart(a), buyer({ buyerPhone: "089900001111" })); // one ordinary order

    const view = await getAbandonedCarts(a.owner);
    expect(view.counts).toEqual({ abandoned: 3, rescued: 0, orders: 1 });
    expect(view.rates).toEqual({ abandonBps: 7500, recoveryBps: 0 });
    expect(view.queue.map((q) => q.id)).toEqual([big.row.id, small.row.id, noPhone.row.id]);
    expect(view.queue.map((q) => q.hasPhone)).toEqual([true, true, false]);
    expect(view.queue[0]).toMatchObject({ subtotalIdr: 400_000, buyerPhone: "081234567892", waOpenedAt: null });
    expect(view.queue[0]!.items).toEqual([{ title: "Kaos q-a", variant: "M", quantity: 4 }]);
    expect(view.queue.map((q) => q.id)).not.toContain(active.row.id);
    expect(view.queue.map((q) => q.id)).not.toContain(foreign.row.id);
    const other = await getAbandonedCarts(b.owner);
    expect(other.counts).toEqual({ abandoned: 1, rescued: 0, orders: 0 });
    expect(other.queue.map((q) => q.id)).toEqual([foreign.row.id]);
    // The window is 30 days from creation: an older (not yet purged) session and order are outside it.
    await backdateCreated([small.row.id], "31 days");
    expect((await getAbandonedCarts(a.owner)).counts.abandoned).toBe(2);
  });

  it("opens wa.me with the number in the shared 62… key, a prefilled Indonesian message and a signed resume link, and records WA dibuka", async () => {
    const s = await makeStore("wa-a");
    const x = await session(s, { buyerName: "Siti Aminah", buyerPhone: "+62 812-3456-7890" });
    await abandon(x.row.id);
    const now = new Date();
    const r = await openWhatsAppRecovery(s.owner, x.row.id, { origin: `${origin}/`, now });
    const url = new URL(r.url);
    expect(url.origin + url.pathname).toBe("https://wa.me/6281234567890");
    const message = url.searchParams.get("text")!;
    expect(message).toContain("Halo Siti");
    expect(message).toContain("Toko wa-a");
    expect(message).toContain(r.resumeUrl);
    expect(message).not.toMatch(/terkirim|dikirim|pasti sampai|gratis|diskon/i); // no promise of delivery or price
    expect(r.resumeUrl.startsWith(`${origin}/checkout/r/v1.`)).toBe(true);
    expect(r.expiresAt.getTime()).toBe(Math.floor(now.getTime() / 1000) * 1000 + 7 * DAY);
    // The link never exposes the session's primary key or buyer data.
    const token = r.resumeUrl.split("/checkout/r/")[1]!;
    expect(token.split(".")[3]).not.toBe(String(x.row.id));
    expect(token.split(".")[3]).toBe(x.row.publicId);
    expect(token).not.toContain(PHONE);
    expect(recoveryMessage({ storeName: "T", buyerName: REDACTED, resumeUrl: "u" })).toMatch(/^Halo Kak,/);
    expect(recoveryMessage({ storeName: "T", buyerName: null, resumeUrl: "u" })).toMatch(/^Halo Kak,/);
    const stamped = await rowOf(x.row.id);
    expect(stamped.waOpenedAt).not.toBeNull();
    expect(stamped).toMatchObject({ status: "abandoned" });
    expect((await getAbandonedCarts(s.owner)).queue[0]!.waOpenedAt).not.toBeNull();
  });

  it("refuses without a usable phone, for a session that is active again or recovered, for a foreign store's id and for a bad id", async () => {
    const a = await makeStore("wa-b");
    const b = await makeStore("wa-c");
    const noPhone = await session(a, { buyerPhone: "" });
    const active = await session(a, { buyerPhone: "081234567891" });
    const foreign = await session(b, { buyerPhone: "081234567892" });
    await abandon(noPhone.row.id);
    await abandon(foreign.row.id);
    expect(await code(openWhatsAppRecovery(a.owner, noPhone.row.id, { origin }))).toBe("no_phone");
    expect(await code(openWhatsAppRecovery(a.owner, active.row.id, { origin }))).toBe("not_actionable");
    expect(await code(openWhatsAppRecovery(a.owner, foreign.row.id, { origin }))).toBe("not_found"); // another store's session id
    expect(await code(openWhatsAppRecovery(a.owner, 0, { origin }))).toBe("not_found");
    expect(await code(openWhatsAppRecovery(a.owner, Number.NaN, { origin }))).toBe("not_found");
    expect((await rowOf(foreign.row.id)).waOpenedAt).toBeNull();
    expect((await rowOf(noPhone.row.id)).waOpenedAt).toBeNull();
    // the buyer comes back between the list and the click: no stamp, no link
    const x = await session(a, { buyerPhone: "081234567893" });
    await abandon(x.row.id);
    await captureCheckoutSession(db, x.cartId, typed({ buyerPhone: "081234567893" }));
    expect(await code(openWhatsAppRecovery(a.owner, x.row.id, { origin }))).toBe("not_actionable");
    expect((await rowOf(x.row.id)).waOpenedAt).toBeNull();
  });

  it("capability map: owner and staff read and contact; reading stays open while the subscription is unpaid, contacting is refused", async () => {
    expect(SELLER_CAPABILITIES).toEqual(expect.arrayContaining(["carts.read", "carts.recover"]));
    expect(BILLING_READ_ONLY_ALLOWED).toContain("carts.read");
    expect(BILLING_READ_ONLY_ALLOWED).not.toContain("carts.recover"); // a stamp is a write
    const s = await billingStore("cap-map");
    const staffId = await makeUser("staff");
    await platform.insert(membership).values({ storeId: s.storeId, userId: staffId, role: "staff" });
    const staff = await seller(staffId, s.storeId);
    expect([can(s.owner, "carts.read"), can(s.owner, "carts.recover"), can(staff, "carts.read"), can(staff, "carts.recover")]).toEqual([true, true, true, true]);
    const x = await session(s);
    await abandon(x.row.id);
    expect((await getAbandonedCarts(staff)).queue.length).toBe(1);
    expect((await openWhatsAppRecovery(staff, x.row.id, { origin })).url).toContain("wa.me/");
    const late = await s.sellerAt(new Date(Date.now() + 30 * DAY));
    expect(late.billing.writable).toBe(false);
    expect((await getAbandonedCarts(late)).queue.length).toBe(1); // read-only applies to writes only
    expect(await code(openWhatsAppRecovery(late, x.row.id, { origin }))).toBe("billing_read_only");
  });
});

describe("signed resume link (7 days, store- and session-bound)", () => {
  const now = new Date("2026-10-28T03:00:00Z");
  const pid = "33333333-3333-4333-8333-333333333333";

  it("round-trips, expires exactly at 7 days and carries the key id", () => {
    const { token, expiresAt } = signResumeToken(7, pid, now);
    expect(expiresAt.getTime()).toBe(now.getTime() + 7 * DAY);
    expect(token).toMatch(/^v1\.tr1\.7\.33333333-3333-4333-8333-333333333333\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyResumeToken(token, now)).toEqual({ ok: true, value: { storeId: 7, publicId: pid, expiresAt } });
    expect(verifyResumeToken(token, new Date(expiresAt.getTime() - 1)).ok).toBe(true);
    expect(verifyResumeToken(token, expiresAt)).toEqual({ ok: false, reason: "expired" });
    expect(verifyResumeToken(token, new Date(expiresAt.getTime() + DAY))).toEqual({ ok: false, reason: "expired" });
  });

  it("every tampered part fails: store, session handle, expiry, signature, key id, version, shape", () => {
    const { token } = signResumeToken(7, pid, now);
    const [v, kid, store, handle, exp, sig] = token.split(".") as [string, string, string, string, string, string];
    const flip = (s: string) => `${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`;
    const cases: [string, string][] = [
      ["wrong store", [v, kid, "8", handle, exp, sig].join(".")],
      ["other session", [v, kid, store, "44444444-4444-4444-8444-444444444444", exp, sig].join(".")],
      ["extended expiry", [v, kid, store, handle, String(Number(exp) + 86_400), sig].join(".")],
      ["bad signature", [v, kid, store, handle, exp, flip(sig)].join(".")],
      ["unknown key id", [v, "zz", store, handle, exp, sig].join(".")],
      ["old version", ["v0", kid, store, handle, exp, sig].join(".")],
      ["short signature", [v, kid, store, handle, exp, sig.slice(0, 40)].join(".")],
      ["empty", ""],
      ["junk", "abc.def"],
      ["extra part", `${token}.x`],
      ["store with sign", [v, kid, "+7", handle, exp, sig].join(".")],
    ];
    for (const [name, t] of cases) expect(verifyResumeToken(t, now).ok, name).toBe(false);
    expect(verifyResumeToken([v, kid, "8", handle, exp, sig].join("."), now)).toEqual({ ok: false, reason: "signature" });
  });

  it("fails closed without a ring, with a malformed ring or with a key shared with another purpose; rotation keeps old links valid", () => {
    const k1 = Buffer.alloc(32, 1).toString("base64");
    const k2 = Buffer.alloc(32, 2).toString("base64");
    const env = (ring: string | undefined, more: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...(ring === undefined ? {} : { KEYRING_CHECKOUT_RESUME: ring }), ...more });
    expect(() => resumeKeyring(env(undefined))).toThrow(/dikonfigurasi/);
    expect(() => resumeKeyring(env(""))).toThrow();
    for (const bad of ["k1", "k1:", `:${k1}`, `k1:${Buffer.alloc(16).toString("base64")}`, `bad id:${k1}`, `k1:${k1},k1:${k2}`]) expect(() => resumeKeyring(env(bad)), bad).toThrow();
    expect(() => resumeKeyring(env(`r:${k1}`, { KEYRING_BUYER_FINGERPRINT: `b:${k1}` }))).toThrow(/tidak boleh sama/);
    expect(() => resumeKeyring(env(`r:${k1}`, { INTEGRATION_TOKEN_KEY: k1 }))).toThrow(/tidak boleh sama/);
    expect(() => resumeKeyring(env(`r:${k1}`, { KEYRING_SHIPPING_CREDENTIALS: `s:${k1}` }))).toThrow(/tidak boleh sama/);
    expect(resumeKeyring(env(`r:${k1}`, { KEYRING_BUYER_FINGERPRINT: `b:${k2}` })).length).toBe(1);
    // no ring: nothing can be signed and nothing verifies
    const { token } = signResumeToken(7, pid, now);
    expect(() => signResumeToken(7, pid, now, env(undefined))).toThrow();
    expect(verifyResumeToken(token, now, env(undefined)).ok).toBe(false);
    // rotation: sign under the old key, verify under a ring whose first (signing) key is new
    const old = signResumeToken(7, pid, now, env(`old:${k1}`));
    const rotated = env(`new:${k2},old:${k1}`);
    expect(verifyResumeToken(old.token, now, rotated).ok).toBe(true);
    expect(signResumeToken(7, pid, now, rotated).token.startsWith("v1.new.")).toBe(true);
    expect(verifyResumeToken(old.token, now, env(`new:${k2}`))).toEqual({ ok: false, reason: "unknown_key" });
    // a token signed under a different secret for the same ids does not verify
    expect(verifyResumeToken(old.token, now, env(`old:${k2}`))).toEqual({ ok: false, reason: "signature" });
  });

  it("redeems for the one session it names, in its own store: wrong store, wrong session, expired, tampered, recovered and gone carts are dead ends", async () => {
    const a = await makeStore("res-a");
    const b = await makeStore("res-b");
    const x = await session(a);
    const y = await session(b, { buyerPhone: "081234567891" });
    await abandon(x.row.id);
    const link = await openWhatsAppRecovery(a.owner, x.row.id, { origin });
    const token = link.resumeUrl.split("/checkout/r/")[1]!;
    const ok = await resumeCheckout(db, token);
    expect(ok).toEqual({ ok: true, storeId: a.storeId, storeSlug: "res-a", cartId: x.cartId });
    expect(await resumeCheckout(db, token)).toEqual(ok); // repeated clicks only rebind the same cart
    expect(await resumeCheckout(db, token, { now: new Date(link.expiresAt.getTime()) })).toEqual({ ok: false, reason: "expired" });
    const tampered = token.replace(`.${a.storeId}.`, `.${b.storeId}.`);
    expect(await resumeCheckout(db, tampered)).toEqual({ ok: false, reason: "signature" });
    // a validly signed pair that names store A with store B's session handle: the lookup runs inside store A and finds nothing
    const crossed = signResumeToken(a.storeId, y.row.publicId, new Date());
    expect(await resumeCheckout(db, crossed.token)).toEqual({ ok: false, reason: "unknown_session" });
    const crossed2 = signResumeToken(b.storeId, x.row.publicId, new Date());
    expect(await resumeCheckout(db, crossed2.token)).toEqual({ ok: false, reason: "unknown_session" });
    expect(await resumeCheckout(db, signResumeToken(a.storeId, "55555555-5555-4555-8555-555555555555", new Date()).token)).toEqual({ ok: false, reason: "unknown_session" });
    // rate limit per client IP
    await admin.execute(sql`insert into rate_limit (key, window_start, count) values ('resume:ip:203.0.113.9', to_timestamp(floor(extract(epoch from now()) / 600) * 600), 10000) on conflict do nothing`);
    expect(await resumeCheckout(db, token, { clientIp: "203.0.113.9" })).toEqual({ ok: false, reason: "rate_limited" });
    // once the order completes the session is recovered and the link is dead
    await placeOrder(db, x.cartId, buyer());
    expect(await resumeCheckout(db, token)).toEqual({ ok: false, reason: "recovered" });
    // an emptied or purged cart is a dead end too
    const z = await session(a, { buyerPhone: "081234567892" });
    await abandon(z.row.id);
    const zl = (await openWhatsAppRecovery(a.owner, z.row.id, { origin })).resumeUrl.split("/checkout/r/")[1]!;
    await setCartLine(a.sf, z.cartId, { variantId: a.variantId, quantity: 0 }, "set");
    expect(await resumeCheckout(db, zl)).toEqual({ ok: false, reason: "cart_gone" });
    await admin.execute(sql`delete from checkout_session where id = ${z.row.id}`);
    expect(await resumeCheckout(db, zl)).toEqual({ ok: false, reason: "unknown_session" });
    // a suspended store takes no resume
    const w = await session(a, { buyerPhone: "081234567893" });
    await abandon(w.row.id);
    const wl = (await openWhatsAppRecovery(a.owner, w.row.id, { origin })).resumeUrl.split("/checkout/r/")[1]!;
    await admin.execute(sql`update store set status = 'suspended' where id = ${a.storeId}`);
    expect(await resumeCheckout(db, wl)).toEqual({ ok: false, reason: "store_unavailable" });
  });
});

describe("export and redaction reach checkout sessions (PRIV-1, PRIV-4)", () => {
  it("export lists the sessions that match the typed phone (any spelling) or e-mail, without the resume handle or the cart; another store's sessions never appear", async () => {
    const a = await makeStore("pv-a");
    const b = await makeStore("pv-b");
    const mine = await session(a, { buyerName: "Budi" });
    await session(a, { buyerPhone: "", buyerEmail: "BUDI@example.com", buyerName: "Budi Email" });
    const other = await session(a, { buyerPhone: "089900001111", buyerEmail: "lain@example.com" });
    const foreign = await session(b, { buyerName: "Budi Lain Toko" });
    await abandon(mine.row.id);

    const byPhone = await exportBuyerData(a.owner, "+62 812-3456-7890");
    expect(byPhone.orders).toEqual([]);
    expect(byPhone.checkoutSessions).toEqual([
      expect.objectContaining({ status: "abandoned", buyerName: "Budi", buyerPhone: PHONE, buyerEmail: "budi@example.com", shippingAddress: "Jl. Merdeka No. 1, Bandung 40111", subtotalIdr: 200_000 }),
    ]);
    expect(JSON.stringify(byPhone)).not.toContain(mine.row.publicId);
    expect(JSON.stringify(byPhone)).not.toContain(mine.cartId);
    expect(Object.keys(byPhone.checkoutSessions[0]!)).not.toEqual(expect.arrayContaining(["id", "cartId", "publicId", "storeId"]));
    const byMail = await exportBuyerData(a.owner, "budi@example.com");
    expect(byMail.checkoutSessions.map((x) => x.buyerName)).toEqual(["Budi", "Budi Email"]);
    expect((await exportBuyerData(b.owner, PHONE)).checkoutSessions.map((x) => x.buyerName)).toEqual(["Budi Lain Toko"]);
    expect((await findBuyerOrders(a.owner, PHONE)).sessions).toBe(1);
    expect(JSON.stringify(byMail)).not.toContain(other.row.publicId);
    expect(foreign.row.storeId).toBe(b.storeId);
  });

  it("redacting an order overwrites the typed contact of its cart's session and of the same buyer's other sessions (name/phone/address REDACTED, e-mail NULL); other buyers and stores stay; a second run changes nothing", async () => {
    const a = await makeStore("pv-c");
    const b = await makeStore("pv-d");
    const ordered = await session(a);
    await abandon(ordered.row.id);
    const sameBuyer = await session(a, { buyerName: "Budi lagi", buyerEmail: "" });
    const byMailOnly = await session(a, { buyerPhone: "", buyerEmail: "budi@example.com", buyerName: "Budi mail" });
    const other = await session(a, { buyerPhone: "089900001111", buyerEmail: "lain@example.com", buyerName: "Orang Lain" });
    const foreign = await session(b);
    const { orderId } = await placeOrder(db, ordered.cartId, buyer({ buyerEmail: "budi@example.com" }));
    await transitionOrder(a.owner, orderId, "confirm");
    await transitionOrder(a.owner, orderId, "process");
    await transitionOrder(a.owner, orderId, "ship", { trackingNumber: "RESI-T45" });
    await deliver(a.storeId, orderId);

    const counts = await redactOrders(a.owner, { orderIds: [orderId] });
    expect(counts.checkoutSessions).toBe(2); // the ordered one is already empty (recovered); the two typed copies of the same buyer
    expect(await rowOf(sameBuyer.row.id)).toMatchObject({ buyerName: REDACTED, buyerPhone: REDACTED, buyerEmail: null, shippingAddress: REDACTED });
    expect(await rowOf(byMailOnly.row.id)).toMatchObject({ buyerName: REDACTED, buyerPhone: null, buyerEmail: null, shippingAddress: REDACTED });
    expect(await rowOf(ordered.row.id)).toMatchObject({ buyerName: null, buyerPhone: null });
    expect(await rowOf(other.row.id)).toMatchObject({ buyerName: "Orang Lain", buyerPhone: "089900001111", buyerEmail: "lain@example.com" });
    expect(await rowOf(foreign.row.id)).toMatchObject({ buyerName: "Budi Santoso", buyerPhone: PHONE });
    // money and status of the session survive; it no longer matches the buyer
    expect((await rowOf(sameBuyer.row.id)).subtotalIdr).toBe(200_000);
    expect((await exportBuyerData(a.owner, PHONE)).checkoutSessions).toEqual([]);
    expect((await findBuyerOrders(a.owner, PHONE)).sessions).toBe(0);
    const snapshot = [await rowOf(sameBuyer.row.id), await rowOf(byMailOnly.row.id)];
    expect(await redactOrders(a.owner, { orderIds: [orderId] })).toMatchObject({ orders: 0, checkoutSessions: 0, skipped: 1 });
    expect([await rowOf(sameBuyer.row.id), await rowOf(byMailOnly.row.id)]).toEqual(snapshot);
  });

  it("a buyer who never ordered is redacted through the session-only service: idempotent, audited with a hashed key, owner only, own store only", async () => {
    const a = await makeStore("pv-e");
    const b = await makeStore("pv-f");
    const lone = await session(a);
    const foreign = await session(b);
    expect(await redactCheckoutSessions(a.owner, "081234567890")).toEqual({ checkoutSessions: 1 });
    expect(await rowOf(lone.row.id)).toMatchObject({ buyerName: REDACTED, buyerPhone: REDACTED, buyerEmail: null, shippingAddress: REDACTED });
    expect((await rowOf(foreign.row.id)).buyerPhone).toBe(PHONE); // store B untouched by store A's redaction
    const again = await redactCheckoutSessions(a.owner, PHONE);
    expect(again).toEqual({ checkoutSessions: 0 });
    const audits = await platform.execute<{ reason: string }>(sql`select reason from audit_log where store_id = ${a.storeId} and action = 'privacy.redact_sessions'`);
    expect(audits.length).toBe(1);
    expect(audits[0]!.reason).toMatch(/^phone:[0-9a-f]{16} sessions:1$/);
    expect(JSON.stringify(audits)).not.toContain(PHONE);
    const staffId = await makeUser("staff");
    await platform.insert(membership).values({ storeId: a.storeId, userId: staffId, role: "staff" });
    await expect(redactCheckoutSessions(await seller(staffId, a.storeId), PHONE)).rejects.toThrow("Akses ditolak.");
    await expect(exportBuyerData(await seller(staffId, a.storeId), PHONE)).rejects.toThrow("Akses ditolak.");
    // store B's owner can redact B's own
    expect(await redactCheckoutSessions(b.owner, PHONE)).toEqual({ checkoutSessions: 1 });
    expect(await platform.select().from(checkoutSession).where(and(eq(checkoutSession.storeId, b.storeId), eq(checkoutSession.buyerPhone, REDACTED)))).toHaveLength(1);
  });
});

describe("wave 5 review: the WhatsApp target, and who owns the idle and purge clocks", () => {
  it("a number typed without a country or trunk prefix is never a WhatsApp target (it was a stranger in another country)", async () => {
    const s = await makeStore("toko-a");
    const foreign = await session(s, { buyerPhone: "81234567890" }); // 8 to 15 digits is accepted by the form: that is +81 (Japan) on wa.me
    await abandon(foreign.row.id);
    expect(await code(openWhatsAppRecovery(s.owner, foreign.row.id, { origin }))).toBe("no_phone");
  });

  it("the app login cannot backdate a session to abandon it at once, pre-age an inserted row, fake a rescue without an order, or write the WA stamp", async () => {
    const s = await makeStore("toko-a");
    const { cartId, row } = await session(s);
    const asApp = <T,>(fn: (tx: Parameters<Parameters<typeof withStore>[2]>[0]) => Promise<T>) => withStore(db, s.storeId, fn);
    // Backdating updated_at is overwritten by the database clock, so the 60-minute rule still holds.
    expect(await code(asApp((tx) => tx.execute(sql`update checkout_session set updated_at = now() - interval '2 hours', status = 'abandoned' where id = ${row.id}`)))).toBe("23514");
    expect((await rowOf(row.id)).status).toBe("active");
    // A recovery needs an order of its own cart.
    expect(await code(asApp((tx) => tx.execute(sql`update checkout_session set status = 'recovered' where id = ${row.id}`)))).toBe("23514");
    // A pre-aged INSERT is stamped with the database clock.
    const other = await newCart(s);
    await asApp((tx) => tx.execute(sql`insert into checkout_session (store_id, cart_id, buyer_phone, subtotal_idr, created_at, updated_at) values (${s.storeId}, ${other}, ${PHONE}, 1000, now() - interval '40 days', now() - interval '40 days')`));
    const [fresh] = await platform.select().from(checkoutSession).where(eq(checkoutSession.cartId, other));
    expect(Date.now() - fresh!.createdAt.getTime()).toBeLessThan(60_000);
    expect(Date.now() - fresh!.updatedAt.getTime()).toBeLessThan(60_000);
    void cartId;
  });
});

describe("wave 5 review: the buyer name cannot turn the message into a link", () => {
  it("a name with a dot (bit.ly, scam.id) is replaced by 'Kak'", () => {
    for (const name of ["bit.ly", "scam.id Budi", "a.b"]) expect(recoveryMessage({ storeName: "Toko A", buyerName: name, resumeUrl: "https://x.test/r/t" })).toContain("Halo Kak,");
    expect(recoveryMessage({ storeName: "Toko A", buyerName: "Siti Rahayu", resumeUrl: "https://x.test/r/t" })).toContain("Halo Siti,");
  });
});
