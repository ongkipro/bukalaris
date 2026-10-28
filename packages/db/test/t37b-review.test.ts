import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { localRoleUrl } from "../src/local-roles.ts";
import { reserveShippingCost } from "../src/ledger/booking.ts";
import { reopenFailedRefund } from "../src/ledger/refunds.ts";
import { releaseAll, releaseStore } from "../src/ledger/release.ts";
import { applyLedgerAdjustment, requestLedgerAdjustment } from "../src/ledger/console.ts";
import { applyReconciliationBatch, prepareReconciliationBatch, submitReconciliationBatch } from "../src/ledger/reconciliation.ts";
import { requestPayout, setPayoutDestination } from "../src/ledger/payouts.ts";
import { consumeSellerStepUp, issueSellerStepUp } from "../src/ledger/stepup.ts";
import { approveForTransfer, claimTransfer, completeTransfer, lockTransfer, recordTransferUnknown, rejectTransfer, requestRejectApproval, requestTransferApproval } from "../src/ledger/transfer.ts";
import { verifyLedger } from "../src/ledger/verify.ts";
import { decideApproval } from "../src/ops/capabilities-approvals.ts";
import { bindSession } from "../src/platform/scoped.ts";
import { withStore } from "../src/platform/tenant.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import { ledgerEntry, orderFinancials, payout, refund } from "../src/schema.ts";
import { admin, db, makeOperator, makeStore, platform } from "./helpers.ts";
import { deliver } from "./deliver.ts";
import { activateDestination, balance, deliveredPrepaid, fund, operatorSession, ownerProof, paidPrepaid, place, receipt, requestPayoutOf, sessionOf, withoutGuard, type S } from "./t37-fixtures.ts";

// T-37 finish: one named regression test per finding of the independent security review (docs/tracks/t37b.md maps finding -> test -> mutation).
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
const payoutRow = async (id: number) => (await platform.select().from(payout).where(eq(payout.id, id)))[0]!;
const refundRow = async (id: number) => (await platform.select().from(refund).where(eq(refund.id, id)))[0]!;
const saleOf = async (orderId: number) => (await platform.select().from(ledgerEntry).where(eq(ledgerEntry.orderId, orderId)).orderBy(ledgerEntry.id)).find((e) => e.kind === "sale")!;
const position = async () => Object.fromEntries(((await platform.execute(sql`select class, amount_idr from platform_money_position`)) as unknown as { class: string; amount_idr: string }[]).map((r) => [r.class, Number(r.amount_idr)]));

async function readyStore(slug = "toko-a", price = 500_000) {
  const s = await makeStore(slug, { price });
  await fund(s);
  await activateDestination(s);
  return s;
}
/** payout requested -> approved for transfer by a second person -> processing. */
async function approved(s: S, amount = 200_000) {
  const { payoutId } = await requestPayoutOf(s, amount);
  const a = await makeOperator(["payouts.process"]);
  const b = await makeOperator(["payouts.process"]);
  const { approvalId } = await requestTransferApproval(a, "payout", payoutId, "pencairan uji");
  await decideApproval(b, approvalId, "approve");
  await approveForTransfer(a, "payout", payoutId);
  return { payoutId, a, b };
}
const expireLease = (payoutId: number) => withoutGuard("payout", "payout_guard", () => admin.execute(sql`update payout set claim_expires_at = now() - interval '1 minute' where id = ${payoutId}`));

describe("P1-1 the release job reaches every store", () => {
  it("P1-1 releaseAll pages past stores whose pending rows can never release: the store after them is still released", async () => {
    for (let i = 1; i <= 4; i++) {
      const stuck = await makeStore(`stuck-${i}`);
      const { orderId } = await paidPrepaid(stuck);
      await transitionOrder(stuck.owner, orderId, "cancel", { reason: "uji pembatalan" }); // a pending sale and its pending reversal: pending forever
    }
    const good = await makeStore("lanjut");
    const { orderId } = await deliveredPrepaid(good);
    expect((await saleOf(orderId)).status).toBe("pending");
    const r = await releaseAll(platform, 3); // a page of three stores: the first run used to look at the stuck ones only
    expect(r.failures).toEqual([]);
    expect(await saleOf(orderId)).toMatchObject({ status: "available", releaseBasis: "delivery" });
  });
});

