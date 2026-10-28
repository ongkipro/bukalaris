import { and, eq, sql } from "drizzle-orm";
import type { Executor, Tx } from "../client.ts";
import { auditLog } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { BREAK_GLASS_ALLOWLIST, holdsCapability, requirePlatformCap } from "./capabilities.ts";
import { scrubText } from "./ops.ts";
import { breakGlassGrant, type PlatformCapability } from "./schema-ops.ts";
export type AccessEvidence = { capability: PlatformCapability; targetKind: string; targetId: string; fieldClass: "tax_identity" | "bank" | "phone" | "email" | "name" | "address" | "verification_evidence" | "buyer_store_links"; purposeCode: string; caseId?: string; reason: string; accessLevel: "masked" | "full" | "export"; expiresAt?: Date; breakGlassGrantId?: number };

/**
 * PRIV-9 purpose catalogue: a fixed list, and each console capability may use only the purposes mapped to it. A capability that is
 * not listed here keeps the earlier rule (any non-empty purpose); the Phase 2 purposes (`legal_request`, `privacy_request`,
 * `incident_response`, `tax_filing_export`) are in no startup mapping.
 */
export const PURPOSES_BY_CAPABILITY: Partial<Record<PlatformCapability, readonly string[]>> = {
  "accounts.read": ["support_case", "fraud_or_abuse_review", "verification_review"],
  "accounts.reveal": ["support_case", "fraud_or_abuse_review", "verification_review"],
  "accounts.support": ["support_case"],
  "accounts.suspend": ["support_case", "fraud_or_abuse_review"],
  "tenants.verify": ["verification_review"],
  "tenants.read": ["support_case", "fraud_or_abuse_review"],
};

/** The row of an active break-glass grant if `userId` may use it for exactly this evidence; otherwise a refusal. */
async function validBreakGlass(exec: Executor, userId: string, grantId: number, e: AccessEvidence, lock: boolean) {
  const q = exec
    .select()
    .from(breakGlassGrant)
    .where(and(eq(breakGlassGrant.id, grantId), eq(breakGlassGrant.requestedBy, userId), sql`${breakGlassGrant.revokedAt} is null`, sql`${breakGlassGrant.startsAt} <= now()`, sql`${breakGlassGrant.expiresAt} > now()`));
  const [g] = await (lock ? q.for("share") : q);
  const refuse = () => new DomainError("forbidden", "Akses darurat tidak berlaku: tidak ada, bukan milik Anda, belum mulai, kedaluwarsa, dicabut, atau untuk target lain.");
  // Break-glass confers only the allowlisted read and reveal capabilities, for the one target and case it was approved for.
  if (!g || !(BREAK_GLASS_ALLOWLIST as readonly string[]).includes(e.capability) || !g.capabilities.includes(e.capability)) throw refuse();
  if (g.targetKind !== e.targetKind || g.targetId !== e.targetId || (e.caseId ?? null) !== g.caseId) throw refuse();
  return g;
}

/** The returned value cannot escape until the transaction containing its access evidence commits. */
export async function withPersonalDataAccess<T>(op: OperatorScope, evidence: AccessEvidence, load: (tx: Tx) => Promise<T>): Promise<T> {
  const viaBreakGlass = evidence.breakGlassGrantId !== undefined;
  if (viaBreakGlass) {
    // A refusal writes its denial row on the pool, before the transaction, so it survives the refusal (like `requirePlatformCap`).
    try {
      await validBreakGlass(op.exec, op.userId, evidence.breakGlassGrantId!, evidence, false);
    } catch (err) {
      await op.exec.insert(auditLog).values({ actorUserId: op.userId, action: "operator.denied", actorCapability: evidence.capability, subjectKind: evidence.targetKind, subjectId: evidence.targetId.slice(0, 200), outcome: "denied", reason: `break_glass:${evidence.breakGlassGrantId}` });
      throw err;
    }
  } else await requirePlatformCap(op, evidence.capability);
  if (!evidence.purposeCode.trim() || !evidence.reason.trim()) throw new DomainError("purpose_required", "Tujuan dan alasan wajib diisi.");
  const allowedPurposes = PURPOSES_BY_CAPABILITY[evidence.capability];
  if (allowedPurposes && !allowedPurposes.includes(evidence.purposeCode)) throw new DomainError("purpose_not_allowed", "Tujuan ini tidak diizinkan untuk izin yang dipakai.");
  if (evidence.accessLevel !== "masked" && (!evidence.caseId || !evidence.expiresAt || evidence.expiresAt <= new Date())) throw new DomainError("purpose_required", "Kasus dan waktu kedaluwarsa wajib untuk akses penuh.");
  if (evidence.accessLevel !== "masked" && !["accounts.reveal", "payouts.process", "refunds.process", "affiliate.payout.process", "tax.identity.review"].includes(evidence.capability)) throw new DomainError("forbidden", "Izin ini tidak boleh mengungkap data pribadi.");
  return op.exec.transaction(async (tx) => {
    // The authority is checked inside the transaction too, before the evidence row and again after the load: a grant revoked
    // meanwhile (another request, committed) or a break-glass grant that expired or was revoked aborts the whole read, so the
    // evidence row rolls back with it and the value never leaves.
    const stillAllowed = async () => {
      if (viaBreakGlass) await validBreakGlass(tx, op.userId, evidence.breakGlassGrantId!, evidence, true);
      else if (!(await holdsCapability(tx, op.userId, evidence.capability))) throw new DomainError("forbidden", `Akses ditolak: butuh izin ${evidence.capability}.`);
    };
    await stillAllowed();
    await tx.execute(sql`select public.console_record_access(${op.userId}, ${evidence.targetKind}, ${evidence.targetId}, ${evidence.fieldClass}, ${evidence.purposeCode}, ${evidence.caseId ?? null}, ${scrubText(evidence.reason)}, ${evidence.accessLevel}, ${evidence.expiresAt?.toISOString() ?? null}::timestamptz, ${evidence.breakGlassGrantId ?? null}::bigint)`);
    const value = await load(tx);
    await stillAllowed();
    return value;
  });
}
