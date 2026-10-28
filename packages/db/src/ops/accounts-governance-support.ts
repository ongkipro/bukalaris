// SA-24 support actions on seller team accounts (T-63 slice 4) and the disabled staff ownership recovery (slice 5).
// Every action needs an OPEN case and a reason, runs in one transaction with its audit row and its `support_action` row, is idempotent
// by a unique key (a replay returns the first row and acts once), and reports the OUTCOME THAT WAS WRITTEN. The operator is never
// shown a link, password, token or OTP, and there is no impersonation: support recovers an account only by mailing the contact on file.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Tx } from "../client.ts";
import { dbMailer } from "../platform/accounts.ts";
import { surfaceOriginsFromEnv } from "../platform/host.ts";
import { accountStatusEvent, supportAction, type SupportActionKind } from "./schema-governance.ts";
import { auditLog, membership, session, user } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { consumeApproval, canonicalPayload, payloadHash, requestApproval } from "./capabilities-approvals.ts";
import { holdsCapability, pgCode, requirePlatformCap } from "./capabilities.ts";
import { caseRefSchema, governed, idempotencyKey, reasonCode, reasonText, requireAccountTarget, type GovernedCase } from "./accounts-governance.ts";
import { withinTx } from "./accounts-governance-reveal.ts";
import { approvalRequest } from "./schema-ops.ts";

/** What was written, in words the screen can show verbatim (UX-22 "report the outcome that was written, not the request"). */
export type SupportOutcomeKind = "sessions_revoked" | "recovery_link_queued" | "identity_suspended" | "identity_reinstated" | "mfa_reset_awaiting_approval" | "mfa_reset_done" | "mfa_reset_cancelled";
export interface SupportOutcome {
  supportActionId: number;
  outcome: SupportOutcomeKind;
  /** Rows or sessions affected, where the action has such a number. */
  count: number | null;
  /** True when the idempotency key had already been used: nothing happened this time. */
  replayed: boolean;
  approvalRequestId: number | null;
}

const base = z.strictObject({ caseRef: caseRefSchema, reasonCode, reason: reasonText, idempotencyKey });
const userIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "ID akun tidak valid.");

type Claim = { id: number; requestedBy: string; actionKind: SupportActionKind; subjectId: string; status: string; approvalRequestId: number | null; resultCode: string | null };
/**
 * Claim the idempotency key: the unique index decides. The first caller inserts; a concurrent or later caller with the same key gets the
 * first row back (and acts on nothing). A key reused for another actor, kind or subject is a conflict, never a silent replay.
 */
async function claimAction(tx: Tx, v: { caseId: number; subjectId: string; actionKind: SupportActionKind; actionKey?: string; status: "requested" | "awaiting_approval"; requestedBy: string; approvalRequestId?: number; idempotencyKey: string; reasonCode: string }): Promise<{ row: Claim; replayed: boolean }> {
  const inserted = await tx
    .insert(supportAction)
    .values({ caseId: v.caseId, subjectKind: "user", subjectId: v.subjectId, actionKind: v.actionKind, actionKey: v.actionKey ?? null, status: v.status, requestedBy: v.requestedBy, approvalRequestId: v.approvalRequestId ?? null, idempotencyKey: v.idempotencyKey, reasonCode: v.reasonCode })
    .onConflictDoNothing({ target: supportAction.idempotencyKey })
    .returning({ id: supportAction.id, requestedBy: supportAction.requestedBy, actionKind: supportAction.actionKind, subjectId: supportAction.subjectId, status: supportAction.status, approvalRequestId: supportAction.approvalRequestId, resultCode: supportAction.resultCode });
  if (inserted[0]) return { row: inserted[0], replayed: false };
  const [existing] = await tx.select({ id: supportAction.id, requestedBy: supportAction.requestedBy, actionKind: supportAction.actionKind, subjectId: supportAction.subjectId, status: supportAction.status, approvalRequestId: supportAction.approvalRequestId, resultCode: supportAction.resultCode }).from(supportAction).where(eq(supportAction.idempotencyKey, v.idempotencyKey));
  if (!existing || existing.requestedBy !== v.requestedBy || existing.actionKind !== v.actionKind || existing.subjectId !== v.subjectId) throw new DomainError("idempotency_conflict", "Kunci idempotensi ini sudah dipakai untuk tindakan lain.");
  return { row: existing, replayed: true };
}
const finish = (tx: Tx, id: number, resultCode: string) => tx.update(supportAction).set({ status: "executed", executedAt: sql`now()` as unknown as Date, resultCode, updatedAt: sql`now()` as unknown as Date }).where(and(eq(supportAction.id, id), eq(supportAction.status, "requested")));
const replayOutcome = (row: Claim, outcome: SupportOutcomeKind): SupportOutcome => ({ supportActionId: row.id, outcome, count: Number(/:(\d+)$/.exec(row.resultCode ?? "")?.[1] ?? NaN) || null, replayed: true, approvalRequestId: row.approvalRequestId });

