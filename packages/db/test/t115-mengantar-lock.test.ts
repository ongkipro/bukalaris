import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueSellerStepUp } from "../src/ledger/stepup.ts";
import { FakeProviderCheck, saveProviderKey, setProviderCheckTransport, shippingReadiness } from "../src/payments/provider-accounts.ts";
import { bindSession, type SellerScope } from "../src/platform/scoped.ts";
import { withStore } from "../src/platform/tenant.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { auditLog, job, order, orderStatusHistory, shipment } from "../src/schema.ts";
import { placeOrder, searchDestinationAreas } from "../src/seller/commerce/checkout.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import { bookShipment, linkUnknownBooking, mapProviderStatus, refreshTracking, releaseUnknownBooking, setBookingAdapter, SHIPMENT_TRACK, type BookingAdapter, type TrackingResult } from "../src/shipping/fulfillment.ts";
import { MengantarError } from "../src/shipping/mengantar/client.ts";
import { figuresOf } from "../src/shipping/mengantar/booking.ts";
import { categoryLabel, displayableCategory, PARCEL_SHIPMENT_STATUS, PARCEL_STATE_MAP, PARCEL_STATES, parcelStateOf, type ParcelState } from "../src/shipping/parcel-state.ts";
import { SHIPPING_ACCOUNT_KINDS, storeShippingAccount } from "../src/shipping/schema-accounts.ts";
import { shipmentStatusEvent, shippingForeignParcel, shippingWebhookEvent, storeShippingSync } from "../src/shipping/schema-fulfillment.ts";
import { fakeSellerMengantar, setSellerMengantarFetch } from "../src/shipping/seller.ts";
import { setPickupAddress } from "../src/shipping/shipping.ts";
import { saveCourierRules, formatShippingQuote } from "../src/shipping/rules.ts";
import {
  confirmDedicatedAccount,
  mengantarWebhookSignature,
  PARCEL_SWEEP_STALE_MS,
  receiveMengantarWebhook,
  resolveForeignParcel,
  scanAccount,
  SCAN_GRACE_MS,
  setWebhookSecret,
  SHIPPING_PROVIDER,
  UNREADABLE_ORDER_ID,
  shippingSync,
  sweepParcels,
  verifyMengantarSignature,
  WEBHOOK_MAX_SKEW_MS,
} from "../src/shipping/sync.ts";
import { shippingOptions } from "../src/shipping/shipping.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { admin, buyer, db, DESTINATION, makeStore, platform } from "./helpers.ts";
import { sessionOf } from "./t37-fixtures.ts";

// T-115 (ADR-0013 section 11, decisions 40 to 45; decisions 30, 31): Mengantar locked, a dedicated account kept in sync, webhooks as triggers
// only, the tracking read as the single writer. Everything runs on the deterministic seller fake (no origin configured) or on the real client
// over a STUBBED fetch (an origin of example.test): no request leaves the process. Keys and the Webhook Secret are canaries.

const KEY = "CANARY-T115-seller-key-0123456789abcdef";
const SECRET = "CANARY-T115-webhook-secret-9f8e7d6c5b4a";
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? String(e));
const RULES = [{ courierCode: "JNE", enabled: true, codEnabled: true }];
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

