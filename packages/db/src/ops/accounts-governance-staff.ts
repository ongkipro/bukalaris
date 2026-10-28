// SA-38 staff and access, SA-39 access reviews (T-62 slice 3 deferred here; IAM-15, IAM-9).
// Staff identities are managed only through `staff.manage` (never `accounts.*`). Deactivation revokes grants, pending requests and
// sessions in ONE transaction; the last active holder of `staff.manage` or `break_glass.approve` cannot be removed (rows locked in key
// order, so of two simultaneous removals one aborts); nobody changes their own grants; a sensitive grant needs the approval of T-60.
// Staff invitation and account creation need the separate operator identity tables of T-59b and are NOT built here (DEFERRED).
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { accessReviewDecision, supportAction } from "./schema-governance.ts";
import { auditLog, platformOperator, session, user } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { dbMailer } from "../platform/accounts.ts";
import { canonicalPayload, consumeApproval, payloadHash, requestApproval } from "./capabilities-approvals.ts";
import { grantCapability, revokeCapability } from "./capabilities-grants.ts";
import { holdsCapability, requirePlatformCap } from "./capabilities.ts";
import { governed, idempotencyKey, reasonCode, reasonText } from "./accounts-governance.ts";
import { withinTx } from "./accounts-governance-reveal.ts";
import { resetNow } from "./accounts-governance-support.ts";
import { approvalRequest, LAST_HOLDER_PROTECTED, operatorGrant, operatorGrantEvent, PLATFORM_CAPABILITIES, type PlatformCapability } from "./schema-ops.ts";

const staffId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "ID staf tidak valid.");
const capabilityName = z.string().refine((c): c is PlatformCapability => (PLATFORM_CAPABILITIES as readonly string[]).includes(c), "Izin tidak dikenal.");
const why = z.strictObject({ reasonCode, reason: reasonText });

export interface StaffRow {
  userId: string;
  email: string;
  name: string;
  status: "active" | "deactivated";
  mfaEnrolled: boolean;
  /** Newest live session; sessions that ended leave no trace, so this is "newest known session". */
  lastSessionAt: Date | null;
  grants: { capability: string; expiresAt: Date | null; lastUsedAt: Date | null }[];
}

/** Staff list (staff.read): status, MFA enrolled yes or no, newest session and the grants with their last use. */
export async function staffList(op: OperatorScope): Promise<StaffRow[]> {
  await requirePlatformCap(op, "staff.read");
  const ops = await op.exec
    .select({ userId: platformOperator.userId, email: user.email, name: user.name, deactivatedAt: platformOperator.deactivatedAt, mfa: user.twoFactorEnabled })
    .from(platformOperator)
    .innerJoin(user, eq(user.id, platformOperator.userId))
    .orderBy(asc(user.email));
  const [grants, sessions] = await Promise.all([
    op.exec.select({ userId: operatorGrant.userId, capability: operatorGrant.capability, expiresAt: operatorGrant.expiresAt, lastUsedAt: operatorGrant.lastUsedAt }).from(operatorGrant).where(sql`${operatorGrant.expiresAt} is null or ${operatorGrant.expiresAt} > now()`).orderBy(asc(operatorGrant.capability)),
    op.exec.select({ userId: session.userId, newest: sql<Date | string | null>`max(${session.createdAt})` }).from(session).where(sql`${session.expiresAt} > now() and ${session.userId} in (select user_id from platform_operator)`).groupBy(session.userId),
  ]);
  return ops.map((o) => ({
    userId: o.userId,
    email: o.email,
    name: o.name,
    status: o.deactivatedAt ? ("deactivated" as const) : ("active" as const),
    mfaEnrolled: o.mfa,
    lastSessionAt: (() => {
      const n = sessions.find((s) => s.userId === o.userId)?.newest;
      return n ? new Date(n) : null;
    })(),
    grants: grants.filter((g) => g.userId === o.userId).map(({ capability, expiresAt, lastUsedAt }) => ({ capability, expiresAt, lastUsedAt })),
  }));
}

