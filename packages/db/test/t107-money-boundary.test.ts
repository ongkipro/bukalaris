import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueSellerStepUp } from "../src/ledger/stepup.ts";
import { storeMoneyMode } from "../src/ledger/boundary.ts";
import { requestLedgerAdjustment, manualCompletionCandidates, consoleMoneyPosition } from "../src/ledger/console.ts";
import { requestPayout, setPayoutDestination } from "../src/ledger/payouts.ts";
import { prepareReconciliationBatch, requestManualCompletion } from "../src/ledger/reconciliation.ts";
import { releaseStore } from "../src/ledger/release.ts";
import { verifyLedger } from "../src/ledger/verify.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { signOrderLink } from "../src/ops/jobs/notify.ts";
import { FakeAutoLaris } from "../src/payments/fake.ts";
import { setPaymentAdapter } from "../src/payments/jobs.ts";
import { FakeProviderCheck, saveProviderKey, setPaymentAccountDetails, setProviderCheckTransport } from "../src/payments/provider-accounts.ts";
import { fakeProviders, type Providers } from "../src/payments/providers.ts";
import { paymentAttempt } from "../src/payments/schema-payments.ts";
import { confirmPaymentByHand, FakeAutoLarisAccounts, setPaymentPreferences, setSellerPaymentTransport } from "../src/payments/seller.ts";
import { bindSession, type SellerScope } from "../src/platform/scoped.ts";
import { withStore } from "../src/platform/tenant.ts";
import { ledgerEntry, membership, order, orderFinancials, orderSellerRefund, payout, payoutDestination, reconciliationBatch, refund, shipment } from "../src/schema.ts";
import { checkoutPaymentChannels, placeOrder, searchDestinationAreas } from "../src/seller/commerce/checkout.ts";
import { sellerCollected, sellerDashboard } from "../src/seller/commerce/dashboard.ts";
import { buyerOrderMoneyForLink, claimDelivery, getOrder, recordSellerRefund, transitionOrder } from "../src/seller/commerce/orders.ts";
import { bookShipment, shipmentTimeline } from "../src/shipping/fulfillment.ts";
import { formatShippingQuote, saveCourierRules, saveShippingSettings, sellerShippingRules } from "../src/shipping/rules.ts";
import { setPickupAddress, shippingOptions } from "../src/shipping/shipping.ts";
import { confirmDedicatedAccount } from "../src/shipping/sync.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { deliver } from "./deliver.ts";
import { admin, buyer, db, DESTINATION, makeOperator, makeStore, makeUser, platform, seller } from "./helpers.ts";
import { activateDestination, fund, sessionOf, withoutGuard } from "./t37-fixtures.ts";

// T-107 (ADR-0013 sections 5 and 8, BILL-4, BILL-5, D-27, D-31, C-P1, C-P7, C-P9): the money boundary for stores on seller-owned accounts. Every
// provider runs on fakes (one fake AutoLaris account per key, the deterministic seller Mengantar fake); the keys are canaries. Each invariant has a
// named test below; the mutation checks of docs/tracks/t107-money-boundary.md break each once and name the test that fails.

const KEY = { autolaris: "CANARY-T107-AUTOLARIS-KEY-0a1b2c3d4e5f6789", mengantar: "CANARY-T107-MENGANTAR-KEY-9f8e7d6c5b4a3210" } as const;
const MENTENG = DESTINATION.destinationAreaId;
const RULES = [{ courierCode: "JNE", enabled: true, codEnabled: true }];
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? String(e));
const pgCode = (p: Promise<unknown>) => p.then(() => "allowed", (e: { cause?: { code?: string }; code?: string }) => e.cause?.code ?? e.code);
/** The money-boundary guard's own refusal (its dedicated SQLSTATE `BKMB1`), told apart from any other check that could refuse the same row. */
const boundary = (p: Promise<unknown>) => p.then(() => "allowed", (e: { cause?: { code?: string }; code?: string }) => ((e.cause?.code ?? e.code) === "BKMB1" ? "money_boundary" : (e.cause?.code ?? e.code ?? "error")));

let accounts: FakeAutoLarisAccounts;
let platformFake: FakeAutoLaris;
const providers = (): Providers => ({ ...fakeProviders, payment: platformFake });
beforeEach(async () => {
  accounts = new FakeAutoLarisAccounts();
  setSellerPaymentTransport(accounts);
  platformFake = new FakeAutoLaris();
  setPaymentAdapter(platformFake);
  setProviderCheckTransport(new FakeProviderCheck());
  await admin.execute(sql`truncate shipping_area, provider_live_setting`);
});
afterEach(() => {
  setSellerPaymentTransport(null);
  setPaymentAdapter(null);
  setProviderCheckTransport(null);
  vi.restoreAllMocks();
});

