// PRIV-9 reveal flow and approval-gated break-glass (T-63 slice 4).
// A reveal needs a capability (or an active break-glass grant), a purpose from the capability's map, an OPEN case that concerns the
// target, and a reason. The access-evidence row commits in the same transaction before the value is returned (`withPersonalDataAccess`),
// the value is valid for the reveal window only, and a repeat read after the window shows the masked value again.
// Break-glass is a time-boxed elevation to the allowlisted read and reveal capabilities, approved by a different staff member who holds
// `break_glass.approve`; it never satisfies a four-eyes approval (the approval code reads `operator_grant` only) and every use is an access event.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client.ts";
import { dbMailer } from "../platform/accounts.ts";
import { auditLog, platformOperator, user } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { consumeApproval, canonicalPayload, payloadHash, requestApproval } from "./capabilities-approvals.ts";
import { BREAK_GLASS_ALLOWLIST, requirePlatformCap } from "./capabilities.ts";
import { withPersonalDataAccess } from "./console-access.ts";
import { requireAccountTarget, requireOpenCase, reasonText } from "./accounts-governance.ts";
import { scrubText } from "./ops.ts";
import { approvalRequest, breakGlassGrant, operatorGrant } from "./schema-ops.ts";

/** How long a revealed value stays visible: a named conservative default, not an owner decision (PRIV-9 leaves the number OPEN; D-22 item 3). */
export const REVEAL_WINDOW_SECONDS = (env: NodeJS.ProcessEnv = process.env) => Math.max(1, Number(env.REVEAL_WINDOW_SECONDS) || 300);

const FIELDS = ["email", "name"] as const;
type Field = (typeof FIELDS)[number];
const COLUMN = { email: user.email, name: user.name } as const;

const revealInput = z.strictObject({
  field: z.enum(FIELDS),
  purposeCode: z.string().min(1).max(64),
  caseRef: z.unknown(),
  reason: reasonText,
  /** Use an active break-glass grant instead of a standing `accounts.reveal` grant. */
  breakGlassGrantId: z.number().int().positive().optional(),
});

/**
 * Reveal one protected field of a seller team member for the reveal window (PRIV-9). Refused with no side effect without an open case,
 * a purpose from the capability's map or a reason; refused with a denial audit row without the capability (or a valid break-glass
 * grant for exactly this target and case). The staff identity is never a target.
 */
export async function revealAccountField(op: OperatorScope, kind: string, userId: string, raw: unknown, env: NodeJS.ProcessEnv = process.env): Promise<{ field: Field; value: string; expiresAt: Date }> {
  if (kind !== "seller") throw new DomainError("not_found", "Akun tidak ditemukan.");
  const i = revealInput.parse(raw);
  if (i.breakGlassGrantId === undefined) await requirePlatformCap(op, "accounts.reveal");
  await requireAccountTarget(op, userId, "accounts.reveal");
  const cited = await op.exec.transaction((tx) => requireOpenCase(tx, i.caseRef, { kind: "user", id: userId }));
  const expiresAt = new Date(Date.now() + REVEAL_WINDOW_SECONDS(env) * 1000);
  const value = await withPersonalDataAccess(
    op,
    { capability: "accounts.reveal", targetKind: "user", targetId: userId, fieldClass: i.field, purposeCode: i.purposeCode, caseId: cited.caseNumber, reason: i.reason, accessLevel: "full", expiresAt, breakGlassGrantId: i.breakGlassGrantId },
    (tx) => readField(tx, userId, i.field),
  );
  return { field: i.field, value, expiresAt };
}

async function readField(tx: Tx, userId: string, field: Field): Promise<string> {
  const [row] = await tx.select({ v: COLUMN[field] }).from(user).where(eq(user.id, userId));
  if (!row?.v) throw new DomainError("not_found", "Nilai tidak tersedia.");
  return row.v;
}

