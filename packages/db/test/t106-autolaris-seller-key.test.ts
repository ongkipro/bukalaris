import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paySubscription } from "../src/billing/attempts.ts";
import { issueSellerStepUp } from "../src/ledger/stepup.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { acceptPaymentCallback } from "../src/payments/callback.ts";
import { classifyAdvice, STARTING_FEE_RATES } from "../src/payments/contract.ts";
import { FakeAutoLaris } from "../src/payments/fake.ts";
import { PAYMENT_VERIFY } from "../src/payments/attempts.ts";
import { checkSellerPayments, setPaymentAdapter } from "../src/payments/jobs.ts";
import { FakeProviderCheck, openProviderKey, paymentReadiness, saveProviderKey, setPaymentAccountDetails, setProviderCheckTransport } from "../src/payments/provider-accounts.ts";
import { fakeProviders, type Providers } from "../src/payments/providers.ts";
import { paymentAnomaly, paymentAttempt, paymentChannelLock, paymentFeeRate, paymentManualConfirmation, paymentObservation, paymentProductionSwitch, storePaymentAccount } from "../src/payments/schema-payments.ts";
import {
  confirmPaymentByHand, currentFeeSchedule, FakeAutoLarisAccounts, paymentPlatformSettings, publishPaymentFeeRates, recordAutoLarisSandboxPass, requestPaymentCheck,
  requestAutoLarisProduction, resealPaymentCredentials, resolveBuyerOrder, retryOrderPayment, sellerPaymentAttempts, setAutoLarisProduction, setPaymentChannelLock, setPaymentPreferences, setSellerPaymentTransport,
} from "../src/payments/seller.ts";
import { AUTOLARIS_PAID } from "../src/payments/settings.ts";
import { callbackToken } from "../src/payments/signature.ts";
import { orderPaymentView } from "../src/payments/view.ts";
import { bindSession, type SellerScope } from "../src/platform/scoped.ts";
import { acceptSellerTerms, recordSellerTermsReview } from "../src/platform/terms.ts";
import { withStore } from "../src/platform/tenant.ts";
import { auditLog, job, ledgerEntry, mailOutbox, membership, order, systemLog } from "../src/schema.ts";
import { checkoutPaymentChannels, placeOrder, searchDestinationAreas } from "../src/seller/commerce/checkout.ts";
import { formatShippingQuote, saveCourierRules } from "../src/shipping/rules.ts";
import { setPickupAddress, shippingOptions } from "../src/shipping/shipping.ts";
import { confirmDedicatedAccount } from "../src/shipping/sync.ts";
import { keyFingerprint } from "../src/shipping/credentials.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { admin, buyer, db, DESTINATION, makeOperator, makeStore, makeUser, platform, seller } from "./helpers.ts";
import { sessionOf } from "./t37-fixtures.ts";
import { decideApproval } from "../src/ops/capabilities-approvals.ts";
import { recordPaymentInquiry, sellerSettlementEnabled } from "../src/payments/attempts.ts";
import { getOrder, transitionOrder } from "../src/seller/commerce/orders.ts";
import { DomainError } from "../src/platform/scoped.ts";
import { removeProviderKey } from "../src/payments/provider-accounts.ts";
import type { OperatorScope } from "../src/platform/scoped.ts";
import { billingStore, providersOf as billingProviders } from "./t50-fixtures.ts";
import "../src/billing/jobs.ts";

// T-106 (ADR-0013 sections 3 to 6, decision 34, D-21, D-33): AutoLaris on the seller's own key, against FAKE AutoLaris accounts (one per key).
// No network, no real key: the keys are canaries, so a leak into any row, job, observation or log line fails the literal scan.

/** T-107 (migration 0022): the provider COD fee row of the versioned schedule, UNVERIFIED starting value. */
const COD_RATE = { COD: { base: "payable", rateBps: 300, fixedIdr: 0 } } as const;
const KEY = { a: "CANARY-T106-STORE-A-KEY-1f2e3d4c5b6a7980", b: "CANARY-T106-STORE-B-KEY-9a8b7c6d5e4f3021" } as const;
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? String(e));
const pgCode = (p: Promise<unknown>) => p.then(() => "allowed", (e: { cause?: { code?: string } }) => e.cause?.code);

let accounts: FakeAutoLarisAccounts;
let platformFake: FakeAutoLaris;
const providers = (): Providers => ({ ...fakeProviders, payment: platformFake });
beforeEach(() => {
  accounts = new FakeAutoLarisAccounts();
  setSellerPaymentTransport(accounts);
  platformFake = new FakeAutoLaris();
  setPaymentAdapter(platformFake);
  setProviderCheckTransport(new FakeProviderCheck());
});
afterEach(async () => {
  setSellerPaymentTransport(null);
  setPaymentAdapter(null);
  setProviderCheckTransport(null);
  vi.restoreAllMocks();
  // Platform settings are not store rows: restore the migration's state for the next test (and the next file).
  await admin.execute(sql`delete from payment_channel_lock`);
  await admin.execute(sql`alter table payment_fee_rate disable trigger payment_fee_rate_append_only; delete from payment_fee_rate where version > 1; alter table payment_fee_rate enable trigger payment_fee_rate_append_only`);
  await admin.execute(sql`update payment_production_switch set enabled = false, sandbox_pass_at = null, sandbox_pass_evidence = null, updated_by = null, revision = 0`);
});

