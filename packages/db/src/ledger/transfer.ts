import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client.ts";
import { consumeApproval, consumeStepUpProof, issueStepUpProof, payloadHash, requestApproval } from "../ops/capabilities-approvals.ts";
import { pgCode, requirePlatformCap } from "../ops/capabilities.ts";
import { withPersonalDataAccess } from "../ops/console-access.ts";
import type { FourEyesAction, PlatformCapability } from "../ops/schema-ops.ts";
import { approvalRequest, auditLog, transferEvidenceArtifact, transferEvidenceRegistry } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { EVIDENCE_MAX_BYTES, EVIDENCE_REF_MIN_LENGTH, PAYOUT_CLAIM_LEASE_MINUTES } from "./settings.ts";
import { assertPayoutsNotFrozen, mapFrozen } from "./control.ts";
import { lockStore } from "./ledger.ts";

// Manual bank transfers of seller payouts and buyer refunds (ADR-0006 decision 5, BILL-5, D-21 item 6). Both follow the same operator lifecycle:
//   requested|pending --approve for transfer (FOUR-EYES: the requester asks, a different staff member approves, the requester executes)--> processing
//   processing --claim (exclusive 30-minute lease + a single-use step-up proof consumed in the same transaction)--> the operator makes the transfer by hand
//   --> paid|completed (records transfer evidence only: a bank reference, unique across ALL payouts and refunds after normalisation, and a receipt file
//       verified by magic bytes, at most 10 MB, unique by SHA-256; it writes no seller ledger row, bank fees are the platform's)
//   --> or rejected|failed (a payout rejection posts the exact opposing `payout_reversal`; from `processing` it needs evidence that NO transfer was sent).
// An unknown transfer outcome STAYS `processing` and allocated: no presumed rejection, no retransfer, no reversal until finance records the confirmed
// outcome from bank evidence. There is no queue that could re-dispatch a transfer: a transfer is a human action, and the state machine has no way back.
// Bank data (account number, holder) is personal data of class `bank`: an operator reads it only through `withPersonalDataAccess`, and the lists below
// only ever select the last four digits.

export type TransferKind = "payout" | "refund";
export const TRANSFER_SPEC = {
  payout: { table: "payout", approve: "payout.approve_transfer", capability: "payouts.process", claimAction: "payout.claim", initial: "requested", ok: "paid", bad: "rejected" },
  refund: { table: "refund", approve: "refund.approve_transfer", capability: "refunds.process", claimAction: "refund.claim", initial: "pending", ok: "completed", bad: "failed" },
} as const satisfies Record<TransferKind, { table: string; approve: string; capability: PlatformCapability; claimAction: string; initial: string; ok: string; bad: string }>;
const T = (k: TransferKind) => sql.identifier(TRANSFER_SPEC[k].table);

export type TransferRow = {
  id: number;
  storeId: number;
  status: string;
  amountIdr: number;
  bank: string | null;
  account: string | null;
  holder: string | null;
  holderCheck: string | null;
  orderId: number | null;
  approvalRequestId: number | null;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  transferUnknownAt: string | null;
};
type Raw = Record<string, string | null>;
const toRow = (r: Raw): TransferRow => ({
  id: Number(r.id),
  storeId: Number(r.store_id),
  status: r.status!,
  amountIdr: Number(r.amount_idr),
  bank: r.bank ?? null,
  account: r.account ?? null,
  holder: r.holder ?? null,
  holderCheck: r.holder_check ?? null,
  orderId: r.order_id == null ? null : Number(r.order_id),
  approvalRequestId: r.approval_request_id == null ? null : Number(r.approval_request_id),
  claimedBy: r.claimed_by_user_id ?? null,
  claimExpiresAt: r.claim_expires_at ?? null,
  transferUnknownAt: r.transfer_unknown_at ?? null,
});

/**
 * The row of one transfer, locked. The bank values are selected ONLY when `bank` is true (callers pass it inside `withPersonalDataAccess`); every other caller gets
 * nulls from the database itself, so a state change (claim, evidence, rejection) never reads an account number (T-37 review P3-8).
 */
