// Four-eyes approvals, session-bound MFA and single-use reauthentication proofs (T-60, IAM-15, DATA-14, D-21).
// Rules that must hold even if a caller is wrong live in the database (CHECKs, the approval_request_guard trigger);
// this module adds the friendly errors and the transaction shape: a proof is consumed by an UPDATE ... RETURNING
// inside the mutation's own transaction, so a write that fails un-consumes it and a proof can never be used twice.
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Tx } from "../client.ts";
import { operatorStepUpProof, approvalRequest, fourEyesRule, sessionMfa } from "./schema-ops.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { holdsCapability, pgCode } from "./capabilities.ts";
import type { FourEyesAction } from "./schema-ops.ts";

/** Canonical JSON (sorted keys, ISO dates): the same logical payload always hashes the same. */
function canonical(v: unknown): string {
  if (v === undefined || typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") throw new TypeError("payload is not JSON-serializable");
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}
/** The exact text an approval or proof is bound to. It is stored on the approval row so the approver sees what they approve. */
export const canonicalPayload = (payload: unknown): string => canonical(payload);
/** SHA-256 hex of the exact payload an approval or proof is bound to. */
export const payloadHash = (payload: unknown): string => createHash("sha256").update(canonical(payload)).digest("hex");

const requestInput = z.strictObject({
  actionKey: z.string().min(1).max(64),
  targetKind: z.string().trim().min(1).max(32),
  targetId: z.string().trim().min(1).max(64),
  payload: z.unknown(),
  reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500),
  /** Shorter than the rule's validity if given; never longer (the database bounds it). */
  ttlSeconds: z.number().int().positive().optional(),
});

/** Ask a second person to approve one exact payload. The requester must hold the rule's capability. */
export async function requestApproval(actor: OperatorScope, raw: unknown): Promise<{ id: number; payloadSha256: string; expiresAt: Date }> {
  const input = requestInput.parse(raw);
  const payloadCanonical = canonicalPayload(input.payload);
  const payloadSha256 = payloadHash(input.payload);
  try {
    return await actor.exec.transaction(async (tx) => {
      const [rule] = await tx.select().from(fourEyesRule).where(eq(fourEyesRule.actionKey, input.actionKey));
      if (!rule || !rule.active) throw new DomainError("not_found", "Tindakan ini tidak memakai persetujuan atau belum aktif.");
      if (!(await holdsCapability(tx, actor.userId, rule.capability))) throw new DomainError("forbidden", `Akses ditolak: butuh izin ${rule.capability}.`);
      const maxValidity = sql`(select max_validity from four_eyes_rule where action_key = ${input.actionKey})`;
      const expiresAt = input.ttlSeconds === undefined ? sql`now() + ${maxValidity}` : sql`now() + least(${maxValidity}, make_interval(secs => ${input.ttlSeconds}::double precision))`;
      const [row] = await tx
        .insert(approvalRequest)
        .values({ actionKey: input.actionKey, targetKind: input.targetKind, targetId: input.targetId, payloadSha256, payloadCanonical, requestedBy: actor.userId, reason: input.reason, expiresAt: expiresAt as unknown as Date })
        .returning({ id: approvalRequest.id, expiresAt: approvalRequest.expiresAt });
      return { id: row!.id, payloadSha256, expiresAt: row!.expiresAt };
    });
  } catch (err) {
    if (pgCode(err) === "23505") throw new DomainError("conflict", "Permintaan persetujuan yang sama masih terbuka.");
    throw err;
  }
}

/** Approve or reject. The decider is never the requester (CHECK) and must hold the rule's capability (trigger); concurrent deciders: one wins. */
export async function decideApproval(actor: OperatorScope, approvalId: number, decision: "approve" | "reject"): Promise<void> {
  await actor.exec.transaction(async (tx) => {
    const [req] = await tx
      .select({ requestedBy: approvalRequest.requestedBy, capability: fourEyesRule.capability })
      .from(approvalRequest)
      .innerJoin(fourEyesRule, eq(fourEyesRule.actionKey, approvalRequest.actionKey))
      .where(eq(approvalRequest.id, approvalId));
    if (!req) throw new DomainError("not_found", "Permintaan persetujuan tidak ditemukan.");
    if (req.requestedBy === actor.userId) throw new DomainError("self_approval", "Pemohon tidak boleh memutuskan permintaannya sendiri.");
    if (!(await holdsCapability(tx, actor.userId, req.capability))) throw new DomainError("forbidden", `Akses ditolak: butuh izin ${req.capability}.`);
    const decided = await tx
      .update(approvalRequest)
      .set({ status: decision === "approve" ? "approved" : "rejected", decidedBy: actor.userId, decidedAt: sql`now()` as unknown as Date })
      .where(and(eq(approvalRequest.id, approvalId), eq(approvalRequest.status, "pending"), gt(approvalRequest.expiresAt, sql`now()`)))
      .returning({ id: approvalRequest.id });
    if (decided.length === 0) throw new DomainError("conflict", "Permintaan persetujuan sudah diputuskan atau kedaluwarsa.");
  });
}

/**
 * Consume an approved request for exactly this action, target and payload, once. Must run inside the transaction of the
 * write it authorizes (`Tx`): the status flips with `UPDATE ... WHERE status = 'approved' RETURNING`, so two executions
 * cannot both succeed and a rolled-back write leaves the approval unconsumed. The caller must be the requester and must
 * still hold the capability; the trigger re-checks that the approver still holds it.
 */