describe("P2-2 an unknown transfer outcome is never re-sent, re-credited or rejected alone", () => {
  it("P2-2a a claim after the lease expired is refused while the outcome is unknown (service and database); the reporter settles it with evidence", async () => {
    const s = await readyStore();
    const { payoutId, a, b } = await approved(s);
    await claimTransfer(a, await operatorSession(a), "payout", payoutId);
    await recordTransferUnknown(a, "payout", payoutId);
    await expireLease(payoutId);
    expect(await code(claimTransfer(b, await operatorSession(b), "payout", payoutId))).toBe("transfer_outcome_unknown");
    expect(await code(claimTransfer(a, await operatorSession(a), "payout", payoutId))).toBe("transfer_outcome_unknown");
    // the database refuses the same move written directly (no service in the way)
    expect(await code(platform.update(payout).set({ claimedByUserId: b.userId, claimExpiresAt: new Date(Date.now() + 600_000) }).where(eq(payout.id, payoutId)))).toBe("23514");
    expect(await code(completeTransfer(b, "payout", payoutId, { evidenceRef: "BNI-UNK-0001", receipt: receipt() }))).toBe("not_claimed");
    await completeTransfer(a, "payout", payoutId, { evidenceRef: "BNI-UNK-0001", receipt: receipt() }); // the reporter, with the bank evidence, after the lease
    expect(await payoutRow(payoutId)).toMatchObject({ status: "paid" });
  });

  it("P2-2b the claimant cannot reject a processing payout alone: no approval, a self approval, a changed amount, an approval of another payout and a direct write are all refused", async () => {
    const s = await readyStore();
    const one = await approved(s, 150_000);
    const two = await approved(s, 150_000);
    await claimTransfer(one.a, await operatorSession(one.a), "payout", one.payoutId);
    expect(await code(rejectTransfer(one.a, "payout", one.payoutId, { reason: "tidak terkirim" }))).toBe("approval_invalid");
    const { approvalId } = await requestRejectApproval(one.a, "payout", one.payoutId, { reason: "bank menyatakan tidak ada transfer", noTransferEvidenceRef: "BANK-STMT-7001" });
    expect(await code(decideApproval(one.a, approvalId, "approve"))).toBe("self_approval");
    expect(await code(rejectTransfer(one.a, "payout", one.payoutId, { approvalId }))).toBe("approval_invalid"); // still pending
    await decideApproval(one.b, approvalId, "approve");
    expect(await code(rejectTransfer(one.b, "payout", one.payoutId, { approvalId }))).toBe("PAYOUT_ALREADY_CLAIMED"); // another operator while the claim is live
    const idle = await approved(s, 100_000); // never claimed: the approver still cannot execute what the requester asked for
    const idleApproval = await requestRejectApproval(idle.a, "payout", idle.payoutId, { reason: "bank menyatakan tidak ada transfer", noTransferEvidenceRef: "BANK-STMT-7002" });
    await decideApproval(idle.b, idleApproval.approvalId, "approve");
    expect(await code(rejectTransfer(idle.b, "payout", idle.payoutId, { approvalId: idleApproval.approvalId }))).toBe("approval_invalid"); // only the requester executes
    expect(await code(rejectTransfer(two.a, "payout", two.payoutId, { approvalId }))).toBe("approval_invalid"); // another payout
    // a direct write of the move, even with a valid approval of ANOTHER payout, is refused by the database
    expect(await code(platform.update(payout).set({ status: "rejected", rejectionReason: "x-reason", noTransferEvidenceRef: "BANK-STMT-7001", rejectApprovalRequestId: approvalId, processedByUserId: one.a.userId, processedAt: new Date() }).where(eq(payout.id, two.payoutId)))).toBe("23514");
    expect(await code(platform.update(payout).set({ status: "rejected", rejectionReason: "x-reason", noTransferEvidenceRef: "BANK-STMT-7001", processedByUserId: one.a.userId, processedAt: new Date() }).where(eq(payout.id, one.payoutId)))).toBe("23514");
    await rejectTransfer(one.a, "payout", one.payoutId, { approvalId });
    expect(await payoutRow(one.payoutId)).toMatchObject({ status: "rejected", rejectApprovalRequestId: approvalId });
  });

  it("P2-2c a no-transfer evidence reference is normalised and single-use in both directions: never again as a reference of a transfer, never as the proof of another rejection", async () => {
    const s = await makeStore("toko-a", { price: 600_000 });
    await fund(s);
    await fund(s);
    await activateDestination(s);
    const paid = await approved(s, 150_000);
    await claimTransfer(paid.a, await operatorSession(paid.a), "payout", paid.payoutId);
    await completeTransfer(paid.a, "payout", paid.payoutId, { evidenceRef: "BCA-REF-1001", receipt: receipt() });
    const rej = await approved(s, 150_000);
    expect(await code(requestRejectApproval(rej.a, "payout", rej.payoutId, { reason: "bank menyatakan tidak ada transfer", noTransferEvidenceRef: "bca ref/1001" }))).toBe("DUPLICATE_BANK_TRANSFER_REFERENCE");
    const { approvalId } = await requestRejectApproval(rej.a, "payout", rej.payoutId, { reason: "bank menyatakan tidak ada transfer", noTransferEvidenceRef: "NOSEND-5555" });
    await decideApproval(rej.b, approvalId, "approve");
    await rejectTransfer(rej.a, "payout", rej.payoutId, { approvalId });
    const third = await approved(s, 100_000);
    await claimTransfer(third.a, await operatorSession(third.a), "payout", third.payoutId);
    expect(await code(completeTransfer(third.a, "payout", third.payoutId, { evidenceRef: "nosend 5555", receipt: receipt() }))).toBe("DUPLICATE_BANK_TRANSFER_REFERENCE");
    expect(await code(requestRejectApproval(third.a, "payout", third.payoutId, { reason: "bank menyatakan tidak ada transfer", noTransferEvidenceRef: "NOSEND-5555" }))).toBe("DUPLICATE_BANK_TRANSFER_REFERENCE");
  });

  it("P2-2d the seller cannot withdraw the same money twice while a transfer outcome is unknown, and one proven rejection returns it exactly once", async () => {
    const s = await readyStore("toko-a", 500_000);
    const { payoutId, a, b } = await approved(s, 500_000); // the whole balance
    await claimTransfer(a, await operatorSession(a), "payout", payoutId);
    await recordTransferUnknown(a, "payout", payoutId);
    expect(await balance(s.storeId)).toEqual({ availableIdr: 0, pendingIdr: 0 });
    expect(await code(requestPayoutOf(s, 200_000))).toBe("insufficient_balance"); // the money is allocated, not available again
    const { approvalId } = await requestRejectApproval(a, "payout", payoutId, { reason: "bank menyatakan tidak ada transfer", noTransferEvidenceRef: "BANK-STMT-8001" });
    await decideApproval(b, approvalId, "approve");
    await rejectTransfer(a, "payout", payoutId, { approvalId });
    expect(await code(rejectTransfer(a, "payout", payoutId, { approvalId }))).toBe("invalid_state");
    expect(await balance(s.storeId)).toEqual({ availableIdr: 500_000, pendingIdr: 0 }); // once, not twice
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });
});