export async function lockTransfer(tx: Tx, kind: TransferKind, id: number, bank = false): Promise<TransferRow> {
  const col = (expr: string) => (bank ? sql.raw(expr) : sql.raw("null::text"));
  const rows =
    kind === "payout"
      ? await tx.execute(sql`select id, store_id, status, amount_idr, ${col("bank_code")} as bank, ${col("bank_account_number")} as account, ${col("bank_account_holder")} as holder, ${col("holder_name_check")} as holder_check, null::bigint as order_id, approval_request_id, claimed_by_user_id, claim_expires_at, transfer_unknown_at from payout where id = ${id} for update`)
      : await tx.execute(sql`select r.id, r.store_id, r.status, r.amount_idr, ${col("r.destination_bank")} as bank, ${col("r.destination_account")} as account, ${col("r.destination_holder")} as holder,
          ${bank ? sql`case when r.destination_holder is null then null when lower(regexp_replace(r.destination_holder, '[^a-zA-Z0-9]', '', 'g')) = lower(regexp_replace(o.buyer_name, '[^a-zA-Z0-9]', '', 'g')) then 'match' else 'mismatch' end` : sql`null::text`} as holder_check,
          r.order_id, r.approval_request_id, r.claimed_by_user_id, r.claim_expires_at, r.transfer_unknown_at
          from refund r join "order" o on o.store_id = r.store_id and o.id = r.order_id where r.id = ${id} for update of r`);
  const row = (rows as unknown as Raw[])[0];
  if (!row) throw new DomainError("not_found", kind === "payout" ? "Penarikan tidak ditemukan." : "Refund tidak ditemukan.");
  return toRow(row);
}

/** What the approver sees and the hash binds: the id, the amount and the bank snapshot (BILL-5). */
export function transferPayload(kind: TransferKind, r: TransferRow) {
  return kind === "payout"
    ? { kind, payoutId: r.id, storeId: r.storeId, amountIdr: r.amountIdr, bankCode: r.bank, bankAccountNumber: r.account, bankAccountHolder: r.holder, holderNameCheck: r.holderCheck }
    : { kind, refundId: r.id, orderId: r.orderId, storeId: r.storeId, amountIdr: r.amountIdr, destinationBank: r.bank, destinationAccount: r.account, destinationHolder: r.holder, holderMatchesRecipient: r.holderCheck };
}

const accessFor = (kind: TransferKind, id: number, purpose: string, reason: string) => ({
  capability: TRANSFER_SPEC[kind].capability,
  targetKind: kind,
  targetId: String(id),
  fieldClass: "bank" as const,
  purposeCode: purpose,
  caseId: `${kind}:${id}`,
  reason,
  accessLevel: "full" as const,
  expiresAt: new Date(Date.now() + 10 * 60_000),
});

/** Step 1 (requester). Reads the bank snapshot under recorded `full` access, builds the exact payload and asks a second person. */
export async function requestTransferApproval(op: OperatorScope, kind: TransferKind, id: number, reason: string): Promise<{ approvalId: number; payloadSha256: string }> {
  const spec = TRANSFER_SPEC[kind];
  await requirePlatformCap(op, spec.capability);
  const payload = await withPersonalDataAccess(op, accessFor(kind, id, "payout_review", "build the approval payload"), async (tx) => {
    const r = await lockTransfer(tx, kind, id, true);
    if (r.status !== spec.initial) throw new DomainError("invalid_state", `Hanya ${kind === "payout" ? "penarikan berstatus requested" : "refund berstatus pending"} yang bisa diajukan.`);
    if (kind === "refund" && !r.account) throw new DomainError("destination_missing", "Pembeli belum mengisi rekening tujuan refund pada halaman status pesanan.");
    return transferPayload(kind, r);
  });
  const req = await requestApproval(op, { actionKey: spec.approve, targetKind: kind, targetId: String(id), payload, reason });
  return { approvalId: req.id, payloadSha256: req.payloadSha256 };
}

/**
 * Step 2 (the REQUESTER executes what the second person approved). The approval is consumed in the same transaction as the move to `processing`; the payload hash is
 * recomputed from the CURRENT immutable snapshot, so an approval for another amount or another bank account never fits.
 */
