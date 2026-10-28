import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { reserveShippingCost, reverseShippingReservation } from "../src/ledger/booking.ts";
import { applyReconciliationBatch, prepareReconciliationBatch, submitReconciliationBatch } from "../src/ledger/reconciliation.ts";
import { consoleMoneyPosition, latePaymentObligations, storeLedger, unknownTransfers } from "../src/ledger/console.ts";
import { assertPayoutsNotFrozen, payoutFreeze, setPayoutFreeze } from "../src/ledger/control.ts";
import { openRefundForPaidOrder } from "../src/ledger/ledger.ts";
import { sellerFinance } from "../src/ledger/payouts.ts";
import { convertLateObligations, getRefundForLink, reopenFailedRefund, submitRefundDestination } from "../src/ledger/refunds.ts";
import { releaseStore } from "../src/ledger/release.ts";
import { approveForTransfer, claimTransfer, completeTransfer, recordTransferUnknown, rejectTransfer, requestTransferApproval } from "../src/ledger/transfer.ts";
import { verifyLedger } from "../src/ledger/verify.ts";
import { decideApproval } from "../src/ops/capabilities-approvals.ts";
import { signOrderLink } from "../src/ops/jobs/notify.ts";
import { withStore } from "../src/platform/tenant.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import { auditLog, ledgerEntry, orderFinancials, payout, refund, shipmentCost } from "../src/schema.ts";
import { admin, db, makeOperator, makeStore, platform } from "./helpers.ts";
import { activateDestination, balance, deliveredCod, fund, operatorSession, paidPrepaid, place, receipt, requestPayoutOf, withoutGuard, type S } from "./t37-fixtures.ts";

// T-37 finish: the tests the first builder left out (booking-time reconciliation, the buyer's refund destination, late-payment obligations, the refund approval path,
// the post-restore freeze) and the Owner console services behind SA-08, SA-17, SA-26 and SA-53.
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
const finOf = async (orderId: number) => (await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId)))[0]!;
const entriesOf = (orderId: number) => platform.select().from(ledgerEntry).where(eq(ledgerEntry.orderId, orderId)).orderBy(ledgerEntry.id);
const costOf = async (orderId: number) => (await platform.select().from(shipmentCost).where(eq(shipmentCost.orderId, orderId)))[0];
const refundOf = async (orderId: number) => (await platform.select().from(refund).where(eq(refund.orderId, orderId)))[0];
const position = async () => Object.fromEntries((await consoleMoneyPosition(await makeOperator(["finance.read"]))).map((p) => [p.class, p.amountIdr]));