export interface StaffDetail extends StaffRow {
  events: { id: number; capability: string; action: string; source: string; actorUserId: string | null; reason: string; createdAt: Date }[];
  openRequests: { id: number; actionKey: string; status: string; expiresAt: Date }[];
  /** Staff MFA resets still waiting: `approvalStatus` is `approved` once a second holder decided, and only the requester can then execute. */
  pendingMfaResets: { supportActionId: number; requestedBy: string; approvalStatus: string | null }[];
}
export async function staffDetail(op: OperatorScope, userId: string): Promise<StaffDetail | null> {
  const id = staffId.parse(userId);
  const row = (await staffList(op)).find((s) => s.userId === id);
  if (!row) return null;
  const [events, openRequests, pendingMfaResets] = await Promise.all([
    op.exec.select({ id: operatorGrantEvent.id, capability: operatorGrantEvent.capability, action: operatorGrantEvent.action, source: operatorGrantEvent.source, actorUserId: operatorGrantEvent.actorUserId, reason: operatorGrantEvent.reason, createdAt: operatorGrantEvent.createdAt }).from(operatorGrantEvent).where(eq(operatorGrantEvent.operatorUserId, id)).orderBy(desc(operatorGrantEvent.id)).limit(30),
    op.exec.select({ id: approvalRequest.id, actionKey: approvalRequest.actionKey, status: approvalRequest.status, expiresAt: approvalRequest.expiresAt }).from(approvalRequest).where(and(eq(approvalRequest.requestedBy, id), inArray(approvalRequest.status, ["pending", "approved"]))).orderBy(desc(approvalRequest.id)).limit(20),
    op.exec
      .select({ supportActionId: supportAction.id, requestedBy: supportAction.requestedBy, approvalStatus: approvalRequest.status })
      .from(supportAction)
      .leftJoin(approvalRequest, eq(approvalRequest.id, supportAction.approvalRequestId))
      .where(and(eq(supportAction.subjectId, id), eq(supportAction.actionKey, "staff.mfa_reset"), eq(supportAction.status, "awaiting_approval"))),
  ]);
  return { ...row, events, openRequests, pendingMfaResets };
}

const refuseSelf = (op: OperatorScope, target: string) => {
  if (op.userId === target) throw new DomainError("self_change", "Staf tidak dapat mengubah izin atau status dirinya sendiri.");
};

/** Grant (staff.manage). Self-grant is refused; a sensitive capability still needs the approved `grant.sensitive` request of T-60. */
export async function grantStaffCapability(op: OperatorScope, raw: unknown): Promise<void> {
  const i = z.object({ userId: staffId, capability: capabilityName, reason: reasonText, expiresAt: z.date().optional(), approvalRequestId: z.number().int().positive().optional() }).parse(raw);
  await requirePlatformCap(op, "staff.manage");
  refuseSelf(op, i.userId);
  await grantCapability(op, i);
}
/** Revoke (staff.manage). Self-revoke is refused; last-holder protection and request cancellation are the T-60 service's. */
export async function revokeStaffCapability(op: OperatorScope, raw: unknown): Promise<void> {
  const i = z.object({ userId: staffId, capability: capabilityName, reason: reasonText }).parse(raw);
  await requirePlatformCap(op, "staff.manage");
  refuseSelf(op, i.userId);
  await revokeCapability(op, i);
}

/**
 * Deactivate a staff member (staff.manage): all grants (with their `operator_grant_event` rows), the operator's open approval requests
 * and all sessions go in one transaction, and `platform_operator.deactivated_at` makes `operatorScope` return null from then on. The last
 * standing holder of `staff.manage` or `break_glass.approve` cannot be deactivated. The row stays: a deactivated operator is still staff
 * and therefore never an `accounts.*` target.
 */