const sessionsOf = (tx: Tx, userId: string) => tx.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });

/** Revoke every session of a seller team member (accounts.support). */
export async function revokeUserSessions(op: OperatorScope, userId: string, raw: unknown): Promise<SupportOutcome> {
  const i = base.parse(raw);
  const id = userIdSchema.parse(userId);
  await requirePlatformCap(op, "accounts.support");
  await requireAccountTarget(op, id, "accounts.support");
  return governed(op, { capability: "accounts.support", action: "support.revoke_sessions", subjectKind: "user", subjectId: id, reasonCode: i.reasonCode, reason: i.reason, case: { ref: i.caseRef, required: true, target: { kind: "user", id } } }, async (tx, c) => {
    const { row, replayed } = await claimAction(tx, { caseId: c!.id, subjectId: id, actionKind: "revoke_sessions", status: "requested", requestedBy: op.userId, idempotencyKey: i.idempotencyKey, reasonCode: i.reasonCode });
    if (replayed) return replayOutcome(row, "sessions_revoked");
    await mustExist(tx, id);
    const gone = await sessionsOf(tx, id);
    await finish(tx, row.id, `revoked:${gone.length}`);
    return { supportActionId: row.id, outcome: "sessions_revoked" as const, count: gone.length, replayed: false, approvalRequestId: null };
  });
}

async function mustExist(tx: Tx, userId: string) {
  const [u] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId));
  if (!u) throw new DomainError("not_found", "Akun tidak ditemukan.");
}

/** Lifetime of a support recovery link: the same as the self-service reset token (one hour). A named default, not an owner decision. */
export const SUPPORT_RECOVERY_TTL_SECONDS = (env: NodeJS.ProcessEnv = process.env) => Math.max(60, Number(env.SUPPORT_RECOVERY_TTL_SECONDS) || 3600);

/**
 * Send a recovery link to the contact on file (accounts.support). The link goes only into one `support_recovery` mail (outbox body
 * purged after delivery or at expiry); the operator receives "queued, delivery not confirmed" and nothing else. The token exists as a
 * SHA-256 only. A suspended identity gets none (suspension is lifted first, on purpose). The mail is queued in the same transaction as
 * the link row, the action row and the audit row: if any of them fails, no link exists anywhere.
 */
export async function startSupportRecovery(op: OperatorScope, userId: string, raw: unknown, env: NodeJS.ProcessEnv = process.env): Promise<SupportOutcome> {
  const i = base.parse(raw);
  const id = userIdSchema.parse(userId);
  await requirePlatformCap(op, "accounts.support");
  await requireAccountTarget(op, id, "accounts.support");
  return governed(op, { capability: "accounts.support", action: "support.start_recovery", subjectKind: "user", subjectId: id, reasonCode: i.reasonCode, reason: i.reason, case: { ref: i.caseRef, required: true, target: { kind: "user", id } } }, async (tx, c) => {
    const { row, replayed } = await claimAction(tx, { caseId: c!.id, subjectId: id, actionKind: "start_recovery", status: "requested", requestedBy: op.userId, idempotencyKey: i.idempotencyKey, reasonCode: i.reasonCode });
    if (replayed) return replayOutcome(row, "recovery_link_queued");
    const [u] = await tx.select({ email: user.email, name: user.name, emailVerified: user.emailVerified, suspendedAt: user.suspendedAt }).from(user).where(eq(user.id, id));
    if (!u) throw new DomainError("not_found", "Akun tidak ditemukan.");
    if (!u.emailVerified) throw new DomainError("contact_unverified", "Kontak pada akun ini belum terverifikasi; tautan tidak dikirim.");
    if (u.suspendedAt) throw new DomainError("account_suspended", "Akun sedang ditangguhkan; pulihkan akun lebih dulu.");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SUPPORT_RECOVERY_TTL_SECONDS(env) * 1000);
    await tx.execute(sql`select public.support_recovery_create(${op.userId}, ${row.id}::bigint, ${id}, ${createHash("sha256").update(token).digest("hex")}, ${expiresAt.toISOString()}::timestamptz)`);
    await dbMailer(tx).send({
      to: u.email,
      subject: "Pemulihan akun Bukalaris",
      oneTime: { purpose: "support_recovery", expiresAt },
      text: [
        `Halo ${u.name},`,
        "Tim dukungan Bukalaris mengirim tautan pemulihan atas permintaan Anda.",
        `Buka tautan berikut untuk mengatur ulang kata sandi (berlaku ${Math.round(SUPPORT_RECOVERY_TTL_SECONDS(env) / 60)} menit, sekali pakai):`,
        `${surfaceOriginsFromEnv(env).appOrigin}/account/support-recovery/${token}`,
        "Abaikan email ini jika Anda tidak memintanya. Staf kami tidak pernah meminta kata sandi atau kode Anda.",
      ].join("\n"),
    });
    await finish(tx, row.id, "link_queued");
    return { supportActionId: row.id, outcome: "recovery_link_queued" as const, count: null, replayed: false, approvalRequestId: null };
  });
}