describe("reserveShippingCost: the debit is reserved before the provider is called (ADR-0006 decision 7)", () => {
  async function prepaid(s: S) {
    const { orderId } = await paidPrepaid(s);
    return { orderId, fin: await finOf(orderId) };
  }
  const book = (s: S, orderId: number, extra: number, fin: { shippingChargedIdr: number }, cod: number | null = null) =>
    reserveShippingCost(platform, { storeId: s.storeId, orderId, requote: { bookedShippingIdr: fin.shippingChargedIdr + extra, providerCodFeeIdr: 0 }, codAmountSentIdr: cod });

  it("covered by the available balance: the debit is born available, one cost record, a second call changes nothing", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    await fund(s, 2); // available 200 000
    const { orderId, fin } = await prepaid(s);
    expect(await book(s, orderId, 30_000, fin)).toMatchObject({ outcome: "reserved", debitIdr: 30_000, marginIdr: 0, debitStatus: "available" });
    expect(await book(s, orderId, 99_000, fin)).toEqual({ outcome: "already", debitIdr: 30_000 }); // append-once: a later price is not a mutation
    const debit = (await entriesOf(orderId)).filter((e) => e.kind === "shipping_debit");
    expect(debit).toMatchObject([{ status: "available", amountIdr: -30_000, releaseBasis: "direct" }]);
    expect(await costOf(orderId)).toMatchObject({ bookedShippingIdr: fin.shippingChargedIdr + 30_000, sellerShippingDebitIdr: 30_000, platformShippingMarginIdr: 0, shippingDebitEntryId: debit[0]!.id });
    expect((await balance(s.storeId)).availableIdr).toBe(170_000);
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });

  it("a prepaid debit nets against its own pending sale when available cannot cover it; when neither can, it is refused BEFORE the provider with nothing written", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const { orderId, fin } = await prepaid(s); // available 0, pending sale 100 000
    expect(await book(s, orderId, 60_000, fin)).toMatchObject({ outcome: "reserved", debitStatus: "pending" });
    const t = await makeStore("toko-b", { price: 100_000 });
    const second = await prepaid(t);
    expect(await book(t, second.orderId, 150_000, second.fin)).toEqual({ outcome: "refused", reason: "insufficient_balance" });
    expect(await costOf(second.orderId)).toBeUndefined();
    expect((await entriesOf(second.orderId)).filter((e) => e.kind === "shipping_debit")).toEqual([]);
  });

  it("a cheaper booking reserves nothing and records the platform's margin; a COD amount that differs from the frozen COD amount is refused", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const { orderId, fin } = await prepaid(s);
    expect(await book(s, orderId, -2_000, fin)).toMatchObject({ outcome: "reserved", debitIdr: 0, marginIdr: 2_000, debitStatus: null });
    expect(await costOf(orderId)).toMatchObject({ sellerShippingDebitIdr: 0, platformShippingMarginIdr: 2_000, shippingDebitEntryId: null });
    expect((await entriesOf(orderId)).filter((e) => e.kind === "shipping_debit")).toEqual([]);
    const codId = await place(s, { paymentMethod: "cod" });
    await transitionOrder(s.owner, codId, "confirm");
    const codFin = await finOf(codId);
    expect(await book(s, codId, 10_000, codFin, codFin.payableIdr - 1)).toEqual({ outcome: "refused", reason: "cod_amount_mismatch" });
    expect(await costOf(codId)).toBeUndefined();
    expect(await book(s, codId, 10_000, codFin, codFin.payableIdr)).toMatchObject({ outcome: "reserved", debitStatus: "pending" }); // COD: settles with the delivered sale (OPEN-F3)
  });

  it("only a placed or processing order is bookable", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const { orderId, fin } = await prepaid(s);
    await transitionOrder(s.owner, orderId, "cancel", { reason: "uji pembatalan" });
    expect(await book(s, orderId, 10_000, fin)).toEqual({ outcome: "refused", reason: "not_bookable" });
  });

  it("the reversal posts the exact opposite once after a definite rejection and blocks a second booking; two bookings racing reserve once", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    await fund(s, 2);
    const { orderId, fin } = await prepaid(s);
    expect(await book(s, orderId, 30_000, fin)).toMatchObject({ outcome: "reserved" });
    expect(await reverseShippingReservation(platform, s.storeId, orderId)).toEqual({ reversed: true });
    expect(await reverseShippingReservation(platform, s.storeId, orderId)).toEqual({ reversed: false });
    expect((await entriesOf(orderId)).filter((e) => e.kind.startsWith("shipping_debit")).map((e) => e.amountIdr)).toEqual([-30_000, 30_000]);
    expect(await book(s, orderId, 30_000, fin)).toEqual({ outcome: "refused", reason: "reservation_reversed" });
    const other = await prepaid(s);
    const results = await Promise.all([1, 2, 3].map(() => book(s, other.orderId, 20_000, other.fin)));
    expect(results.filter((r) => r.outcome === "reserved")).toHaveLength(1);
    expect((await entriesOf(other.orderId)).filter((e) => e.kind === "shipping_debit")).toHaveLength(1);
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });
});

