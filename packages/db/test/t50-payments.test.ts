import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { paySubscription, recordSubscriptionInquiry, SUBSCRIPTION_VERIFY, type SubscriptionAttempt } from "../src/billing/attempts.ts";
import { ensureSubscriptionInvoice } from "../src/billing/invoices.ts";
import { acceptAutoLarisCallback } from "../src/billing/callback.ts";
import { failUnknownAttemptAsOperator } from "../src/billing/console.ts";
import { ATTEMPT_REPLACE_AFTER_EXPIRY_MS } from "../src/billing/settings.ts";
import { assertPaymentOwner, recordPaymentInquiry } from "../src/payments/attempts.ts";
import { PaymentContractError } from "../src/payments/contract.ts";
import { FakeAutoLaris } from "../src/payments/fake.ts";
import { setPaymentAdapter } from "../src/payments/jobs.ts";
import { paymentAttempt } from "../src/payments/schema-payments.ts";
import { callbackToken } from "../src/payments/signature.ts";
import { reconcileUnknownJobs } from "../src/ops/jobs/manage.ts";
import { job } from "../src/schema.ts";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { buyer, db, admin, platform } from "./helpers.ts";
import { attemptsOf, billingStore, billingTestSetup, type BillingStore as Store, drain, eventsOf, invoicesOf, operatorWith, providersOf, subscriptionOf } from "./t50-fixtures.ts";

// T-50 against the T-49 contract (fake AutoLaris): subscription attempts, owner-kind separation, verify-by-pull settlement, replay, expiry.
// No network, no real provider, no real secret.

billingTestSetup();


async function openPayment(s: Store, p: FakeAutoLaris, channel = "VABCA") {
  setPaymentAdapter(p);
  const r = await paySubscription(await s.sellerAt(), { channel }, providersOf(p));
  await drain(p);
  const a = (await attemptsOf(r.invoice.id)).at(-1)!;
  return { ...r, a };
}
const paidAdvice = (p: FakeAutoLaris, a: SubscriptionAttempt, over: Record<string, unknown> = {}) => p.adviceResults.set(a.transactionId!, { rc: "00", ket: "Sukses", data: { status: "PAID", amount: a.totalIdr, ...over } });
const callbackOf = (a: SubscriptionAttempt, over: Record<string, unknown> = {}) => ({ token: callbackToken(a.reffId), rawBody: JSON.stringify({ reff_id: a.reffId, trx_id: a.transactionId, amount: a.totalIdr, status: "PAID", ...over }) });
const settle = (s: Store, a: SubscriptionAttempt, raw: unknown, source: "callback" | "reconcile" = "callback") => recordSubscriptionInquiry({ exec: platform, storeId: s.storeId }, a.id, raw, { source, mode: "fake" });
const jobsOf = (kind: string) => platform.select().from(job).where(eq(job.kind, kind)).orderBy(job.id);
/** Superuser time travel on immutable columns: the guard trigger is the thing under test elsewhere, so it is lifted only around this update. */
async function expire(a: SubscriptionAttempt, msAgo = ATTEMPT_REPLACE_AFTER_EXPIRY_MS + 60_000) {
  await admin.execute(sql`alter table subscription_payment_attempt disable trigger subscription_attempt_guard`);
  try {
    await admin.execute(sql`update subscription_payment_attempt set expires_at = now() - ${msAgo} * interval '1 millisecond' where id = ${a.id}`);
  } finally {
    await admin.execute(sql`alter table subscription_payment_attempt enable trigger subscription_attempt_guard`);
  }
}
const pgCode = (p: Promise<unknown>) => p.then(() => "allowed", (e: { cause?: { code?: string } }) => e.cause?.code);