export async function approveForTransfer(op: OperatorScope, kind: TransferKind, id: number): Promise<void> {
  const spec = TRANSFER_SPEC[kind];
  await requirePlatformCap(op, spec.capability);
  await mapFrozen(() => withPersonalDataAccess(op, accessFor(kind, id, "payout_review", "execute the approved transfer"), async (tx) => {
    await assertPayoutsNotFrozen(tx);
    const r = await lockTransfer(tx, kind, id, true);
    if (r.status !== spec.initial) throw new DomainError("invalid_state", "Status tidak lagi menunggu persetujuan.");
    const [req] = await tx
      .select({ id: approvalRequest.id })
      .from(approvalRequest)
      .where(sql`${approvalRequest.actionKey} = ${spec.approve} and ${approvalRequest.targetKind} = ${kind} and ${approvalRequest.targetId} = ${String(id)} and ${approvalRequest.status} = 'approved' and ${approvalRequest.requestedBy} = ${op.userId}`)
      .orderBy(sql`${approvalRequest.id} desc`)
      .limit(1);
    if (!req) throw new DomainError("approval_invalid", "Belum ada persetujuan orang kedua untuk transfer ini.");
    await consumeApproval(tx, op, { approvalId: req.id, actionKey: spec.approve, targetKind: kind, targetId: String(id), payloadSha256: payloadHash(transferPayload(kind, r)) });
    const rows = await tx.execute(sql`update ${T(kind)} set status = 'processing', approval_request_id = ${req.id}, approved_at = now() where id = ${id} and status = ${spec.initial} returning id`);
    if ((rows as unknown as unknown[]).length === 0) throw new DomainError("invalid_state", "Status tidak lagi menunggu persetujuan.");
    await tx.insert(auditLog).values({ storeId: r.storeId, actorUserId: op.userId, actorCapability: spec.capability, action: `${kind}.approve_transfer`, subjectKind: kind, subjectId: String(id), outcome: "allowed", reason: `approval:${req.id}` });
  }));
}

/**
 * Claim (the operator about to make the transfer). An exclusive lease of `PAYOUT_CLAIM_LEASE_MINUTES`, and a single-use step-up proof of THIS session consumed
 * in the same transaction: when the claim fails (someone else holds it) the proof stays unconsumed until it expires. A concurrent claim gets 409
 * `PAYOUT_ALREADY_CLAIMED`; the lease expires by itself.
 */
export async function claimTransfer(op: OperatorScope, sessionId: string, kind: TransferKind, id: number): Promise<{ claimExpiresAt: string }> {
  const spec = TRANSFER_SPEC[kind];
  await requirePlatformCap(op, spec.capability);
  const binding = { sessionId, userId: op.userId, actionKey: spec.claimAction, subjectKind: kind, subjectId: String(id) };
  const proofId = await issueStepUpProof(op.exec, binding);
  return mapFrozen(() => op.exec.transaction(async (tx) => {
    await assertPayoutsNotFrozen(tx);
    await consumeStepUpProof(tx, proofId, binding);
    const rows = (await tx.execute(sql`
      update ${T(kind)} set claimed_by_user_id = ${op.userId}, claim_expires_at = now() + make_interval(mins => ${PAYOUT_CLAIM_LEASE_MINUTES})
       where id = ${id} and status = 'processing' and transfer_unknown_at is null and (claimed_by_user_id is null or claim_expires_at <= now() or claimed_by_user_id = ${op.userId})
      returning claim_expires_at`)) as unknown as { claim_expires_at: string }[];
    if (rows.length === 0) {
      const [cur] = (await tx.execute(sql`select status, claimed_by_user_id, transfer_unknown_at from ${T(kind)} where id = ${id}`)) as unknown as { status: string; claimed_by_user_id: string | null; transfer_unknown_at: string | null }[];
      if (!cur) throw new DomainError("not_found", "Tidak ditemukan.");
      if (cur.status === "processing" && cur.transfer_unknown_at) throw new DomainError("transfer_outcome_unknown", "Hasil transfer ini belum diketahui: tidak boleh diklaim lagi atau dikirim ulang. Selesaikan dengan bukti bank (dicatat selesai oleh pelapor, atau ditolak dengan persetujuan orang kedua).");
      if (cur.status === "processing") throw new DomainError(kind === "payout" ? "PAYOUT_ALREADY_CLAIMED" : "REFUND_ALREADY_CLAIMED", "Sedang diproses operator lain (klaim aktif 30 menit).");
      throw new DomainError("invalid_state", "Hanya transfer berstatus processing yang bisa diklaim.");
    }
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: spec.capability, action: `${kind}.claim`, subjectKind: kind, subjectId: String(id), outcome: "allowed" });
    return { claimExpiresAt: rows[0]!.claim_expires_at };
  }));
}

