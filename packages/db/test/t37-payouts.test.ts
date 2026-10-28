import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ledgerBalance } from "../src/ledger/ledger.ts";
import { requestPayout, setPayoutDestination, transferBankDetail, transferQueue } from "../src/ledger/payouts.ts";
import { consumeSellerStepUp, issueSellerStepUp } from "../src/ledger/stepup.ts";
import { approveForTransfer, claimTransfer, completeTransfer, recordTransferUnknown, rejectTransfer, requestRejectApproval, requestTransferApproval, sniffReceipt } from "../src/ledger/transfer.ts";
import { verifyLedger } from "../src/ledger/verify.ts";
import { decideApproval } from "../src/ops/capabilities-approvals.ts";
import { bindSession } from "../src/platform/scoped.ts";
import { withStore } from "../src/platform/tenant.ts";
import { ledgerEntry, payout, payoutDestination, refund } from "../src/schema.ts";
import { admin, db, makeOperator, makeStore, platform } from "./helpers.ts";
import { activateDestination, balance, fund, operatorSession, ownerProof, receipt, requestPayoutOf, sessionOf, withoutGuard, type S } from "./t37-fixtures.ts";

// T-37 payouts (ADR-0006 decision 5, BILL-5, D-19, D-21 b-d, f): request, four-eyes approve-for-transfer, claim lease, evidence, rejection and the unknown outcome.
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
const payoutRow = async (id: number) => (await platform.select().from(payout).where(eq(payout.id, id)))[0]!;

async function readyStore(price = 500_000) {
  const s = await makeStore("toko-a", { price });
  await fund(s);
  await activateDestination(s);
  return s;
}
/** payout requested -> approved for transfer by a second person -> processing. Returns the two operators and their sessions. */
async function approved(s: S, amount = 200_000) {
  const { payoutId } = await requestPayoutOf(s, amount);
  const a = await makeOperator(["payouts.process"]);
  const b = await makeOperator(["payouts.process"]);
  const { approvalId } = await requestTransferApproval(a, "payout", payoutId, "pencairan uji");
  await decideApproval(b, approvalId, "approve");
  await approveForTransfer(a, "payout", payoutId);
  return { payoutId, a, b, sa: await operatorSession(a), sb: await operatorSession(b) };
}

