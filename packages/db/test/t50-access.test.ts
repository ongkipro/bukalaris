import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { billingAccess } from "../src/billing/access.ts";
import { paySubscription, recordSubscriptionInquiry } from "../src/billing/attempts.ts";
import { runBillingCycle } from "../src/billing/cycle.ts";
import { listInvoices } from "../src/billing/invoices.ts";
import { BILLING_READ_ONLY_ALLOWED, DomainError, requireCap, SELLER_CAPABILITIES } from "../src/platform/scoped.ts";
import { createInvitation } from "../src/platform/accounts.ts";
import { setStoreStatus } from "../src/platform/platform.ts";
import { FakeAutoLaris } from "../src/payments/fake.ts";
import { setPaymentAdapter } from "../src/payments/jobs.ts";
import { createProduct, listProducts, updateProduct } from "../src/seller/commerce/catalog.ts";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import { adjustStock, getOrder, listOrders, transitionOrder } from "../src/seller/commerce/orders.ts";
import { exportBuyerData, findBuyerOrders } from "../src/seller/commerce/privacy.ts";
import { setPickupArea } from "../src/shipping/shipping.ts";
import { createChannel } from "../src/storefront/channels.ts";
import { getStoreSettings, updateStoreSettings } from "../src/storefront/content.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { store } from "../src/schema.ts";
import { storefrontScope } from "../src/platform/scoped.ts";
import { buyer, db, makeOperator, PICKUP_AREA, platform, admin } from "./helpers.ts";
import { attemptsOf, billingStore, type BillingStore, billingTestSetup, drain, eventsOf, providersOf, sellerAs, setSubscription, subscriptionOf } from "./t50-fixtures.ts";

// T-50 access policy (BILL-7, UX-18, IAM-5): trial/active/past_due/suspended arithmetic at the instants, enforced on the server's write paths,
// with data, storefront, checkout, billing and the data export kept usable, and the operator restriction independent of billing.

billingTestSetup();
const DAY = 86_400_000;
const code = (p: Promise<unknown>) => p.then(() => "allowed", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);

describe("trial, active, past_due and suspended at the exact instants (Asia/Jakarta anchor), seen by the seller scope", () => {
  it("writes are allowed up to, and refused from, the trial end instant; past_due lasts exactly the grace days; the stored state follows the evaluator", async () => {
    const s = await billingStore("toko-a");
    const sub = await subscriptionOf(s.storeId);
    expect(sub.status).toBe("trial");
    const end = sub.trialEndsAt.getTime();
    const before = await billingAccess({ exec: db, storeId: s.storeId }, new Date(end - 1));
    const at = await billingAccess({ exec: db, storeId: s.storeId }, new Date(end));
    const lastGrace = await billingAccess({ exec: db, storeId: s.storeId }, new Date(end + 3 * DAY - 1));
    const graceOver = await billingAccess({ exec: db, storeId: s.storeId }, new Date(end + 3 * DAY));
    expect([before.state, at.state, lastGrace.state, graceOver.state]).toEqual(["trial", "past_due", "past_due", "suspended"]);
    expect([before.writable, at.writable, lastGrace.writable, graceOver.writable]).toEqual([true, false, false, false]);
    expect(at.pastDueAt!.getTime()).toBe(end);
    expect(at.graceEndsAt!.getTime()).toBe(end + 3 * DAY);
    // the cron persists exactly that, once
    await runBillingCycle(platform, { now: new Date(end) });
    const stored = await subscriptionOf(s.storeId);
    expect(stored).toMatchObject({ status: "past_due" });
    expect(stored.pastDueAt!.getTime()).toBe(end);
    expect(stored.graceEndsAt!.getTime()).toBe(end + 3 * DAY);
    await runBillingCycle(platform, { now: new Date(end + 3 * DAY) });
    expect((await subscriptionOf(s.storeId)).status).toBe("suspended");
    expect((await eventsOf(s.storeId, "status_changed")).map((e) => [e.from_status, e.to_status])).toEqual([["trial", "past_due"], ["past_due", "suspended"]]);
  });

  it("a store created at 03:00 WIB on the 29th (still the 28th in UTC) anchors on the Jakarta date, and the first paid period starts there", async () => {
    const s = await billingStore("toko-a");
    await setSubscription(s.storeId, { trialEndsAt: new Date("2026-10-28T20:30:00Z") }); // 29 Oct 03:30 WIB
    expect((await subscriptionOf(s.storeId)).billingAnchorDate).toBe("2026-10-29");
    expect(await code(admin.execute(sql`update store_subscription set billing_anchor_date = '2030-01-01' where store_id = ${s.storeId}`))).toBe("23514"); // CHECK: the anchor is the Jakarta date of the trial end
    expect(await code(platform.execute(sql`update store_subscription set trial_ends_at = now() where store_id = ${s.storeId}`))).toBe("23514"); // write-once (trigger) and the anchor would no longer match
  });
});