export async function deactivateStaff(op: OperatorScope, userId: string, raw: unknown): Promise<{ revokedGrants: number; endedSessions: number }> {
  const w = why.parse(raw);
  const id = staffId.parse(userId);
  await requirePlatformCap(op, "staff.manage");
  refuseSelf(op, id);
  return governed(op, { capability: "staff.manage", action: "staff.deactivate", subjectKind: "staff", subjectId: id, reasonCode: w.reasonCode, reason: w.reason }, async (tx) => {
    for (const capability of LAST_HOLDER_PROTECTED) {
      const holders = await tx.select({ userId: operatorGrant.userId, standing: sql<boolean>`(${operatorGrant.expiresAt} is null)` }).from(operatorGrant).where(eq(operatorGrant.capability, capability)).orderBy(asc(operatorGrant.userId)).for("update");
      if (holders.some((h) => h.userId === id) && !holders.some((h) => h.userId !== id && h.standing)) throw new DomainError("last_holder", `Pemegang aktif terakhir izin ${capability} tidak dapat dinonaktifkan.`);
    }
    const [target] = await tx.select({ userId: platformOperator.userId, deactivatedAt: platformOperator.deactivatedAt }).from(platformOperator).where(eq(platformOperator.userId, id)).for("update");
    if (!target) throw new DomainError("not_found", "Staf tidak ditemukan.");
    if (target.deactivatedAt) throw new DomainError("conflict", "Staf sudah dinonaktifkan.");
    const gone = await tx.delete(operatorGrant).where(eq(operatorGrant.userId, id)).returning({ capability: operatorGrant.capability });
    if (gone.length > 0) await tx.insert(operatorGrantEvent).values(gone.map((g) => ({ operatorUserId: id, capability: g.capability, action: "revoke" as const, source: "product" as const, actorUserId: op.userId, reason: `deaktivasi: ${w.reason}` })));
    await tx.update(approvalRequest).set({ status: "cancelled" }).where(and(eq(approvalRequest.requestedBy, id), inArray(approvalRequest.status, ["pending", "approved"])));
    const ended = await tx.delete(session).where(eq(session.userId, id)).returning({ id: session.id });
    await tx.update(platformOperator).set({ deactivatedAt: sql`now()` as unknown as Date }).where(eq(platformOperator.userId, id));
    return { revokedGrants: gone.length, endedSessions: ended.length };
  });
}

/** Reactivate (staff.manage). Grants are not restored: each capability is granted again through the normal, audited path. */
export async function reactivateStaff(op: OperatorScope, userId: string, raw: unknown): Promise<void> {
  const w = why.parse(raw);
  const id = staffId.parse(userId);
  await requirePlatformCap(op, "staff.manage");
  refuseSelf(op, id);
  await governed(op, { capability: "staff.manage", action: "staff.reactivate", subjectKind: "staff", subjectId: id, reasonCode: w.reasonCode, reason: w.reason }, async (tx) => {
    const done = await tx.update(platformOperator).set({ deactivatedAt: null }).where(and(eq(platformOperator.userId, id), sql`${platformOperator.deactivatedAt} is not null`)).returning({ id: platformOperator.userId });
    if (done.length === 0) throw new DomainError("conflict", "Staf tidak sedang dinonaktifkan atau tidak ditemukan.");
  });
}

/** End every session of a staff member (staff.manage). */
export async function revokeStaffSessions(op: OperatorScope, userId: string, raw: unknown): Promise<number> {
  const w = why.parse(raw);
  const id = staffId.parse(userId);
  await requirePlatformCap(op, "staff.manage");
  refuseSelf(op, id);
  return governed(op, { capability: "staff.manage", action: "staff.revoke_sessions", subjectKind: "staff", subjectId: id, reasonCode: w.reasonCode, reason: w.reason }, async (tx) => {
    const [t] = await tx.select({ id: platformOperator.userId }).from(platformOperator).where(eq(platformOperator.userId, id));
    if (!t) throw new DomainError("not_found", "Staf tidak ditemukan.");
    return (await tx.delete(session).where(eq(session.userId, id)).returning({ id: session.id })).length;
  });
}

// ── Staff MFA reset: staff.manage with four-eyes (`staff.mfa_reset`), never through accounts.* ───────────────────────────
export interface StaffMfaPayload {
  kind: "staff_mfa_reset";
  userId: string;
}
const staffMfaPayload = (userId: string): StaffMfaPayload => ({ kind: "staff_mfa_reset", userId });
export interface StaffMfaOutcome {
  supportActionId: number;
  outcome: "mfa_reset_awaiting_approval" | "mfa_reset_done" | "mfa_reset_cancelled";
  approvalRequestId: number | null;
  replayed: boolean;
}