describe("P3-3 one debit that does not fit stops nothing", () => {
  it("P3-3 a debit larger than available does not roll back the store's release, does not fail the job, and is netted when it fits", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    await fund(s, 3); // available 300 000
    await activateDestination(s);
    const { orderId } = await paidPrepaid(s); // a pending sale of 100 000
    const [fin] = await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId));
    const r = await reserveShippingCost(platform, { storeId: s.storeId, orderId, requote: { bookedShippingIdr: fin!.shippingChargedIdr + 350_000, providerCodFeeIdr: 0 }, codAmountSentIdr: null });
    expect(r).toMatchObject({ outcome: "reserved", debitIdr: 350_000, debitStatus: "pending" }); // 300 000 + the pending sale covers it
    await requestPayoutOf(s, 300_000); // the seller withdraws what was available: the debit no longer fits
    await transitionOrder(s.owner, orderId, "process");
    await transitionOrder(s.owner, orderId, "ship", { trackingNumber: `T37-${orderId}` });
    await deliver(s.storeId, orderId);
    const out = await releaseStore(platform, s.storeId); // used to throw 'the available balance would go negative' and roll everything back
    expect(out.released).toBeGreaterThanOrEqual(1);
    expect(await saleOf(orderId)).toMatchObject({ status: "available" });
    const debit = (await platform.select().from(ledgerEntry).where(eq(ledgerEntry.orderId, orderId))).find((e) => e.kind === "shipping_debit")!;
    expect(debit.status).toBe("pending");
    expect((await releaseAll(platform)).failures).toEqual([]); // the job does not fail every minute
    expect((await verifyLedger(platform)).violations).toEqual([]);
    await fund(s, 4); // more sales: now the debit fits and is netted against them
    const after = (await platform.select().from(ledgerEntry).where(eq(ledgerEntry.id, debit.id)))[0]!;
    expect(after).toMatchObject({ status: "available", releaseBasis: "netting" });
    expect((await balance(s.storeId)).availableIdr).toBe(100_000 + 400_000 - 350_000);
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });
});