/**
 * The fields THIS staff member revealed whose window is still open. Each read is itself a `full` access event bound to the original case,
 * purpose and expiry; once the window ends (or the authority behind it is gone) the field is simply absent and the page shows the mask.
 */
export async function activeRevealedFields(op: OperatorScope, userId: string): Promise<{ field: Field; value: string; expiresAt: Date }[]> {
  const out: { field: Field; value: string; expiresAt: Date }[] = [];
  for (const field of FIELDS) {
    const [w] = (await op.exec.execute(sql`select case_id, purpose_code, expires_at, break_glass_grant_id from public.console_active_reveal(${op.userId}, 'user', ${userId}, ${field})`)) as unknown as { case_id: string | null; purpose_code: string; expires_at: Date | string; break_glass_grant_id: string | null }[];
    if (!w || !w.case_id) continue;
    const expiresAt = new Date(w.expires_at);
    try {
      const value = await withPersonalDataAccess(
        op,
        { capability: "accounts.reveal", targetKind: "user", targetId: userId, fieldClass: field, purposeCode: w.purpose_code, caseId: w.case_id, reason: "pengungkapan masih dalam jendela waktunya", accessLevel: "full", expiresAt, breakGlassGrantId: w.break_glass_grant_id ? Number(w.break_glass_grant_id) : undefined },
        (tx) => readField(tx, userId, field),
      );
      out.push({ field, value, expiresAt });
    } catch (err) {
      if (!(err instanceof DomainError)) throw err; // authority lost (revoked, expired grant) or value gone: masked again
    }
  }
  return out;
}

// ── Break-glass ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const requestInput = z.strictObject({
  userId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  caseRef: z.unknown(),
  capabilities: z.array(z.enum(BREAK_GLASS_ALLOWLIST)).min(1).max(BREAK_GLASS_ALLOWLIST.length),
  /** The window length is the requester's, bounded only by approval; the PRIV-9 maximum is OPEN, so no maximum is invented here. */
  durationSeconds: z.number().int().min(1),
  reason: reasonText,
});

/** The payload the approver reads and the executor must reproduce byte for byte (a changed payload is a new request). */
export interface BreakGlassPayload {
  kind: "break_glass";
  caseNumber: string;
  userId: string;
  capabilities: string[];
  durationSeconds: number;
}
export const breakGlassPayload = (p: { caseNumber: string; userId: string; capabilities: readonly string[]; durationSeconds: number }): BreakGlassPayload => ({ kind: "break_glass", caseNumber: p.caseNumber, userId: p.userId, capabilities: [...p.capabilities].sort(), durationSeconds: p.durationSeconds });

/** The OperatorScope of the same operator on an open transaction: a service that opens its own transaction then joins this one as a savepoint. */
export const withinTx = (op: OperatorScope, tx: Tx): OperatorScope => ({ ...op, exec: tx }) as OperatorScope;

/** Ask a second `break_glass.approve` holder to approve an elevation (four-eyes `breakglass.approve`). Nothing is granted by asking. */
export async function requestBreakGlass(op: OperatorScope, raw: unknown): Promise<{ approvalId: number; payloadSha256: string; expiresAt: Date }> {
  await requirePlatformCap(op, "break_glass.approve");
  const i = requestInput.parse(raw);
  await requireAccountTarget(op, i.userId, "break_glass.approve");
  return op.exec.transaction(async (tx) => {
    const cited = await requireOpenCase(tx, i.caseRef, { kind: "user", id: i.userId });
    const payload = breakGlassPayload({ caseNumber: cited.caseNumber, userId: i.userId, capabilities: i.capabilities, durationSeconds: i.durationSeconds });
    const r = await requestApproval(withinTx(op, tx), { actionKey: "breakglass.approve", targetKind: "user", targetId: i.userId, payload, reason: i.reason });
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "break_glass.approve", action: "break_glass.request", subjectKind: "user", subjectId: i.userId, caseId: cited.caseNumber, accessLevel: "write", outcome: "allowed", reason: scrubText(`approval:${r.id}`) });
    return { approvalId: r.id, payloadSha256: r.payloadSha256, expiresAt: r.expiresAt };
  });
}