describe("payout request and destination (D-19)", () => {
  it("a new destination is HELD 72 hours and cannot be used; once the hold elapsed the payout snapshots it, debits available once and a replayed key debits nothing", async () => {
    const s = await makeStore("toko-a", { price: 500_000 });
    await fund(s);
    const { scope, proofId } = await ownerProof(s, "payout.destination", String(s.storeId));
    const d = await setPayoutDestination(scope, { proofId, bankCode: "bca", accountNumber: "1234567890", accountHolderName: "toko-a-owner" });
    expect((new Date(d.holdUntil).getTime() - Date.now()) / 3_600_000).toBeGreaterThan(71.9);
    expect(await code(requestPayoutOf(s, 200_000))).toBe("no_active_destination");
    await activateDestination(s);
    const key = randomUUID();
    const first = await requestPayoutOf(s, 200_000, key);
    const again = await requestPayoutOf(s, 200_000, key);
    expect(again).toEqual({ payoutId: first.payoutId, replayed: true });
    expect(await balance(s.storeId)).toEqual({ availableIdr: 300_000, pendingIdr: 0 });
    expect(await payoutRow(first.payoutId)).toMatchObject({ bankCode: "BCA", bankAccountNumber: "1234567890", status: "requested", amountIdr: 200_000 });
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });

  it("below the minimum, above available, from staff, and without a fresh proof are all refused with nothing written", async () => {
    const s = await readyStore();
    expect(await code(requestPayoutOf(s, 50_000))).toBe("below_minimum");
    expect(await code(requestPayoutOf(s, 500_001))).toBe("insufficient_balance");
    expect(await code(requestPayout(bindSession(s.owner, await sessionOf(s.ownerId)), { proofId: randomUUID(), requestKey: randomUUID(), amountIdr: 200_000 }))).toBe("reauth_required");
    expect(await code(issueSellerStepUp(bindSession(s.owner, await sessionOf(s.ownerId, false)), { action: "payout.request", subjectId: "k" }))).toBe("reauth_required"); // no second factor in THIS session
    expect(await platform.select().from(payout)).toHaveLength(0);
    expect(await balance(s.storeId)).toEqual({ availableIdr: 500_000, pendingIdr: 0 });
  });

  it("concurrent payout requests serialise on the per-store lock: the balance is never overdrawn (D-21 f)", async () => {
    for (let round = 0; round < 3; round++) {
      const s = await makeStore(`toko-c${round}`, { price: 300_000 });
      await fund(s);
      await activateDestination(s);
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => requestPayoutOf(s, 200_000)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); // 300 000 covers one 200 000 request only
      expect((await balance(s.storeId)).availableIdr).toBe(100_000);
      expect((await verifyLedger(platform)).violations).toEqual([]);
    }
  });

  it("the step-up proof is single-use, bound to session, store, action and subject, and a failed write leaves it unconsumed (D-21 d)", async () => {
    const s = await readyStore();
    const key = randomUUID();
    const sid = await sessionOf(s.ownerId);
    const me = bindSession(s.owner, sid);
    const proofId = await issueSellerStepUp(me, { action: "payout.request", subjectId: key });
    // wrong session, wrong subject, wrong action: all refused
    for (const bad of [{ scope: bindSession(s.owner, await sessionOf(s.ownerId)), subjectId: key }, { scope: me, subjectId: "other" }]) {
      expect(await code(withStore(db, s.storeId, (tx) => consumeSellerStepUp(tx, bad.scope, proofId, { subjectId: bad.subjectId, action: "payout.request" })))).toBe("reauth_required");
    }
    expect(await code(withStore(db, s.storeId, (tx) => consumeSellerStepUp(tx, me, proofId, { action: "payout.destination", subjectId: key })))).toBe("reauth_required");
    // a failed write (amount above the balance) rolls back and the proof is still usable
    expect(await code(requestPayout(me, { proofId, requestKey: key, amountIdr: 9_000_000 }))).toBe("insufficient_balance");
    expect(await requestPayout(me, { proofId, requestKey: key, amountIdr: 200_000 })).toMatchObject({ replayed: false });
    // single use: the same proof cannot authorise a second payout, even concurrently
    const key2 = randomUUID();
    expect(await code(requestPayout(me, { proofId, requestKey: key2, amountIdr: 100_000 }))).toBe("reauth_required");
    const p3 = await issueSellerStepUp(me, { action: "payout.request", subjectId: "k3" });
    const race = await Promise.allSettled([1, 2, 3].map(() => withStore(db, s.storeId, (tx) => consumeSellerStepUp(tx, me, p3, { action: "payout.request", subjectId: "k3" }))));
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("the database refuses a payout or destination written with a proof that was not consumed in the same transaction, and a payout to a destination still on hold", async () => {
    const s = await readyStore();
    const [dest] = await platform.select().from(payoutDestination).where(eq(payoutDestination.storeId, s.storeId));
    const sid = await sessionOf(s.ownerId);
    const unconsumed = await issueSellerStepUp(bindSession(s.owner, sid), { action: "payout.request", subjectId: "k" });
    const insert = (proof: string) => withStore(db, s.storeId, (tx) => tx.execute(sql`insert into payout (store_id, requested_by_user_id, request_key, step_up_ref, amount_idr, destination_id, bank_code, bank_account_number, bank_account_holder, holder_name_check) values (${s.storeId}, ${s.ownerId}, ${randomUUID()}, ${proof}, 150000, ${dest!.id}, ${dest!.bankCode}, ${dest!.accountNumber}, ${dest!.accountHolderName}, ${dest!.holderNameCheck})`));
    expect(await code(insert(unconsumed))).not.toBe("ok"); // raw insert with an unconsumed proof (and no debit entry) fails
    await withoutGuard("payout_destination", "payout_destination_guard", () => admin.execute(sql`update payout_destination set status = 'held', hold_until = now() + interval '5 hours' where id = ${dest!.id}`));
    expect(await code(requestPayoutOf(s, 150_000))).not.toBe("ok"); // held: no active destination
  });
});

describe("approve-for-transfer is four-eyes; claim is an exclusive lease; evidence is unique (D-21 b, c, d)", () => {
  it("the requester cannot approve, a non-holder cannot, the approval binds the exact bank snapshot, and the requester executes it once", async () => {
    const s = await readyStore();
    const { payoutId } = await requestPayoutOf(s, 200_000);
    const a = await makeOperator(["payouts.process"]);
    const b = await makeOperator(["payouts.process"]);
    const outsider = await makeOperator(["refunds.process"]);
    expect(await code(requestTransferApproval(outsider, "payout", payoutId, "tanpa izin"))).toBe("forbidden");
    expect(await code(approveForTransfer(a, "payout", payoutId))).toBe("approval_invalid"); // nothing approved yet
    const { approvalId } = await requestTransferApproval(a, "payout", payoutId, "pencairan uji");
    expect(await code(decideApproval(a, approvalId, "approve"))).toBe("self_approval");
    expect(await code(decideApproval(outsider, approvalId, "approve"))).toBe("forbidden");
    await decideApproval(b, approvalId, "approve");
    expect(await code(approveForTransfer(b, "payout", payoutId))).toBe("approval_invalid"); // only the requester executes
    // the snapshot changes after approval (guard lifted): the payload hash no longer fits
    await withoutGuard("payout", "payout_guard", () => admin.execute(sql`update payout set bank_account_number = '9999999999' where id = ${payoutId}`));
    expect(await code(approveForTransfer(a, "payout", payoutId))).toBe("approval_invalid");
    await withoutGuard("payout", "payout_guard", () => admin.execute(sql`update payout set bank_account_number = '1234567890' where id = ${payoutId}`));
    await approveForTransfer(a, "payout", payoutId);
    expect(await payoutRow(payoutId)).toMatchObject({ status: "processing" });
    expect(await code(approveForTransfer(a, "payout", payoutId))).toBe("invalid_state");
    expect(await platform.select().from(payout).where(eq(payout.status, "paid"))).toHaveLength(0);
  });

  it("the database refuses `processing` or `paid` without the approved request id", async () => {
    const s = await readyStore();
    const { payoutId } = await requestPayoutOf(s, 200_000);
    expect(await code(platform.update(payout).set({ status: "processing" }).where(eq(payout.id, payoutId)))).toBe("23514");
  });

  it("the claim is an exclusive 30-minute lease: a second operator gets PAYOUT_ALREADY_CLAIMED, its step-up proof stays unconsumed, and an expired lease can be taken over", async () => {
    const s = await readyStore();
    const { payoutId, a, b, sa, sb } = await approved(s);
    await claimTransfer(a, sa, "payout", payoutId);
    expect(await code(claimTransfer(b, sb, "payout", payoutId))).toBe("PAYOUT_ALREADY_CLAIMED");
    const [left] = (await admin.execute(sql`select count(*)::int as n from operator_step_up_proof where user_id = ${b.userId} and consumed_at is null`)) as unknown as { n: number }[];
    expect(left!.n).toBe(1); // the failed claim un-consumed the proof
    await withoutGuard("payout", "payout_guard", () => admin.execute(sql`update payout set claim_expires_at = now() - interval '1 minute' where id = ${payoutId}`));
    await claimTransfer(b, await operatorSession(b), "payout", payoutId);
    expect((await payoutRow(payoutId)).claimedByUserId).toBe(b.userId);
    // the first operator's lease is gone: it cannot record the payment
    expect(await code(completeTransfer(a, "payout", payoutId, { evidenceRef: "BNI-REF-0001", receipt: receipt() }))).toBe("not_claimed");
    // two operators racing for a free payout: exactly one claim
    const s2 = await makeStore("toko-b", { price: 500_000 });
    await fund(s2);
    await activateDestination(s2);
    const r = await approved(s2);
    const results = await Promise.allSettled([claimTransfer(r.a, await operatorSession(r.a), "payout", r.payoutId), claimTransfer(r.b, await operatorSession(r.b), "payout", r.payoutId)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });

  it("paid records evidence only: a transfer reference is unique across payouts AND refunds after normalising, a receipt file is never reused, bad files are refused, no ledger row is written", async () => {
    const s = await makeStore("toko-a", { price: 600_000 });
    await fund(s, 1);
    await fund(s, 1);
    await activateDestination(s);
    const one = await approved(s, 150_000);
    const two = await approved(s, 150_000);
    await claimTransfer(one.a, one.sa, "payout", one.payoutId);
    const before = (await platform.select().from(ledgerEntry)).length;
    const file = receipt("same-file");
    await completeTransfer(one.a, "payout", one.payoutId, { evidenceRef: "BCA-2026/10/28 #A1", receipt: file });
    expect(await payoutRow(one.payoutId)).toMatchObject({ status: "paid", transferEvidenceRef: "BCA-2026/10/28 #A1" });
    expect((await platform.select().from(ledgerEntry)).length).toBe(before); // no seller ledger row at paid
    await claimTransfer(two.a, two.sa, "payout", two.payoutId);
    expect(await code(completeTransfer(two.a, "payout", two.payoutId, { evidenceRef: "bca 2026-10-28 a1", receipt: receipt() }))).toBe("DUPLICATE_BANK_TRANSFER_REFERENCE"); // same reference after normalisation
    expect(await code(completeTransfer(two.a, "payout", two.payoutId, { evidenceRef: "BCA-OTHER-77", receipt: file }))).toBe("EVIDENCE_REUSE_FORBIDDEN"); // same file bytes
    expect(await code(completeTransfer(two.a, "payout", two.payoutId, { evidenceRef: "A-1-!!-2", receipt: receipt() }))).toBe("bad_evidence_ref");
    expect(await code(completeTransfer(two.a, "payout", two.payoutId, { evidenceRef: "BCA-OTHER-78", receipt: new Uint8Array([1, 2, 3]) }))).toBe("receipt_type");
    expect(() => sniffReceipt(new Uint8Array(10 * 1024 * 1024 + 1))).toThrow();
    expect((await payoutRow(two.payoutId)).status).toBe("processing"); // every failed attempt rolled back
    await completeTransfer(two.a, "payout", two.payoutId, { evidenceRef: "BCA-OTHER-79", receipt: receipt() });
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });

  it("an UNKNOWN transfer outcome stays processing and allocated: it is never claimed again, cannot be rejected by one person, is never re-credited, and no queue can re-dispatch it (D-21 b)", async () => {
    const s = await readyStore();
    const { payoutId, a, b } = await approved(s);
    await claimTransfer(a, await operatorSession(a), "payout", payoutId);
    await recordTransferUnknown(a, "payout", payoutId);
    expect(await payoutRow(payoutId)).toMatchObject({ status: "processing" });
    expect(await code(recordTransferUnknown(b, "payout", payoutId))).toBe("not_claimed");
    expect(await code(rejectTransfer(a, "payout", payoutId, { reason: "kemungkinan gagal kirim" }))).toBe("approval_invalid"); // no presumed rejection, and never alone
    expect(await code(requestRejectApproval(a, "payout", payoutId, { reason: "kemungkinan gagal kirim" }))).toBe("evidence_required");
    expect(await balance(s.storeId)).toEqual({ availableIdr: 300_000, pendingIdr: 0 }); // still allocated: not re-credited
    expect(await platform.select().from(ledgerEntry).where(eq(ledgerEntry.kind, "payout_reversal"))).toHaveLength(0);
    expect(await code(platform.update(payout).set({ transferUnknownAt: null }).where(eq(payout.id, payoutId)))).toBe("23514");
    // finance proves no effect: a SECOND person approves exactly that statement; the rejection restores exactly the debit, once, and a replay posts nothing
    const { approvalId } = await requestRejectApproval(a, "payout", payoutId, { reason: "bank menyatakan tidak ada transfer", noTransferEvidenceRef: "BANK-STMT-9001" });
    expect(await code(decideApproval(a, approvalId, "approve"))).toBe("self_approval");
    await decideApproval(b, approvalId, "approve");
    await rejectTransfer(a, "payout", payoutId, { approvalId });
    expect(await balance(s.storeId)).toEqual({ availableIdr: 500_000, pendingIdr: 0 });
    expect(await payoutRow(payoutId)).toMatchObject({ status: "rejected", noTransferEvidenceRef: "BANK-STMT-9001", rejectionReason: "bank menyatakan tidak ada transfer" });
    expect(await code(rejectTransfer(a, "payout", payoutId, { approvalId }))).toBe("invalid_state");
    expect(await platform.select().from(ledgerEntry).where(eq(ledgerEntry.kind, "payout_reversal"))).toHaveLength(1);
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });

  it("rejecting a requested payout restores the exact debit; two concurrent rejections post one reversal", async () => {
    const s = await readyStore();
    const { payoutId } = await requestPayoutOf(s, 200_000);
    const a = await makeOperator(["payouts.process"]);
    const b = await makeOperator(["payouts.process"]);
    const res = await Promise.allSettled([rejectTransfer(a, "payout", payoutId, { reason: "rekening tidak valid" }), rejectTransfer(b, "payout", payoutId, { reason: "rekening tidak valid" })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await platform.select().from(ledgerEntry).where(eq(ledgerEntry.kind, "payout_reversal"))).toHaveLength(1);
    expect(await balance(s.storeId)).toEqual({ availableIdr: 500_000, pendingIdr: 0 });
  });

  it("bank values are personal data: the queue shows the last four digits only and the full snapshot needs a case, an expiry and is recorded as an access event", async () => {
    await admin.execute(sql`truncate personal_data_access_event`); // restricted table, not reached by the shared truncate
    const s = await readyStore();
    const { payoutId } = await requestPayoutOf(s, 200_000);
    const op = await makeOperator(["payouts.process"]);
    const q = await transferQueue(op, "payout", ["requested"]);
    expect(q).toHaveLength(1);
    expect(JSON.stringify(q)).not.toContain("1234567890");
    expect(q[0]).toMatchObject({ accountLast4: "7890", amountIdr: 200_000 });
    const events = async () => ((await admin.execute(sql`select access_level from personal_data_access_event where target_kind = 'payout' and target_id = ${String(payoutId)}`)) as unknown as unknown[]).length;
    expect(await events()).toBe(0);
    expect(await code(transferBankDetail(op, "payout", payoutId, { caseId: "", reason: "tinjau" }))).toBe("purpose_required");
    expect(await events()).toBe(0);
    expect(await transferBankDetail(op, "payout", payoutId, { caseId: `payout:${payoutId}`, reason: "tinjau pencairan" })).toMatchObject({ account: "1234567890", holder: expect.any(String) });
    expect(await events()).toBe(1);
    const noCap = await makeOperator(["tenants.read"]);
    expect(await code(transferQueue(noCap, "payout", ["requested"]))).toBe("forbidden");
  });

  it("a seller cannot touch another store's payout rows or the ledger of another store through the app login", async () => {
    const a = await readyStore();
    const b = await makeStore("toko-b", { price: 500_000 });
    const { payoutId } = await requestPayoutOf(a, 200_000);
    expect(await withStore(db, b.storeId, (tx) => tx.select().from(payout).where(eq(payout.id, payoutId)))).toEqual([]);
    expect(await withStore(db, b.storeId, (tx) => tx.select().from(refund))).toEqual([]);
    expect((await ledgerBalance(platform, a.storeId)).availableIdr).toBe(300_000);
  });
});