describe("owner kind separation: an order attempt never settles an invoice reference and the reverse", () => {
  it("settlement paths, the owner assertion, the callback binding and the database CHECKs all keep the two apart", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const sub = await openPayment(s, p);
    expect(p.createCalls[0]!.owner).toEqual({ kind: "subscription_invoice", id: sub.invoice.id }); // wired to the contract with the invoice owner kind

    // a real buyer order attempt of the same store
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const placed = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer", paymentChannel: "VABCA" }), providersOf(p));
    await drain(p);
    const [orderAttempt] = await platform.select().from(paymentAttempt).where(eq(paymentAttempt.orderId, placed.orderId));
    expect(orderAttempt!.ownerKind).toBe("order");

    // 1. an order attempt id is not a subscription attempt, and a subscription attempt id is not an order attempt: each settlement path refuses the other's id
    paidAdvice(p, sub.a);
    p.adviceResults.set(orderAttempt!.transactionId!, { rc: "00", data: { status: "PAID", amount: orderAttempt!.totalIdr } });
    await expect(settle(s, { ...sub.a, id: orderAttempt!.id }, p.adviceResults.get(orderAttempt!.transactionId!))).rejects.toMatchObject({ code: "not_found" });
    await expect(recordPaymentInquiry({ exec: platform, storeId: s.storeId }, sub.a.id, p.adviceResults.get(sub.a.transactionId!), { source: "callback", mode: "fake" })).rejects.toMatchObject({ code: "not_found" });
    expect((await invoicesOf(s.storeId))[0]!.status).toBe("pending"); // nothing settled by either mix-up
    // 2. the owner assertion itself, both directions
    expect(() => assertPaymentOwner(sub.a, { kind: "order", id: String(placed.orderId) })).toThrow(PaymentContractError);
    expect(() => assertPaymentOwner(sub.a, { kind: "subscription_invoice", id: "someone-else" })).toThrow(PaymentContractError);
    expect(() => assertPaymentOwner(orderAttempt!, { kind: "subscription_invoice", id: sub.invoice.id })).toThrow(PaymentContractError);
    expect(() => assertPaymentOwner(sub.a, { kind: "subscription_invoice", id: sub.invoice.id })).not.toThrow();
    // 3. the signed reference of one kind cannot carry the body of the other
    const wrongBody = { token: callbackToken(orderAttempt!.reffId), rawBody: JSON.stringify({ reff_id: sub.a.reffId, amount: sub.a.totalIdr }) };
    await expect(acceptAutoLarisCallback(db, wrongBody)).rejects.toMatchObject({ code: "binding" });
    const wrongBody2 = { token: callbackToken(sub.a.reffId), rawBody: JSON.stringify({ reff_id: orderAttempt!.reffId, amount: orderAttempt!.totalIdr }) };
    await expect(acceptAutoLarisCallback(db, wrongBody2)).rejects.toMatchObject({ code: "binding" });
    // each reference reaches its own verification job kind
    await acceptAutoLarisCallback(db, callbackOf(sub.a));
    await acceptAutoLarisCallback(db, { token: callbackToken(orderAttempt!.reffId), rawBody: JSON.stringify({ reff_id: orderAttempt!.reffId, amount: orderAttempt!.totalIdr }) });
    expect(await jobsOf(SUBSCRIPTION_VERIFY)).toHaveLength(1);
    expect(await jobsOf("payment.verify")).toHaveLength(1);
    // 4. the database: owner kind and id are CHECKs on both tables
    expect(await pgCode(platform.execute(sql`update payment_attempt set owner_kind = 'subscription_invoice' where id = ${orderAttempt!.id}`))).toBe("23514");
    expect(await pgCode(admin.execute(sql`update subscription_payment_attempt set owner_kind = 'order' where id = ${sub.a.id}`))).toBe("23514");
    expect(await pgCode(admin.execute(sql`update subscription_payment_attempt set owner_id = '1' where id = ${sub.a.id}`))).toBe("23514");
  });
});