/**
 * The requester executes what a different holder approved: the approval is consumed, the grant window starts now, every audit-capability
 * holder gets a notice (in the same transaction: a grant whose notice cannot be queued is not made) and the grant row is inserted.
 */
export async function activateBreakGlass(op: OperatorScope, approvalId: number): Promise<{ grantId: number; startsAt: Date; expiresAt: Date }> {
  await requirePlatformCap(op, "break_glass.approve");
  return op.exec.transaction(async (tx) => {
    const [a] = await tx.select().from(approvalRequest).where(and(eq(approvalRequest.id, approvalId), eq(approvalRequest.actionKey, "breakglass.approve"), eq(approvalRequest.requestedBy, op.userId)));
    if (!a) throw new DomainError("approval_invalid", "Persetujuan tidak ditemukan atau bukan milik Anda.");
    const p = JSON.parse(a.payloadCanonical) as BreakGlassPayload;
    // The stored text is what was approved; it must still be a break-glass payload that hashes to the approved value.
    if (p.kind !== "break_glass" || canonicalPayload(p) !== a.payloadCanonical || payloadHash(p) !== a.payloadSha256) throw new DomainError("approval_invalid", "Muatan persetujuan tidak cocok.");
    const { decidedBy } = await consumeApproval(tx, op, { approvalId, actionKey: "breakglass.approve", targetKind: "user", targetId: a.targetId, payloadSha256: a.payloadSha256 });
    const cited = await requireOpenCase(tx, p.caseNumber, { kind: "user", id: p.userId });
    const [g] = await tx
      .insert(breakGlassGrant)
      .values({
        requestedBy: op.userId,
        approvedBy: decidedBy,
        capabilities: p.capabilities,
        targetKind: "user",
        targetId: p.userId,
        caseId: cited.caseNumber,
        reason: scrubText(a.reason, 500),
        startsAt: sql`now()` as unknown as Date,
        expiresAt: sql`now() + make_interval(secs => ${p.durationSeconds})` as unknown as Date,
      })
      .returning({ id: breakGlassGrant.id, startsAt: breakGlassGrant.startsAt, expiresAt: breakGlassGrant.expiresAt });
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "break_glass.approve", action: "break_glass.grant", subjectKind: "user", subjectId: p.userId, caseId: cited.caseNumber, accessLevel: "write", outcome: "allowed", reason: `grant:${g!.id} approval:${approvalId}` });
    // Every holder of audit.read is told at grant time (ids and times only: no contact, no reason text).
    const holders = await tx
      .selectDistinct({ email: user.email })
      .from(operatorGrant)
      .innerJoin(platformOperator, eq(platformOperator.userId, operatorGrant.userId))
      .innerJoin(user, eq(user.id, operatorGrant.userId))
      .where(and(eq(operatorGrant.capability, "audit.read"), isNull(platformOperator.deactivatedAt), sql`(${operatorGrant.expiresAt} is null or ${operatorGrant.expiresAt} > now())`));
    const mailer = dbMailer(tx);
    for (const h of holders) {
      await mailer.send({
        to: h.email,
        subject: `Akses darurat #${g!.id} diberikan`,
        text: [`Akses darurat #${g!.id} untuk kasus ${cited.caseNumber} diberikan.`, `Peminta: ${op.userId}; penyetuju: ${decidedBy}.`, `Berlaku sampai ${g!.expiresAt.toISOString()}.`, "Tinjau di Owner console setelah akses berakhir."].join("\n"),
      });
    }
    return { grantId: g!.id, startsAt: g!.startsAt, expiresAt: g!.expiresAt };
  });
}