type S = Awaited<ReturnType<typeof makeStore>>;
const ownerOf = async (s: S): Promise<SellerScope> => {
  const me = bindSession(s.owner, await sessionOf(s.ownerId));
  await acceptSellerTerms(me, { version: 1, agreed: true }); // T-116
  return me;
};
/** A store on its own AutoLaris account that is ready (decision 13): key checked, order fields, sender address, payment-only profile confirmed. */
async function sellerStore(slug: string, apiKey: string, environment: "sandbox" | "production" = "sandbox") {
  const s = await makeStore(slug);
  const me = await ownerOf(s);
  // T-107 (review M1; ADR-0013 decision 40): a store on its own accounts ships only on its own Mengantar account (sandbox fake, JNE with COD).
  await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: `CANARY-T106-MENGANTAR-${slug}-0123456789abcdef`, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
  await confirmDedicatedAccount(me, { confirmed: true }); // T-115: shipping is ready only on a confirmed dedicated account
  await setPickupAddress(me, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
  await saveCourierRules(me, { couriers: [{ courierCode: "JNE", enabled: true, codEnabled: true }] });
  await searchDestinationAreas("menteng", undefined, s.sf);
  await saveProviderKey(me, { provider: "autolaris", environment, apiKey, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
  await setPaymentAccountDetails(me, { originAreaId: "3517100", destinationAreaId: "3518010", shipperEmail: `${slug}@example.invalid`, senderAddress: "Jl. Braga No. 1, Bandung 40111", paymentOnlyConfirmed: true });
  const [acc] = await admin.select({ id: storePaymentAccount.id }).from(storePaymentAccount).where(eq(storePaymentAccount.storeId, s.storeId));
  return { ...s, me, apiKey, accountId: acc!.id };
}
type Seller = Awaited<ReturnType<typeof sellerStore>>;
/** Decision 34 with four-eyes: a second operator approves, the requester switches on (consuming the approval). */
async function switchProductionOn(op: OperatorScope) {
  const second = await makeOperator(["providers.read", "providers.manage", "settings.manage"]);
  await recordSellerTermsReview(second, { version: 1, adviserName: "Penasihat T-106", reviewedOn: "2026-11-23", note: "Syarat penjual v1 ditinjau sebelum uji switch produksi" }); // T-116 gate
  const { approvalId } = await requestAutoLarisProduction(op, { reason: "sandbox pass verified" });
  expect(await code(decideApproval(op, approvalId, "approve"))).toBe("self_approval");
  expect(await code(setAutoLarisProduction(op, { enabled: true, reason: "go live", approvalId }))).toBe("approval_invalid"); // not approved yet
  await decideApproval(second, approvalId, "approve");
  await setAutoLarisProduction(op, { enabled: true, reason: "go live", approvalId });
  expect(await code(setAutoLarisProduction(op, { enabled: true, reason: "again", approvalId }))).toBe("approval_invalid"); // single use
}

async function place(s: S, over: Record<string, unknown> = {}) {
  // The fee list the buyer was shown (a store on its own Mengantar account requires it at submit, T-105).
  const shippingQuote = formatShippingQuote((await shippingOptions(s.sf, DESTINATION.destinationAreaId, { lines: [{ quantity: 1, weightGrams: 1000 }], subtotal: 100_000 })).options);
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
  return { ...(await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer", paymentChannel: "VABCA", shippingQuote, ...over }), providers())), cartId };
}
async function drain() {
  for (let i = 0; i < 6; i++) if ((await runOnce(platform, { workerId: "t106", providers: providers() })).length === 0) break;
}
const attemptsOf = (orderId: number) => platform.select().from(paymentAttempt).where(eq(paymentAttempt.orderId, orderId)).orderBy(paymentAttempt.attemptNo);
const orderOf = async (orderId: number) => (await platform.select().from(order).where(eq(order.id, orderId)))[0]!;
const paid = (a: { transactionId: string | null; totalIdr: number }, word = "PAID") => ({ rc: "00", ket: "Sukses", data: { status: word, amount: a.totalIdr } });
/** Superuser time travel on an immutable column; the guard is under test elsewhere. */
async function age(attemptId: string, set: { expiresHoursAgo?: number; createdHoursAgo?: number }) {
  await admin.execute(sql`alter table payment_attempt disable trigger payment_attempt_guard`);
  try {
    if (set.expiresHoursAgo !== undefined) await admin.execute(sql`update payment_attempt set expires_at = now() - ${set.expiresHoursAgo} * interval '1 hour' where id = ${attemptId}`);
    if (set.createdHoursAgo !== undefined) await admin.execute(sql`update payment_attempt set created_at = now() - ${set.createdHoursAgo} * interval '1 hour' where id = ${attemptId}`);
    await admin.execute(sql`update payment_attempt set next_advice_at = now() - interval '1 second' where id = ${attemptId}`);
  } finally {
    await admin.execute(sql`alter table payment_attempt enable trigger payment_attempt_guard`);
  }
}
/** An order of a seller store whose instruction exists on that store's account. */
async function openOrder(s: Seller, over: Record<string, unknown> = {}) {
  const placed = await place(s, over);
  await drain();
  return { ...placed, a: (await attemptsOf(placed.orderId)).at(-1)! };
}

describe("T-106 instruction, status check and callback on the store's own AutoLaris key", () => {
  it("an order of a seller_owned store creates its instruction on that store's key with the account's order fields, and the attempt snapshots the account, its environment and the fee decision", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const { a } = await openOrder(s);
    expect(a).toMatchObject({ requestState: "accepted", paymentAccountId: s.accountId, environment: "sandbox", attemptNo: 1, feeBearer: "buyer", feeRateVersion: 1, adminFeeIdr: 6_500, expectedFeeIdr: 6_500 });
    const mine = accounts.account(KEY.a);
    expect(mine.createCalls).toHaveLength(1);
    expect(mine.createCalls[0]!.profile).toEqual({ shipperName: "Toko toko-a", originAreaId: "3517100", destinationAreaId: "3518010", shipperEmail: "toko-a@example.invalid", senderAddress: "Jl. Braga No. 1, Bandung 40111" });
    expect(platformFake.createCalls).toHaveLength(0); // never the platform account
    expect(accounts.calls.filter((c) => c.op === "submit").map((c) => c.account)).toEqual([FakeAutoLarisAccounts.accountOf(KEY.a)]);
    // A store without its own account keeps the platform account of T-49 (one attempt, no snapshot).
    const legacy = await makeStore("toko-legacy");
    const placed = await place(legacy);
    await drain();
    expect((await attemptsOf(placed.orderId))[0]).toMatchObject({ paymentAccountId: null, environment: null, requestState: "accepted" });
    expect(platformFake.createCalls).toHaveLength(1);
  });

  it("callback alone never settles: the route's core resolves the store from the signed reference and only stores evidence; the pull on the store's key settles", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const { orderId, a } = await openOrder(s);
    const outcome = await acceptPaymentCallback(db, { token: callbackToken(a.reffId), rawBody: JSON.stringify({ reff_id: a.reffId, trx_id: a.transactionId, amount: a.totalIdr, status: "PAID" }) });
    expect(outcome.outcome).toBe("accepted");
    // Evidence only: nothing changed, a pull is queued for the owning store.
    expect((await orderOf(orderId)).status).toBe("awaiting_payment");
    expect((await attemptsOf(orderId))[0]).toMatchObject({ status: "pending", paidAt: null });
    const verify = await platform.select().from(job).where(eq(job.kind, PAYMENT_VERIFY));
    expect(verify.map((j) => [j.storeId, (j.payload as { attemptId: string }).attemptId])).toEqual([[s.storeId, a.id]]);
    // The provider (this store's account) does not report it paid yet: the pull leaves it pending.
    await drain();
    expect((await orderOf(orderId)).status).toBe("awaiting_payment");
    // Paid on the store's account: the next pull settles.
    accounts.account(KEY.a).adviceResults.set(a.transactionId!, paid(a));
    await acceptPaymentCallback(db, { token: callbackToken(a.reffId), rawBody: JSON.stringify({ reff_id: a.reffId, trx_id: a.transactionId, amount: a.totalIdr, status: "PAID", n: 2 }) });
    await drain();
    expect((await orderOf(orderId)).status).toBe("placed");
    expect((await attemptsOf(orderId))[0]!.status).toBe("paid");
    expect(accounts.calls.filter((c) => c.op === "advice").every((c) => c.account === FakeAutoLarisAccounts.accountOf(KEY.a))).toBe(true);
    expect(platformFake.adviceCalls).toHaveLength(0);
  });

  it("unknown status word never settles: only the paid code plus a word on the one allow-list settles; an unknown word is recorded for review", async () => {
    expect(AUTOLARIS_PAID.words).toEqual(["PAID"]);
    expect(AUTOLARIS_PAID.verified).toBe(false); // UNVERIFIED until AutoLaris confirms
    for (const word of ["SUCCESS", "BERHASIL", "SETTLED", "LUNAS", "DELIVERED", "paid"]) expect(classifyAdvice({ rc: "00", data: { status: word, amount: 1_000 } }, 1_000), word).toBe("unknown");
    const s = await sellerStore("toko-a", KEY.a);
    const { orderId, a } = await openOrder(s);
    accounts.account(KEY.a).adviceResults.set(a.transactionId!, paid(a, "SUCCESS"));
    await age(a.id, {});
    expect(await checkSellerPayments(platform, platformFake)).toBe(1);
    expect((await orderOf(orderId)).status).toBe("awaiting_payment");
    expect((await attemptsOf(orderId))[0]!.status).not.toBe("paid");
    const obs = await platform.select().from(paymentObservation).where(eq(paymentObservation.attemptId, a.id));
    expect(obs.map((o) => [o.source, o.classification, o.statusWord])).toEqual([["status_check", "unknown", "SUCCESS"]]);
    // The listed word settles on the same path.
    accounts.account(KEY.a).adviceResults.set(a.transactionId!, paid(a));
    await age(a.id, {});
    await checkSellerPayments(platform, platformFake);
    expect((await orderOf(orderId)).status).toBe("placed");
  });

  it("store A's status check never uses store B's key or the platform key", async () => {
    const A = await sellerStore("toko-a", KEY.a);
    const B = await sellerStore("toko-b", KEY.b);
    const a = (await openOrder(A)).a;
    const b = (await openOrder(B)).a;
    // A's transaction reads as paid on B's account and on the platform account, but not (yet) on A's own account.
    accounts.account(KEY.b).adviceResults.set(a.transactionId!, paid(a));
    platformFake.adviceResults.set(a.transactionId!, paid(a));
    await age(a.id, {});
    await age(b.id, {});
    expect(await checkSellerPayments(platform, platformFake)).toBe(2);
    expect((await orderOf(a.orderId)).status).toBe("awaiting_payment");
    const advice = accounts.calls.filter((c) => c.op === "advice");
    expect(advice.find((c) => c.ref === a.transactionId)?.account).toBe(FakeAutoLarisAccounts.accountOf(KEY.a));
    expect(advice.find((c) => c.ref === b.transactionId)?.account).toBe(FakeAutoLarisAccounts.accountOf(KEY.b));
    expect(platformFake.adviceCalls).toHaveLength(0);
    // Paid on A's own account: settled.
    accounts.account(KEY.a).adviceResults.set(a.transactionId!, paid(a));
    await age(a.id, {});
    await checkSellerPayments(platform, platformFake);
    expect((await orderOf(a.orderId)).status).toBe("placed");
    expect((await orderOf(b.orderId)).status).toBe("awaiting_payment");
    // In store B's context neither the application role nor the worker's platform role can open store A's key (the one envelope function).
    expect(await pgCode(withStore(db, B.storeId, (tx) => tx.execute(sql`select * from provider_key_envelope(${A.storeId}::bigint, 'autolaris')`)))).toBe("42501");
    expect(await pgCode(withStore(platform, B.storeId, (tx) => tx.execute(sql`select * from provider_key_envelope(${A.storeId}::bigint, 'autolaris')`)))).toBe("42501");
  });

  it("the scheduled check covers pending attempts and those expired in the last 24 hours, newest first, and skips older ones", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const old = (await openOrder(s)).a, recent = (await openOrder(s)).a, pending = (await openOrder(s)).a;
    await age(old.id, { expiresHoursAgo: 25, createdHoursAgo: 49 });
    await age(recent.id, { expiresHoursAgo: 1, createdHoursAgo: 25 });
    await age(pending.id, { createdHoursAgo: 1 });
    accounts.calls = [];
    expect(await checkSellerPayments(platform, platformFake)).toBe(2);
    expect(accounts.calls.filter((c) => c.op === "advice").map((c) => c.ref)).toEqual([pending.transactionId, recent.transactionId]);
    // A late payment of the recently expired attempt still settles its order.
    accounts.account(KEY.a).adviceResults.set(recent.transactionId!, paid(recent));
    await age(recent.id, {});
    await checkSellerPayments(platform, platformFake);
    expect((await orderOf(recent.orderId)).status).toBe("placed");
    expect((await orderOf(old.orderId)).status).toBe("awaiting_payment");
  });
});

describe("T-106 method rules at submit, fee bearer and Owner console settings", () => {
  it("excluded or locked channel refused at submit: the method list and the submit share one function (master switch, exclusion, lock, readiness, production switch)", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const op = await makeOperator(["providers.read", "providers.manage"]);
    const list = async () => (await checkoutPaymentChannels(db, s.storeId, platformFake)).channels.map((c) => c.code);
    expect(await list()).toEqual(["VABCA", "QRIS", "VABNI", "OVO"]); // the store's account list, priced by the schedule
    // Seller exclusion.
    await setPaymentPreferences(s.me, { enabled: true, excludedChannels: ["VABCA"], feeBearer: "buyer" });
    expect(await list()).not.toContain("VABCA");
    expect(await code(place(s, { paymentChannel: "VABCA" }))).toBe("payment_channel");
    // Platform lock (Owner console), audited.
    await setPaymentChannelLock(op, { channelCode: "QRIS", locked: true, reason: "provider does not serve QRIS for sellers" });
    expect(await list()).not.toContain("QRIS");
    expect(await code(place(s, { paymentChannel: "QRIS" }))).toBe("payment_channel");
    expect(await code(place(s, { paymentChannel: "VABNI" }))).toBe("ok");
    // Master switch off: nothing offered, nothing accepted.
    await setPaymentPreferences(s.me, { enabled: false, excludedChannels: [], feeBearer: "buyer" });
    expect(await list()).toEqual([]);
    expect(await code(place(s, { paymentChannel: "VABNI" }))).toBe("payment_channel");
    // The in-transaction re-check closes the race between the submit check and the order write.
    await setPaymentPreferences(s.me, { enabled: true, excludedChannels: [], feeBearer: "buyer" });
    const { assertChannelStillOffered } = await import("../src/payments/seller.ts");
    await setPaymentPreferences(s.me, { enabled: true, excludedChannels: ["OVO"], feeBearer: "buyer" });
    expect(await code(withStore(db, s.storeId, (tx) => assertChannelStillOffered(tx, s.storeId, "OVO", s.accountId)))).toBe("payment_channel");
    // Not ready (payment-only profile withdrawn) and production without the switch: not offered.
    await setPaymentAccountDetails(s.me, { originAreaId: "3517100", destinationAreaId: "3518010", shipperEmail: "toko-a@example.invalid", senderAddress: "Jl. Braga No. 1, Bandung 40111", paymentOnlyConfirmed: false });
    expect(await list()).toEqual([]);
    const p = await sellerStore("toko-p", KEY.b, "production");
    expect((await paymentReadiness(p.me)).missing).toEqual(["production_off"]);
    expect((await checkoutPaymentChannels(db, p.storeId, platformFake)).channels).toEqual([]);
    expect(await code(setAutoLarisProduction(op, { enabled: true, reason: "go live" }))).toBe("sandbox_pass_required");
    expect(await code(requestAutoLarisProduction(op, { reason: "go live" }))).toBe("sandbox_pass_required");
    expect(await pgCode(admin.execute(sql`update payment_production_switch set enabled = true`))).toBe("23514"); // the CHECK holds too
    await recordAutoLarisSandboxPass(op, { evidence: "docs/tracks/t106-autolaris-seller-key.md sandbox run", reason: "sandbox pass recorded" });
    await switchProductionOn(op);
    expect((await checkoutPaymentChannels(db, p.storeId, platformFake)).channels.length).toBeGreaterThan(0);
    const audit = await platform.select({ action: auditLog.action }).from(auditLog).where(sql`${auditLog.action} like 'payment.%'`).orderBy(auditLog.id);
    expect(audit.map((r) => r.action)).toEqual(expect.arrayContaining(["payment.preferences.update", "payment.channel.lock", "payment.production.sandbox_pass", "payment.production.on"]));
  });

  it("fee-bearer amounts frozen: buyer pays total plus fee, seller bills the order total and bears the fee; a later rate version or bearer change never alters an existing attempt", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const op = await makeOperator(["providers.read", "providers.manage"]);
    const buyerBears = (await openOrder(s)).a;
    const o1 = await orderOf(buyerBears.orderId);
    expect(buyerBears).toMatchObject({ feeBearer: "buyer", amountIdr: o1.total, adminFeeIdr: 6_500, totalIdr: o1.total + 6_500, expectedFeeIdr: 6_500, feeRateVersion: 1 });
    await setPaymentPreferences(s.me, { enabled: true, excludedChannels: [], feeBearer: "seller" });
    const sellerBears = (await openOrder(s)).a;
    const o2 = await orderOf(sellerBears.orderId);
    expect(sellerBears).toMatchObject({ feeBearer: "seller", amountIdr: o2.total, adminFeeIdr: 0, totalIdr: o2.total, expectedFeeIdr: 6_500 });
    // A new rate version prices new orders only.
    const v = await publishPaymentFeeRates(op, { rates: [{ channelCode: "VABCA", base: "flat", rateBps: 0, fixedIdr: 4_000 }], reason: "provider confirmed new VA price" });
    expect(v).toBe(2);
    // A channel the new version does not name is carried forward (review nit), never silently dropped from checkout.
    expect((await currentFeeSchedule(platform)).rates).toEqual({ ...STARTING_FEE_RATES, ...COD_RATE, VABCA: { base: "flat", rateBps: 0, fixedIdr: 4_000 } }); // T-107: the COD fee row is carried forward too
    expect((await currentFeeSchedule(platform)).rates.VABCA).toEqual({ base: "flat", rateBps: 0, fixedIdr: 4_000 });
    await setPaymentPreferences(s.me, { enabled: true, excludedChannels: [], feeBearer: "buyer" });
    const later = (await openOrder(s)).a;
    expect(later).toMatchObject({ feeRateVersion: 2, adminFeeIdr: 4_000, expectedFeeIdr: 4_000 });
    expect((await attemptsOf(buyerBears.orderId))[0]).toMatchObject({ feeBearer: "buyer", adminFeeIdr: 6_500, feeRateVersion: 1 });
    expect((await attemptsOf(sellerBears.orderId))[0]).toMatchObject({ feeBearer: "seller", adminFeeIdr: 0, expectedFeeIdr: 6_500 });
    // The database keeps them frozen for every login role, and the versions are append-only.
    expect(await pgCode(platform.execute(sql`update payment_attempt set fee_bearer = 'seller' where id = ${buyerBears.id}`))).toBe("23514");
    expect(await pgCode(platform.execute(sql`update payment_attempt set fee_rate_version = 2 where id = ${buyerBears.id}`))).toBe("23514");
    expect(await pgCode(platform.execute(sql`update payment_fee_rate set fixed_idr = 1 where version = 1`))).toBe("42501");
    expect(await pgCode(db.execute(sql`insert into payment_fee_rate (version, channel_code, base, rate_bps, fixed_idr, created_by, reason) values (9, 'VABCA', 'flat', 0, 1, 'x', 'xyz')`))).toBe("42501");
    // The version-1 seed is the documented starting data.
    const seed = await platform.select().from(paymentFeeRate).where(eq(paymentFeeRate.version, 1));
    expect(Object.fromEntries(seed.map((r) => [r.channelCode, { base: r.base, rateBps: r.rateBps, fixedIdr: r.fixedIdr }]))).toEqual({ ...STARTING_FEE_RATES, ...COD_RATE }); // T-107 added the COD row (migration 0021)
  });

  it("Owner console payment settings need providers.manage and are audited; reading needs providers.read", async () => {
    const reader = await makeOperator(["providers.read"]);
    const settings = await paymentPlatformSettings(reader);
    expect(settings.production).toMatchObject({ provider: "autolaris", enabled: false, sandboxPassAt: null });
    expect(settings.schedule.version).toBe(1);
    expect(await code(setPaymentChannelLock(reader, { channelCode: "OVO", locked: true, reason: "x-y-z" }))).toBe("forbidden");
    expect(await code(publishPaymentFeeRates(reader, { rates: [{ channelCode: "OVO", base: "payable", rateBps: 300, fixedIdr: 0 }], reason: "x-y-z" }))).toBe("forbidden");
    expect(await code(setAutoLarisProduction(reader, { enabled: false, reason: "x-y-z" }))).toBe("forbidden");
    expect(await code(paymentPlatformSettings(await makeOperator(["tenants.read"])))).toBe("forbidden");
    expect(await platform.select().from(paymentChannelLock)).toEqual([]);
    const [sw] = await platform.select().from(paymentProductionSwitch);
    expect(sw!.enabled).toBe(false);
  });
});