describe("instruction creation: committed intent first, one fenced /submit, a timeout is an uncertain outcome and never a second bill", () => {
  it("wave 3 review: a period whose end has passed cannot be paid by invoice id either (no back-billing)", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    setPaymentAdapter(p);
    const first = await paySubscription(await s.sellerAt(), { channel: "QRIS" }, providersOf(p));
    const lapsed = new Date(Date.now() + 40 * 86_400_000); // period 0 ended 30 days after the anchor
    await expect(paySubscription(await s.sellerAt(lapsed), { channel: "QRIS", invoiceId: first.invoice.id, now: lapsed }, providersOf(p))).rejects.toMatchObject({ code: "period_lapsed" });
  });

  it("Pay commits invoice, attempt and job intent before any provider call; the worker then creates exactly one instruction with the stored reference", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    setPaymentAdapter(p);
    const r = await paySubscription(await s.sellerAt(), { channel: "QRIS" }, providersOf(p));
    expect(p.createCalls).toHaveLength(0);
    expect(r.attempt).toMatchObject({ requestState: "in_progress", status: "pending", amountIdr: 175000, adminFeeIdr: 0, totalIdr: 175000, ownerKind: "subscription_invoice" });
    expect(r.attempt.reffId).toMatch(/^\d{29}$/);
    expect(r.attempt.localReference).toMatch(/^SUB-[0-9A-Z]{9}[0-9A-F]{3}$/);
    await drain(p);
    await drain(p);
    expect(p.createCalls).toHaveLength(1);
    expect(p.createCalls[0]!.reffId).toBe(r.attempt.reffId); // the persisted reference, never a new one
    expect(p.createCalls[0]!.channelCode).toBe("QRIS"); // a real channel code
    const a = (await attemptsOf(r.invoice.id))[0]!;
    expect(a.requestState).toBe("accepted");
    expect(a.instruction?.qr).toBe("000201010212\n  QRIS-BYTES-UNCHANGED-6304ABCD "); // preserved byte for byte
    expect(new URL(p.createCalls[0]!.callbackUrl).searchParams.get("cb")).toBe(callbackToken(a.reffId)); // signed reference of THIS attempt
  });

  it("only the provider's channel list and the real subscription channel codes are accepted (a bare bank name, a fee-less e-wallet or an unlisted channel is refused before anything is stored)", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const seller = await s.sellerAt();
    for (const channel of ["BCA", "OVO", "COD", "MYSTERY", ""]) await expect(paySubscription(seller, { channel }, providersOf(p))).rejects.toMatchObject({ code: "payment_channel" });
    p.channels = { rc: "00", data: [{ channel_code: "QRIS", name: "QRIS", admin: "0.7", tipe_admin: "persen" }] };
    await expect(paySubscription(seller, { channel: "VABCA" }, providersOf(p))).rejects.toMatchObject({ code: "payment_channel" }); // VABCA absent from the list = disabled
    expect(await invoicesOf(s.storeId)).toHaveLength(0);
    expect(p.createCalls).toHaveLength(0);
  });

  it("a timeout after dispatch leaves the attempt unknown AND live: Pay again returns the same attempt, no second bill, and the fake recovers it by reference", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    p.crashAfterCreate = true;
    setPaymentAdapter(p);
    const first = await paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p));
    await drain(p);
    const [unknown] = await attemptsOf(first.invoice.id);
    expect(unknown!.requestState).toBe("unknown");
    const again = await paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p));
    await drain(p);
    expect(again.attempt.id).toBe(first.attempt.id);
    expect(again.attemptCreated).toBe(false);
    expect(p.createCalls).toHaveLength(1); // never re-dispatched
    expect(await attemptsOf(first.invoice.id)).toHaveLength(1);
    p.crashAfterCreate = false;
    await reconcileUnknownJobs(platform);
    expect((await attemptsOf(first.invoice.id))[0]!.requestState).toBe("accepted"); // reconciled by the reference, still one bill
    expect(p.createCalls).toHaveLength(1);
  });

  it("a provider that never received the request stays unknown for an operator; only a billing.manage operator can release it, with a reason, and then Pay creates a new controlled attempt on the SAME invoice", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    p.down = true;
    setPaymentAdapter(p);
    const first = await paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p));
    await drain(p);
    expect((await attemptsOf(first.invoice.id))[0]!.requestState).toBe("unknown");
    p.down = false;
    // the fake can recover only a bill that exists; none does, so the unknown outcome persists
    await reconcileUnknownJobs(platform);
    const blocked = await paySubscription(await s.sellerAt(), { channel: "QRIS" }, providersOf(p));
    expect(blocked.attempt.id).toBe(first.attempt.id);
    await expect(failUnknownAttemptAsOperator(await operatorWith("billing.read"), { attemptId: first.attempt.id, storeId: s.storeId, reason: "tanpa izin" })).rejects.toMatchObject({ code: "forbidden" });
    await failUnknownAttemptAsOperator(await operatorWith("billing.manage"), { attemptId: first.attempt.id, storeId: s.storeId, reason: "dicek di dasbor penyedia: tidak ada tagihan" });
    const second = await paySubscription(await s.sellerAt(), { channel: "QRIS" }, providersOf(p));
    expect(second.invoice.id).toBe(first.invoice.id);
    expect(second.attempt.id).not.toBe(first.attempt.id);
    expect(second.attempt.reffId).not.toBe(first.attempt.reffId);
    const live = (await attemptsOf(first.invoice.id)).filter((a) => ["pending", "unknown"].includes(a.status) && a.requestState !== "failed");
    expect(live).toHaveLength(1);
  });

  it("a logical rejection ends the attempt as failed (frees the invoice), and the next Pay creates a new attempt with a new reference on the same invoice", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    p.createResult = { rc: "05", ket: "ditolak" };
    setPaymentAdapter(p);
    const first = await paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p));
    await drain(p);
    expect((await attemptsOf(first.invoice.id))[0]!.requestState).toBe("failed");
    p.createResult = undefined;
    const second = await paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p));
    await drain(p);
    expect(second.invoice.id).toBe(first.invoice.id);
    expect(second.attempt.reffId).not.toBe(first.attempt.reffId);
    expect((await attemptsOf(first.invoice.id)).map((a) => a.requestState)).toEqual(["failed", "accepted"]);
  });

  it("double Pay, concurrently, returns one attempt and enqueues one instruction job", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const results = await Promise.all(Array.from({ length: 8 }, async () => paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p))));
    expect(new Set(results.map((r) => r.attempt.id)).size).toBe(1);
    expect(results.filter((r) => r.attemptCreated)).toHaveLength(1);
    expect(await jobsOf("subscription.instruction")).toHaveLength(1);
    await drain(p);
    expect(p.createCalls).toHaveLength(1);
  });
});