describe("Seller Admin is read-only from past_due, on every write path, and nothing is deleted", () => {
  it("every capability is either one of the read/billing/data-protection ones or refused with billing_read_only (a capability added later fails closed)", async () => {
    const s = await billingStore("toko-a");
    const late = await s.sellerAt(new Date(Date.now() + 4 * DAY));
    expect(late.billing.state).toBe("past_due");
    const outcomes = Object.fromEntries(SELLER_CAPABILITIES.map((cap) => [cap, (() => { try { requireCap(late, cap); return "allowed"; } catch (e) { return (e as DomainError).code; } })()]));
    for (const cap of SELLER_CAPABILITIES) {
      expect(outcomes[cap], cap).toBe(BILLING_READ_ONLY_ALLOWED.includes(cap) ? "allowed" : "billing_read_only");
    }
    expect([...BILLING_READ_ONLY_ALLOWED].sort()).toEqual(["affiliate.read", "billing.pay", "billing.read", "carts.read", "catalog.read", "finance.read", "orders.read", "privacy.manage", "promotions.read", "shipping.read"]);
    expect(outcomes["finance.payout"]).toBe("billing_read_only"); // the payout request is a write: refused while unpaid (owner decision on netting is deferred in TASKS)
    const now = await s.sellerAt();
    for (const cap of SELLER_CAPABILITIES) expect(() => requireCap(now, cap), cap).not.toThrow(); // an active trial: the owner may do everything
  });

  it("direct service calls are denied for catalog, inventory, orders, members, shipping, channels and settings; reads and the buyer-data export still work; data is retained", async () => {
    const s = await billingStore("toko-a");
    const trial = await s.sellerAt();
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const placed = await placeOrder(db, cartId, buyer(), providersOf(new FakeAutoLaris()));
    const late = await s.sellerAt(new Date(Date.now() + 4 * DAY));
    const refused = async (p: Promise<unknown>) => expect(await code(p)).toBe("billing_read_only");
    await refused(createProduct(late, { title: "Baru", status: "draft", variant: { title: "M", price: 1000, stock: 1, weightGrams: 100 } }));
    await refused(updateProduct(late, s.productId, { title: "Ubah", status: "active" }));
    await refused(adjustStock(late, s.variantId, { delta: 1, reason: "tambah" }));
    await refused(transitionOrder(late, placed.orderId, "confirm"));
    await refused(createInvitation(late, { send: async () => {} }, { email: "x@y.test", role: "staff" }, (t) => t));
    await refused(setPickupArea(late, PICKUP_AREA));
    await refused(createChannel(late, { name: "api" }));
    await refused(updateStoreSettings(late, { name: "Nama Baru", description: "", whatsapp: "", theme: "responsive" }));
    // the same calls succeed while the trial runs (not vacuous: the refusal is the billing state, not the payload)
    await expect(updateStoreSettings(trial, { name: "Nama Baru", description: "", whatsapp: "", theme: "responsive" })).resolves.toBeUndefined();
    // reads, the order's own data and the buyer-data export are NOT locked (erasure is the same `privacy.manage` capability, asserted above)
    expect((await listProducts(late)).length).toBe(1);
    expect((await listOrders(late)).orders).toHaveLength(1);
    expect((await getOrder(late, placed.orderId))!.id).toBe(placed.orderId);
    expect((await getStoreSettings(late)).name).toBe("Nama Baru");
    expect((await findBuyerOrders(late, "081234567890")).orders).toHaveLength(1);
    expect((await exportBuyerData(late, "081234567890")).orders).toHaveLength(1);
    // nothing was deleted by the restriction
    expect((await platform.execute(sql`select (select count(*) from product where store_id = ${s.storeId})::int as p, (select count(*) from "order" where store_id = ${s.storeId})::int as o`))[0]).toMatchObject({ p: 1, o: 1 });
  });

  it("billing and payment stay usable in read-only mode: invoices can be listed and paid, and the payment restores writes", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    setPaymentAdapter(p);
    const later = new Date(Date.now() + 4 * DAY);
    const late = await s.sellerAt(later);
    expect(late.billing.writable).toBe(false);
    const r = await paySubscription(late, { channel: "VABCA", now: later }, providersOf(p));
    expect(r.invoice.periodIndex).toBe(0);
    expect((await listInvoices(db, s.storeId)).map((i) => i.id)).toEqual([r.invoice.id]);
    await drain(p);
    const a = (await attemptsOf(r.invoice.id))[0]!;
    await recordSubscriptionInquiry({ exec: platform, storeId: s.storeId }, a.id, { rc: "00", data: { status: "PAID", amount: a.totalIdr } }, { source: "reconcile", mode: "fake", now: later });
    const restored = await s.sellerAt(later);
    expect(restored.billing).toMatchObject({ state: "active", writable: true });
    await expect(createProduct(restored, { title: "Lagi", status: "draft", variant: { title: "M", price: 1000, stock: 1, weightGrams: 100 } })).resolves.toBeTypeOf("number");
  });

  it("coverage that has ended is not restored by a payment of a period that ended too: writes return only while the covered end is in the future", async () => {
    const s = await billingStore("toko-a");
    await setSubscription(s.storeId, { trialEndsAt: new Date(Date.now() - 50 * DAY) });
    await setSubscription(s.storeId, { currentPeriodStart: new Date(Date.now() - 40 * DAY), currentPeriodEnd: new Date(Date.now() - 10 * DAY) });
    const access = await billingAccess({ exec: db, storeId: s.storeId });
    expect(access.writable).toBe(false); // covered through a past instant is not covered
    expect(["past_due", "suspended"]).toContain(access.state);
    await setSubscription(s.storeId, { currentPeriodEnd: new Date(Date.now() + 10 * DAY), currentPeriodStart: new Date(Date.now() - 20 * DAY) });
    expect((await billingAccess({ exec: db, storeId: s.storeId })).state).toBe("active");
  });
});