describe("the buyer's refund destination (D-20, OPEN-F4)", () => {
  async function cancelledPaid() {
    const s = await makeStore("toko-a", { price: 100_000 });
    const { orderId } = await paidPrepaid(s);
    await transitionOrder(s.owner, orderId, "cancel", { reason: "uji pembatalan" });
    return { s, orderId, token: signOrderLink(orderId), refund: (await refundOf(orderId))! };
  }
  const dest = { bank: "bca", account: "1234567890", holder: "Budi Santoso" };

  it("the signed link alone submits and corrects the destination while pending; the page shows the last four digits only; a forged, expired or foreign link and a bad account are refused", async () => {
    const { s, orderId, token, refund: r } = await cancelledPaid();
    const other = await paidPrepaid(s);
    await transitionOrder(s.owner, other.orderId, "cancel", { reason: "uji pembatalan" });
    await submitRefundDestination(db, token, dest);
    expect(await refundOf(orderId)).toMatchObject({ destinationBank: "BCA", destinationAccount: "1234567890", destinationHolder: "Budi Santoso", status: "pending" });
    await submitRefundDestination(db, token, { ...dest, account: "9988776655" }); // a correction
    const view = await getRefundForLink(db, token);
    expect(view).toMatchObject({ id: r.id, status: "pending", amountIdr: r.amountIdr, destinationSet: true, destinationLast4: "6655", destinationBank: "BCA" });
    expect(JSON.stringify(view)).not.toContain("9988776655");
    expect(await code(submitRefundDestination(db, `${token}x`, dest))).toBe("not_found");
    expect(await code(submitRefundDestination(db, signOrderLink(orderId, Date.now() - 40 * 86_400_000), dest))).toBe("not_found"); // expired
    await expect(submitRefundDestination(db, token, { ...dest, account: "12ab" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(submitRefundDestination(db, token, { ...dest, bank: "BCA", extra: "x" })).rejects.toMatchObject({ name: "ZodError" });
    expect((await refundOf(other.orderId))!.destinationAccount).toBeNull(); // another order's refund is untouched
  });

  it("once approved for transfer the destination is frozen, the app login can change nothing else, and an order without a refund has no form", async () => {
    const { orderId, token, refund: r } = await cancelledPaid();
    await submitRefundDestination(db, token, dest);
    const a = await makeOperator(["refunds.process"]);
    const b = await makeOperator(["refunds.process"]);
    const { approvalId } = await requestTransferApproval(a, "refund", r.id, "refund pembatalan");
    await decideApproval(b, approvalId, "approve");
    await approveForTransfer(a, "refund", r.id);
    expect(await code(submitRefundDestination(db, token, { ...dest, account: "5555555555" }))).toBe("not_editable");
    expect((await refundOf(orderId))!.destinationAccount).toBe("1234567890");
    const other = await makeStore("toko-b", { price: 100_000 });
    const plain = await place(other, { paymentMethod: "cod" });
    expect(await getRefundForLink(db, signOrderLink(plain))).toBeNull();
    expect(await code(withStore(db, r.storeId, (tx) => tx.update(refund).set({ status: "completed" }).where(eq(refund.id, r.id))))).toBe("42501"); // the buyer link only submits the destination
  });
});

describe("late-payment obligations and the refund an order cancellation opens", () => {
  it("cancelling a gateway-paid order opens exactly one full refund (goods + shipping + the admin fee the buyer paid) and reverses the pending sale", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const { orderId, attempt } = await paidPrepaid(s);
    await transitionOrder(s.owner, orderId, "cancel", { reason: "uji pembatalan" });
    const r = (await refundOf(orderId))!;
    expect(r).toMatchObject({ status: "pending", reason: "order_cancelled", amountIdr: attempt.totalIdr, feeRefundIdr: attempt.adminFeeIdr });
    expect(r.goodsRefundIdr + r.shippingRefundIdr + r.feeRefundIdr).toBe(attempt.totalIdr);
    expect((await entriesOf(orderId)).map((e) => `${e.kind}:${e.status}`)).toEqual(["sale:pending", "return_reversal:pending"]);
    expect(await platform.select().from(refund).where(eq(refund.orderId, orderId))).toHaveLength(1);
    expect(await position()).toMatchObject({ refunds_open: attempt.totalIdr, seller_pending: 0, seller_available: 0 });
  });

  it("an obligation without its refund (left by an interrupted run) is converted once; replays and a second pass open nothing; the console lists obligation and refund together", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const { orderId, attempt } = await paidPrepaid(s);
    await transitionOrder(s.owner, orderId, "cancel", { reason: "uji pembatalan" });
    await withoutGuard("refund", "refund_guard", () => admin.execute(sql`delete from refund where order_id = ${orderId}`));
    await admin.execute(sql`insert into late_payment_obligation (attempt_id, store_id, order_id, amount_idr) values (${attempt.id}, ${s.storeId}, ${orderId}, ${attempt.totalIdr})`);
    const op = await makeOperator(["finance.read"]);
    expect(await latePaymentObligations(op)).toMatchObject([{ orderId, amountIdr: attempt.totalIdr, refundId: null, refundStatus: null }]); // a break: obligation without a refund
    expect(await convertLateObligations(platform)).toBe(1);
    expect(await convertLateObligations(platform)).toBe(0);
    expect(await refundOf(orderId)).toMatchObject({ status: "pending", reason: "late_payment", amountIdr: attempt.totalIdr });
    expect(await latePaymentObligations(op)).toMatchObject([{ orderId, refundId: expect.any(Number), refundStatus: "pending" }]);
    expect(await code(latePaymentObligations(await makeOperator(["tenants.read"])))).toBe("forbidden");
  });
});

describe("refund approval and completion", () => {
  async function refundWithDestination() {
    const s = await makeStore("toko-a", { price: 100_000 });
    const { orderId } = await paidPrepaid(s);
    await transitionOrder(s.owner, orderId, "cancel", { reason: "uji pembatalan" });
    const r = (await refundOf(orderId))!;
    await submitRefundDestination(db, signOrderLink(orderId), { bank: "BCA", account: "1234567890", holder: "Budi Santoso" });
    return { s, orderId, r };
  }

  it("a refund needs a destination before approval; approve for transfer is four-eyes; the claimant completes it with evidence; the seller ledger is untouched", async () => {
    const { s, orderId, r } = await refundWithDestination();
    const noDest = await makeStore("toko-b", { price: 100_000 });
    const second = await paidPrepaid(noDest);
    await transitionOrder(noDest.owner, second.orderId, "cancel", { reason: "uji pembatalan" });
    const a = await makeOperator(["refunds.process"]);
    const b = await makeOperator(["refunds.process"]);
    expect(await code(requestTransferApproval(a, "refund", (await refundOf(second.orderId))!.id, "tanpa rekening"))).toBe("destination_missing");
    const before = (await platform.select().from(ledgerEntry)).length;
    const { approvalId } = await requestTransferApproval(a, "refund", r.id, "refund pembatalan");
    expect(await code(decideApproval(a, approvalId, "approve"))).toBe("self_approval");
    await decideApproval(b, approvalId, "approve");
    await approveForTransfer(a, "refund", r.id);
    await claimTransfer(a, await operatorSession(a), "refund", r.id);
    await completeTransfer(a, "refund", r.id, { evidenceRef: "BCA-REFUND-0001", receipt: receipt() });
    expect(await refundOf(orderId)).toMatchObject({ status: "completed", transferEvidenceRef: "BCA-REFUND-0001", approvalRequestId: approvalId });
    expect((await platform.select().from(ledgerEntry)).length).toBe(before); // a buyer refund is the platform's: no seller entry
    expect(await position()).toMatchObject({ refunds_open: second.attempt.totalIdr });
    expect((await verifyLedger(platform)).violations).toEqual([]);
    expect((await balance(s.storeId)).availableIdr).toBe(0);
  });

  it("refunding more than was paid is refused by the database, a second refund for the order is idempotent, and a completed refund never reopens", async () => {
    const { s, orderId, r } = await refundWithDestination();
    const attempt = (await admin.execute(sql`select id, total_idr from payment_attempt where order_id = ${orderId}`)) as unknown as { id: string; total_idr: string }[];
    const insert = (amount: number, goods: number) =>
      platform.execute(sql`insert into refund (store_id, order_id, payment_attempt_id, goods_refund_idr, shipping_refund_idr, fee_refund_idr, amount_idr, reason) values (${s.storeId}, ${orderId}, ${attempt[0]!.id}, ${goods}, ${r.shippingRefundIdr}, ${r.feeRefundIdr}, ${amount}, 'order_cancelled')`);
    expect(await code(insert(r.amountIdr + 1_000, r.goodsRefundIdr + 1_000))).toBe("23514"); // more than the payment (and a unique violation would be 23505, not this)
    expect(await code(platform.update(refund).set({ amountIdr: r.amountIdr + 1, goodsRefundIdr: r.goodsRefundIdr + 1 }).where(eq(refund.id, r.id)))).toBe("42501"); // the composition is immutable
    expect(await withStore(platform, s.storeId, (tx) => openRefundForPaidOrder(tx, s.storeId, orderId, "order_cancelled"))).toBe(false); // replay: nothing opened
    expect(await code(insert(r.amountIdr, r.goodsRefundIdr))).toBe("23505"); // the same order never gets a second live refund
    expect(await platform.select().from(refund).where(eq(refund.orderId, orderId))).toHaveLength(1);
    expect(await code(reopenFailedRefund(await makeOperator(["refunds.process"]), r.id, "bukan yang gagal"))).toBe("invalid_state");
  });

  it("concurrent approvals decide once and concurrent executions move the refund once", async () => {
    const { r } = await refundWithDestination();
    const a = await makeOperator(["refunds.process"]);
    const b = await makeOperator(["refunds.process"]);
    const c = await makeOperator(["refunds.process"]);
    const { approvalId } = await requestTransferApproval(a, "refund", r.id, "refund pembatalan");
    const decided = await Promise.allSettled([decideApproval(b, approvalId, "approve"), decideApproval(c, approvalId, "approve"), decideApproval(b, approvalId, "approve")]);
    expect(decided.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const ran = await Promise.allSettled([approveForTransfer(a, "refund", r.id), approveForTransfer(a, "refund", r.id), approveForTransfer(a, "refund", r.id)]);
    expect(ran.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await platform.select().from(refund).where(eq(refund.id, r.id)))[0]).toMatchObject({ status: "processing", approvalRequestId: approvalId });
  });
});

describe("the post-restore payout freeze (RUNBOOK 14, DR-1)", () => {
  const frozenFlow = async () => {
    const s = await makeStore("toko-a", { price: 500_000 });
    await fund(s);
    await activateDestination(s);
    const { payoutId } = await requestPayoutOf(s, 150_000);
    const a = await makeOperator(["payouts.process"]);
    const b = await makeOperator(["payouts.process"]);
    return { s, payoutId, a, b };
  };

  it("only payouts.process flips it, with a reason, audited; the state is readable by the seller screen", async () => {
    const { s, a } = await frozenFlow();
    expect(await code(setPayoutFreeze(await makeOperator(["tenants.read"]), { frozen: true, reason: "pemulihan data" }))).toBe("forbidden");
    expect(await code(setPayoutFreeze(a, { frozen: true, reason: "x" }))).toBeUndefined(); // ZodError: a reason is required
    expect((await payoutFreeze(platform)).frozen).toBe(false);
    await setPayoutFreeze(a, { frozen: true, reason: "pemulihan data dari cadangan jam 10" });
    expect(await payoutFreeze(platform)).toMatchObject({ frozen: true, reason: "pemulihan data dari cadangan jam 10", changedBy: a.userId });
    expect((await sellerFinance(s.owner)).payoutsFrozen).toBe(true);
    expect(await platform.select().from(auditLog).where(eq(auditLog.action, "payout.freeze"))).toHaveLength(1);
    await setPayoutFreeze(a, { frozen: false, reason: "bukti bank sudah dicocokkan" });
    expect((await sellerFinance(s.owner)).payoutsFrozen).toBe(false);
    expect(await platform.select().from(auditLog).where(eq(auditLog.action, "payout.unfreeze"))).toHaveLength(1);
  });

  it("while frozen no payout is requested, approved, claimed, completed, rejected or released by a batch (service and database), while notes, destinations, refund addresses and ledger.release go on; unfreezing resumes", async () => {
    const { s, payoutId, a, b } = await frozenFlow();
    const { approvalId } = await requestTransferApproval(a, "payout", payoutId, "pencairan uji");
    await decideApproval(b, approvalId, "approve");
    const cod = await deliveredCod(s);
    const opA = await makeOperator(["payouts.reconcile"]);
    const opB = await makeOperator(["payouts.reconcile"]);
    const fin = await finOf(cod);
    const { batchId } = await prepareReconciliationBatch(opA, { evidenceRef: "INV-FREEZE-1", lines: [{ orderId: cod, evidenceLineRef: "L1", evidenceAmountIdr: fin.payableIdr, evidenceDate: "2026-10-28" }] });
    const batchApproval = await submitReconciliationBatch(opA, batchId, "rekonsiliasi uji");
    await decideApproval(opB, batchApproval.approvalId, "approve");
    await setPayoutFreeze(a, { frozen: true, reason: "pemulihan data dari cadangan" });
    expect(await code(requestPayoutOf(s, 100_000))).toBe("payouts_frozen");
    expect(await code(approveForTransfer(a, "payout", payoutId))).toBe("payouts_frozen");
    expect(await code(rejectTransfer(a, "payout", payoutId, { reason: "dibekukan" }))).toBe("payouts_frozen");
    expect(await code(applyReconciliationBatch(opA, batchId))).toBe("payouts_frozen");
    // the database refuses the same moves written directly (no service in the way): 55000 object_not_in_prerequisite_state
    expect(await code(platform.update(payout).set({ status: "rejected", rejectionReason: "x-dibekukan", processedByUserId: a.userId, processedAt: new Date() }).where(eq(payout.id, payoutId)))).toBe("55000");
    expect(await code(platform.update(payout).set({ claimedByUserId: a.userId, claimExpiresAt: new Date(Date.now() + 60_000) }).where(eq(payout.id, payoutId)))).toBe("55000");
    expect(await code(platform.execute(sql`update reconciliation_batch set status = 'applied', applied_at = now(), approved_by_user_id = ${opB.userId} where id = ${batchId}`))).toBe("55000");
    // what stays possible
    expect((await releaseStore(platform, s.storeId)).released).toBeGreaterThanOrEqual(0);
    await activateDestination(s, { accountNumber: "5551234567" });
    expect((await sellerFinance(s.owner)).destinations.length).toBeGreaterThan(0);
    await setPayoutFreeze(a, { frozen: false, reason: "bukti bank sudah dicocokkan" });
    await approveForTransfer(a, "payout", payoutId);
    expect((await platform.select().from(payout).where(eq(payout.id, payoutId)))[0]!.status).toBe("processing");
    expect(await applyReconciliationBatch(opA, batchId)).toEqual({ items: 1 });
  });

  it("a missing control row reads as frozen (fail closed), in the service and in the database", async () => {
    const { s } = await frozenFlow();
    await withoutGuard("payout_control", "payout_control_guard", () => admin.execute(sql`delete from payout_control`));
    try {
      expect((await payoutFreeze(platform)).frozen).toBe(true);
      await expect(assertPayoutsNotFrozen(platform)).rejects.toMatchObject({ code: "payouts_frozen" });
      expect(await code(requestPayoutOf(s, 100_000))).toBe("payouts_frozen");
      expect(await code(platform.execute(sql`insert into payout_control (id) values (2)`))).toBe("42501");
    } finally {
      await admin.execute(sql`insert into payout_control (id, frozen, reason, changed_by) values (1, false, 'initial', 'system:migration')`);
    }
  });
});

describe("Owner console money services (SA-08, SA-17, SA-26, SA-53)", () => {
  it("SA-26 lists unknown transfers and the failed-refund class without any bank value, for finance.read only", async () => {
    const s = await makeStore("toko-a", { price: 500_000 });
    await fund(s);
    await activateDestination(s);
    const { payoutId } = await requestPayoutOf(s, 200_000);
    const a = await makeOperator(["payouts.process"]);
    const b = await makeOperator(["payouts.process"]);
    const { approvalId } = await requestTransferApproval(a, "payout", payoutId, "pencairan uji");
    await decideApproval(b, approvalId, "approve");
    await approveForTransfer(a, "payout", payoutId);
    const fin = await makeOperator(["finance.read"]);
    expect(await unknownTransfers(fin)).toEqual([]);
    await claimTransfer(a, await operatorSession(a), "payout", payoutId);
    await recordTransferUnknown(a, "payout", payoutId);
    const list = await unknownTransfers(fin);
    expect(list).toMatchObject([{ kind: "payout", id: payoutId, storeId: s.storeId, amountIdr: 200_000, claimedBy: a.userId }]);
    expect(JSON.stringify(list)).not.toContain("1234567890");
    expect(await code(unknownTransfers(await makeOperator(["payouts.process"])))).toBe("forbidden");
    expect(await position()).toMatchObject({ payouts_processing: 200_000, refunds_failed: 0 });
  });

  it("SA-17 pages one store's ledger by keyset, shows balances from the ledger, never bank values, a foreign or unknown store is not found, and finance.read is required", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    for (let i = 0; i < 3; i++) await fund(s, 1); // three delivered sales: three ledger rows
    await activateDestination(s);
    await requestPayoutOf(s, 100_000);
    const other = await makeStore("toko-b", { price: 100_000 });
    await fund(other, 1);
    const fin = await makeOperator(["finance.read"]);
    const first = (await storeLedger(fin, s.storeId, { limit: 3 }))!;
    expect(first.rows).toHaveLength(3);
    expect(first.next).not.toBeNull();
    expect(first.balance).toEqual({ availableIdr: 200_000, pendingIdr: 0 });
    const rest = (await storeLedger(fin, s.storeId, { limit: 3, cursor: first.next! }))!;
    expect(rest.rows.every((e) => e.storeId === s.storeId)).toBe(true);
    expect([...first.rows, ...rest.rows].filter((e) => e.kind === "payout")).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain("1234567890");
    expect(await storeLedger(fin, 999_999)).toBeNull();
    expect(await code(storeLedger(await makeOperator(["tenants.read"]), s.storeId))).toBe("forbidden");
    expect(first.rows.map((e) => e.id)).toEqual([...first.rows.map((e) => e.id)].sort((x, y) => y - x));
  });

  it("staff never see money: a seller staff scope is refused the finance screen (finance.read is owner-only)", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    await expect(sellerFinance({ ...s.owner, role: "staff" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(sellerFinance(s.owner)).resolves.toMatchObject({ balance: { availableIdr: 0, pendingIdr: 0 }, processingIdr: 0, payoutsFrozen: false });
  });
});