type Own = Awaited<ReturnType<typeof makeStore>> & { me: SellerScope };
/** A store on its own accounts: its own Mengantar (pickup registered, JNE with COD) and/or its own AutoLaris (ready), with the given fee bearers. */
async function ownStore(slug: string, o: { mengantar?: boolean; autolaris?: boolean; payBearer?: "buyer" | "seller"; codBearer?: "buyer" | "seller" } = {}): Promise<Own> {
  const s = await makeStore(slug);
  const me = bindSession(s.owner, await sessionOf(s.ownerId));
  if (o.mengantar !== false) {
    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: KEY.mengantar, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
    await confirmDedicatedAccount(me, { confirmed: true }); // T-115: shipping is ready only on a confirmed dedicated account
    await setPickupAddress(me, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
    await saveCourierRules(me, { couriers: RULES });
    await searchDestinationAreas("menteng", undefined, s.sf); // the province of the buyer's area is on record (COD needs it, ADR-0013 section 4)
    if (o.codBearer) await saveShippingSettings(me, { codEnabled: true, codFeeBearer: o.codBearer, codBlockedProvinces: [], revision: (await sellerShippingRules(me)).settings.revision });
  }
  if (o.autolaris !== false) {
    await saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: KEY.autolaris, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    await setPaymentAccountDetails(me, { originAreaId: "3517100", destinationAreaId: "3518010", shipperEmail: `${slug}@example.invalid`, senderAddress: "Jl. Braga No. 1, Bandung 40111", paymentOnlyConfirmed: true });
    if (o.payBearer) await setPaymentPreferences(me, { enabled: true, excludedChannels: [], feeBearer: o.payBearer });
  }
  return { ...s, me };
}
let phone = 0;
/** A buyer submit with the fee list the buyer was shown (a store on its own Mengantar account requires it). */
async function submit(s: Own, over: Record<string, unknown> = {}) {
  const quote = await shippingOptions(s.sf, MENTENG, { lines: [{ quantity: 1, weightGrams: 1000 }], subtotal: 100_000 });
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
  return (await placeOrder(db, cartId, buyer({ shippingQuote: formatShippingQuote(quote.options), buyerPhone: `0815${String(++phone).padStart(8, "0")}`, ...over }), providers())).orderId;
}
const drain = async () => {
  for (let i = 0; i < 6; i++) if ((await runOnce(platform, { workerId: "t107", providers: providers() })).length === 0) break;
};
const finOf = async (orderId: number) => (await admin.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId)))[0]!;
const orderOf = async (orderId: number) => (await admin.select().from(order).where(eq(order.id, orderId)))[0]!;
const attemptOf = async (orderId: number) => (await admin.select().from(paymentAttempt).where(eq(paymentAttempt.orderId, orderId)))[0]!;
const ledgerOf = (orderId: number) => admin.select().from(ledgerEntry).where(eq(ledgerEntry.orderId, orderId));
/** The provider fee formula of the schedule: half-up basis points on the base, plus the fixed part (decision 19). */
const feeOf = (base: number, bps: number) => Math.floor((base * bps + 5_000) / 10_000);
/** A prepaid order paid by the seller's hand confirmation on its own AutoLaris account (decision 24). */
async function paidPrepaid(s: Own, channel: "QRIS" | "VABCA" = "QRIS") {
  const orderId = await submit(s, { paymentMethod: "manual_transfer", paymentChannel: channel });
  await drain();
  await confirmPaymentByHand(s.me, { attemptId: (await attemptOf(orderId)).id, reason: "uang masuk di mutasi", evidence: `MUT-${orderId}` });
  return orderId;
}
/** A COD order the courier delivered (the store's tracking read; the provider transition is the one writer of `completed`). */
async function deliveredCod(s: Own) {
  const orderId = await submit(s, { paymentMethod: "cod" });
  await transitionOrder(s.owner, orderId, "confirm");
  await transitionOrder(s.owner, orderId, "process");
  await transitionOrder(s.owner, orderId, "ship", { trackingNumber: `T107-${orderId}` });
  await deliver(s.storeId, orderId);
  return orderId;
}
/** Superuser time travel: a sandbox order counted as real (the marker guard is under test in T-105). */
const markReal = (orderId: number) => withoutGuard(`"order"`, "order_test_marker_guard", () => admin.execute(sql`update "order" set test_order = false where id = ${orderId}`));