describe("settlement: only a pulled rc 00 + PAID + the attempt's own total is paid; replay and concurrency settle and extend coverage ONCE", () => {
  it("a verified payment marks invoice and attempt paid, covers exactly the invoice's stored period and makes the subscription active", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const { a, invoice } = await openPayment(s, p);
    expect((await subscriptionOf(s.storeId)).status).toBe("trial");
    paidAdvice(p, a);
    await acceptAutoLarisCallback(db, callbackOf(a));
    await drain(p);
    const sub = await subscriptionOf(s.storeId);
    expect(sub.status).toBe("active");
    expect(sub.currentPeriodEnd!.toISOString()).toBe(new Date(Date.parse(`${invoice.periodEnd}T00:00:00Z`) - 7 * 3_600_000).toISOString()); // period end, 00:00 WIB
    expect(sub.currentPeriodStart!.toISOString()).toBe(new Date(Date.parse(`${invoice.periodStart}T00:00:00Z`) - 7 * 3_600_000).toISOString());
    const [inv] = await invoicesOf(s.storeId);
    expect(inv).toMatchObject({ status: "paid", settlementSource: "provider" });
    expect(inv!.coverageAppliedAt).not.toBeNull();
    expect((await attemptsOf(invoice.id))[0]).toMatchObject({ status: "paid" });
    expect(await eventsOf(s.storeId, "coverage_applied")).toHaveLength(1);
  });

  it("a callback alone (even with PAID and the right amount) changes nothing: it only enqueues the verification, which pulls the provider", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const { a, invoice } = await openPayment(s, p);
    const before = await subscriptionOf(s.storeId);
    expect((await acceptAutoLarisCallback(db, callbackOf(a))).outcome).toBe("accepted");
    expect((await invoicesOf(s.storeId))[0]!.status).toBe("pending");
    expect(await subscriptionOf(s.storeId)).toEqual(before);
    await drain(p); // the provider still says pending (rc 02): the pull decides, and it does not settle
    expect((await invoicesOf(s.storeId))[0]!.status).toBe("pending");
    expect(p.adviceCalls).toEqual([a.transactionId]);
    expect((await attemptsOf(invoice.id))[0]!.status).toBe("pending");
  });

  it("a payment return is not settlement: the browser returning to the page, or a callback body claiming PAID with a wrong amount, never settle", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const { a } = await openPayment(s, p);
    await expect(acceptAutoLarisCallback(db, callbackOf(a, { amount: a.totalIdr - 1 }))).rejects.toMatchObject({ code: "amount" });
    await expect(acceptAutoLarisCallback(db, { token: "bad.token", rawBody: "{}" })).rejects.toBeInstanceOf(PaymentContractError);
    expect(await jobsOf(SUBSCRIPTION_VERIFY)).toHaveLength(0);
    expect((await invoicesOf(s.storeId))[0]!.status).toBe("pending");
  });

  it("exact amount: the provider amount one rupiah off, a generic status word, a delivery word, a wrong rc and a pending answer never settle", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const { a } = await openPayment(s, p);
    const answers: unknown[] = [
      { rc: "00", data: { status: "PAID", amount: a.totalIdr - 1 } },
      { rc: "00", data: { status: "PAID", amount: a.totalIdr + 1 } },
      { rc: "00", data: { status: "PAID", amount: String(a.totalIdr + 1) } },
      { rc: "00", data: { status: "SUCCESS", amount: a.totalIdr } },
      { rc: "00", data: { status: "DELIVERED", amount: a.totalIdr } },
      { rc: "01", data: { status: "PAID", amount: a.totalIdr } },
      { rc: "02", ket: "FAILED" },
      null,
      "PAID",
    ];
    for (const raw of answers) expect((await settle(s, a, raw)).coverageApplied).toBe(false);
    expect((await invoicesOf(s.storeId))[0]!.status).toBe("pending");
    expect((await subscriptionOf(s.storeId)).currentPeriodEnd).toBeNull();
    expect((await settle(s, a, { rc: "00", data: { status: "PAID", amount: a.totalIdr } })).coverageApplied).toBe(true); // and the exact answer does
  });

  it("replay: the same callback, the same verification and a late reconcile, delivered many times and concurrently, settle and extend coverage once", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const { a } = await openPayment(s, p);
    paidAdvice(p, a);
    const raw = p.adviceResults.get(a.transactionId!);
    const results = await Promise.all([...Array.from({ length: 6 }, () => settle(s, a, raw)), ...Array.from({ length: 4 }, () => settle(s, a, raw, "reconcile"))]);
    expect(results.filter((r) => r.coverageApplied)).toHaveLength(1);
    await settle(s, a, raw);
    await acceptAutoLarisCallback(db, callbackOf(a));
    await acceptAutoLarisCallback(db, callbackOf(a)); // identical body: a recorded no-op
    await drain(p);
    const sub = await subscriptionOf(s.storeId);
    const end = sub.currentPeriodEnd!.getTime();
    expect(await eventsOf(s.storeId, "coverage_applied")).toHaveLength(1);
    expect(await eventsOf(s.storeId, "attempt_paid")).toHaveLength(1);
    expect((await eventsOf(s.storeId, "status_changed")).filter((e) => e.to_status === "active")).toHaveLength(1); // to active exactly once
    await settle(s, a, raw);
    expect((await subscriptionOf(s.storeId)).currentPeriodEnd!.getTime()).toBe(end);
  });

  it("the settlement enabled flag of the T-49 contract holds: a LIVE adapter settles nothing until the owner enables a vendor status in writing", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const { a } = await openPayment(s, p);
    const r = await recordSubscriptionInquiry({ exec: platform, storeId: s.storeId }, a.id, { rc: "00", data: { status: "PAID", amount: a.totalIdr } }, { source: "callback", mode: "live" });
    expect(r).toMatchObject({ classification: "paid", applied: false, coverageApplied: false });
    expect((await invoicesOf(s.storeId))[0]!.status).toBe("pending");
    const poll = await settle(s, a, { rc: "00", data: { status: "PAID", amount: a.totalIdr } }, "reconcile");
    expect(poll.coverageApplied).toBe(true); // the fake adapter exercises the whole path
  });

  it("coverage is never back-dated or shortened: paying period 1 before period 0 covers exactly period 1, and a later payment of period 0 does not move the end backwards", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const seller = await s.sellerAt();
    setPaymentAdapter(p);
    const i1 = await ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "operator", actor: "op", periodIndex: 1, now: new Date(Date.now() + 31 * 86_400_000) });
    const i0 = await ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "operator", actor: "op", periodIndex: 0 });
    if (i0.kind !== "invoice" || i1.kind !== "invoice") throw new Error("expected invoices");
    const first = await paySubscription(seller, { channel: "VABCA", invoiceId: i1.invoice.id }, providersOf(p));
    await drain(p);
    const a1 = (await attemptsOf(first.invoice.id))[0]!;
    await settle(s, a1, { rc: "00", data: { status: "PAID", amount: a1.totalIdr } });
    const end1 = (await subscriptionOf(s.storeId)).currentPeriodEnd!.getTime();
    const second = await paySubscription(seller, { channel: "QRIS", invoiceId: i0.invoice.id }, providersOf(p));
    await drain(p);
    const a0 = (await attemptsOf(second.invoice.id))[0]!;
    await settle(s, a0, { rc: "00", data: { status: "PAID", amount: a0.totalIdr } });
    expect((await subscriptionOf(s.storeId)).currentPeriodEnd!.getTime()).toBe(end1);
    expect((await invoicesOf(s.storeId)).map((i) => [i.periodIndex, i.status])).toEqual([[0, "paid"], [1, "paid"]]);
  });
});