/** Request a staff member's MFA reset (staff.manage). Records the request only; a second `staff.manage` holder approves the exact payload. */
export async function requestStaffMfaReset(op: OperatorScope, userId: string, raw: unknown): Promise<StaffMfaOutcome> {
  const i = why.extend({ idempotencyKey }).parse(raw);
  const id = staffId.parse(userId);
  await requirePlatformCap(op, "staff.manage");
  refuseSelf(op, id);
  return governed(op, { capability: "staff.manage", action: "staff.mfa_reset_request", subjectKind: "staff", subjectId: id, reasonCode: i.reasonCode, reason: i.reason }, async (tx) => {
    const [t] = await tx.select({ id: platformOperator.userId }).from(platformOperator).where(eq(platformOperator.userId, id));
    if (!t) throw new DomainError("not_found", "Staf tidak ditemukan.");
    const [prior] = await tx.select().from(supportAction).where(eq(supportAction.idempotencyKey, i.idempotencyKey));
    if (prior) {
      if (prior.requestedBy !== op.userId || prior.actionKind !== "reset_mfa" || prior.subjectId !== id) throw new DomainError("idempotency_conflict", "Kunci idempotensi ini sudah dipakai untuk tindakan lain.");
      return { supportActionId: prior.id, outcome: prior.status === "executed" ? ("mfa_reset_done" as const) : ("mfa_reset_awaiting_approval" as const), approvalRequestId: prior.approvalRequestId, replayed: true };
    }
    const approval = await requestApproval(withinTx(op, tx), { actionKey: "staff.mfa_reset", targetKind: "staff", targetId: id, payload: staffMfaPayload(id), reason: i.reason });
    const [row] = await tx.insert(supportAction).values({ caseId: null, subjectKind: "user", subjectId: id, actionKind: "reset_mfa", actionKey: "staff.mfa_reset", status: "awaiting_approval", requestedBy: op.userId, approvalRequestId: approval.id, idempotencyKey: i.idempotencyKey, reasonCode: i.reasonCode }).returning({ id: supportAction.id });
    return { supportActionId: row!.id, outcome: "mfa_reset_awaiting_approval" as const, approvalRequestId: approval.id, replayed: false };
  });
}

/** Execute the approved staff MFA reset: the requester only, the approval consumed in the same transaction, the staff member's factor and sessions removed, a notice mailed. */
export async function executeStaffMfaReset(op: OperatorScope, supportActionId: number): Promise<StaffMfaOutcome> {
  await requirePlatformCap(op, "staff.manage");
  return op.exec.transaction(async (tx) => {
    if (!(await holdsCapability(tx, op.userId, "staff.manage"))) throw new DomainError("forbidden", "Akses ditolak: butuh izin staff.manage.");
    const [a] = await tx.select().from(supportAction).where(and(eq(supportAction.id, supportActionId), eq(supportAction.actionKey, "staff.mfa_reset"), eq(supportAction.requestedBy, op.userId))).for("update");
    if (!a || !a.approvalRequestId) throw new DomainError("not_found", "Permintaan reset tidak ditemukan.");
    if (a.status === "executed") return { supportActionId, outcome: "mfa_reset_done" as const, approvalRequestId: a.approvalRequestId, replayed: true };
    const [ap] = await tx.select().from(approvalRequest).where(eq(approvalRequest.id, a.approvalRequestId));
    if (!ap || ["rejected", "expired", "cancelled"].includes(ap.status) || ap.expiresAt.getTime() <= Date.now()) {
      await tx.update(supportAction).set({ status: "cancelled", resultCode: "approval_not_granted", updatedAt: sql`now()` as unknown as Date }).where(and(eq(supportAction.id, supportActionId), eq(supportAction.status, "awaiting_approval")));
      return { supportActionId, outcome: "mfa_reset_cancelled" as const, approvalRequestId: a.approvalRequestId, replayed: false };
    }
    if (ap.status === "pending") throw new DomainError("awaiting_approval", "Menunggu penyetuju kedua.");
    const payload = JSON.parse(ap.payloadCanonical) as StaffMfaPayload;
    if (payload.kind !== "staff_mfa_reset" || payload.userId !== a.subjectId || canonicalPayload(payload) !== ap.payloadCanonical || payloadHash(payload) !== ap.payloadSha256) throw new DomainError("approval_invalid", "Muatan persetujuan tidak cocok.");
    await consumeApproval(tx, op, { approvalId: ap.id, actionKey: "staff.mfa_reset", targetKind: "staff", targetId: a.subjectId, payloadSha256: ap.payloadSha256 });
    const [u] = await tx.select({ email: user.email, name: user.name }).from(user).where(eq(user.id, a.subjectId));
    await resetNow(tx, op, a.subjectId, "staff.manage");
    await tx.update(supportAction).set({ status: "approved", updatedAt: sql`now()` as unknown as Date }).where(and(eq(supportAction.id, supportActionId), eq(supportAction.status, "awaiting_approval")));
    await tx.update(supportAction).set({ status: "executed", executedAt: sql`now()` as unknown as Date, resultCode: "mfa_reset", updatedAt: sql`now()` as unknown as Date }).where(and(eq(supportAction.id, supportActionId), eq(supportAction.status, "approved")));
    if (u) await dbMailer(tx).send({ to: u.email, subject: "Verifikasi dua langkah akun staf direset", text: `Halo ${u.name},\nVerifikasi dua langkah akun staf Anda direset. Daftarkan lagi saat masuk berikutnya.` });
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "staff.manage", action: "staff.mfa_reset_execute", subjectKind: "staff", subjectId: a.subjectId, purposeCode: a.reasonCode, accessLevel: "write", outcome: "allowed", reason: `approval:${ap.id}` });
    return { supportActionId, outcome: "mfa_reset_done" as const, approvalRequestId: ap.id, replayed: false };
  });
}