export async function consumeApproval(
  tx: Tx,
  actor: { userId: string },
  input: { approvalId: number; actionKey: FourEyesAction; targetKind: string; targetId: string; payloadSha256: string },
): Promise<{ decidedBy: string }> {
  const invalid = () => new DomainError("approval_invalid", "Persetujuan tidak berlaku: tidak ada, kedaluwarsa, sudah dipakai, atau tidak cocok dengan tindakan ini.");
  const [rule] = await tx.select().from(fourEyesRule).where(eq(fourEyesRule.actionKey, input.actionKey));
  if (!rule?.active) throw invalid();
  if (!(await holdsCapability(tx, actor.userId, rule.capability))) throw new DomainError("forbidden", `Akses ditolak: butuh izin ${rule.capability}.`);
  try {
    const [row] = await tx
      .update(approvalRequest)
      .set({ status: "executed", executedAt: sql`now()` as unknown as Date })
      .where(
        and(
          eq(approvalRequest.id, input.approvalId),
          eq(approvalRequest.status, "approved"),
          eq(approvalRequest.actionKey, input.actionKey),
          eq(approvalRequest.targetKind, input.targetKind),
          eq(approvalRequest.targetId, input.targetId),
          eq(approvalRequest.payloadSha256, input.payloadSha256),
          eq(approvalRequest.requestedBy, actor.userId),
          gt(approvalRequest.expiresAt, sql`now()`),
        ),
      )
      .returning({ decidedBy: approvalRequest.decidedBy });
    if (!row) throw invalid();
    return { decidedBy: row.decidedBy! };
  } catch (err) {
    // The trigger refuses the move when the approver lost the capability or the request expired between the WHERE and the write.
    if (pgCode(err) === "42501" || pgCode(err) === "23514") throw invalid();
    throw err;
  }
}

/** Mark open requests past their expiry `expired` (the sweeper of JOB-12 calls this). Returns how many. */
export async function expireApprovals(exec: Executor): Promise<number> {
  const rows = await exec
    .update(approvalRequest)
    .set({ status: "expired" })
    .where(and(inArray(approvalRequest.status, ["pending", "approved"]), sql`${approvalRequest.expiresAt} <= now()`))
    .returning({ id: approvalRequest.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// MFA bound to the session (D-21). `user.two_factor_enabled` says the account has a second factor; only a row here
// says THIS session passed it. The Better Auth hook in apps/web/src/lib/auth.ts writes the row after every successful
// second-factor verification, so a session that predates enrolment, or never verified a code, has no row.
// ---------------------------------------------------------------------------
export async function recordSessionMfa(exec: Executor, input: { sessionId: string; userId: string; method: "totp" | "backup_code" | "otp" }): Promise<void> {
  await exec
    .insert(sessionMfa)
    .values(input)
    .onConflictDoUpdate({ target: sessionMfa.sessionId, set: { method: input.method, verifiedAt: sql`now()` as unknown as Date } });
}

export async function sessionMfaVerified(exec: Executor, sessionId: string, userId: string): Promise<boolean> {
  const [row] = await exec.select({ s: sessionMfa.sessionId }).from(sessionMfa).where(and(eq(sessionMfa.sessionId, sessionId), eq(sessionMfa.userId, userId)));
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Reauthentication proofs (D-21): single-use, bound to session + action + subject, consumed with the write.
// ---------------------------------------------------------------------------
/** How long a verified second-factor code stays "fresh" and how long an issued proof lives. A conservative default, not an owner decision (D-22 item 3). */
export const STEP_UP_WINDOW_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ProofBinding = { sessionId: string; userId: string; actionKey: string; subjectKind: string; subjectId: string };

/** Issue a proof when this session verified a second-factor code within the window; otherwise the caller must ask for a code first. */
export async function issueStepUpProof(exec: Executor, b: ProofBinding): Promise<string> {
  const rows = (await exec.execute(sql`
    insert into operator_step_up_proof (session_id, user_id, action_key, subject_kind, subject_id, expires_at)
    select m.session_id, m.user_id, ${b.actionKey}, ${b.subjectKind}, ${b.subjectId}, now() + make_interval(secs => ${STEP_UP_WINDOW_SECONDS})
    from session_mfa m
    where m.session_id = ${b.sessionId} and m.user_id = ${b.userId} and m.verified_at > now() - make_interval(secs => ${STEP_UP_WINDOW_SECONDS})
    returning id`)) as unknown as { id: string }[];
  if (rows.length === 0) throw new DomainError("reauth_required", "Masukkan kode verifikasi dua langkah lagi untuk melanjutkan.");
  return rows[0]!.id;
}

/** Consume a proof inside the write's transaction. A wrong session, action or subject, a used or an expired proof all fail the same way. */
export async function consumeStepUpProof(tx: Tx, proofId: string, b: ProofBinding): Promise<void> {
  const fail = () => new DomainError("reauth_required", "Masukkan kode verifikasi dua langkah lagi untuk melanjutkan.");
  if (!UUID.test(proofId)) throw fail();
  const rows = await tx
    .update(operatorStepUpProof)
    .set({ consumedAt: sql`now()` as unknown as Date })
    .where(
      and(
        eq(operatorStepUpProof.id, proofId),
        sql`${operatorStepUpProof.consumedAt} is null`,
        gt(operatorStepUpProof.expiresAt, sql`now()`),
        eq(operatorStepUpProof.sessionId, b.sessionId),
        eq(operatorStepUpProof.userId, b.userId),
        eq(operatorStepUpProof.actionKey, b.actionKey),
        eq(operatorStepUpProof.subjectKind, b.subjectKind),
        eq(operatorStepUpProof.subjectId, b.subjectId),
      ),
    )
    .returning({ id: operatorStepUpProof.id });
  if (rows.length === 0) throw fail();
}