export type BreakGlassState = "active" | "expired" | "revoked";
export interface BreakGlassView {
  id: number;
  requestedBy: string;
  approvedBy: string;
  capabilities: string[];
  targetKind: string;
  targetId: string;
  caseId: string;
  reason: string;
  startsAt: Date;
  expiresAt: Date;
  state: BreakGlassState;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}
const view = (g: typeof breakGlassGrant.$inferSelect): BreakGlassView => ({
  id: g.id,
  requestedBy: g.requestedBy,
  approvedBy: g.approvedBy,
  capabilities: g.capabilities,
  targetKind: g.targetKind,
  targetId: g.targetId,
  caseId: g.caseId,
  reason: scrubText(g.reason, 500),
  startsAt: g.startsAt,
  expiresAt: g.expiresAt,
  state: g.revokedAt ? "revoked" : g.expiresAt.getTime() <= Date.now() ? "expired" : "active",
  reviewedBy: g.reviewedBy,
  reviewedAt: g.reviewedAt,
});

/** Grants the holder may see: their own requests and approvals (break_glass.approve). */
export async function listBreakGlass(op: OperatorScope): Promise<BreakGlassView[]> {
  await requirePlatformCap(op, "break_glass.approve");
  const rows = await op.exec.select().from(breakGlassGrant).orderBy(desc(breakGlassGrant.id)).limit(50);
  return rows.map(view);
}

/** Ended grants nobody has reviewed yet, for the access review (access.review). The review deadline is OPEN, so none is shown. */
export async function breakGlassReviewQueue(op: OperatorScope): Promise<BreakGlassView[]> {
  await requirePlatformCap(op, "access.review");
  const rows = await op.exec.select().from(breakGlassGrant).where(and(isNull(breakGlassGrant.reviewedAt), sql`(${breakGlassGrant.revokedAt} is not null or ${breakGlassGrant.expiresAt} <= now())`)).orderBy(desc(breakGlassGrant.id)).limit(50);
  return rows.map(view);
}

/** End a grant early (break_glass.approve). Revoked once; the guard trigger refuses a second revocation. */
export async function revokeBreakGlass(op: OperatorScope, grantId: number): Promise<void> {
  await requirePlatformCap(op, "break_glass.approve");
  await op.exec.transaction(async (tx) => {
    const done = await tx.update(breakGlassGrant).set({ revokedAt: sql`now()` as unknown as Date }).where(and(eq(breakGlassGrant.id, grantId), isNull(breakGlassGrant.revokedAt), sql`${breakGlassGrant.expiresAt} > now()`)).returning({ id: breakGlassGrant.id });
    if (done.length === 0) throw new DomainError("conflict", "Akses darurat tidak ada, sudah berakhir, atau sudah dicabut.");
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "break_glass.approve", action: "break_glass.revoke", subjectKind: "break_glass", subjectId: String(grantId), accessLevel: "write", outcome: "allowed", reason: `grant:${grantId}` });
  });
}

/** The review record after an elevation ended (access.review). The requester never reviews their own elevation; one review per grant. */
export async function reviewBreakGlass(op: OperatorScope, grantId: number): Promise<void> {
  await requirePlatformCap(op, "access.review");
  await op.exec.transaction(async (tx) => {
    const done = await tx
      .update(breakGlassGrant)
      .set({ reviewedBy: op.userId, reviewedAt: sql`now()` as unknown as Date })
      .where(and(eq(breakGlassGrant.id, grantId), isNull(breakGlassGrant.reviewedAt), sql`${breakGlassGrant.requestedBy} <> ${op.userId}`, sql`(${breakGlassGrant.revokedAt} is not null or ${breakGlassGrant.expiresAt} <= now())`))
      .returning({ id: breakGlassGrant.id });
    if (done.length === 0) throw new DomainError("conflict", "Akses darurat belum berakhir, sudah ditinjau, atau Anda peminta aslinya.");
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "access.review", action: "break_glass.review", subjectKind: "break_glass", subjectId: String(grantId), accessLevel: "write", outcome: "allowed", reason: `grant:${grantId}` });
  });
}