type Own = Awaited<ReturnType<typeof makeStore>> & { me: SellerScope; hookId: string };
/** A store on its own, dedicated Mengantar account, ready to ship, with its Webhook Secret stored. */
async function ownStore(slug: string, opts: { key?: string; environment?: "sandbox" | "production"; secret?: string | null } = {}): Promise<Own> {
  const s = await makeStore(slug);
  const me = bindSession(s.owner, await sessionOf(s.ownerId));
  await saveProviderKey(me, { provider: "mengantar", environment: opts.environment ?? "sandbox", apiKey: opts.key ?? KEY, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
  await confirmDedicatedAccount(me, { confirmed: true });
  await setPickupAddress(me, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
  await saveCourierRules(me, { couriers: RULES });
  if (opts.secret !== null) await setWebhookSecret(me, { secret: opts.secret ?? SECRET, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar_webhook" }) });
  const [row] = await platform.select({ hookId: storeShippingSync.hookId }).from(storeShippingSync).where(eq(storeShippingSync.storeId, s.storeId));
  return { ...s, me, hookId: row!.hookId };
}
const run = (workerId = "W") => runOnce(platform, { workerId });
const shipmentOf = async (orderId: number) => (await platform.select().from(shipment).where(eq(shipment.orderId, orderId)))[0]!;
const orderOf = async (orderId: number) => (await platform.select().from(order).where(eq(order.id, orderId)))[0]!;
const trackJobs = async (orderId: number) => (await platform.select().from(job).where(and(eq(job.kind, SHIPMENT_TRACK), sql`${job.payload}->>'orderId' = ${String(orderId)}`)));
const pendingTrackJobs = async () => platform.select().from(job).where(and(eq(job.kind, SHIPMENT_TRACK), eq(job.status, "pending")));

async function paidOrder(s: Own, paymentMethod: "manual_transfer" | "cod" = "manual_transfer") {
  const cart = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
  const quote = await shippingOptions(s.sf, DESTINATION.destinationAreaId, { lines: [{ quantity: 1, weightGrams: 1000 }], subtotal: 100_000 });
  const { orderId } = await placeOrder(db, cart, buyer({ paymentMethod, shippingQuote: formatShippingQuote(quote.options), courier: "JNE" }));
  await run("setup");
  await transitionOrder(s.owner, orderId, paymentMethod === "cod" ? "confirm" : "pay");
  return orderId;
}

/** A scripted provider: books with a resi, then answers each tracking read from the queue (the last answer repeats). */
type Scripted = BookingAdapter & { reads: TrackingResult[]; tracked: number };
function scripted(reads: Partial<TrackingResult>[] = [], opts: { unpaid?: boolean } = {}): Scripted {
  const a: Scripted = {
    reads: reads.map((r) => ({ trackingNumber: null, providerStatus: null, paid: true, history: [], ...r })),
    tracked: 0,
    async createOrder(input) {
      const providerOrderId = `ORD${input.orderId}x${input.idempotencyKey?.split("-").at(-1) ?? 0}`;
      if (opts.unpaid) return { providerOrderId, providerBatchId: `B${input.orderId}`, trackingNumber: null, paid: false, providerStatus: "active" }; // balance short (decision 31)
      return { providerOrderId, providerBatchId: `B${input.orderId}`, trackingNumber: `RESI${input.orderId}`, paid: true, providerStatus: "PENDING PICKUP", figures: { estimatedPrice: 12_000, estimatedSpecialPrice: 10_800, discount: 1_200 } };
    },
    async payUnpaid() {},
    async track() {
      a.tracked++;
      return a.reads.length > 1 ? a.reads.shift()! : (a.reads[0] ?? { trackingNumber: null, providerStatus: "ON DELIVERY", paid: true, history: [] });
    },
  };
  return a;
}
async function booked(s: Own, adapter: Scripted, paymentMethod: "manual_transfer" | "cod" = "manual_transfer") {
  setBookingAdapter(adapter);
  const orderId = await paidOrder(s, paymentMethod);
  await bookShipment(s.me, orderId, { pickupType: "drop_off" });
  await run("book");
  return orderId;
}
/** One signed delivery to the store's webhook address, as Mengantar sends it. */
function deliver(s: { hookId: string }, body: Record<string, unknown> | string, opts: { secret?: string; ts?: number; env?: string | null; sig?: string | null; now?: number } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const ts = String(opts.ts ?? Date.now());
  const signature = opts.sig === undefined ? mengantarWebhookSignature(opts.secret ?? SECRET, ts, raw) : opts.sig;
  return receiveMengantarWebhook(db, { hookId: s.hookId, rawBody: raw, timestamp: ts, signature, environment: opts.env ?? null }, opts.now);
}
const parcelBody = (orderId: number, status_category: string, providerOrderId = `ORD${orderId}x0`) => ({ cnote_no: `RESI${orderId}`, order_id: providerOrderId, courier: "JNE", status_category });
/** What a webhook could have changed: the parcel, the order and the queued reads. */
const snapshot = async (orderId: number) => {
  const s = await shipmentOf(orderId);
  const o = await orderOf(orderId);
  return { status: s.status, providerStatus: s.providerStatus, lastTrackedAt: s.lastTrackedAt?.toISOString() ?? null, order: o.status, tracking: o.trackingNumber, jobs: (await trackJobs(orderId)).length };
};

let check: FakeProviderCheck;
beforeEach(async () => {
  check = new FakeProviderCheck();
  setProviderCheckTransport(check);
  fakeSellerMengantar.accounts.clear();
  fakeSellerMengantar.balanceIdr = 250_000;
});
afterEach(() => {
  setProviderCheckTransport(null);
  setBookingAdapter(null);
  setSellerMengantarFetch(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("T-115 decision 40: Mengantar is the only shipping aggregator", () => {
  it("no provider other than Mengantar can be connected for shipping: every account kind is a Mengantar account, the database refuses another, and no seller or operator shipping screen offers a choice", async () => {
    expect(SHIPPING_PROVIDER).toBe("mengantar");
    expect([...SHIPPING_ACCOUNT_KINDS]).toEqual(["partner_managed", "platform_master", "seller_owned"]); // T-48 Mengantar Partner/master and the seller's own Mengantar key
    const s = await makeStore("t115-lock");
    expect(await code(admin.execute(sql`insert into store_shipping_account (store_id, kind, status, external_user_id) values (${s.storeId}, 'autolaris', 'pending', ${`store:${s.storeId}`})`))).toBe("23514");
    // The AutoLaris key is a payment account: saving it never creates or touches a shipping account.
    const me = bindSession(s.owner, await sessionOf(s.ownerId));
    await saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: "autolaris-key-0123456789abcdef", proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    expect((await platform.select().from(storeShippingAccount).where(and(eq(storeShippingAccount.storeId, s.storeId), eq(storeShippingAccount.kind, "seller_owned"))))).toEqual([]);
    // No seller or Owner-console shipping screen, and no shipping module, offers another aggregator or a provider choice.
    const dirs = ["apps/web/src/app/(seller)/seller/shipping", "apps/web/src/app/(operator)/admin/shipping", "packages/db/src/shipping"];
    const files = dirs.flatMap(function walk(d: string): string[] {
      return readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []));
    });
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) => /\b(biteship|shipper\.id|rajaongkir|kiriminaja|everpro|name="(shippingProvider|aggregator)")/i.test(readFileSync(join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("T-115 decision 41: a new account, used only by this store", () => {
  it("the connection check refuses an account that already holds orders; nothing is stored", async () => {
    const s = await makeStore("t115-used");
    const me = bindSession(s.owner, await sessionOf(s.ownerId));
    const proof = () => issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" });
    // An account with an order from elsewhere (the fake's "USED" account): refused, no key stored, the proof unconsumed.
    const p = await proof();
    expect(await code(saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: "USED-account-key-0123456789abcdef", proofId: p }))).toBe("account_not_empty");
    expect(await platform.select().from(storeShippingAccount).where(and(eq(storeShippingAccount.storeId, s.storeId), eq(storeShippingAccount.kind, "seller_owned")))).toEqual([]);
    expect((await admin.execute(sql`select consumed_at from store_step_up_proof where id = ${p}`))[0]).toEqual({ consumed_at: null });
    // An empty account is accepted. A second key on an account holding only this store's own parcels (key rotation) is accepted too.
    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: KEY, proofId: p });
    // The live path on a stubbed origin: the check reads one page of the order list, archive included, on the store's key.
    vi.stubEnv("MENGANTAR_SANDBOX_ORIGIN", "https://sandbox.example.test");
    const calls: string[] = [];
    let accountOrders: unknown[] = [{ ORDER_ID: "SOMEONEELSE1", cnote_no: "X1", status: "active", createdAt: "2025-01-01T00:00:00.000Z" }];
    setSellerMengantarFetch((async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ success: true, data: accountOrders, nextCursor: "" }), { status: 200 });
    }) as typeof fetch);
    const NEW_KEY = "rotated-key-of-another-account-0123456789";
    expect(await code(saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: NEW_KEY, proofId: await proof() }))).toBe("account_not_empty");
    const url = new URL(calls.at(-1)!);
    expect(url.pathname).toBe(`/api/public/${encodeURIComponent(NEW_KEY)}/order`);
    expect(url.searchParams.get("size")).toBe("100");
    expect(JSON.parse(url.searchParams.get("dateRange")!)).toMatchObject({ startDate: "2015-01-01T00:00:00.000Z" });
    accountOrders = [];
    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: NEW_KEY, proofId: await proof() });
    // An unreadable order list refuses too (the account cannot be shown to be dedicated): nothing changes.
    setSellerMengantarFetch((async () => new Response("{}", { status: 503 })) as typeof fetch);
    expect(await code(saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: "third-key-0123456789abcdef", proofId: await proof() }))).toBe("account_check_failed");
  });

  it("the seller's dedicated-account confirmation is recorded for the connected key and environment only, after the account is checked again; shipping is ready only with it", async () => {
    const s = await makeStore("t115-dedicated");
    const me = bindSession(s.owner, await sessionOf(s.ownerId));
    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: KEY, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
    await setPickupAddress(me, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
    expect(await shippingReadiness(me)).toEqual({ ready: false, missing: ["dedicated"] });
    expect(await code(confirmDedicatedAccount(me, { confirmed: false }))).not.toBe("ok");
    expect(await code(confirmDedicatedAccount({ ...me, role: "staff" }, { confirmed: true }))).toBe("forbidden");
    // The account gained an order from elsewhere since the key was saved: the confirmation is refused.
    fakeSellerMengantar.accounts.set(KEY, [{ providerOrderId: "ELSEWHERE01", trackingNumber: null, status: "active", createdAt: "2026-11-01T00:00:00.000Z" }]);
    expect(await code(confirmDedicatedAccount(me, { confirmed: true }))).toBe("account_not_empty");
    fakeSellerMengantar.accounts.clear();
    await confirmDedicatedAccount(me, { confirmed: true });
    expect(await shippingReadiness(me)).toEqual({ ready: true, missing: [] });
    expect((await platform.select().from(auditLog).where(eq(auditLog.action, "shipping.account.dedicated_confirmed"))).map((r) => r.storeId)).toEqual([s.storeId]);
    // The confirmation is the store's own write at the time it is given: back-dating is refused by the database for the app role.
    expect(await code(withStore(db, s.storeId, (tx) => tx.execute(sql`update store_shipping_sync set dedicated_confirmed_at = now() - interval '1 day'`)))).toBe("42501");
    // Another account (a new key): not dedicated until confirmed again.
    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: "second-account-key-0123456789abcdef", proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
    expect((await shippingReadiness(me)).missing).toContain("dedicated");
    expect((await shippingSync(me)).dedicated.confirmedAt).toBeNull();
  });

  it("a parcel in the account that Bukalaris did not create is listed as foreign, not imported, and marks the store's sync as not exact until the seller resolves it", async () => {
    const s = await ownStore("t115-foreign");
    const orderId = await booked(s, scripted());
    const own = (await shipmentOf(orderId)).providerOrderId!;
    const old = new Date(Date.now() - 3_600_000).toISOString();
    fakeSellerMengantar.accounts.set(KEY, [
      { providerOrderId: own, trackingNumber: `RESI${orderId}`, status: "PENDING PICKUP", createdAt: old },
      { providerOrderId: "FOREIGN0001", trackingNumber: "FRESI1", status: "PICKED UP", createdAt: old },
      { providerOrderId: "YOUNG000001", trackingNumber: null, status: "active", createdAt: new Date().toISOString() }, // a booking may still be on its way back
    ]);
    const counts = async () => ({ orders: (await platform.select().from(order).where(eq(order.storeId, s.storeId))).length, shipments: (await platform.select().from(shipment).where(eq(shipment.storeId, s.storeId))).length });
    const before = await counts();
    expect((await shippingSync(s.me)).exact).toBe(true);
    expect(await scanAccount(platform, s.storeId)).toEqual({ foreign: 1, read: 3 });
    expect(await counts()).toEqual(before); // never imported
    const view = await shippingSync(s.me);
    expect(view.exact).toBe(false);
    expect(view.foreign.map((f) => [f.providerOrderId, f.trackingNumber, f.providerStatus])).toEqual([["FOREIGN0001", "FRESI1", "PICKED UP"]]);
    // A second scan does not duplicate it; the young order is checked once it is older than the grace period.
    expect(await scanAccount(platform, s.storeId, new Date(Date.now() + SCAN_GRACE_MS + 60_000))).toMatchObject({ foreign: 2 }); // both found, one row each
    expect((await platform.select().from(shippingForeignParcel).where(eq(shippingForeignParcel.storeId, s.storeId))).map((r) => r.providerOrderId).sort()).toEqual(["FOREIGN0001", "YOUNG000001"]);
    for (const f of (await shippingSync(s.me)).foreign) await resolveForeignParcel(s.me, f.id, { note: "Paket lama dari toko offline, sudah dihapus" });
    expect((await shippingSync(s.me)).exact).toBe(true);
    expect(await code(resolveForeignParcel(s.me, 999_999, { note: "tidak ada" }))).toBe("not_found");
    // Store B never sees store A's foreign parcels.
    const b = await ownStore("t115-foreign-b", { key: "store-b-key-0123456789abcdef", secret: null });
    expect(await withStore(db, b.storeId, (tx) => tx.select().from(shippingForeignParcel))).toEqual([]);
  });
});