describe("T-106 retry, late payment, anomaly and manual confirmation", () => {
  it("retry keeps the old attempt; a late payment of it settles the order; a second settled attempt raises an anomaly and nothing is booked in the ledger", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const { orderId, cartId, a: first } = await openOrder(s);
    const ref = (await resolveBuyerOrder(db, { orderId, cartId }))!;
    expect(ref).toEqual({ storeId: s.storeId, orderId });
    expect(await code(retryOrderPayment(db, ref, platformFake))).toBe("not_retryable"); // the first instruction is still valid
    await age(first.id, { expiresHoursAgo: 1 });
    const second = await retryOrderPayment(db, ref, platformFake);
    expect(second).toMatchObject({ attemptNo: 2, channelCode: first.channelCode, amountIdr: first.amountIdr, adminFeeIdr: first.adminFeeIdr, totalIdr: first.totalIdr, feeBearer: first.feeBearer, feeRateVersion: first.feeRateVersion, paymentAccountId: s.accountId });
    expect(second.reffId).not.toBe(first.reffId);
    await drain();
    const [one, two] = await attemptsOf(orderId);
    expect(one).toMatchObject({ id: first.id, requestState: "accepted" }); // kept
    expect(two).toMatchObject({ requestState: "accepted" });
    expect(await withStore(db, s.storeId, (tx) => orderPaymentView(tx, s.storeId, orderId))).toMatchObject({ attemptNo: 2, sellerAccount: true, retryable: false });
    // The buyer paid the OLD instruction late: the status check settles the order through it.
    accounts.account(KEY.a).adviceResults.set(first.transactionId!, paid(first));
    await age(first.id, {});
    await checkSellerPayments(platform, platformFake);
    expect((await orderOf(orderId)).status).toBe("placed");
    expect(await platform.select().from(paymentAnomaly)).toEqual([]);
    // ...and then paid the new one too: a second settled attempt is an anomaly for the seller; the order is not paid twice.
    accounts.account(KEY.a).adviceResults.set(two!.transactionId!, paid(two!));
    await age(two!.id, {});
    await checkSellerPayments(platform, platformFake);
    expect((await platform.select().from(paymentAnomaly)).map((x) => [x.attemptId, x.kind])).toEqual([[two!.id, "second_settled"]]);
    expect((await sellerPaymentAttempts(s.me)).find((x) => x.id === two!.id)?.anomalies).toEqual(["second_settled"]);
    expect(await platform.select().from(ledgerEntry).where(eq(ledgerEntry.storeId, s.storeId))).toEqual([]); // the money is the seller's (ADR-0013 section 8)
    expect(await code(retryOrderPayment(db, ref, platformFake))).toBe("not_retryable"); // paid order
  });

  it("a provider error leaves the order pending with a retry for the buyer; the database refuses a retry that skips the rules", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    accounts.account(KEY.a).createResult = { rc: "01", ket: "Invalid parameter" };
    const { orderId, cartId, a } = await openOrder(s);
    expect(a.requestState).toBe("failed");
    expect((await orderOf(orderId)).status).toBe("awaiting_payment"); // never cancelled
    const ref = (await resolveBuyerOrder(db, { orderId, cartId }))!;
    expect(await withStore(db, s.storeId, (tx) => orderPaymentView(tx, s.storeId, orderId))).toMatchObject({ requestState: "failed", retryable: true });
    accounts.account(KEY.a).createResult = undefined;
    await retryOrderPayment(db, ref, platformFake);
    await drain();
    expect((await attemptsOf(orderId)).map((x) => [x.attemptNo, x.requestState])).toEqual([[1, "failed"], [2, "accepted"]]);
    // Database: no retry while the last attempt is valid, no number gap, never on the platform account.
    const insert = (no: number, account: number | null) => withStore(db, s.storeId, (tx) => tx.execute(sql`insert into payment_attempt (store_id, order_id, owner_id, attempt_no, request_key, reff_id, channel_code, customer, amount_idr, admin_fee_idr, total_idr, expires_at, next_advice_at, payment_account_id, environment)
      select store_id, order_id, owner_id, ${no}, ${`x-${no}`}, ${`99${no}`}, channel_code, customer, amount_idr, admin_fee_idr, total_idr, now() + interval '1 day', now(), ${account}, ${account ? "sandbox" : null} from payment_attempt where id = ${a.id}`));
    expect(await pgCode(insert(3, s.accountId))).toBe("23514"); // attempt 2 is still valid
    expect(await pgCode(insert(5, s.accountId))).toBe("23514");
    const legacy = await makeStore("toko-legacy");
    const lp = await place(legacy);
    await drain();
    expect(await code(retryOrderPayment(db, { storeId: legacy.storeId, orderId: lp.orderId }, platformFake))).toBe("not_retryable");
  });

  it("the seller confirms a payment by hand with reason and evidence: one immutable record per attempt; staff and another store are refused", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const { orderId, a } = await openOrder(s);
    const staffId = await makeUser("staff");
    await platform.insert(membership).values({ storeId: s.storeId, userId: staffId, role: "staff" });
    expect(await code(confirmPaymentByHand(await seller(staffId, s.storeId), { attemptId: a.id, reason: "uang masuk", evidence: "MUT-1" }))).toBe("forbidden");
    const other = await sellerStore("toko-b", KEY.b);
    expect(await code(confirmPaymentByHand(other.me, { attemptId: a.id, reason: "uang masuk", evidence: "MUT-1" }))).toBe("not_found");
    expect(await code(confirmPaymentByHand(s.me, { attemptId: a.id, reason: "ok", evidence: "MUT-1" }))).not.toBe("ok"); // reason too short
    expect(await confirmPaymentByHand(s.me, { attemptId: a.id, reason: "Uang masuk di mutasi BCA", evidence: "MUT-20261116-01" })).toEqual({ outcome: "paid" });
    expect((await orderOf(orderId)).status).toBe("placed");
    expect(await code(confirmPaymentByHand(s.me, { attemptId: a.id, reason: "Uang masuk lagi", evidence: "MUT-2" }))).toBe("already_confirmed");
    const [rec] = await platform.select().from(paymentManualConfirmation).where(eq(paymentManualConfirmation.attemptId, a.id));
    expect(rec).toMatchObject({ storeId: s.storeId, orderId, confirmedBy: s.ownerId, reason: "Uang masuk di mutasi BCA", evidence: "MUT-20261116-01" });
    // Immutable: no role edits or deletes it (no grant; the append-only trigger for the owner too).
    expect(await pgCode(withStore(db, s.storeId, (tx) => tx.execute(sql`update payment_manual_confirmation set reason = 'changed reason' where id = ${rec!.id}`)))).toBe("42501");
    expect(await pgCode(withStore(db, s.storeId, (tx) => tx.execute(sql`delete from payment_manual_confirmation where id = ${rec!.id}`)))).toBe("42501");
    expect(await pgCode(admin.execute(sql`update payment_manual_confirmation set reason = 'changed reason' where id = ${rec!.id}`))).toBe("42501");
    // The provider later reports the same attempt paid: no anomaly (same attempt), no second transition.
    accounts.account(KEY.a).adviceResults.set(a.transactionId!, paid(a));
    await age(a.id, {});
    await checkSellerPayments(platform, platformFake);
    expect(await platform.select().from(paymentAnomaly)).toEqual([]);
    // The database refuses a confirmation of an attempt the provider already reported paid (review: the guard checks the status).
    expect(await pgCode(withStore(db, s.storeId, (tx) => tx.execute(sql`insert into payment_manual_confirmation (store_id, attempt_id, order_id, confirmed_by, reason, evidence) values (${s.storeId}, ${a.id}, ${orderId}, ${s.ownerId}, 'late manual record', 'MUT-9')`)))).toBe("23514"); // the guard runs before the one-per-attempt unique index
    // A confirmation of a SECOND attempt of an order already paid by hand raises the anomaly (the buyer paid twice).
    const y = await openOrder(s);
    await age(y.a.id, { expiresHoursAgo: 1 });
    const y2 = await retryOrderPayment(db, (await resolveBuyerOrder(db, { orderId: y.orderId, cartId: y.cartId }))!, platformFake);
    await drain();
    expect(await confirmPaymentByHand(s.me, { attemptId: y2.id, reason: "Uang masuk di mutasi BCA", evidence: "MUT-3" })).toEqual({ outcome: "paid" });
    expect(await confirmPaymentByHand(s.me, { attemptId: y.a.id, reason: "Pembeli juga membayar tagihan lama", evidence: "MUT-4" })).toEqual({ outcome: "anomaly" });
    expect((await platform.select().from(paymentAnomaly)).map((x) => [x.attemptId, x.kind])).toEqual([[y.a.id, "second_settled"]]);
    const audit = await platform.select({ action: auditLog.action, actor: auditLog.actorUserId }).from(auditLog).where(and(eq(auditLog.storeId, s.storeId), eq(auditLog.action, "payment.manual_confirm")));
    expect(audit).toHaveLength(3);
  });
});