describe("billing debt never touches the storefront or checkout; only the independent operator restriction does; the two never move each other", () => {
  async function checkout(s: BillingStore, p = new FakeAutoLaris()) {
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    return placeOrder(db, cartId, buyer(), providersOf(p));
  }

  it("a store in past_due and in billing-suspended still serves its storefront and takes buyer orders", async () => {
    const s = await billingStore("toko-a");
    await setSubscription(s.storeId, { trialEndsAt: new Date(Date.now() - 2 * DAY) });
    await runBillingCycle(platform);
    expect((await subscriptionOf(s.storeId)).status).toBe("past_due");
    expect(await storefrontScope(db, "toko-a")).not.toBeNull();
    await expect(checkout(s)).resolves.toMatchObject({ replayed: false });
    await setSubscription(s.storeId, { trialEndsAt: new Date(Date.now() - 20 * DAY) });
    await runBillingCycle(platform);
    expect((await subscriptionOf(s.storeId)).status).toBe("suspended");
    expect(await storefrontScope(db, "toko-a")).not.toBeNull();
    await expect(checkout(s)).resolves.toMatchObject({ replayed: false });
  });

  it("operator suspension refuses new buyer checkout and sets suspended_at with the status; lifting it clears it, restores checkout and does NOT clear a debt", async () => {
    const s = await billingStore("toko-a");
    const op = await makeOperator();
    await setSubscription(s.storeId, { trialEndsAt: new Date(Date.now() - 20 * DAY) });
    await runBillingCycle(platform);
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await setStoreStatus(op, s.storeId, { status: "suspended", reason: "pelanggaran kebijakan" });
    const [row] = await platform.select({ status: store.status, suspendedAt: store.suspendedAt }).from(store).where(eq(store.id, s.storeId));
    expect(row!.status).toBe("suspended");
    expect(row!.suspendedAt).toBeInstanceOf(Date);
    await expect(placeOrder(db, cartId, buyer(), providersOf(new FakeAutoLaris()))).rejects.toMatchObject({ code: "store_unavailable" });
    const debt = await subscriptionOf(s.storeId);
    await setStoreStatus(op, s.storeId, { status: "active", reason: "pelanggaran selesai ditinjau" });
    expect((await platform.select({ suspendedAt: store.suspendedAt }).from(store).where(eq(store.id, s.storeId)))[0]!.suspendedAt).toBeNull();
    expect(await subscriptionOf(s.storeId)).toEqual(debt); // lifting changed no billing field
    await expect(placeOrder(db, cartId, buyer(), providersOf(new FakeAutoLaris()))).resolves.toMatchObject({ replayed: false }); // checkout is back
    const owner = await sellerAs(s.ownerId, s.storeId);
    expect(owner.billing.writable).toBe(false); // Seller Admin stays read-only while unpaid
    expect(await code(createProduct(owner, { title: "x", status: "draft", variant: { title: "M", price: 1, stock: 1, weightGrams: 1 } }))).toBe("billing_read_only");
  });

  it("a payment verified while the store is operator-suspended updates coverage and never clears the operator timestamp, which cannot be written on its own", async () => {
    const s = await billingStore("toko-a");
    const op = await makeOperator();
    const p = new FakeAutoLaris();
    setPaymentAdapter(p);
    const r = await paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p)); // the instruction exists before the suspension
    await drain(p);
    await setStoreStatus(op, s.storeId, { status: "suspended", reason: "tinjauan keamanan" });
    const [{ suspendedAt }] = await platform.select({ suspendedAt: store.suspendedAt }).from(store).where(eq(store.id, s.storeId));
    const a = (await attemptsOf(r.invoice.id))[0]!;
    const paid = await recordSubscriptionInquiry({ exec: platform, storeId: s.storeId }, a.id, { rc: "00", data: { status: "PAID", amount: a.totalIdr } }, { source: "callback", mode: "fake" });
    expect(paid.coverageApplied).toBe(true);
    expect((await subscriptionOf(s.storeId)).status).toBe("active"); // financial coverage updated
    const [after] = await platform.select({ status: store.status, suspendedAt: store.suspendedAt }).from(store).where(eq(store.id, s.storeId));
    expect(after).toEqual({ status: "suspended", suspendedAt }); // the operator restriction is untouched
    await expect(placeOrder(db, await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add").catch(() => "00000000-0000-4000-8000-000000000000"), buyer(), providersOf(p))).rejects.toBeInstanceOf(DomainError); // checkout still refused
    // the timestamp cannot be cleared on its own: the trigger keeps it with the status
    await platform.update(store).set({ suspendedAt: null }).where(eq(store.id, s.storeId));
    expect((await platform.select({ suspendedAt: store.suspendedAt }).from(store).where(eq(store.id, s.storeId)))[0]!.suspendedAt?.getTime()).toBe(suspendedAt!.getTime());
  });

  it("the invariant status <-> suspended_at is a CHECK too (a row whose trigger is bypassed still cannot disagree)", async () => {
    const s = await billingStore("toko-a");
    await admin.execute(sql`alter table store disable trigger store_suspension_sync`);
    try {
      expect(await code(admin.execute(sql`update store set status = 'suspended' where id = ${s.storeId}`))).toBe("23514");
      expect(await code(admin.execute(sql`update store set suspended_at = now() where id = ${s.storeId}`))).toBe("23514");
    } finally {
      await admin.execute(sql`alter table store enable trigger store_suspension_sync`);
    }
  });
});