describe("P3-4 verify:ledger is exact", () => {
  it("P3-4 a COD debit with a lower id than its sale, released in the same transaction, is not a false available_dipped_negative", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const orderId = await place(s, { paymentMethod: "cod" });
    await transitionOrder(s.owner, orderId, "confirm");
    const [fin] = await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId));
    expect(await reserveShippingCost(platform, { storeId: s.storeId, orderId, requote: { bookedShippingIdr: fin!.shippingChargedIdr + 30_000, providerCodFeeIdr: 0 }, codAmountSentIdr: fin!.payableIdr })).toMatchObject({ outcome: "reserved", debitStatus: "pending" });
    await transitionOrder(s.owner, orderId, "process");
    await transitionOrder(s.owner, orderId, "ship", { trackingNumber: `T37-${orderId}` });
    await deliver(s.storeId, orderId);
    const opA = await makeOperator(["payouts.reconcile"]);
    const opB = await makeOperator(["payouts.reconcile"]);
    const { batchId } = await prepareReconciliationBatch(opA, { evidenceRef: "INV-P34-0001", lines: [{ orderId, evidenceLineRef: "L1", evidenceAmountIdr: fin!.payableIdr, evidenceDate: "2026-10-28" }] });
    const { approvalId } = await submitReconciliationBatch(opA, batchId, "rekonsiliasi uji");
    await decideApproval(opB, approvalId, "approve");
    await applyReconciliationBatch(opA, batchId);
    await releaseStore(platform, s.storeId);
    const rows = await platform.select().from(ledgerEntry).where(eq(ledgerEntry.orderId, orderId)).orderBy(ledgerEntry.id);
    const debit = rows.find((e) => e.kind === "shipping_debit")!;
    const sale = rows.find((e) => e.kind === "sale")!;
    expect(debit.id).toBeLessThan(sale.id); // the debit sorts first by id ...
    expect(debit.releasedAt!.getTime()).toBe(sale.releasedAt!.getTime()); // ... at the very same instant
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });
});