/** The claimant says the outcome of the transfer is UNKNOWN (bank timeout, ambiguous screen). It stays `processing`, allocated, until bank evidence proves the effect. */
export async function recordTransferUnknown(op: OperatorScope, kind: TransferKind, id: number): Promise<void> {
  const spec = TRANSFER_SPEC[kind];
  await requirePlatformCap(op, spec.capability);
  await op.exec.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      update ${T(kind)} set transfer_unknown_at = coalesce(transfer_unknown_at, now())
       where id = ${id} and status = 'processing' and claimed_by_user_id = ${op.userId} and claim_expires_at > now() returning store_id`)) as unknown as { store_id: string }[];
    if (rows.length === 0) throw new DomainError("not_claimed", "Hanya pemegang klaim aktif yang bisa mencatat hasil tidak diketahui.");
    await tx.insert(auditLog).values({ storeId: Number(rows[0]!.store_id), actorUserId: op.userId, actorCapability: spec.capability, action: `${kind}.transfer_unknown`, subjectKind: kind, subjectId: String(id), outcome: "allowed" });
  });
}

// ── Evidence ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type ReceiptKind = "png" | "jpeg" | "webp" | "pdf";
const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
/** Magic-byte sniffing of PNG, JPEG, WebP and PDF; the declared type or file name is never believed. */
export function sniffReceipt(bytes: Uint8Array): { kind: ReceiptKind; sha256: string; size: number } {
  if (bytes.length === 0 || bytes.length > EVIDENCE_MAX_BYTES) throw new DomainError("receipt_size", "Bukti transfer harus 1 byte sampai 10 MB.");
  const kind: ReceiptKind | null = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ? "png"
    : startsWith(bytes, [0xff, 0xd8, 0xff])
      ? "jpeg"
      : startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
        ? "webp"
        : startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
          ? "pdf"
          : null;
  if (!kind) throw new DomainError("receipt_type", "Bukti transfer harus berupa PNG, JPEG, WebP atau PDF.");
  return { kind, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

const evidenceInput = z.strictObject({
  evidenceRef: z.string().trim().min(EVIDENCE_REF_MIN_LENGTH, "Referensi transfer terlalu pendek.").max(120),
  receipt: z.instanceof(Uint8Array),
});

/** Store the receipt file and the reference. Both are database-unique (digest; reference after normalisation by a trigger): reuse across ANY payout or refund fails. */
async function recordEvidence(tx: Tx, kind: TransferKind, id: number, op: OperatorScope, evidence: { evidenceRef: string; receipt: Uint8Array }): Promise<number> {
  const file = sniffReceipt(evidence.receipt);
  const [art] = await tx
    .insert(transferEvidenceArtifact)
    .values({ sha256: file.sha256, kind: file.kind, sizeBytes: file.size, content: Buffer.from(evidence.receipt).toString("base64"), uploadedByUserId: op.userId, claimedBy: `${kind}:${id}` })
    .onConflictDoNothing()
    .returning({ id: transferEvidenceArtifact.id });
  if (!art) throw new DomainError("EVIDENCE_REUSE_FORBIDDEN", "File bukti ini sudah dipakai pada transfer lain.");
  try {
    await tx.insert(transferEvidenceRegistry).values({ refRaw: evidence.evidenceRef, normRef: "", subjectKind: kind, subjectId: id });
  } catch (err) {
    if (pgCode(err) === "23505") throw new DomainError("DUPLICATE_BANK_TRANSFER_REFERENCE", "Referensi transfer bank ini sudah dipakai pada transfer lain.");
    if (pgCode(err) === "23514") throw new DomainError("bad_evidence_ref", "Referensi transfer minimal 6 huruf atau angka.");
    throw err;
  }
  return art.id;
}

/** `processing -> paid|completed`: records the evidence of the transfer the claimant made. Needs a LIVE claim of this operator. No ledger row is written. */
export async function completeTransfer(op: OperatorScope, kind: TransferKind, id: number, raw: { evidenceRef: string; receipt: Uint8Array }): Promise<void> {
  const spec = TRANSFER_SPEC[kind];
  await requirePlatformCap(op, spec.capability);
  const evidence = evidenceInput.parse(raw);
  await mapFrozen(() => op.exec.transaction(async (tx) => {
    await assertPayoutsNotFrozen(tx);
    const r = await lockTransfer(tx, kind, id);
    if (r.status !== "processing") throw new DomainError("invalid_state", "Hanya transfer berstatus processing yang bisa dicatat selesai.");
    // The lease only stops two people sending at once. A transfer whose outcome was reported unknown is never claimed again, so the reporter settles it with the bank evidence.
    const leaseLive = r.claimExpiresAt !== null && new Date(r.claimExpiresAt) > new Date();
    if (r.claimedBy !== op.userId || !(leaseLive || r.transferUnknownAt)) throw new DomainError("not_claimed", "Klaim aktif diperlukan: klaim ulang sebelum mencatat bukti.");
    const artifactId = await recordEvidence(tx, kind, id, op, evidence);
    const rows =
      kind === "payout"
        ? await tx.execute(sql`update payout set status = 'paid', transfer_evidence_ref = ${evidence.evidenceRef}, evidence_artifact_id = ${artifactId}, processed_by_user_id = ${op.userId}, processed_at = now(), claimed_by_user_id = null, claim_expires_at = null, transfer_unknown_at = null where id = ${id} and status = 'processing' returning id`)
        : await tx.execute(sql`update refund set status = 'completed', transfer_evidence_ref = ${evidence.evidenceRef}, evidence_artifact_id = ${artifactId}, processed_by_user_id = ${op.userId}, claimed_by_user_id = null, claim_expires_at = null, transfer_unknown_at = null where id = ${id} and status = 'processing' returning id`);
    if ((rows as unknown as unknown[]).length === 0) throw new DomainError("invalid_state", "Status berubah.");
    await tx.insert(auditLog).values({ storeId: r.storeId, actorUserId: op.userId, actorCapability: spec.capability, action: `${kind}.${spec.ok}`, subjectKind: kind, subjectId: String(id), outcome: "allowed", reason: `receipt:${artifactId}` });
  }));
}

const rejectInput = z.strictObject({
  reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500),
  noTransferEvidenceRef: z.string().trim().min(EVIDENCE_REF_MIN_LENGTH).max(120).optional(),
});
export const REJECT_ACTION = { payout: "payout.reject_processing", refund: "refund.fail" } as const satisfies Record<TransferKind, FourEyesAction>;
/** The reference as the database normalises it (lower-case letters and digits only): what the approval binds and the registry makes unique. */
export const normaliseEvidenceRef = (ref: string) => ref.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A payout is decided alone only while it is still `requested` (nothing was approved or sent, the seller's money simply returns). Every other rejection or failure is four-eyes. */
const rejectNeedsApproval = (kind: TransferKind, status: string) => kind === "refund" || status === "processing";

/** Insert the no-transfer evidence reference into the registry: unique across every payout and refund after normalisation, so a reference cannot be reused as proof twice. */
async function registerEvidenceRef(tx: Tx, kind: TransferKind, id: number, ref: string): Promise<void> {
  try {
    await tx.insert(transferEvidenceRegistry).values({ refRaw: ref, normRef: "", subjectKind: kind, subjectId: id });
  } catch (err) {
    if (pgCode(err) === "23505") throw new DomainError("DUPLICATE_BANK_TRANSFER_REFERENCE", "Referensi bukti bank ini sudah dipakai pada transfer lain.");
    if (pgCode(err) === "23514") throw new DomainError("bad_evidence_ref", "Referensi bukti minimal 6 huruf atau angka.");
    throw err;
  }
}

/**
 * Four-eyes for the decision that leaves money where it is: rejecting a payout in `processing` ("no transfer was sent", D-21 b) and failing a refund (the buyer's
 * money stays owed). The requester names the reason and, when something was in flight, the bank evidence reference; a second person approves exactly that text.
 * The reference must not have been used as evidence before (checked here for a plain message, enforced by the registry).
 */
export async function requestRejectApproval(op: OperatorScope, kind: TransferKind, id: number, raw: { reason: string; noTransferEvidenceRef?: string }): Promise<{ approvalId: number; payloadSha256: string }> {
  const spec = TRANSFER_SPEC[kind];
  await requirePlatformCap(op, spec.capability);
  const input = rejectInput.parse(raw);
  const r = await op.exec.transaction(async (tx) => lockTransfer(tx, kind, id));
  if (!rejectNeedsApproval(kind, r.status) || (r.status !== spec.initial && r.status !== "processing")) throw new DomainError("invalid_state", "Keputusan ini tidak membutuhkan persetujuan atau status sudah berubah.");
  if (r.status === "processing" && !input.noTransferEvidenceRef) throw new DomainError("evidence_required", "Setelah disetujui untuk transfer, penolakan butuh bukti bank bahwa tidak ada transfer yang terkirim.");
  const norm = input.noTransferEvidenceRef ? normaliseEvidenceRef(input.noTransferEvidenceRef) : "";
  if (input.noTransferEvidenceRef) {
    if (norm.length < EVIDENCE_REF_MIN_LENGTH) throw new DomainError("bad_evidence_ref", "Referensi bukti minimal 6 huruf atau angka.");
    const used = (await op.exec.execute(sql`select 1 from transfer_evidence_registry where norm_ref = ${norm}`)) as unknown as unknown[];
    if (used.length > 0) throw new DomainError("DUPLICATE_BANK_TRANSFER_REFERENCE", "Referensi bukti bank ini sudah dipakai pada transfer lain.");
  }
  const payload = { decision: kind === "payout" ? "reject_processing" : "fail", kind, [kind === "payout" ? "payoutId" : "refundId"]: id, storeId: r.storeId, amountIdr: r.amountIdr, reason: input.reason, noTransferEvidenceRef: input.noTransferEvidenceRef ?? "", noTransferEvidenceNorm: norm };
  const req = await requestApproval(op, { actionKey: REJECT_ACTION[kind], targetKind: kind, targetId: String(id), payload, reason: input.reason });
  return { approvalId: req.id, payloadSha256: req.payloadSha256 };
}

/**
 * `requested|pending|processing -> rejected|failed`. A payout still `requested` is rejected by one operator with a reason. Every other case (a payout in `processing`, any
 * refund) needs `approvalId`: the approval the REQUESTER obtained from a second person, consumed in this transaction; the reason and the bank evidence reference are read from
 * the approved payload, never typed again. The reference goes into the evidence registry (single use). It is refused while another operator holds a live claim. A payout
 * rejection posts the exact opposing `payout_reversal` in the same transaction (store lock first, then the rows; the unique index makes a replay post nothing).
 */
export async function rejectTransfer(op: OperatorScope, kind: TransferKind, id: number, raw: { reason?: string; noTransferEvidenceRef?: string; approvalId?: number }): Promise<void> {
  const spec = TRANSFER_SPEC[kind];
  await requirePlatformCap(op, spec.capability);
  await mapFrozen(() => op.exec.transaction(async (tx) => {
    await assertPayoutsNotFrozen(tx);
    const [pre] = (await tx.execute(sql`select store_id from ${T(kind)} where id = ${id}`)) as unknown as { store_id: string }[];
    if (!pre) throw new DomainError("not_found", "Tidak ditemukan.");
    await lockStore(tx, Number(pre.store_id));
    const r = await lockTransfer(tx, kind, id);
    if (r.status !== spec.initial && r.status !== "processing") throw new DomainError("invalid_state", "Sudah diputuskan.");
    if (r.status === "processing" && r.claimedBy && r.claimedBy !== op.userId && r.claimExpiresAt && new Date(r.claimExpiresAt) > new Date()) throw new DomainError(kind === "payout" ? "PAYOUT_ALREADY_CLAIMED" : "REFUND_ALREADY_CLAIMED", "Sedang diproses operator lain.");
    let reason: string;
    let evidenceRef: string | null = null;
    let approvalId: number | null = null;
    if (rejectNeedsApproval(kind, r.status)) {
      if (!raw.approvalId) throw new DomainError("approval_invalid", "Keputusan ini butuh persetujuan orang kedua (persetujuan tidak disertakan).");
      const [req] = await tx.select().from(approvalRequest).where(and(eq(approvalRequest.id, raw.approvalId), eq(approvalRequest.actionKey, REJECT_ACTION[kind]), eq(approvalRequest.targetKind, kind), eq(approvalRequest.targetId, String(id)), eq(approvalRequest.requestedBy, op.userId)));
      if (!req) throw new DomainError("approval_invalid", "Persetujuan tidak ditemukan untuk transfer ini atau bukan permintaan Anda.");
      const p = z.looseObject({ reason: z.string(), noTransferEvidenceRef: z.string(), noTransferEvidenceNorm: z.string(), amountIdr: z.number(), storeId: z.number() }).parse(JSON.parse(req.payloadCanonical));
      if (p.amountIdr !== r.amountIdr || p.storeId !== r.storeId) throw new DomainError("approval_invalid", "Jumlah atau toko berubah sejak persetujuan.");
      await consumeApproval(tx, op, { approvalId: raw.approvalId, actionKey: REJECT_ACTION[kind], targetKind: kind, targetId: String(id), payloadSha256: req.payloadSha256 });
      reason = p.reason;
      evidenceRef = p.noTransferEvidenceRef || null;
      approvalId = raw.approvalId;
      if (r.status === "processing" && !evidenceRef) throw new DomainError("evidence_required", "Penolakan setelah disetujui butuh bukti bahwa tidak ada transfer yang terkirim.");
    } else {
      reason = rejectInput.parse({ reason: raw.reason }).reason;
    }
    if (evidenceRef) await registerEvidenceRef(tx, kind, id, evidenceRef);
    const rows =
      kind === "payout"
        ? await tx.execute(sql`update payout set status = 'rejected', rejection_reason = ${reason}, no_transfer_evidence_ref = ${evidenceRef}, reject_approval_request_id = ${approvalId}, processed_by_user_id = ${op.userId}, processed_at = now(), claimed_by_user_id = null, claim_expires_at = null, transfer_unknown_at = null where id = ${id} and status in ('requested', 'processing') returning id`)
        : await tx.execute(sql`update refund set status = 'failed', failure_reason = ${reason}, no_transfer_evidence_ref = ${evidenceRef}, fail_approval_request_id = ${approvalId}, processed_by_user_id = ${op.userId}, claimed_by_user_id = null, claim_expires_at = null, transfer_unknown_at = null where id = ${id} and status in ('pending', 'processing') returning id`);
    if ((rows as unknown as unknown[]).length === 0) throw new DomainError("invalid_state", "Sudah diputuskan.");
    if (kind === "payout") {
      const debit = (await tx.execute(sql`select amount_idr from ledger_entry where store_id = ${r.storeId} and payout_id = ${id} and kind = 'payout'`)) as unknown as { amount_idr: string }[];
      if (debit.length !== 1) throw new Error(`invariant: payout ${id} has ${debit.length} debit entries`);
      // The exact opposing entry of THAT payout's debit; replays hit ledger_one_payout_reversal_per_payout and post nothing.
      await tx.execute(sql`insert into ledger_entry (store_id, payout_id, kind, status, amount_idr, released_at, release_basis, note) values (${r.storeId}, ${id}, 'payout_reversal', 'available', ${-Number(debit[0]!.amount_idr)}, now(), 'direct', 'Penarikan ditolak: dana dikembalikan') on conflict do nothing`);
    }
    await tx.insert(auditLog).values({ storeId: r.storeId, actorUserId: op.userId, actorCapability: spec.capability, action: `${kind}.${spec.bad}`, subjectKind: kind, subjectId: String(id), outcome: "allowed", reason: reason.slice(0, 200) });
  }));
}