/**
 * Suspend or restore an identity (accounts.suspend): every session ends in the same transaction, one `account_status_event` records the
 * change, and `resolve_user_suspended` makes the seller scope refuse the identity from then on, so a stale session cannot mutate.
 * The owner-side function decides the move atomically (`WHERE suspended_at IS NULL`): two staff members acting at once yield one
 * transition and one `conflict`. Membership removal stays a store-owner action.
 */
export async function setIdentitySuspension(op: OperatorScope, userId: string, raw: unknown): Promise<SupportOutcome> {
  const i = base.extend({ suspend: z.boolean() }).parse(raw);
  const id = userIdSchema.parse(userId);
  await requirePlatformCap(op, "accounts.suspend");
  await requireAccountTarget(op, id, "accounts.suspend");
  const kind: SupportActionKind = i.suspend ? "suspend" : "reinstate";
  return governed(op, { capability: "accounts.suspend", action: i.suspend ? "support.suspend" : "support.reinstate", subjectKind: "user", subjectId: id, reasonCode: i.reasonCode, reason: i.reason, case: { ref: i.caseRef, required: true, target: { kind: "user", id } } }, async (tx, c) => {
    const { row, replayed } = await claimAction(tx, { caseId: c!.id, subjectId: id, actionKind: kind, status: "requested", requestedBy: op.userId, idempotencyKey: i.idempotencyKey, reasonCode: i.reasonCode });
    if (replayed) return replayOutcome(row, i.suspend ? "identity_suspended" : "identity_reinstated");
    await mustExist(tx, id);
    const [{ changed }] = (await tx.execute(sql`select public.console_set_user_suspension(${op.userId}, ${id}, ${i.suspend}) as changed`)) as unknown as { changed: boolean }[];
    if (!changed) throw new DomainError("conflict", i.suspend ? "Akun sudah ditangguhkan (mungkin oleh staf lain)." : "Akun tidak sedang ditangguhkan.");
    const gone = i.suspend ? await sessionsOf(tx, id) : [];
    await tx.insert(accountStatusEvent).values({ subjectKind: "user", subjectId: id, fromStatus: i.suspend ? "active" : "suspended", toStatus: i.suspend ? "suspended" : "active", reasonCode: i.reasonCode, reasonNote: i.reason, actorUserId: op.userId, caseId: c!.id });
    await finish(tx, row.id, i.suspend ? `suspended:${gone.length}` : "reinstated");
    return { supportActionId: row.id, outcome: i.suspend ? ("identity_suspended" as const) : ("identity_reinstated" as const), count: i.suspend ? gone.length : null, replayed: false, approvalRequestId: null };
  });
}

// ── MFA reset ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The exact payload a second person approves and the requester must reproduce at execution. */
export interface MfaResetPayload {
  kind: "mfa_reset";
  userId: string;
  caseNumber: string;
}
const mfaPayload = (userId: string, caseNumber: string): MfaResetPayload => ({ kind: "mfa_reset", userId, caseNumber });

const noticeMail = (tx: Tx, to: string, name: string) =>
  dbMailer(tx).send({ to, subject: "Verifikasi dua langkah akun Anda direset", text: [`Halo ${name},`, "Verifikasi dua langkah akun Bukalaris Anda direset oleh tim dukungan. Anda perlu mendaftarkannya lagi saat masuk berikutnya.", "Hubungi kami segera jika ini bukan permintaan Anda."].join("\n") });

/**
 * Ask for a second-factor reset (accounts.support). For an account that owns a store the reset is four-eyes (`mfa.reset`): this call
 * only records the request and says "waiting for a second approver"; the reset happens in `executeMfaReset` after a different holder
 * approved the exact payload. A team member without any store-owner role is a single-approver action: it executes here, with the case,
 * the reason and a notice to the previous contact (IAM-15).
 */