describe("P3-5 the demo reset works on a populated demo store", () => {
  it("P3-5 reset_demo_ledger through the OWNER connection removes a demo store's step-up proofs and recorded transfer evidence", async () => {
    const s = await readyStore("demo-reset", 500_000);
    const { payoutId, a } = await approved(s, 200_000);
    await claimTransfer(a, await operatorSession(a), "payout", payoutId);
    await completeTransfer(a, "payout", payoutId, { evidenceRef: "DEMO-REF-0001", receipt: receipt() });
    const count = async (t: string) => Number(((await admin.execute(sql.raw(`select count(*)::int as n from ${t} where store_id = ${s.storeId}`))) as unknown as { n: number }[])[0]!.n);
    expect(await count("store_step_up_proof")).toBeGreaterThan(0);
    const owner = createDb(localRoleUrl(process.env.TEST_DATABASE_URL!, "bukalaris_owner"));
    try {
      await owner.execute(sql`select reset_demo_ledger(array[${s.storeId}]::bigint[])`);
    } finally {
      await owner.$client.end();
    }
    for (const t of ["store_step_up_proof", "payout", "payout_destination", "ledger_entry"]) expect(await count(t)).toBe(0);
    expect(Number(((await admin.execute(sql`select count(*)::int as n from transfer_evidence_registry`)) as unknown as { n: number }[])[0]!.n)).toBe(0);
    // and the guards still refuse the same delete without the marker
    await expect(admin.execute(sql`delete from transfer_evidence_registry`)).resolves.toBeDefined(); // nothing left to refuse: re-plant below
    const t = await readyStore("toko-b", 500_000);
    const p = await approved(t, 200_000);
    await claimTransfer(p.a, await operatorSession(p.a), "payout", p.payoutId);
    await completeTransfer(p.a, "payout", p.payoutId, { evidenceRef: "REAL-REF-0001", receipt: receipt() });
    expect(await code(admin.execute(sql`delete from transfer_evidence_registry`))).not.toBe("ok");
    expect(await code(admin.execute(sql`delete from store_step_up_proof`))).not.toBe("ok");
  });
});

describe("P3-6 the database backstops do not trust the caller", () => {
  it("P3-6a the seller login cannot move an order to completed or returned; the courier writer (platform) still can", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const { orderId } = await paidPrepaid(s);
    await transitionOrder(s.owner, orderId, "process");
    await transitionOrder(s.owner, orderId, "ship", { trackingNumber: `T37-${orderId}` });
    for (const status of ["completed", "returned"]) {
      expect(await code(withStore(db, s.storeId, (tx) => tx.execute(sql`update "order" set status = ${status} where id = ${orderId}`)))).toBe("42501");
    }
    await deliver(s.storeId, orderId);
    expect((await platform.execute(sql`select status from "order" where id = ${orderId}`))[0]!.status).toBe("completed");
  });

  it("P3-6b the move to processing needs an approval of THIS payout: another payout's approval, a pending request and a missing one are refused by the database", async () => {
    const s = await makeStore("toko-a", { price: 600_000 });
    await fund(s);
    await fund(s);
    await activateDestination(s);
    const { payoutId: p1 } = await requestPayoutOf(s, 150_000);
    const { payoutId: p2 } = await requestPayoutOf(s, 150_000);
    const a = await makeOperator(["payouts.process"]);
    const b = await makeOperator(["payouts.process"]);
    const first = await requestTransferApproval(a, "payout", p1, "pencairan satu");
    const second = await requestTransferApproval(a, "payout", p2, "pencairan dua");
    await decideApproval(b, first.approvalId, "approve");
    const move = (id: number, approvalId: number | null) => platform.update(payout).set({ status: "processing", approvalRequestId: approvalId, approvedAt: new Date() }).where(eq(payout.id, id));
    expect(await code(move(p2, first.approvalId))).toBe("23514"); // the approval of payout 1 does not approve payout 2
    expect(await code(move(p2, second.approvalId))).toBe("23514"); // payout 2's own request is still pending
    expect(await code(move(p2, null))).toBe("23514");
    expect(await code(move(p1, first.approvalId))).toBe("ok"); // the approved request of this payout fits
  });

  it("P3-6b an adjustment is bound to its approval: another amount or another business reference with a valid approval is refused", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const a = await makeOperator(["ledger.adjust"]);
    const b = await makeOperator(["ledger.adjust"]);
    const input = { storeId: s.storeId, amountIdr: 5_000, businessRef: "ADJ-P36-0001", reason: "koreksi uji" };
    const { approvalId } = await requestLedgerAdjustment(a, input);
    await decideApproval(b, approvalId, "approve");
    const insert = (amount: number, ref: string) =>
      platform.execute(sql`insert into ledger_entry (store_id, kind, status, amount_idr, business_ref, approval_request_id, note, released_at, release_basis) values (${s.storeId}, 'adjustment', 'available', ${amount}, ${ref}, ${approvalId}, 'x', now(), 'direct')`);
    expect(await code(insert(6_000, "ADJ-P36-0001"))).toBe("23514");
    expect(await code(insert(5_000, "ADJ-OTHER-0002"))).toBe("23514");
    expect(await applyLedgerAdjustment(a, { ...input, approvalId })).toMatchObject({ entryId: expect.any(Number) });
  });

  it("P3-6c the 72-hour hold is enforced by the database and read from the named setting: a shorter hold is refused, the service follows the setting", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const { scope, proofId } = await ownerProof(s, "payout.destination", String(s.storeId));
    const raw = withStore(db, s.storeId, async (tx) => {
      await consumeSellerStepUp(tx, scope, proofId, { action: "payout.destination", subjectId: String(s.storeId) });
      await tx.execute(sql`insert into payout_destination (store_id, bank_code, account_number, account_holder_name, holder_name_check, status, hold_until, created_by_user_id, step_up_ref) values (${s.storeId}, 'BCA', '1234567890', 'Pemilik', 'match', 'held', now() + interval '1 hour', ${s.ownerId}, ${proofId})`);
    });
    expect(await code(raw)).toBe("23514");
    await admin.execute(sql`update payout_control set destination_hold_hours = 24`);
    try {
      const again = await ownerProof(s, "payout.destination", String(s.storeId));
      const d = await setPayoutDestination(again.scope, { proofId: again.proofId, bankCode: "BCA", accountNumber: "1234567890", accountHolderName: `${s.sf.storeSlug}-owner` });
      const hours = (new Date(d.holdUntil).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThan(24.1);
    } finally {
      await admin.execute(sql`update payout_control set destination_hold_hours = 72`);
    }
  });
});