// ── SA-39 access review ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface AccessReviewRow {
  operatorUserId: string;
  email: string;
  capability: string;
  grantedAt: Date;
  expiresAt: Date | null;
  /** NULL = never used since last-use tracking began (a real source: `operator_grant.last_used_at`, written when a console operation passes the capability check). */
  lastUsedAt: Date | null;
  source: string | null;
  lastDecision: { decision: string; at: Date; by: string } | null;
  own: boolean;
}
/** Every standing or timed grant of every active staff member with its last use, for the reviewer to confirm or revoke (access.review). */
export async function accessReviewList(op: OperatorScope): Promise<AccessReviewRow[]> {
  await requirePlatformCap(op, "access.review");
  const rows = await op.exec
    .select({
      operatorUserId: operatorGrant.userId,
      email: user.email,
      capability: operatorGrant.capability,
      grantedAt: operatorGrant.createdAt,
      expiresAt: operatorGrant.expiresAt,
      lastUsedAt: operatorGrant.lastUsedAt,
      source: sql<string | null>`(select e.source from operator_grant_event e where e.operator_user_id = ${operatorGrant.userId} and e.capability = ${operatorGrant.capability} and e.action = 'grant' order by e.id desc limit 1)`,
    })
    .from(operatorGrant)
    .innerJoin(platformOperator, eq(platformOperator.userId, operatorGrant.userId))
    .innerJoin(user, eq(user.id, operatorGrant.userId))
    .where(and(isNull(platformOperator.deactivatedAt), sql`(${operatorGrant.expiresAt} is null or ${operatorGrant.expiresAt} > now())`))
    .orderBy(asc(user.email), asc(operatorGrant.capability));
  const decisions = await op.exec.select().from(accessReviewDecision).orderBy(desc(accessReviewDecision.id)).limit(500);
  return rows.map((r) => {
    const d = decisions.find((x) => x.operatorUserId === r.operatorUserId && x.capability === r.capability);
    return { ...r, lastDecision: d ? { decision: d.decision, at: d.createdAt, by: d.reviewerUserId } : null, own: r.operatorUserId === op.userId };
  });
}

/**
 * Confirm or revoke one grant (access.review). Confirming never covers the reviewer's own grants (CHECK `reviewer <> operator`).
 * Revoking also needs `staff.manage` and goes through the T-60 revoke (last-holder protection, request cancellation, session removal) in
 * the same transaction as the decision row, so a refused revoke leaves no "revoked" decision behind.
 */
export async function reviewGrant(op: OperatorScope, raw: unknown): Promise<void> {
  const i = z.strictObject({ operatorUserId: staffId, capability: capabilityName, decision: z.enum(["confirmed", "revoked"]), reason: reasonText }).parse(raw);
  await requirePlatformCap(op, "access.review");
  if (i.decision === "revoked") await requirePlatformCap(op, "staff.manage");
  refuseSelf(op, i.operatorUserId);
  await governed(op, { capability: "access.review", action: `access_review.${i.decision}`, subjectKind: "staff", subjectId: i.operatorUserId, reasonCode: `grant_${i.decision}`, reason: `${i.capability}: ${i.reason}` }, async (tx) => {
    const [g] = await tx.select().from(operatorGrant).where(and(eq(operatorGrant.userId, i.operatorUserId), eq(operatorGrant.capability, i.capability))).for("update");
    if (!g) throw new DomainError("not_found", "Izin tidak ditemukan (mungkin sudah dicabut).");
    await tx.insert(accessReviewDecision).values({ reviewerUserId: op.userId, operatorUserId: i.operatorUserId, capability: i.capability, decision: i.decision, lastUsedAt: g.lastUsedAt, grantCreatedAt: g.createdAt, reason: i.reason });
    if (i.decision === "revoked") await revokeCapability(withinTx(op, tx), { userId: i.operatorUserId, capability: i.capability, reason: `review akses: ${i.reason}` });
  });
}