describe("T-115 decision 43: two paths, one writer", () => {
  it("a verified webhook (documented signature: HMAC-SHA256 of timestamp and raw body) is stored and only enqueues a tracking read on the store's key; the read is the single writer", async () => {
    // The documented test vector.
    const vector = '{"cnote_no":"JNE1234567890","order_id":"ORD-000123","courier":"JNE","status_category":"DELIVERED"}';
    expect(mengantarWebhookSignature("testsecret", "1787548800000", vector)).toBe("05826dec707ea7164801d952cb7eaf7ce9adc0c8aa0b93366480434164a1a111");
    expect(verifyMengantarSignature("testsecret", "1787548800000", vector, "05826dec707ea7164801d952cb7eaf7ce9adc0c8aa0b93366480434164a1a111")).toBe(true);
    expect(verifyMengantarSignature("testsecret", "1787548800000", vector.replace("DELIVERED", "RTS"), "05826dec707ea7164801d952cb7eaf7ce9adc0c8aa0b93366480434164a1a111")).toBe(false);

    const s = await ownStore("t115-webhook");
    const adapter = scripted([{ trackingNumber: null, providerStatus: "DELIVERED", statusChangedAt: new Date().toISOString(), history: [{ at: "16-11-2026 10:00", desc: "Delivered" }] }]);
    const orderId = await booked(s, adapter);
    await platform.update(job).set({ status: "done" }).where(eq(job.kind, SHIPMENT_TRACK)); // the booking's own first poll is not what this test drives
    const before = await snapshot(orderId);
    expect(await deliver(s, parcelBody(orderId, "DELIVERED"))).toEqual({ status: 200, outcome: "read_enqueued" });
    // Stored, and nothing else changed by the delivery itself.
    expect(await platform.select({ category: shippingWebhookEvent.statusCategory, outcome: shippingWebhookEvent.outcome }).from(shippingWebhookEvent)).toEqual([{ category: "DELIVERED", outcome: "read_enqueued" }]);
    expect({ ...(await snapshot(orderId)), jobs: 0 }).toEqual({ ...before, jobs: 0 });
    expect((await pendingTrackJobs()).map((j) => j.storeId)).toEqual([s.storeId]);
    // The read on the store's key writes the state.
    await run("read");
    expect(adapter.tracked).toBe(1);
    expect(await shipmentOf(orderId)).toMatchObject({ status: "delivered", providerStatus: "DELIVERED" });
    expect(await orderOf(orderId)).toMatchObject({ status: "completed" });
  });

  it("forged, unsigned, stale, replayed, out-of-order and sandbox-marked webhooks change nothing by themselves", async () => {
    const s = await ownStore("t115-forged", { environment: "production" });
    vi.stubEnv("MENGANTAR_PRODUCTION_ORIGIN", ""); // production account on the local fake (no origin configured)
    const reads = scripted([{ providerStatus: "ON DELIVERY", statusChangedAt: "2026-11-16T03:00:00.000Z" }]);
    const orderId = await booked(s, reads);
    await platform.update(job).set({ status: "done" }).where(eq(job.kind, SHIPMENT_TRACK));
    const before = await snapshot(orderId);
    const body = parcelBody(orderId, "DELIVERED");
    expect(await deliver(s, body, { secret: "not-the-store-secret-000" })).toEqual({ status: 401, outcome: "unauthorized" }); // forged
    expect(await deliver(s, body, { sig: null })).toEqual({ status: 401, outcome: "unauthorized" }); // unsigned
    expect(await deliver(s, body, { sig: "" })).toEqual({ status: 401, outcome: "unauthorized" });
    expect(await deliver(s, JSON.stringify(body) + " ", { sig: mengantarWebhookSignature(SECRET, String(Date.now()), JSON.stringify(body)) })).toEqual({ status: 401, outcome: "unauthorized" }); // body changed after signing
    expect(await deliver(s, body, { ts: Date.now() - WEBHOOK_MAX_SKEW_MS - 1_000 })).toEqual({ status: 401, outcome: "stale" });
    expect(await deliver(s, body, { ts: Date.now() + WEBHOOK_MAX_SKEW_MS + 1_000 })).toEqual({ status: 401, outcome: "stale" });
    expect(await deliver(s, body, { env: "sandbox" })).toEqual({ status: 403, outcome: "sandbox_refused" }); // a production account
    expect(await deliver({ hookId: "0".repeat(32) }, body)).toEqual({ status: 401, outcome: "unauthorized" }); // no such store
    expect(await snapshot(orderId)).toEqual(before);
    expect(await platform.select().from(shippingWebhookEvent)).toEqual([]);
    // Replayed: the same signed delivery twice is one event and one read.
    const ts = Date.now();
    expect(await deliver(s, body, { ts })).toEqual({ status: 200, outcome: "read_enqueued" });
    expect(await deliver(s, body, { ts })).toEqual({ status: 200, outcome: "duplicate" });
    expect(await platform.select().from(shippingWebhookEvent)).toHaveLength(1);
    expect(await pendingTrackJobs()).toHaveLength(1);
    // Out of order: the parcel says DELIVERED now (provider answer), an older ON DELIVERY delivery arrives after: the read decides, never the delivery.
    reads.reads = [{ trackingNumber: null, providerStatus: "DELIVERED", paid: true, history: [], statusChangedAt: "2026-11-16T05:00:00.000Z" }];
    await run("read");
    expect(await shipmentOf(orderId)).toMatchObject({ status: "delivered" });
    expect(await deliver(s, parcelBody(orderId, "ON DELIVERY"), { ts: ts - 60_000 })).toEqual({ status: 200, outcome: "parcel_final" });
    expect(await pendingTrackJobs()).toHaveLength(0);
    expect(await shipmentOf(orderId)).toMatchObject({ status: "delivered", providerStatus: "DELIVERED" });
    expect(await orderOf(orderId)).toMatchObject({ status: "completed" });
  });

  it("racing reads cannot move a parcel back: an answer older than the applied state changes nothing but the read time", async () => {
    const s = await ownStore("t115-race", { secret: null });
    const adapter = scripted([
      { providerStatus: "PICKED UP", statusChangedAt: "2026-11-16T05:00:00.000Z" },
      { providerStatus: "PENDING PICKUP", statusChangedAt: "2026-11-16T04:00:00.000Z" },
    ]);
    const orderId = await booked(s, adapter);
    await refreshTracking(s.me, orderId);
    await run("r1");
    await platform.update(job).set({ nextAttemptAt: new Date() }).where(and(eq(job.kind, SHIPMENT_TRACK), eq(job.status, "pending")));
    await run("r1b");
    expect(await shipmentOf(orderId)).toMatchObject({ status: "in_transit", providerStatus: "PICKED UP" });
    const at = (await shipmentOf(orderId)).providerStatusAt;
    // The older answer arrives through the sweep: ignored.
    await platform.update(shipment).set({ lastTrackedAt: new Date(Date.now() - PARCEL_SWEEP_STALE_MS - 60_000) }).where(eq(shipment.orderId, orderId));
    await sweepParcels(platform);
    await run("r2");
    expect(await shipmentOf(orderId)).toMatchObject({ status: "in_transit", providerStatus: "PICKED UP", providerStatusAt: at });
  });

  it("a webhook for store A cannot move store B's parcel", async () => {
    const a = await ownStore("t115-cross-a");
    const b = await ownStore("t115-cross-b", { key: "store-b-own-key-0123456789abcdef", secret: "CANARY-T115-store-b-secret-0000" });
    const bOrder = await booked(b, scripted());
    await platform.update(job).set({ status: "done" }).where(eq(job.kind, SHIPMENT_TRACK));
    const before = await snapshot(bOrder);
    // A's address, A's secret, B's parcel ids: no parcel of A matches; nothing is enqueued for B.
    expect(await deliver(a, parcelBody(bOrder, "DELIVERED", (await shipmentOf(bOrder)).providerOrderId!))).toEqual({ status: 200, outcome: "no_parcel" });
    // A's address signed with B's secret: refused.
    expect(await deliver(a, parcelBody(bOrder, "DELIVERED"), { secret: "CANARY-T115-store-b-secret-0000" })).toEqual({ status: 401, outcome: "unauthorized" });
    expect(await snapshot(bOrder)).toEqual(before);
    expect(await pendingTrackJobs()).toEqual([]);
    // Under the application role, A's context sees none of B's webhook events, parcels or link row.
    await deliver(b, parcelBody(bOrder, "PICKED UP"), { secret: "CANARY-T115-store-b-secret-0000" });
    expect(await withStore(db, a.storeId, (tx) => tx.select().from(shippingWebhookEvent).where(eq(shippingWebhookEvent.storeId, b.storeId)))).toEqual([]);
    expect(await withStore(db, a.storeId, (tx) => tx.select({ id: shipment.id }).from(shipment).where(eq(shipment.storeId, b.storeId)))).toEqual([]);
    expect(await code(withStore(db, a.storeId, (tx) => tx.execute(sql`select * from provider_key_envelope(${b.storeId}::bigint, 'mengantar_webhook')`)))).toBe("42501");
  });

  it("missed webhooks are repaired by the scheduled read: every non-final parcel is read, the stalest of each store first", async () => {
    const a = await ownStore("t115-sweep-a", { secret: null });
    const b = await ownStore("t115-sweep-b", { key: "sweep-b-key-0123456789abcdef", secret: null });
    const adapter = scripted([{ providerStatus: "DELIVERED", history: [] }]);
    const aOrders = [await booked(a, adapter), await booked(a, adapter), await booked(a, adapter)];
    const bOrder = await booked(b, adapter);
    // No webhook arrived (paused delivery) and the booking's own poll chain is over: only the sweep can find the change.
    await platform.update(job).set({ status: "done" }).where(eq(job.kind, SHIPMENT_TRACK));
    const old = Date.now() - PARCEL_SWEEP_STALE_MS - 60_000;
    // Store A's parcels are all staler than store B's one: a plain "stalest first" order would read A, A, A before B.
    for (const [i, id] of aOrders.entries()) await platform.update(shipment).set({ lastTrackedAt: new Date(old - (10 - i) * 60_000) }).where(eq(shipment.orderId, id));
    await platform.update(shipment).set({ lastTrackedAt: new Date(old) }).where(eq(shipment.orderId, bOrder));
    expect(await sweepParcels(platform)).toBe(4);
    const queued = (await platform.select({ storeId: job.storeId }).from(job).where(and(eq(job.kind, SHIPMENT_TRACK), eq(job.status, "pending"))).orderBy(job.id)).map((j) => j.storeId);
    expect(queued.slice(0, 2).sort()).toEqual([a.storeId, b.storeId].sort()); // fair: one parcel of each store before a second of any
    expect(await sweepParcels(platform)).toBe(0); // idempotent within the staleness window
    await run("sweep");
    for (const id of [...aOrders, bOrder]) expect(await orderOf(id)).toMatchObject({ status: "completed" });
    expect(await sweepParcels(platform, new Date(Date.now() + 2 * PARCEL_SWEEP_STALE_MS))).toBe(0); // final parcels are never read again
  });

  it("a seller's read-now is limited per parcel and per store (RL-TRACK-REFRESH); the last state stays shown", async () => {
    const s = await ownStore("t115-refresh", { secret: null });
    const orderId = await booked(s, scripted());
    await refreshTracking(s.me, orderId);
    expect(await code(refreshTracking(s.me, orderId))).toBe("rate_limited");
  });
});