describe("P3-7 a failed refund stays owed", () => {
  async function pendingRefund() {
    const s = await makeStore("toko-a", { price: 100_000 });
    const { orderId } = await paidPrepaid(s);
    await transitionOrder(s.owner, orderId, "cancel", { reason: "uji pembatalan" });
    const [r] = await platform.select().from(refund).where(eq(refund.orderId, orderId));
    return { s, orderId, refundId: r!.id, amount: r!.amountIdr };
  }

  it("P3-7 one operator cannot fail a refund; with a second person it fails, stays visible as refunds_failed, and can be reopened and re-approved", async () => {
    const { refundId, amount } = await pendingRefund();
    const a = await makeOperator(["refunds.process"]);
    const b = await makeOperator(["refunds.process"]);
    expect(await code(rejectTransfer(a, "refund", refundId, { reason: "rekening tidak valid" }))).toBe("approval_invalid");
    expect(await code(platform.update(refund).set({ status: "failed", failureReason: "rekening tidak valid", processedByUserId: a.userId }).where(eq(refund.id, refundId)))).toBe("23514"); // a direct write
    expect(await position()).toMatchObject({ refunds_open: amount, refunds_failed: 0 });
    const { approvalId } = await requestRejectApproval(a, "refund", refundId, { reason: "rekening tidak valid" });
    expect(await code(decideApproval(a, approvalId, "approve"))).toBe("self_approval");
    await decideApproval(b, approvalId, "approve");
    await rejectTransfer(a, "refund", refundId, { approvalId });
    expect(await refundRow(refundId)).toMatchObject({ status: "failed", failApprovalRequestId: approvalId });
    expect(await position()).toMatchObject({ refunds_open: 0, refunds_failed: amount }); // still owed, still visible
    const reopened = await reopenFailedRefund(a, refundId, "pembeli memberi rekening baru");
    expect(await reopenFailedRefund(a, refundId, "klik ganda")).toEqual(reopened); // idempotent
    expect(await refundRow(reopened.refundId)).toMatchObject({ status: "pending", amountIdr: amount });
    expect(await position()).toMatchObject({ refunds_open: amount, refunds_failed: 0 });
    expect(await code(reopenFailedRefund(a, reopened.refundId, "bukan yang gagal"))).toBe("invalid_state");
  });
});