describe("T-107 order_financials of a seller_owned order", () => {
  it("fee-bearer matrix (buyer/seller × QRIS, VA, COD): order_financials is written once with both fee bearers and the one fee of the method, no platform margin, cashback or affiliate deduction", async () => {
    let n = 0;
    for (const bearer of ["buyer", "seller"] as const) {
      for (const method of ["QRIS", "VABCA", "COD"] as const) {
        const s = await ownStore(`m-${bearer}-${method.toLowerCase()}-${++n}`, { payBearer: bearer, codBearer: bearer });
        const orderId = await submit(s, method === "COD" ? { paymentMethod: "cod" } : { paymentMethod: "manual_transfer", paymentChannel: method });
        const [o, f] = [await orderOf(orderId), await finOf(orderId)];
        const label = `${bearer} × ${method}`;
        // No platform money in the snapshot: margin, platform discount, cashback, affiliate, COD fee inside payable or its VAT.
        expect(o.shippingMargin, label).toBe(0);
        expect(f, label).toMatchObject({ moneyMode: "seller_owned", paymentFeeBearer: bearer, codFeeBearer: bearer, feeRateVersion: 1, platformShippingDiscountIdr: 0, shippingCashbackGrossIdr: 0, platformCashbackIdr: 0, sellerCashbackIdr: 0, affiliateId: null, affiliateCommissionIdr: 0, codFeeIdr: 0, codFeeVatIdr: 0 });
        expect(f.payableIdr, label).toBe(o.total);
        expect(f.saleAmountIdr, label).toBe(f.goodsProceedsIdr + f.includedSalesTaxIdr + f.addedSalesTaxIdr); // nothing deducted from the seller's sale
        const fee = method === "COD" ? feeOf(o.total, 300) : method === "QRIS" ? feeOf(o.subtotal - o.goodsDiscount, 70) : 6_500;
        expect(method === "COD" ? f.expectedCodFeeIdr : f.expectedGatewayFeeIdr, label).toBe(fee);
        expect(method === "COD" ? f.expectedGatewayFeeIdr : f.expectedCodFeeIdr, label).toBe(0);
        expect(f.buyerFeeIdr, label).toBe(bearer === "buyer" ? fee : 0); // buyer: the bill is grossed up; seller: the bill equals the order total
        if (method === "COD") {
          // The courier collects the bill on the store's own key: the total plus the COD fee the buyer bears.
          await transitionOrder(s.owner, orderId, "confirm");
          await bookShipment(s.owner, orderId, { pickupType: "drop_off" });
          const [sh] = await admin.select().from(shipment).where(eq(shipment.orderId, orderId));
          expect(sh!.codAmount, label).toBe(o.total + (bearer === "buyer" ? fee : 0));
        } else {
          const a = await attemptOf(orderId);
          expect({ fee: a.adminFeeIdr, total: a.totalIdr, bearer: a.feeBearer }, label).toEqual({ fee: bearer === "buyer" ? fee : 0, total: o.total + (bearer === "buyer" ? fee : 0), bearer });
        }
        expect(await ledgerOf(orderId), label).toEqual([]);
      }
    }
  });

  it("the database freezes the store's mode and bearers: order_financials of a seller_owned order is immutable and refuses a platform figure", async () => {
    const s = await ownStore("frozen", { payBearer: "seller", codBearer: "buyer" });
    const orderId = await submit(s, { paymentMethod: "cod" });
    expect(await pgCode(admin.execute(sql`update order_financials set buyer_fee_idr = 0 where order_id = ${orderId}`))).toBe("42501");
    // A platform figure in a seller_owned snapshot is refused by the table's own check.
    await withoutGuard("order_financials", "order_financials_guard", async () => {
      expect(await pgCode(admin.execute(sql`update order_financials set platform_cashback_idr = 100, shipping_cashback_gross_idr = 100 where order_id = ${orderId}`))).toBe("23514");
      expect(await pgCode(admin.execute(sql`update order_financials set money_mode = 'platform_held' where order_id = ${orderId}`))).toBe("23514");
    });
  });

  it("the database writes the snapshot only with the store's mode and bearers at submit: a different mode or bearer is refused on INSERT", async () => {
    const s = await ownStore("insertguard", { payBearer: "seller", codBearer: "buyer" });
    const orderId = await submit(s, { paymentMethod: "cod" });
    const original = await finOf(orderId);
    // Re-write the snapshot inside a rolled-back transaction (the local reset switch lifts the delete guard for this statement only).
    const rewrite = (values: typeof original) => admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('bukalaris.ledger_reset', 'demo', true)`);
      await tx.execute(sql`delete from order_line_financials where order_id = ${orderId}`);
      await tx.execute(sql`delete from order_financials where order_id = ${orderId}`);
      await tx.execute(sql`select set_config('bukalaris.ledger_reset', '', true)`);
      await tx.insert(orderFinancials).values(values);
      throw new Error("rollback");
    });
    expect(await boundary(rewrite({ ...original, moneyMode: "platform_held", paymentFeeBearer: null, codFeeBearer: null, feeRateVersion: null, expectedCodFeeIdr: 0, buyerFeeIdr: 0 }))).toBe("money_boundary");
    expect(await boundary(rewrite({ ...original, codFeeBearer: "seller", buyerFeeIdr: 0 }))).toBe("money_boundary");
    expect(await boundary(rewrite({ ...original, paymentFeeBearer: "buyer" }))).toBe("money_boundary");
    expect(await code(rewrite(original))).toBe("Error: rollback"); // the true values pass the guard (control)
  });

  it("a store on its own AutoLaris account without its own Mengantar account offers no shipping and refuses a submit: never a method that cannot complete", async () => {
    const s = await ownStore("nomengantar", { mengantar: false, payBearer: "buyer" });
    expect(await storeMoneyMode(admin, s.storeId)).toBe("seller_owned");
    expect(await code(shippingOptions(s.sf, MENTENG, { lines: [{ quantity: 1, weightGrams: 1000 }], subtotal: 100_000 }))).toBe("shipping_not_ready");
    for (const over of [{ paymentMethod: "cod" }, { paymentMethod: "manual_transfer", paymentChannel: "QRIS" }]) {
      const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
      expect(await code(placeOrder(db, cartId, buyer(over), providers())), over.paymentMethod).toBe("shipping_not_ready");
    }
    expect(await admin.select().from(order).where(eq(order.storeId, s.storeId))).toEqual([]);
    // A platform-held store keeps quoting on the platform account (T-34).
    const legacy = await makeStore("nomengantar-legacy");
    expect((await shippingOptions(legacy.sf, MENTENG, { lines: [{ quantity: 1, weightGrams: 1000 }], subtotal: 100_000 })).options.length).toBeGreaterThan(0);
  });
});

describe("T-107 no ledger for a seller_owned store", () => {
  it("no ledger row for a seller_owned order: a hand-confirmed payment, a COD delivery and a cancellation after payment write no ledger entry and no platform refund", async () => {
    const s = await ownStore("noledger");
    const prepaid = await paidPrepaid(s);
    const cod = await deliveredCod(s);
    expect((await orderOf(cod)).status).toBe("completed");
    expect((await orderOf(cod)).paidAt).not.toBeNull(); // C-P1: delivered COD is paid information for the seller
    await transitionOrder(s.owner, prepaid, "cancel", { reason: "stok habis, uang dikembalikan" });
    expect(await admin.select().from(ledgerEntry).where(eq(ledgerEntry.storeId, s.storeId))).toEqual([]);
    expect(await admin.select().from(refund).where(eq(refund.storeId, s.storeId))).toEqual([]);
  });

  it("review M3: the courier writer follows the frozen money mode, not the shipping account: an own-Mengantar COD order frozen platform_held books its sale", async () => {
    const s = await ownStore("legacycod", { autolaris: false });
    const orderId = await submit(s, { paymentMethod: "cod" });
    expect((await orderOf(orderId)).shippingAccountKind).toBe("seller_owned");
    // The case the backfill leaves behind: an older own-account COD order it could not prove seller-held (for example one with a margin) stays platform_held.
    await withoutGuard("order_financials", "order_financials_guard", () => withoutGuard("order_financials", "order_financials_money_guard", () =>
      admin.execute(sql`update order_financials set money_mode = 'platform_held', payment_fee_bearer = null, cod_fee_bearer = null, expected_cod_fee_idr = 0, buyer_fee_idr = 0, fee_rate_version = null where order_id = ${orderId}`)));
    await transitionOrder(s.owner, orderId, "confirm");
    await transitionOrder(s.owner, orderId, "process");
    await transitionOrder(s.owner, orderId, "ship", { trackingNumber: `T107-${orderId}` });
    await deliver(s.storeId, orderId);
    expect((await ledgerOf(orderId)).map((e) => e.kind)).toContain("sale");
    expect((await verifyLedger(platform)).violations.filter((v) => v.storeId === s.storeId)).toEqual([]);
  });

  it("the database refuses every platform money row for a seller-owned order or store, for every role, by rule (a platform-held store is accepted)", async () => {
    const s = await ownStore("dbrule");
    const cod = await deliveredCod(s);
    const prepaid = await paidPrepaid(s);
    const a = await attemptOf(prepaid);
    const [batch] = await admin.insert(reconciliationBatch).values({ shippingAccountId: 1, source: "owner_batch", evidenceRef: "INV-T107-DB", preparedByUserId: s.ownerId }).returning({ id: reconciliationBatch.id });
    const rows = {
      sale: sql`insert into ledger_entry (store_id, order_id, kind, status, amount_idr) values (${s.storeId}, ${cod}, 'sale', 'pending', 1000)`,
      payout: sql`insert into payout (store_id, requested_by_user_id, request_key, step_up_ref, amount_idr, destination_id, bank_code, bank_account_number, bank_account_holder, holder_name_check) values (${s.storeId}, ${s.ownerId}, 'T107-PAYOUT', ${randomUUID()}, 100000, 1, 'BCA', '1234567890', 'x', 'match')`,
      reconciliation: sql`insert into reconciliation_batch_item (batch_id, order_id, store_id, cod_amount_idr, evidence_line_ref, evidence_amount_idr, evidence_date) values (${batch!.id}, ${cod}, ${s.storeId}, 1000, 'L1', 1000, '2026-11-16')`,
      shipmentCost: sql`insert into shipment_cost (order_id, store_id, booked_shipping_idr, shipping_charged_idr, seller_shipping_debit_idr, platform_shipping_margin_idr) values (${cod}, ${s.storeId}, 1000, 1000, 0, 0)`,
      adjustment: sql`insert into ledger_entry (store_id, kind, status, amount_idr, business_ref, approval_request_id, released_at, release_basis) values (${s.storeId}, 'adjustment', 'available', 1000, 'T107-ADJ', 1, now(), 'direct')`,
      destination: sql`insert into payout_destination (store_id, bank_code, account_number, account_holder_name, holder_name_check, status, hold_until, created_by_user_id, step_up_ref) values (${s.storeId}, 'BCA', '1234567890', 'x', 'match', 'held', now(), ${s.ownerId}, ${randomUUID()})`,
      refund: sql`insert into refund (store_id, order_id, payment_attempt_id, goods_refund_idr, shipping_refund_idr, fee_refund_idr, amount_idr, reason) values (${s.storeId}, ${prepaid}, ${a.id}, ${a.totalIdr}, 0, 0, ${a.totalIdr}, 'order_cancelled')`,
      platformAttempt: sql`insert into payment_attempt (store_id, order_id, owner_id, request_key, reff_id, channel_code, customer, amount_idr, admin_fee_idr, total_idr, expires_at) values (${s.storeId}, ${prepaid}, ${String(prepaid)}, 'platform-fallback', ${"9".repeat(29)}, 'VABCA', '{"id":"x","name":"x","phone":"x","email":null}'::jsonb, ${a.amountIdr}, 0, ${a.amountIdr}, now() + interval '1 day')`,
      obligation: sql`insert into late_payment_obligation (attempt_id, store_id, order_id, amount_idr) values (${a.id}, ${s.storeId}, ${prepaid}, ${a.totalIdr})`,
    };
    for (const [name, q] of Object.entries(rows)) expect(await boundary(admin.execute(q)), name).toBe("money_boundary");
    expect(await storeMoneyMode(admin, s.storeId)).toBe("seller_owned");
    // A platform-held store: the same rows pass this guard, and its real money paths insert (ADR-0006 unchanged): a released sale through the
    // payment and release services, a payout destination through the step-up service, then a raw sale of the same shape is not refused by rule.
    const legacy = await makeStore("dbrule-legacy");
    expect(await storeMoneyMode(admin, legacy.storeId)).toBe("platform_held");
    const funded = await fund(legacy);
    await activateDestination(legacy);
    expect((await admin.select().from(ledgerEntry).where(eq(ledgerEntry.storeId, legacy.storeId))).length).toBeGreaterThan(0);
    expect(await admin.select().from(payoutDestination).where(eq(payoutDestination.storeId, legacy.storeId))).toHaveLength(1);
    expect(await boundary(admin.execute(sql`insert into ledger_entry (store_id, order_id, kind, status, amount_idr) values (${legacy.storeId}, ${funded.orderId}, 'sale', 'pending', 1000)`))).not.toBe("money_boundary");
  });

  it("payout request refused: payout, payout destination, release, reconciliation, manual completion and ledger adjustment refuse a seller-owned store by rule, not by missing data", async () => {
    const s = await ownStore("nopayout");
    const cod = await deliveredCod(s);
    const key = randomUUID();
    expect(await code(requestPayout(s.me, { proofId: await issueSellerStepUp(s.me, { action: "payout.request", subjectId: key }), requestKey: key, amountIdr: 100_000 }))).toBe("seller_owned_store");
    expect(await code(setPayoutDestination(s.me, { proofId: await issueSellerStepUp(s.me, { action: "payout.destination", subjectId: String(s.storeId) }), bankCode: "BCA", accountNumber: "1234567890", accountHolderName: "Pemilik Toko" }))).toBe("seller_owned_store");
    expect(await code(releaseStore(platform, s.storeId))).toBe("seller_owned_store");
    const op = await makeOperator(["payouts.reconcile", "payouts.process", "ledger.adjust", "finance.read"]);
    expect(await code(prepareReconciliationBatch(op, { evidenceRef: "INV-T107", lines: [{ orderId: cod, evidenceLineRef: "L1", evidenceAmountIdr: 1, evidenceDate: "2026-11-16" }] }))).toBe("seller_owned_order");
    expect(await code(requestLedgerAdjustment(op, { storeId: s.storeId, amountIdr: 1_000, businessRef: "T107-ADJ", reason: "koreksi saldo" }))).toBe("seller_owned_store");
    const shipped = await submit(s, { paymentMethod: "cod" });
    await transitionOrder(s.owner, shipped, "confirm");
    await transitionOrder(s.owner, shipped, "process");
    await transitionOrder(s.owner, shipped, "ship", { trackingNumber: `T107-${shipped}` });
    await claimDelivery(s.owner, shipped);
    expect(await code(requestManualCompletion(op, { orderId: shipped, evidenceRef: "POD-1", reason: "bukti kurir" }))).toBe("seller_owned_order");
    expect((await manualCompletionCandidates(op)).map((c) => c.orderId)).not.toContain(shipped); // the Owner console lists platform-held money only
    expect(await admin.select().from(payout).where(eq(payout.storeId, s.storeId))).toEqual([]);
    expect(await admin.select().from(payoutDestination).where(eq(payoutDestination.storeId, s.storeId))).toEqual([]);
  });

  it("the platform account is never used for a seller-owned store: without its own AutoLaris account it offers no QRIS/VA and refuses a direct submit (Ceiling T-106-1 closed for it)", async () => {
    const s = await ownStore("noplatform", { autolaris: false, codBearer: "buyer" });
    const methods = await checkoutPaymentChannels(db, s.storeId, platformFake);
    expect(methods.channels).toEqual([]);
    expect(methods.codFee).toEqual({ bearer: "buyer", base: "payable", rateBps: 300, fixedIdr: 0 });
    expect(await code(submit(s, { paymentMethod: "manual_transfer", paymentChannel: "VABCA" }))).toBe("payment_channel");
    expect(platformFake.createCalls).toHaveLength(0);
    // A platform-held store keeps the T-49 platform account and no COD fee terms.
    const legacy = await makeStore("noplatform-legacy");
    expect((await checkoutPaymentChannels(db, legacy.storeId, platformFake)).codFee).toBeNull();
  });
});

describe("T-107 clean cut-over to the store's own accounts (review M2)", () => {
  it("a store with platform money in flight cannot connect its own account (service and database), the seller sees why; with none left it can", async () => {
    const legacy = await makeStore("cutover");
    const me = bindSession(legacy.owner, await sessionOf(legacy.ownerId));
    const connect = async () => saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: KEY.autolaris, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    // An order that is not completed, cancelled or returned.
    const cartId = await setCartLine(legacy.sf, undefined, { variantId: legacy.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer({ paymentMethod: "cod" }), providers());
    const refused = await connect().then(() => null, (e: { code?: string; message?: string }) => e);
    expect(refused?.code).toBe("platform_money_open");
    expect(refused?.message).toContain("pesanan yang belum selesai");
    expect(await pgCode(admin.execute(sql`insert into store_payment_account (store_id, environment, status) values (${legacy.storeId}, 'sandbox', 'needs_key')`))).toBe("BKMB2");
    expect(await pgCode(admin.execute(sql`insert into store_shipping_account (store_id, kind, status, external_user_id, environment) values (${legacy.storeId}, 'seller_owned', 'needs_key', 'x', 'sandbox')`))).toBe("BKMB2");
    expect(await storeMoneyMode(admin, legacy.storeId)).toBe("platform_held");
    // A ledger balance is money in flight too.
    const funded = await makeStore("cutover-funded");
    await fund(funded);
    expect(await pgCode(admin.execute(sql`insert into store_payment_account (store_id, environment, status) values (${funded.storeId}, 'sandbox', 'needs_key')`))).toBe("BKMB2");
    // Once the order is closed (rejected: restocked, nothing collected) the store moves to its own accounts.
    await transitionOrder(legacy.owner, orderId, "reject", { reason: "pembeli membatalkan" });
    await connect();
    expect(await storeMoneyMode(admin, legacy.storeId)).toBe("seller_owned");
  });

  it("verify:ledger keeps a converted store's earlier platform history clean and flags only rows created after the conversion", async () => {
    const legacy = await makeStore("history");
    await activateDestination(legacy); // platform history: a payout destination before the conversion
    const me = bindSession(legacy.owner, await sessionOf(legacy.ownerId));
    await saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: KEY.autolaris, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    expect((await verifyLedger(platform)).violations).toEqual([]);
    // A destination forced past the guard after the conversion is flagged.
    // Both guards stand in the way of a hand-made row: the boundary (the point of this check) and the D-19 hold and step-up rule.
    await withoutGuard("payout_destination", "payout_destination_guard", () => withoutGuard("payout_destination", "a_money_boundary_guard", () => admin.execute(sql`insert into payout_destination (store_id, bank_code, account_number, account_holder_name, holder_name_check, status, hold_until, superseded_at, created_by_user_id, step_up_ref) values (${legacy.storeId}, 'BCA', '9876543210', 'x', 'match', 'superseded', now(), now(), ${legacy.ownerId}, ${randomUUID()})`)));
    expect((await verifyLedger(platform)).violations.map((v) => v.code)).toContain("seller_owned_in_platform_books");
  });
});

describe("T-107 Seller Admin: collected amounts, refunds recorded by the seller", () => {
  it("dashboard totals equal the sum of paid and delivered orders by method; test orders and unpaid orders are not counted", async () => {
    const s = await ownStore("collected", { payBearer: "buyer", codBearer: "buyer" });
    const qris = await paidPrepaid(s, "QRIS");
    const va = await paidPrepaid(s, "VABCA");
    const cod = await deliveredCod(s);
    const pendingCod = await submit(s, { paymentMethod: "cod" });
    const unpaid = await submit(s, { paymentMethod: "manual_transfer", paymentChannel: "QRIS" });
    const sandbox = await paidPrepaid(s, "QRIS"); // stays a test order
    for (const id of [qris, va, cod, pendingCod, unpaid]) await markReal(id);
    const bill = async (id: number) => {
      const f = await finOf(id);
      return f.payableIdr + f.buyerFeeIdr;
    };
    const d = await sellerDashboard(s.me, "today");
    expect(d.collected).toEqual({
      byMethod: [{ method: "cod", orders: 1, amountIdr: await bill(cod) }, { method: "qris", orders: 1, amountIdr: await bill(qris) }, { method: "va", orders: 1, amountIdr: await bill(va) }],
      orders: 3, totalIdr: (await bill(cod)) + (await bill(qris)) + (await bill(va)), refundedIdr: 0, refunds: 0,
    });
    expect(d.kpi.total).toBe(5); // the sandbox order is in no sales figure
    expect((await orderOf(sandbox)).testOrder).toBe(true);
    expect((await sellerCollected(s.me))!.last30.totalIdr).toBe(d.collected!.totalIdr);
    // A platform-held store has no collected view (its money is the ledger's).
    const legacy = await makeStore("collected-legacy");
    expect((await sellerDashboard(legacy.owner, "today")).collected).toBeNull();
    expect(await sellerCollected(legacy.owner)).toBeNull();
  });

  it("a refund is recorded on the order as made by the seller: owner only, paid orders only, never above the buyer's bill (service and database, also under concurrency), append-only, shown on the buyer's link", async () => {
    const s = await ownStore("refund", { payBearer: "buyer" });
    const orderId = await paidPrepaid(s);
    const unpaid = await submit(s, { paymentMethod: "manual_transfer", paymentChannel: "QRIS" });
    const { billIdr } = (await getOrder(s.me, orderId))!.money!;
    const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    const input = (amountIdr: number) => ({ amountIdr, refundedOn: today, method: "bank_transfer", reason: "barang habis, uang kembali" });
    const staffId = await makeUser("refund-staff");
    await platform.insert(membership).values({ storeId: s.storeId, userId: staffId, role: "staff" });
    expect(await code(recordSellerRefund(await seller(staffId, s.storeId), orderId, input(1_000)))).toBe("forbidden");
    expect(await code(recordSellerRefund(s.me, unpaid, input(1_000)))).toBe("not_paid");
    expect(await code(recordSellerRefund(s.me, orderId, input(billIdr + 1)))).toBe("refund_exceeds_bill");
    expect(await code(recordSellerRefund(s.me, orderId, { ...input(1_000), refundedOn: "2999-01-01" }))).toBe("refund_date");
    await recordSellerRefund(s.me, orderId, input(billIdr - 5_000));
    // Two concurrent records that each fit alone but not together: the database lets one through.
    const raced = await Promise.all([recordSellerRefund(s.me, orderId, input(4_000)).then(() => "ok", () => "refused"), withStore(db, s.storeId, (tx) => tx.insert(orderSellerRefund).values({ storeId: s.storeId, orderId, amountIdr: 4_000, refundedOn: today, method: "cash", reason: "langsung lewat db", recordedByUserId: s.ownerId })).then(() => "ok", () => "refused")]);
    expect(raced.sort()).toEqual(["ok", "refused"]);
    const money = (await getOrder(s.me, orderId))!.money!;
    expect(money.refundedIdr).toBe(billIdr - 1_000);
    expect(await boundary(withStore(db, s.storeId, (tx) => tx.insert(orderSellerRefund).values({ storeId: s.storeId, orderId, amountIdr: 1_001, refundedOn: today, method: "cash", reason: "lewat batas tagihan", recordedByUserId: s.ownerId })))).toBe("money_boundary");
    expect(await pgCode(admin.execute(sql`update order_seller_refund set amount_idr = 1 where order_id = ${orderId}`))).toBe("42501");
    expect(await pgCode(admin.execute(sql`delete from order_seller_refund where order_id = ${orderId}`))).toBe("42501");
    // Store B cannot read or write store A's records (FORCE RLS).
    const other = await makeStore("refund-other");
    expect(await withStore(db, other.storeId, (tx) => tx.select().from(orderSellerRefund).where(eq(orderSellerRefund.orderId, orderId)))).toEqual([]);
    // C-P9: the buyer's signed link shows the recorded refunds (amount, day, method) and nothing of the seller's note.
    const view = (await buyerOrderMoneyForLink(db, signOrderLink(orderId)))!;
    expect(view.refundedIdr).toBe(billIdr - 1_000);
    expect(JSON.stringify(view)).not.toContain("barang habis");
    // A platform-held order is refused by rule: its refunds follow BILL-5.
    const legacy = await makeStore("refund-legacy");
    const legacyMe = bindSession(legacy.owner, await sessionOf(legacy.ownerId));
    const cartId = await setCartLine(legacy.sf, undefined, { variantId: legacy.variantId, quantity: 1 }, "add");
    const { orderId: legacyOrder } = await placeOrder(db, cartId, buyer({ paymentMethod: "cod" }), providers());
    expect(await code(recordSellerRefund(legacyMe, legacyOrder, input(1_000)))).toBe("platform_held_order");
  });

  it("seller screens name Mengantar: the waybill of the store's own account comes from Mengantar, the platform path stays white-label", () => {
    const base = { createdAt: new Date(0), bookedAt: new Date(1), deliveredAt: null, status: "booked" as const, trackingHistory: [] };
    expect(shipmentTimeline(base, "Mengantar").map((t) => t.text)).toContain("Resi terbit dari Mengantar");
    expect(shipmentTimeline(base).map((t) => t.text)).toContain("Resi terbit dari Bukalaris Kirim");
  });
});

describe("T-107 Owner console and verify:ledger with mixed data", () => {
  it("verify:ledger passes with mixed data (platform ledger beside seller-owned orders) and flags a seller-owned order in the platform books", async () => {
    const legacy = await makeStore("mixed-legacy");
    await fund(legacy); // a released prepaid sale in the platform ledger
    const s = await ownStore("mixed-own", { payBearer: "seller", codBearer: "buyer" });
    const cod = await deliveredCod(s);
    await recordSellerRefund(s.me, cod, { amountIdr: 1_000, refundedOn: new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10), method: "cash", reason: "ongkir kelebihan" });
    const ok = await verifyLedger(platform);
    expect(ok.violations).toEqual([]);
    expect(ok.sellerOwnedOrders).toBeGreaterThanOrEqual(1);
    expect(ok.sellerOwnedStores).toBe(1);
    const position = Object.fromEntries((await consoleMoneyPosition(await makeOperator(["finance.read"]))).map((p) => [p.class, p.amountIdr]));
    expect(position.platform_cod_fee).toBe(0); // the seller-owned COD fee is the courier's, never a platform class
    // A row forced past the guard is flagged.
    await withoutGuard("ledger_entry", "a_money_boundary_guard", async () => admin.insert(ledgerEntry).values({ storeId: s.storeId, orderId: cod, kind: "sale", status: "pending", amountIdr: (await finOf(cod)).saleAmountIdr }));
    const bad = await verifyLedger(platform);
    expect(bad.violations.map((v) => v.code)).toContain("seller_owned_in_platform_books");
  });
});