describe("T-115 decision 42: the whole parcel life through one mapping table", () => {
  it("each state of decision 42, including pickup failed, return in progress, returned, cancelled and both CANCELED and CANCELLED spellings, comes from the one table", () => {
    const expected: Record<string, ParcelState> = {
      active: "created",
      "ACTIVE/WAITING NEXT PROCESS": "created",
      "PENDING PICKUP": "waiting_pickup",
      "PICKUP FAILED": "pickup_failed",
      PICKUP_FAILED_API: "pickup_failed",
      "PICKED UP": "picked_up",
      UNDELIVERED: "in_transit",
      "ON DELIVERY": "out_for_delivery",
      "DELIVERY COURIER": "out_for_delivery",
      DELIVERED: "delivered",
      RTS: "returned",
      CANCELED: "cancelled",
      CANCELLED: "cancelled",
      ERROR: "error",
    };
    for (const [category, state] of Object.entries(expected)) expect(parcelStateOf(category), category).toBe(state);
    expect(Object.keys(PARCEL_STATE_MAP).length).toBe(Object.keys(expected).length);
    // Every state of decision 42 exists and drives a shipment status; "returning" (return in progress) keeps the parcel moving, not final.
    expect([...PARCEL_STATES]).toEqual(["created", "waiting_pickup", "pickup_failed", "picked_up", "in_transit", "out_for_delivery", "delivered", "returning", "returned", "cancelled", "error"]);
    expect(PARCEL_SHIPMENT_STATUS).toMatchObject({ returning: "in_transit", returned: "returned", pickup_failed: "problem", cancelled: "cancelled", delivered: "delivered" });
    // UNVERIFIED (no Order Status Reference Sheet read): no documented category maps to `returning` or a generic `in_transit` yet; they arrive raw.
    expect(Object.values(PARCEL_STATE_MAP).some((r) => r.parcel === "returning")).toBe(false);
    expect(mapProviderStatus(" cancelled ")).toMatchObject({ status: "cancelled" });
    expect(mapProviderStatus("UNDELIVERED")).toMatchObject({ status: "problem" });
    expect(categoryLabel("RTS")).toBe("Dikembalikan ke pengirim (RTS)");
  });

  it("each state through the single writer on the store's own account: pickup failed asks for attention, RTS returns the order, a courier cancellation (either spelling) releases the booking, delivery completes the order and marks COD paid", async () => {
    const s = await ownStore("t115-states", { secret: null });
    const read = (adapter: Scripted, orderId: number) => refreshTracking(s.me, orderId).then(() => run(`r${orderId}`));
    // Pickup failed: the parcel needs the seller, the order is untouched.
    const a = scripted([{ providerStatus: "PICKUP FAILED" }]);
    const failed = await booked(s, a);
    await read(a, failed);
    expect(await shipmentOf(failed)).toMatchObject({ status: "problem", providerStatus: "PICKUP FAILED" });
    expect(await orderOf(failed)).toMatchObject({ status: "shipped" });
    // RTS (returned): the order is returned (stock back as built).
    const b = scripted([{ providerStatus: "RTS" }]);
    const rts = await booked(s, b);
    await read(b, rts);
    expect(await shipmentOf(rts)).toMatchObject({ status: "returned" });
    expect(await orderOf(rts)).toMatchObject({ status: "returned" });
    // A cancellation in the seller's account, both spellings: the booking is released, the order goes back to Diproses and may be booked again.
    for (const spelling of ["CANCELED", "CANCELLED"]) {
      const c = scripted([{ providerStatus: spelling }]);
      const id = await booked(s, c);
      const first = (await shipmentOf(id)).providerOrderId!;
      await read(c, id);
      expect(await shipmentOf(id)).toMatchObject({ status: "cancelled", providerStatus: spelling });
      expect(await orderOf(id)).toMatchObject({ status: "processing", trackingNumber: null });
      expect((await platform.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, id))).at(-1)).toMatchObject({ fromStatus: "shipped", toStatus: "processing" });
      await bookShipment(s.me, id, { pickupType: "drop_off" });
      await run(`rebook${id}`);
      const again = await shipmentOf(id);
      expect(again).toMatchObject({ status: "booked", bookingAttempts: 1 });
      expect(again.providerOrderId).not.toBe(first);
      expect(await orderOf(id)).toMatchObject({ status: "shipped" });
      // The cancelled provider order is still known as the store's own: never flagged foreign later.
      fakeSellerMengantar.accounts.set(KEY, [{ providerOrderId: first, trackingNumber: null, status: spelling, createdAt: "2026-01-01T00:00:00.000Z" }]);
      expect(await scanAccount(platform, s.storeId)).toMatchObject({ foreign: 0 });
    }
    // Delivered: a COD order is completed and marked paid (C-P1); the status history keeps every category with its source.
    await searchDestinationAreas("menteng", undefined, s.sf); // COD needs a resolved destination province (T-105)
    const d = scripted([{ providerStatus: "DELIVERED", figures: { COD_AMOUNT: 112_000, GOODS_AMOUNT: 100_000 } }]);
    const cod = await booked(s, d, "cod");
    await read(d, cod);
    expect(await orderOf(cod)).toMatchObject({ status: "completed" });
    expect((await orderOf(cod)).paidAt).toBeInstanceOf(Date);
    const history = await platform.select({ category: shipmentStatusEvent.category, parcelState: shipmentStatusEvent.parcelState, source: shipmentStatusEvent.source }).from(shipmentStatusEvent).where(eq(shipmentStatusEvent.shipmentId, (await shipmentOf(cod)).id)).orderBy(shipmentStatusEvent.id);
    expect(history).toEqual([{ category: "PENDING PICKUP", parcelState: "waiting_pickup", source: "booking" }, { category: "DELIVERED", parcelState: "delivered", source: "read" }]);
  });

  it("an unknown status category stays raw: stored as received, no state change, never a guessed state, and shown as received to the seller", async () => {
    const s = await ownStore("t115-unknown", { secret: null });
    const a = scripted([{ providerStatus: "WAREHOUSE HOLD" }]);
    const orderId = await booked(s, a);
    await refreshTracking(s.me, orderId);
    await run("unknown");
    expect(await shipmentOf(orderId)).toMatchObject({ status: "booked", providerStatus: "WAREHOUSE HOLD" });
    expect(await orderOf(orderId)).toMatchObject({ status: "shipped" });
    expect(await platform.select({ category: shipmentStatusEvent.category, parcelState: shipmentStatusEvent.parcelState }).from(shipmentStatusEvent).where(eq(shipmentStatusEvent.source, "read"))).toEqual([{ category: "WAREHOUSE HOLD", parcelState: null }]);
    expect(parcelStateOf("WAREHOUSE HOLD")).toBeNull();
    expect(mapProviderStatus("WAREHOUSE HOLD")).toBeNull();
    expect(displayableCategory("WAREHOUSE HOLD")).toBe("WAREHOUSE HOLD");
    expect(displayableCategory("<script>alert(1)</script>")).toBeNull(); // not a status code: never echoed
  });
});