export async function requestMfaReset(op: OperatorScope, userId: string, raw: unknown): Promise<SupportOutcome> {
  const i = base.parse(raw);
  const id = userIdSchema.parse(userId);
  await requirePlatformCap(op, "accounts.support");
  await requireAccountTarget(op, id, "accounts.support");
  return governed(op, { capability: "accounts.support", action: "support.reset_mfa", subjectKind: "user", subjectId: id, reasonCode: i.reasonCode, reason: i.reason, case: { ref: i.caseRef, required: true, target: { kind: "user", id } } }, async (tx, c) => {
    const [u] = await tx.select({ email: user.email, name: user.name }).from(user).where(eq(user.id, id));
    if (!u) throw new DomainError("not_found", "Akun tidak ditemukan.");
    const [owner] = await tx.select({ s: membership.storeId }).from(membership).where(and(eq(membership.userId, id), eq(membership.role, "owner"))).limit(1);
    if (!owner) {
      const { row, replayed } = await claimAction(tx, { caseId: c!.id, subjectId: id, actionKind: "reset_mfa", status: "requested", requestedBy: op.userId, idempotencyKey: i.idempotencyKey, reasonCode: i.reasonCode });
      if (replayed) return replayOutcome(row, "mfa_reset_done");
      await resetNow(tx, op, id, "accounts.support");
      await noticeMail(tx, u.email, u.name);
      await finish(tx, row.id, "mfa_reset");
      return { supportActionId: row.id, outcome: "mfa_reset_done" as const, count: null, replayed: false, approvalRequestId: null };
    }
    // Four-eyes: replay first (a replay must not create a second approval request).
    const [prior] = await tx.select({ id: supportAction.id, requestedBy: supportAction.requestedBy, actionKind: supportAction.actionKind, subjectId: supportAction.subjectId, status: supportAction.status, approvalRequestId: supportAction.approvalRequestId, resultCode: supportAction.resultCode }).from(supportAction).where(eq(supportAction.idempotencyKey, i.idempotencyKey));
    if (prior) {
      if (prior.requestedBy !== op.userId || prior.actionKind !== "reset_mfa" || prior.subjectId !== id) throw new DomainError("idempotency_conflict", "Kunci idempotensi ini sudah dipakai untuk tindakan lain.");
      return replayOutcome(prior, prior.status === "executed" ? "mfa_reset_done" : "mfa_reset_awaiting_approval");
    }
    const approval = await requestApproval(withinTx(op, tx), { actionKey: "mfa.reset", targetKind: "user", targetId: id, payload: mfaPayload(id, c!.caseNumber), reason: i.reason });
    const { row } = await claimAction(tx, { caseId: c!.id, subjectId: id, actionKind: "reset_mfa", actionKey: "mfa.reset", status: "awaiting_approval", requestedBy: op.userId, approvalRequestId: approval.id, idempotencyKey: i.idempotencyKey, reasonCode: i.reasonCode });
    return { supportActionId: row.id, outcome: "mfa_reset_awaiting_approval" as const, count: null, replayed: false, approvalRequestId: approval.id };
  });
}

/** The owner-side reset. It re-checks the actor's capability and the target class itself (the service checks them too). */
export async function resetNow(tx: Tx, op: OperatorScope, userId: string, capability: "accounts.support" | "staff.manage"): Promise<number> {
  try {
    const [{ n }] = (await tx.execute(sql`select public.console_reset_user_mfa(${op.userId}, ${userId}, ${capability}) as n`)) as unknown as { n: number }[];
    return n;
  } catch (err) {
    if (pgCode(err) === "42501") throw new DomainError("forbidden", `Akses ditolak: butuh izin ${capability}.`);
    if (pgCode(err) === "P0002") throw new DomainError("not_found", "Akun tidak ditemukan.");
    throw err;
  }
}

/**
 * Execute an approved four-eyes MFA reset. Only the requester can (the approval binds the requester), the approval is consumed in the same
 * transaction by `UPDATE ... WHERE status = 'approved'` (so two executions cannot both succeed and a failed write leaves it unconsumed),
 * and the `support_action` row can become `executed` only because the trigger sees that executed approval. A rejected, expired or
 * cancelled approval cancels the action instead.
 */