describe("T-106 limits, platform account for subscriptions, key custody", () => {
  it("RL-PAY-RECHECK: a check now only queues a pull on the store's key, 6 per minute per order and 30 per 10 minutes per IP", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const { orderId, a } = await openOrder(s);
    const ref = { storeId: s.storeId, orderId };
    expect(await requestPaymentCheck(db, ref, { clientIp: "203.0.113.9" })).toBe(1);
    expect((await orderOf(orderId)).status).toBe("awaiting_payment"); // the request itself changes nothing
    for (let i = 0; i < 5; i++) await requestPaymentCheck(db, ref, { clientIp: "203.0.113.9" });
    expect(await code(requestPaymentCheck(db, ref, { clientIp: "203.0.113.9" }))).toBe("rate_limited");
    const jobs = await platform.select().from(job).where(eq(job.kind, PAYMENT_VERIFY));
    expect(jobs.length).toBeGreaterThanOrEqual(1); // one pull per attempt per minute (two when the burst straddles a minute)
    expect(jobs.length).toBeLessThanOrEqual(2);
    accounts.account(KEY.a).adviceResults.set(a.transactionId!, paid(a));
    await drain();
    expect((await orderOf(orderId)).status).toBe("placed");
  });

  it("subscription invoices keep using the platform account even when the store has its own AutoLaris account", async () => {
    const s = await billingStore("toko-a");
    const me = bindSession(s.owner, await sessionOf(s.ownerId));
    await acceptSellerTerms(me, { version: 1, agreed: true }); // T-116
    await saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: KEY.a, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    const p = new FakeAutoLaris();
    setPaymentAdapter(p);
    const r = await paySubscription(await s.sellerAt(), { channel: "VABCA" }, billingProviders(p));
    for (let i = 0; i < 6; i++) if ((await runOnce(platform, { workerId: "t106-sub", providers: billingProviders(p) })).length === 0) break;
    expect(p.createCalls.map((c) => c.owner)).toEqual([{ kind: "subscription_invoice", id: r.invoice.id }]);
    expect(accounts.calls).toEqual([]);
  });

  it("payment keyring rotation: the re-seal job moves every AutoLaris key to the leading ring key, keeps the store binding, and the fingerprint follows", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const before = (await admin.select().from(storePaymentAccount).where(eq(storePaymentAccount.storeId, s.storeId)))[0]!;
    expect(before.keyId).toBe("testpay");
    vi.stubEnv("KEYRING_PAYMENT_CREDENTIALS", `pay2:${Buffer.from("t106-rotated-payment-ring-key-32").toString("base64")},${process.env.KEYRING_PAYMENT_CREDENTIALS}`);
    expect(await resealPaymentCredentials(platform)).toEqual({ changed: 1, failed: 0 });
    const after = (await admin.select().from(storePaymentAccount).where(eq(storePaymentAccount.storeId, s.storeId)))[0]!;
    expect(after).toMatchObject({ keyId: "pay2", keyFingerprint: keyFingerprint("payment_credentials", KEY.a), revision: before.revision });
    expect(after.sealedKey).not.toBe(before.sealedKey);
    expect(await openProviderKey({ exec: db, storeId: s.storeId }, "autolaris")).toBe(KEY.a);
    expect(await resealPaymentCredentials(platform)).toEqual({ changed: 0, failed: 0 });
    // The rotated key still works end to end.
    const { a } = await openOrder(s);
    expect(a.requestState).toBe("accepted");
  });

  it("canary-key literal scan: no attempt, observation, job, audit row, mail, log line, view or fake call log carries a seller key", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const { orderId, cartId, a } = await openOrder(s);
    await acceptPaymentCallback(db, { token: callbackToken(a.reffId), rawBody: JSON.stringify({ reff_id: a.reffId, trx_id: a.transactionId, amount: a.totalIdr, status: "PAID" }) });
    accounts.account(KEY.a).adviceResults.set(a.transactionId!, paid(a, "SUCCESS"));
    await drain();
    await requestPaymentCheck(db, { storeId: s.storeId, orderId });
    await age(a.id, { expiresHoursAgo: 1 });
    await retryOrderPayment(db, (await resolveBuyerOrder(db, { orderId, cartId }))!, platformFake);
    accounts.account(KEY.a).createResult = { rc: "01" };
    await drain();
    await confirmPaymentByHand(s.me, { attemptId: a.id, reason: "Uang masuk di mutasi BCA", evidence: "MUT-1" });
    const dump = JSON.stringify([
      await platform.select().from(paymentAttempt), await platform.select().from(paymentObservation), await platform.select().from(job), await platform.select().from(auditLog),
      await platform.select().from(mailOutbox), await platform.select().from(systemLog), await sellerPaymentAttempts(s.me), accounts.calls,
      await withStore(db, s.storeId, (tx) => orderPaymentView(tx, s.storeId, orderId)),
    ]);
    for (const k of Object.values(KEY)) for (const enc of [k, encodeURIComponent(k), Buffer.from(k).toString("base64"), Buffer.from(k).toString("hex")]) expect(dump).not.toContain(enc);
  });
});