describe("T-115 decisions 43 and 45: the sealed Webhook Secret and Mengantar's money figures", () => {
  it("the Webhook Secret is sealed like the API key (owner, step-up, audit with a fingerprint) and never appears in an error, a log, an audit row, a job, a mail, an event or a view", async () => {
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
    const s = await ownStore("t115-secret");
    const errors: string[] = [];
    const capture = (p: Promise<unknown>) => p.catch((e: unknown) => void errors.push(`${String(e)} ${JSON.stringify(e)} ${(e as Error)?.stack ?? ""}`));
    // Without a fresh step-up: refused (service and database).
    await capture(setWebhookSecret(s.me, { secret: `${SECRET}-2`, proofId: "00000000-0000-4000-8000-000000000000" }));
    expect(await code(withStore(db, s.storeId, (tx) => tx.execute(sql`update store_shipping_sync set sealed_webhook_secret = 'x', webhook_key_id = 'k'`)))).toBe("42501");
    await capture(setWebhookSecret({ ...s.me, role: "staff" }, { secret: SECRET, proofId: "x" }));
    await capture(setWebhookSecret(s.me, { secret: "short", proofId: await issueSellerStepUp(s.me, { action: "integrations.provider_key", subjectId: "mengantar_webhook" }) }));
    // The app role cannot read it back.
    expect(await code(withStore(db, s.storeId, (tx) => tx.execute(sql`select sealed_webhook_secret from store_shipping_sync`)))).toBe("42501");
    // Webhooks of every outcome, a scan, a read.
    const orderId = await booked(s, scripted([{ providerStatus: "PICKED UP" }]));
    await deliver(s, parcelBody(orderId, "PICKED UP"));
    await deliver(s, parcelBody(orderId, "PICKED UP"), { secret: "wrong-secret-000000" });
    await deliver(s, "not json");
    await run("secret");
    await scanAccount(platform, s.storeId);
    // The audit row carries the fingerprint, never the secret.
    const audit = await platform.select().from(auditLog).where(eq(auditLog.action, "provider.webhook_secret.set"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toMatch(/fingerprint=hmac:[0-9a-f]{16}/);
    const view = JSON.stringify(await shippingSync(s.me));
    // A literal scan of every table, the console and every captured error.
    const tables = (await admin.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)) as unknown as { table_name: string }[];
    const hits: string[] = [];
    for (const { table_name } of tables) {
      const [r] = (await admin.execute(sql`select count(*)::int as n from ${sql.identifier(table_name)} t where to_jsonb(t)::text like ${`%${SECRET}%`}`)) as unknown as { n: number }[];
      if (r!.n > 0) hits.push(table_name);
    }
    expect(hits).toEqual([]);
    expect([view, ...logs, ...errors].filter((x) => x.includes(SECRET))).toEqual([]);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it("Mengantar's balance and invoices are mirrored read-only with the read time; per-parcel figures only for the documented fields", async () => {
    const s = await ownStore("t115-money", { secret: null });
    expect((await shippingSync(s.me)).mirror).toEqual({ readAt: null, balanceIdr: null, invoices: [] });
    await scanAccount(platform, s.storeId);
    const m = (await shippingSync(s.me)).mirror;
    expect(m.readAt).toBeInstanceOf(Date);
    expect(m.balanceIdr).toBe(250_000);
    expect(m.invoices.map((i) => [i.invNumber, i.type, i.total])).toEqual([["FAKEINV0002", "typePayment", 50_000], ["FAKEINV0001", "typeAddBalance", 300_000]]);
    // The app role reads the mirror but cannot write it (only the scan on the store's key does).
    expect(await code(withStore(db, s.storeId, (tx) => tx.execute(sql`update store_shipping_sync set balance_idr = 1`)))).toBe("42501");
    // The live answer on a stubbed origin: documented fields only, the user block and unknown fields dropped.
    vi.stubEnv("MENGANTAR_SANDBOX_ORIGIN", "https://sandbox.example.test");
    setSellerMengantarFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/invoices")) return new Response(JSON.stringify({ success: true, data: [{ inv_number: "SS2209220816416", type: "typeWithdraw", status: "statusCleared", amount: 12345, total: 12345, createdAt: "2022-09-22T08:16:50.143Z", user: { name: "Name", email: "x@example.invalid" }, api_req_id: "632c" }], count: 1, balance: 9635676, nextCursor: "" }), { status: 200 });
      return new Response(JSON.stringify({ success: true, data: [], nextCursor: "" }), { status: 200 });
    }) as typeof fetch);
    await scanAccount(platform, s.storeId);
    const live = (await platform.select({ invoices: storeShippingSync.invoices, balance: storeShippingSync.balanceIdr }).from(storeShippingSync).where(eq(storeShippingSync.storeId, s.storeId)))[0]!;
    expect(live).toEqual({ balance: 9_635_676, invoices: [{ invNumber: "SS2209220816416", type: "typeWithdraw", status: "statusCleared", amount: 12_345, total: 12_345, createdAt: "2022-09-22T08:16:50.143Z" }] });
    vi.unstubAllEnvs();
    setSellerMengantarFetch(null);
    // Per-parcel: only the documented fields of the booking answer and the order read, never an invented one.
    expect(figuresOf({ estimatedPrice: 8000, estimatedSpecialPrice: 5600, discount: 1600, COD_FEE: 3329.99, COD_AMOUNT: 500000, GOODS_AMOUNT: "100000", returnFee: 9000, codRemittance: 1 })).toEqual({ estimatedPrice: 8000, estimatedSpecialPrice: 5600, discount: 1600, COD_FEE: 3330, COD_AMOUNT: 500000, GOODS_AMOUNT: 100000 });
    const orderId = await booked(s, scripted([{ providerStatus: "PICKED UP", figures: { COD_AMOUNT: 112_000 } }]));
    expect(await shipmentOf(orderId)).toMatchObject({ providerFigures: { estimatedPrice: 12_000, estimatedSpecialPrice: 10_800, discount: 1_200 } });
    expect((await shipmentOf(orderId)).providerFiguresAt).toBeInstanceOf(Date);
    await refreshTracking(s.me, orderId);
    await run("figures");
    expect((await shipmentOf(orderId)).providerFigures).toEqual({ estimatedPrice: 12_000, estimatedSpecialPrice: 10_800, discount: 1_200, COD_AMOUNT: 112_000 });
  });
});