export async function executeMfaReset(op: OperatorScope, supportActionId: number): Promise<SupportOutcome> {
  await requirePlatformCap(op, "accounts.support");
  return op.exec.transaction(async (tx) => {
    if (!(await holdsCapability(tx, op.userId, "accounts.support"))) throw new DomainError("forbidden", "Akses ditolak: butuh izin accounts.support.");
    const [a] = await tx.select().from(supportAction).where(and(eq(supportAction.id, supportActionId), eq(supportAction.actionKind, "reset_mfa"), eq(supportAction.requestedBy, op.userId))).for("update");
    if (!a || !a.approvalRequestId) throw new DomainError("not_found", "Permintaan reset tidak ditemukan.");
    if (a.status === "executed") return { supportActionId, outcome: "mfa_reset_done" as const, count: null, replayed: true, approvalRequestId: a.approvalRequestId };
    const [ap] = await tx.select().from(approvalRequest).where(eq(approvalRequest.id, a.approvalRequestId));
    if (!ap || ["rejected", "expired", "cancelled"].includes(ap.status) || (ap.status !== "executed" && ap.expiresAt.getTime() <= Date.now())) {
      // The cancellation is a written outcome, not an error: throwing here would roll the status change back with it.
      await tx.update(supportAction).set({ status: "cancelled", updatedAt: sql`now()` as unknown as Date, resultCode: "approval_not_granted" }).where(and(eq(supportAction.id, supportActionId), eq(supportAction.status, "awaiting_approval")));
      return { supportActionId, outcome: "mfa_reset_cancelled" as const, count: null, replayed: false, approvalRequestId: a.approvalRequestId };
    }
    if (ap.status === "pending") throw new DomainError("awaiting_approval", "Menunggu penyetuju kedua.");
    const payload = JSON.parse(ap.payloadCanonical) as MfaResetPayload;
    if (payload.kind !== "mfa_reset" || payload.userId !== a.subjectId || canonicalPayload(payload) !== ap.payloadCanonical || payloadHash(payload) !== ap.payloadSha256) throw new DomainError("approval_invalid", "Muatan persetujuan tidak cocok.");
    await consumeApproval(tx, op, { approvalId: ap.id, actionKey: "mfa.reset", targetKind: "user", targetId: a.subjectId, payloadSha256: ap.payloadSha256 });
    const [u] = await tx.select({ email: user.email, name: user.name }).from(user).where(eq(user.id, a.subjectId));
    await resetNow(tx, op, a.subjectId, "accounts.support");
    await tx.update(supportAction).set({ status: "approved", updatedAt: sql`now()` as unknown as Date }).where(and(eq(supportAction.id, supportActionId), eq(supportAction.status, "awaiting_approval")));
    await tx.update(supportAction).set({ status: "executed", executedAt: sql`now()` as unknown as Date, resultCode: "mfa_reset", updatedAt: sql`now()` as unknown as Date }).where(and(eq(supportAction.id, supportActionId), eq(supportAction.status, "approved")));
    if (u) await noticeMail(tx, u.email, u.name);
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "accounts.support", action: "support.reset_mfa_execute", subjectKind: "user", subjectId: a.subjectId, caseId: payload.caseNumber, purposeCode: a.reasonCode, accessLevel: "write", outcome: "allowed", reason: `approval:${ap.id}` });
    return { supportActionId, outcome: "mfa_reset_done" as const, count: null, replayed: false, approvalRequestId: ap.id };
  });
}

/**
 * Staff-executed store ownership recovery (`members.recover`, `ownership.recover`) is decided DISABLED in Phase 1 (D-19): locked-out
 * sellers use self-service recovery. The answer is not-found for everyone, with or without the capability, and nothing is written except a
 * denial audit row so an attempt is visible; the four-eyes rule is inactive too, so no approval for it can exist.
 */
export async function recoverStoreOwnership(op: OperatorScope, storeId: number): Promise<never> {
  await op.exec.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "members.recover", action: "operator.denied", subjectKind: "store", subjectId: String(storeId).slice(0, 64), outcome: "denied", reason: "ownership_recovery_disabled_phase1" });
  throw new DomainError("not_found", "Halaman tidak ditemukan.");
}

export type { GovernedCase };

/**
 * Redeem a support recovery link on the APP pool (the identity page cannot read the table): the owner-side function consumes the
 * single-use token and returns the user id once, or null for a wrong, used, expired, suspended-identity or staff link.
 */
export async function redeemSupportRecovery(exec: Executor, token: string): Promise<string | null> {
  const [row] = (await exec.execute(sql`select public.support_recovery_redeem(${token}) as user_id`)) as unknown as { user_id: string | null }[];
  return row?.user_id ?? null;
}