describe("P3-8 hardening", () => {
  it("P3-8a a state change reads no bank value: lockTransfer returns nulls unless the caller asks inside personal-data access", async () => {
    const s = await readyStore();
    const { payoutId } = await requestPayoutOf(s, 200_000);
    const plain = await platform.transaction((tx) => lockTransfer(tx, "payout", payoutId));
    expect(plain).toMatchObject({ bank: null, account: null, holder: null, holderCheck: null, amountIdr: 200_000 });
    const full = await platform.transaction((tx) => lockTransfer(tx, "payout", payoutId, true));
    expect(full).toMatchObject({ bank: "BCA", account: "1234567890" });
  });

  it("P3-8b the step-up session comes from the scope, never from the call: an unbound scope gets no proof, a typed sessionId is refused, another session's proof does not fit", async () => {
    const s = await readyStore();
    const sid = await sessionOf(s.ownerId);
    expect(await code(issueSellerStepUp(s.owner, { action: "payout.request", subjectId: "k" }))).toBe("reauth_required"); // no bound session
    const mine = bindSession(s.owner, sid);
    const proofId = await issueSellerStepUp(mine, { action: "payout.request", subjectId: "k" });
    const otherSession = bindSession(s.owner, await sessionOf(s.ownerId));
    expect(await code(withStore(db, s.storeId, (tx) => consumeSellerStepUp(tx, otherSession, proofId, { action: "payout.request", subjectId: "k" })))).toBe("reauth_required");
    await expect(requestPayout(mine, { sessionId: "anything", proofId, requestKey: randomUUID(), amountIdr: 200_000 })).rejects.toMatchObject({ name: "ZodError" });
  });
});

describe("one reversal, once (database unique indexes)", () => {
  it("a second return_reversal for one order and a second payout_reversal for one payout are refused by the database", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const { orderId } = await paidPrepaid(s);
    await transitionOrder(s.owner, orderId, "cancel", { reason: "uji pembatalan" }); // posts the one return_reversal
    const dupReturn = platform.execute(sql`insert into ledger_entry (store_id, order_id, kind, status, amount_idr, note) select store_id, order_id, 'return_reversal', 'pending', amount_idr, 'ganda' from ledger_entry where order_id = ${orderId} and kind = 'return_reversal'`);
    expect(await code(dupReturn)).toBe("23505");
    const t = await readyStore("toko-b");
    const { payoutId } = await requestPayoutOf(t, 200_000);
    const op = await makeOperator(["payouts.process"]);
    await rejectTransfer(op, "payout", payoutId, { reason: "rekening tidak valid" }); // posts the one payout_reversal
    const dupPayout = platform.execute(sql`insert into ledger_entry (store_id, payout_id, kind, status, amount_idr, released_at, release_basis, note) select store_id, payout_id, 'payout_reversal', 'available', amount_idr, now(), 'direct', 'ganda' from ledger_entry where payout_id = ${payoutId} and kind = 'payout_reversal'`);
    expect(await code(dupPayout)).toBe("23505");
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });
});

describe("the per-store lock serialises money writers", () => {
  it("a payout request waits for the store lock held by another writer (it cannot read a stale balance), and completes once the lock is released", async () => {
    const s = await readyStore("toko-a", 500_000);
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const lockedPromise = new Promise<void>((r) => (locked = r));
    const holder = admin.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bukalaris.payout.store'), hashtext(${String(s.storeId)}))`);
      locked();
      await held;
    });
    await lockedPromise;
    const request = requestPayoutOf(s, 200_000);
    const early = await Promise.race([request.then(() => "done"), new Promise<string>((r) => setTimeout(() => r("blocked"), 1500))]);
    release();
    await holder;
    await request;
    expect(early).toBe("blocked");
    expect((await balance(s.storeId)).availableIdr).toBe(300_000);
  });
});