describe("expired instructions: a new controlled attempt on the same invoice, never a second invoice, never two live instructions", () => {
  it("after the expiry and the safety margin Pay replaces the instruction (same invoice, new reference, old one expired); before it, the live instruction is reused", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const first = await openPayment(s, p);
    const reused = await paySubscription(await s.sellerAt(), { channel: "QRIS" }, providersOf(p));
    expect(reused.attempt.id).toBe(first.a.id); // pending instructions are reused, whatever channel the second click asked for
    await expire(first.a, 1_000); // expired, but inside the safety margin
    expect((await paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p))).attempt.id).toBe(first.a.id);
    await expire(first.a);
    const replaced = await paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p));
    await drain(p);
    expect(replaced.invoice.id).toBe(first.invoice.id);
    expect(replaced.attempt.id).not.toBe(first.a.id);
    expect(replaced.attempt.reffId).not.toBe(first.a.reffId);
    const all = await attemptsOf(first.invoice.id);
    expect(all.map((a) => a.status)).toEqual(["expired", "pending"]);
    expect(await invoicesOf(s.storeId)).toHaveLength(1);
    expect(await eventsOf(s.storeId, "attempt_expired")).toHaveLength(1);
  });

  it("concurrent Pay clicks on an expired instruction create exactly one replacement", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const first = await openPayment(s, p);
    await expire(first.a);
    const results = await Promise.all(Array.from({ length: 8 }, async () => paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p))));
    expect(new Set(results.map((r) => r.attempt.id)).size).toBe(1);
    expect(results[0]!.attempt.id).not.toBe(first.a.id);
    const live = (await attemptsOf(first.invoice.id)).filter((a) => ["pending", "unknown"].includes(a.status) && a.requestState !== "failed");
    expect(live).toHaveLength(1);
  });

  it("the database refuses to expire an attempt before its expiry instant, and refuses two live attempts for one invoice", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const { a, invoice } = await openPayment(s, p);
    expect(await pgCode(platform.execute(sql`update subscription_payment_attempt set status = 'expired' where id = ${a.id}`))).toBe("23514");
    const dup = platform.execute(sql`insert into subscription_payment_attempt (store_id, invoice_id, owner_id, local_reference, reff_id, channel_code, customer, amount_idr, admin_fee_idr, total_idr, expires_at, created_by)
      values (${s.storeId}, ${invoice.id}, ${invoice.id}::text, 'SUB-000000000AAA', '1', 'VABCA', '{"id":"1","name":"x","phone":"0800000000","email":null}'::jsonb, 175000, 0, 175000, now() + interval '1 day', 'raw')`);
    expect(await pgCode(dup)).toBe("23505");
  });

  it("a late payment of an EXPIRED attempt is still money received and settles once; the replacement's later payment extends nothing and leaves a duplicate-payment event", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const first = await openPayment(s, p);
    await expire(first.a);
    const replaced = await paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p));
    await drain(p);
    const second = (await attemptsOf(first.invoice.id)).find((x) => x.id === replaced.attempt.id)!;
    const old = (await attemptsOf(first.invoice.id)).find((x) => x.id === first.a.id)!;
    expect(old.status).toBe("expired");
    expect((await settle(s, old, { rc: "00", data: { status: "PAID", amount: old.totalIdr } })).coverageApplied).toBe(true);
    const end = (await subscriptionOf(s.storeId)).currentPeriodEnd!.getTime();
    const dup = await settle(s, second, { rc: "00", data: { status: "PAID", amount: second.totalIdr } });
    expect(dup).toMatchObject({ coverageApplied: false, duplicate: true });
    expect((await subscriptionOf(s.storeId)).currentPeriodEnd!.getTime()).toBe(end);
    expect(await eventsOf(s.storeId, "payment_on_covered_invoice")).toHaveLength(1);
    expect(await eventsOf(s.storeId, "coverage_applied")).toHaveLength(1);
    // an expired attempt answered "pending" stays expired (it does not become live again)
    const third = await billingStore("toko-b");
    const q = new FakeAutoLaris();
    const t = await openPayment(third, q);
    await expire(t.a);
    await paySubscription(await third.sellerAt(), { channel: "VABCA" }, providersOf(q));
    await expect(settle(third, t.a, { rc: "02" })).resolves.toMatchObject({ applied: false });
    expect((await attemptsOf(t.invoice.id)).find((x) => x.id === t.a.id)!.status).toBe("expired");
  });

  it("a payment arriving for a void invoice extends nothing and is recorded for a refund decision", async () => {
    const s = await billingStore("toko-a");
    const p = new FakeAutoLaris();
    const { a, invoice } = await openPayment(s, p);
    await admin.execute(sql`update subscription_invoice set status = 'void', voided_at = now(), void_reason = 'dibatalkan' where id = ${invoice.id}`);
    const r = await settle(s, a, { rc: "00", data: { status: "PAID", amount: a.totalIdr } });
    expect(r).toMatchObject({ applied: true, coverageApplied: false });
    expect(await eventsOf(s.storeId, "payment_on_void_invoice")).toHaveLength(1);
    expect((await subscriptionOf(s.storeId)).currentPeriodEnd).toBeNull();
  });
});