describe("T-106 review fixes", () => {
  it("a key that does not open never stops the status check of other stores, and the re-seal skips that row and goes on", async () => {
    const A = await sellerStore("toko-a", KEY.a); // lower account id: its broken envelope sits at the head of every sweep
    const B = await sellerStore("toko-b", KEY.b);
    const a = (await openOrder(A)).a, b = (await openOrder(B)).a;
    await admin.execute(sql`update store_payment_account set sealed_key = 'AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA==' where store_id = ${A.storeId}`);
    accounts.account(KEY.b).adviceResults.set(b.transactionId!, paid(b));
    await age(a.id, { createdHoursAgo: 0 });
    await age(b.id, { createdHoursAgo: 1 }); // A's attempt is the newest: it comes first
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await checkSellerPayments(platform, platformFake)).toBe(2);
    expect((await orderOf(b.orderId)).status).toBe("placed"); // store B is checked although store A's key does not open
    expect((await orderOf(a.orderId)).status).toBe("awaiting_payment");
    const [after] = await platform.select({ next: paymentAttempt.nextAdviceAt }).from(paymentAttempt).where(eq(paymentAttempt.id, a.id));
    expect(after!.next.getTime()).toBeGreaterThan(Date.now()); // moved forward: it never holds the head of the batch
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])) as { event: string; code: string })).toContainEqual(expect.objectContaining({ event: "payment.seller_key.unusable", code: "payment_envelope_invalid" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY.a);
    // Re-seal: the broken row is skipped, the next one is moved to the new ring key.
    vi.stubEnv("KEYRING_PAYMENT_CREDENTIALS", `pay2:${Buffer.from("t106-rotated-payment-ring-key-32").toString("base64")},${process.env.KEYRING_PAYMENT_CREDENTIALS}`);
    expect(await resealPaymentCredentials(platform)).toEqual({ changed: 1, failed: 1 });
    const rows = await admin.select({ storeId: storePaymentAccount.storeId, keyId: storePaymentAccount.keyId }).from(storePaymentAccount).orderBy(storePaymentAccount.id);
    expect(rows).toEqual([{ storeId: A.storeId, keyId: "testpay" }, { storeId: B.storeId, keyId: "pay2" }]);
  });

  it("the seller's bare pay action is refused for an order on the store's own account (service and database); a platform-account order still pays", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const { orderId } = await openOrder(s);
    expect(await code(transitionOrder(s.me, orderId, "pay"))).toBe("manual_confirmation_required");
    expect(await pgCode(withStore(db, s.storeId, (tx) => tx.execute(sql`update "order" set status = 'placed' where id = ${orderId}`)))).toBe("42501");
    expect((await orderOf(orderId)).status).toBe("awaiting_payment");
    const legacy = await makeStore("toko-legacy");
    const lp = await place(legacy);
    await drain();
    expect(await transitionOrder(legacy.owner, lp.orderId, "pay")).toBe("placed");
  });

  it("an attempt is never created or checked on the account's other environment", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const op = await makeOperator(["providers.read", "providers.manage"]);
    const { a } = await openOrder(s); // sandbox attempt, accepted
    const pendingCreate = await place(s); // sandbox attempt, instruction not yet created
    await recordAutoLarisSandboxPass(op, { evidence: "track report sandbox run", reason: "sandbox pass recorded" });
    await switchProductionOn(op);
    // The same key moves to production (an empty key field keeps it): the fake account behind the key would now answer paid.
    await saveProviderKey(s.me, { provider: "autolaris", environment: "production", apiKey: "", proofId: await issueSellerStepUp(s.me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    accounts.account(KEY.a).adviceResults.set(a.transactionId!, paid(a));
    accounts.calls = [];
    await age(a.id, {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await checkSellerPayments(platform, platformFake);
    await drain();
    expect((await orderOf(a.orderId)).status).toBe("awaiting_payment"); // never checked on the production account
    expect((await attemptsOf(pendingCreate.orderId))[0]).toMatchObject({ environment: "sandbox", requestState: "failed" }); // never created there either
    expect(accounts.calls).toEqual([]);
  });

  it("live-mode settlement on a seller key stays off while the paid words are unverified", async () => {
    expect(sellerSettlementEnabled("fake")).toBe(true);
    expect(sellerSettlementEnabled("live")).toBe(false);
    const s = await sellerStore("toko-a", KEY.a);
    const { orderId, a } = await openOrder(s);
    const r = await recordPaymentInquiry({ exec: platform, storeId: s.storeId }, a.id, paid(a), { source: "status_check", mode: "live" });
    expect(r).toMatchObject({ classification: "paid", applied: false });
    expect((await orderOf(orderId)).status).toBe("awaiting_payment");
    expect((await attemptsOf(orderId))[0]!.status).toBe("pending");
  });

  it("the order page offers no bare pay action for an order on the store's own account, and still does for a platform-account order", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const { orderId } = await openOrder(s);
    expect((await getOrder(s.me, orderId))!.actions).not.toContain("pay");
    expect((await getOrder(s.me, orderId))!.actions).toContain("cancel");
    const legacy = await makeStore("toko-legacy");
    const lp = await place(legacy);
    await drain();
    expect((await getOrder(legacy.owner, lp.orderId))!.actions).toContain("pay");
  });

  it("a transient failure while opening the store's account leaves the instruction job to retry; a permanent one ends the attempt as failed", async () => {
    const s = await sellerStore("toko-a", KEY.a);
    const placed = await place(s);
    setSellerPaymentTransport({ mode: "fake", adapterFor() { throw new DomainError("provider_unavailable", "no transport"); } });
    await drain();
    expect((await attemptsOf(placed.orderId))[0]!.requestState).toBe("in_progress");
    const jobOf = async () => (await platform.select().from(job).where(and(eq(job.kind, "payment.instruction"), eq(job.key, `order:${placed.orderId}`))))[0]!;
    expect(await jobOf()).toMatchObject({ status: "pending", attempts: 1 });
    // The transport is back: the retry (made due here) creates the instruction on the store's key.
    setSellerPaymentTransport(accounts);
    await platform.update(job).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(job.id, (await jobOf()).id));
    await drain();
    expect((await attemptsOf(placed.orderId))[0]!.requestState).toBe("accepted");
    // Permanent: the key was removed before the job ran → failed without a provider call, the buyer can ask again later.
    const second = await place(s);
    await removeProviderKey(s.me, { provider: "autolaris", proofId: await issueSellerStepUp(s.me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    accounts.calls = [];
    await drain();
    expect((await attemptsOf(second.orderId))[0]!.requestState).toBe("failed");
    expect(accounts.calls).toEqual([]);
  });

  it("an attempt whose settlement throws never stops another store's attempt in the same batch", async () => {
    const A = await sellerStore("toko-a", KEY.a);
    const B = await sellerStore("toko-b", KEY.b);
    const a = (await openOrder(A)).a, b = (await openOrder(B)).a;
    accounts.account(KEY.a).adviceResults.set(a.transactionId!, { rc: "00", data: { status: "PAID", amount: a.totalIdr, n: 1n } }); // unserialisable: recordPaymentInquiry throws a TypeError
    accounts.account(KEY.b).adviceResults.set(b.transactionId!, paid(b));
    await age(a.id, { createdHoursAgo: 0 });
    await age(b.id, { createdHoursAgo: 1 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await checkSellerPayments(platform, platformFake)).toBe(2);
    expect((await orderOf(b.orderId)).status).toBe("placed");
    expect((await orderOf(a.orderId)).status).toBe("awaiting_payment");
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])) as { event: string; code: string })).toContainEqual(expect.objectContaining({ event: "payment.status_check.failed", code: "error" }));
  });

  it("a production-ON approval is bound to the recorded sandbox pass: a pass recorded after the approval voids it", async () => {
    const op = await makeOperator(["providers.read", "providers.manage", "settings.manage"]);
    const second = await makeOperator(["providers.read", "providers.manage"]);
    await recordSellerTermsReview(op, { version: 1, adviserName: "Penasihat T-106", reviewedOn: "2026-11-23", note: "Syarat penjual v1 ditinjau sebelum uji switch produksi" }); // T-116 gate
    await recordAutoLarisSandboxPass(op, { evidence: "first sandbox run", reason: "sandbox pass recorded" });
    const { approvalId } = await requestAutoLarisProduction(op, { reason: "go live" });
    await decideApproval(second, approvalId, "approve");
    await recordAutoLarisSandboxPass(op, { evidence: "second sandbox run, other result", reason: "sandbox pass recorded again" });
    expect(await code(setAutoLarisProduction(op, { enabled: true, reason: "go live", approvalId }))).toBe("approval_invalid");
    expect((await platform.select().from(paymentProductionSwitch))[0]!.enabled).toBe(false);
  });
});