describe("T-115 review fixes (2026-11-16)", () => {
  it("a provider status that is not a status code (it may name the receiver) is never stored or shown as received: status history, webhook evidence and foreign parcels keep the redaction marker", async () => {
    const s = await ownStore("t115-priv");
    const free = "Diterima oleh Budi Santoso";
    const orderId = await booked(s, scripted([{ providerStatus: free }]));
    await refreshTracking(s.me, orderId);
    await run("priv");
    expect(await platform.select({ category: shipmentStatusEvent.category, parcelState: shipmentStatusEvent.parcelState }).from(shipmentStatusEvent).where(eq(shipmentStatusEvent.source, "read"))).toEqual([{ category: "[dihapus]", parcelState: null }]);
    expect(await deliver(s, parcelBody(orderId, free))).toMatchObject({ status: 200 });
    expect(await platform.select({ c: shippingWebhookEvent.statusCategory }).from(shippingWebhookEvent)).toEqual([{ c: "[dihapus]" }]);
    fakeSellerMengantar.accounts.set(KEY, [{ providerOrderId: "FOREIGNPRIV1", trackingNumber: null, status: free, createdAt: "2026-01-01T00:00:00.000Z" }]);
    await scanAccount(platform, s.storeId);
    expect((await shippingSync(s.me)).foreign.map((f) => f.providerStatus)).toEqual(["[dihapus]"]);
    for (const shown of [free, "diterima", "[dihapus]", "PICKED UP 7"]) expect(displayableCategory(shown), shown).toBeNull();
    expect(displayableCategory("active")).toBe("active"); // a documented category, as received
    expect((await admin.execute(sql`select count(*)::int n from shipment_status_event e where e.category like ${"%Budi%"}`))[0]).toEqual({ n: 0 });
  });

  it("an unpaid booking cancelled in the store's own account is released without a resi: the shipment is cancelled, the order keeps its status, the sweep stops reading it and booking again creates a new provider order", async () => {
    const s = await ownStore("t115-unpaid", { secret: null });
    const a = scripted([{ providerStatus: "CANCELLED", trackingNumber: null, paid: false }], { unpaid: true });
    const orderId = await booked(s, a);
    expect(await shipmentOf(orderId)).toMatchObject({ status: "awaiting_balance", trackingNumber: null });
    const first = (await shipmentOf(orderId)).providerOrderId!;
    const before = (await orderOf(orderId)).status;
    await refreshTracking(s.me, orderId);
    await run("cancel-unpaid");
    expect(await shipmentOf(orderId)).toMatchObject({ status: "cancelled", providerStatus: "CANCELLED" });
    expect((await orderOf(orderId)).status).toBe(before);
    await platform.update(shipment).set({ lastTrackedAt: new Date(Date.now() - 2 * PARCEL_SWEEP_STALE_MS) }).where(eq(shipment.orderId, orderId));
    expect(await sweepParcels(platform)).toBe(0);
    setBookingAdapter(scripted());
    await bookShipment(s.me, orderId, { pickupType: "drop_off" });
    await run("rebook-unpaid");
    const again = await shipmentOf(orderId);
    expect(again).toMatchObject({ status: "booked", bookingAttempts: 1 });
    expect(again.providerOrderId).not.toBe(first);
  });

  it("money that reached the seller's own accounts is never booked or refunded by the platform: no ledger entry for an own-account COD delivery or return, no platform refund for an own-account prepaid return", async () => {
    const s = await ownStore("t115-money-boundary", { secret: null });
    await searchDestinationAreas("menteng", undefined, s.sf);
    const ledgerOf = async (orderId: number) => (await admin.execute(sql`select count(*)::int n from ledger_entry where order_id = ${orderId}`))[0]!.n;
    const refundsOf = async (orderId: number) => (await admin.execute(sql`select count(*)::int n from refund where order_id = ${orderId}`))[0]!.n;
    const read = (orderId: number) => refreshTracking(s.me, orderId).then(() => run(`r${orderId}`));
    // COD delivered on the store's own courier account: the cash is the seller's, no platform COD sale.
    const delivered = await booked(s, scripted([{ providerStatus: "DELIVERED" }]), "cod");
    await read(delivered);
    expect(await orderOf(delivered)).toMatchObject({ status: "completed" });
    expect(await ledgerOf(delivered)).toBe(0);
    // COD returned: nothing to reverse or refund on the platform.
    const cod = await booked(s, scripted([{ providerStatus: "RTS" }]), "cod");
    await read(cod);
    expect(await orderOf(cod)).toMatchObject({ status: "returned" });
    expect([await ledgerOf(cod), await refundsOf(cod)]).toEqual([0, 0]);
    // Prepaid on the store's own AutoLaris account (T-106 attempt with an account), then returned: the seller refunds, not the platform.
    const prepaid = await booked(s, scripted([{ providerStatus: "RTS" }]));
    await saveProviderKey(s.me, { provider: "autolaris", environment: "sandbox", apiKey: "autolaris-own-key-0123456789abcdef", proofId: await issueSellerStepUp(s.me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    const [attempt] = (await admin.execute(sql`select id from payment_attempt where order_id = ${prepaid}`)) as unknown as { id: string }[];
    expect(attempt).toBeDefined();
    await admin.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`); // fixture only: an attempt the store's own account settled (T-106 owns that path)
      await tx.execute(sql`update payment_attempt set payment_account_id = (select id from store_payment_account where store_id = ${s.storeId}), environment = 'sandbox', status = 'paid', paid_at = now() where id = ${attempt!.id}`);
    });
    await read(prepaid);
    expect(await orderOf(prepaid)).toMatchObject({ status: "returned" });
    expect(await refundsOf(prepaid)).toBe(0);
  });

  it("without the provider's change time, a read never moves a parcel back in the forward order of the non-final states", async () => {
    const s = await ownStore("t115-rank", { secret: null });
    const a = scripted([{ providerStatus: "ON DELIVERY" }, { providerStatus: "PICKED UP" }, { providerStatus: "UNDELIVERED" }]);
    const orderId = await booked(s, a);
    const read = async () => {
      await platform.update(shipment).set({ lastTrackedAt: new Date(Date.now() - 2 * PARCEL_SWEEP_STALE_MS) }).where(eq(shipment.orderId, orderId));
      await sweepParcels(platform, new Date(Date.now() + a.tracked * PARCEL_SWEEP_STALE_MS));
      await run(`rank${a.tracked}`);
    };
    await read();
    expect(await shipmentOf(orderId)).toMatchObject({ providerStatus: "ON DELIVERY", status: "in_transit" });
    await read(); // an older answer (no lastStatusChange): ignored
    expect(await shipmentOf(orderId)).toMatchObject({ providerStatus: "ON DELIVERY", status: "in_transit" });
    await read(); // a failed delivery attempt after the last mile started is not "backwards"
    expect(await shipmentOf(orderId)).toMatchObject({ providerStatus: "UNDELIVERED", status: "problem" });
  });

  it("while a booking's outcome is unknown, a parcel that appeared after it started can be neither marked handled nor used to release the booking: the seller links it", async () => {
    const s = await ownStore("t115-unknown-foreign", { secret: null });
    setBookingAdapter({ ...scripted(), async createOrder() { throw new MengantarError("timeout", "Mengantar timed out after 8000 ms"); } });
    const orderId = await paidOrder(s);
    await bookShipment(s.me, orderId, { pickupType: "drop_off" });
    await run("unknown");
    expect(await shipmentOf(orderId)).toMatchObject({ status: "unknown" });
    const later = new Date(Date.now() + 60_000).toISOString();
    fakeSellerMengantar.accounts.set(KEY, [
      { providerOrderId: "MAYBEMINE001", trackingNumber: "R1", status: "PENDING PICKUP", createdAt: later },
      { providerOrderId: "OLDFOREIGN01", trackingNumber: "R0", status: "DELIVERED", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await scanAccount(platform, s.storeId, new Date(Date.now() + SCAN_GRACE_MS + 120_000));
    const byId = Object.fromEntries((await shippingSync(s.me)).foreign.map((f) => [f.providerOrderId, f.id]));
    expect(await code(resolveForeignParcel(s.me, byId.MAYBEMINE001!, { note: "bukan paket saya" }))).toBe("booking_unknown_open");
    expect(await code(releaseUnknownBooking(s.me, orderId, { reason: "akun kurir sudah dicek" }))).toBe("foreign_parcel_open");
    await resolveForeignParcel(s.me, byId.OLDFOREIGN01!, { note: "paket lama sebelum toko ini" }); // older than the booking: not a candidate
    setBookingAdapter(scripted([{ providerStatus: "PENDING PICKUP", trackingNumber: "R1" }]));
    await linkUnknownBooking(s.me, orderId, { providerOrderId: "MAYBEMINE001" });
    expect((await shippingSync(s.me)).foreign).toEqual([]); // linked: Bukalaris's own now, the sync is exact again
  });

  it("an order in the account whose id cannot be read refuses the account at connection and is listed as foreign by the scan", async () => {
    vi.stubEnv("MENGANTAR_SANDBOX_ORIGIN", "https://sandbox.example.test");
    let data: unknown[] = [{ cnote_no: "X1", status: "active" }];
    setSellerMengantarFetch((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/invoices")) return new Response(JSON.stringify({ success: true, data: [], balance: 0, nextCursor: "" }), { status: 200 });
      return new Response(JSON.stringify({ success: true, data, nextCursor: "" }), { status: 200 });
    }) as typeof fetch);
    const t = await makeStore("t115-unreadable");
    const me = bindSession(t.owner, await sessionOf(t.ownerId));
    expect(await code(saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: KEY, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) }))).toBe("account_not_empty");
    data = [];
    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: KEY, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
    data = [{ ORDER_ID: "has space and !", createdAt: "2026-01-01T00:00:00.000Z" }];
    await scanAccount(platform, t.storeId);
    expect((await shippingSync(me)).foreign.map((f) => f.providerOrderId)).toEqual([UNREADABLE_ORDER_ID]);
  });
});
