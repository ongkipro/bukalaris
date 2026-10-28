// Granting and revoking Owner console capabilities (T-60, IAM-15, D-21). Every change writes its `operator_grant_event`
// and revokes the affected operator's sessions in the same transaction, so a stale session never keeps old powers and
// the audit trail can never miss a change.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Tx } from "../client.ts";
import { platformOperator, session } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { holdsCapability, pgCode, requirePlatformCap } from "./capabilities.ts";
import { consumeApproval, payloadHash } from "./capabilities-approvals.ts";
import {
  CAPABILITY_CATALOGUE,
  LAST_HOLDER_PROTECTED,
  PLATFORM_CAPABILITIES,
  SENSITIVE_CAPABILITIES,
  approvalRequest,
  fourEyesRule,
  operatorGrant,
  operatorGrantEvent,
  type GrantSource,
  type PlatformCapability,
} from "./schema-ops.ts";

const capabilityName = z.string().refine((c): c is PlatformCapability => (PLATFORM_CAPABILITIES as readonly string[]).includes(c), "Izin tidak dikenal.");
const reasonText = z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500);

const grantInput = z.strictObject({
  userId: z.string().min(1).max(128),
  capability: capabilityName,
  reason: reasonText,
  expiresAt: z.date().optional(),
  /** Required for a sensitive capability: an approved `grant.sensitive` request bound to `grantPayload(...)`. */
  approvalRequestId: z.number().int().positive().optional(),
});
const revokeInput = z.strictObject({ userId: z.string().min(1).max(128), capability: capabilityName, reason: reasonText });

/** The payload a `grant.sensitive` approval is bound to; the requester and the executor must derive it the same way. */
export function grantPayload(input: { userId: string; capability: PlatformCapability; expiresAt?: Date | null }) {
  return { userId: input.userId, capability: input.capability, expiresAt: input.expiresAt ?? null };
}
export const grantPayloadHash = (input: Parameters<typeof grantPayload>[0]) => payloadHash(grantPayload(input));

const isGrantable = (c: PlatformCapability) => CAPABILITY_CATALOGUE.find((x) => x.name === c)?.phase !== "P2";

/** Everything a staff change must do besides the grant row itself: the event, and the operator's sessions go. */
async function writeEvent(
  tx: Tx,
  e: { userId: string; capability: PlatformCapability; action: "grant" | "revoke"; source: GrantSource; actorUserId: string | null; reason: string; approvalRequestId?: number | null },
) {
  await tx.insert(operatorGrantEvent).values({
    operatorUserId: e.userId,
    capability: e.capability,
    action: e.action,
    source: e.source,
    actorUserId: e.actorUserId,
    reason: e.reason,
    approvalRequestId: e.approvalRequestId ?? null,
  });
}
const revokeSessions = (tx: Tx, userId: string) => tx.delete(session).where(eq(session.userId, userId));

/**
 * Lock every holder row of a capability in primary-key order. Two transactions that both want to remove holders of the
 * same capability take the locks in the same order, so they queue instead of deadlocking, and the second re-reads the
 * rows the first one changed (READ COMMITTED) before it decides whether anyone would be left.
 */
async function lockHolders(tx: Tx, capability: PlatformCapability) {
  return tx
    // `standing` = no expiry: a time-limited holder does not count as the holder that remains (IAM-15 "last active holder").
    .select({ userId: operatorGrant.userId, standing: sql<boolean>`(${operatorGrant.expiresAt} is null)` })
    .from(operatorGrant)
    .where(eq(operatorGrant.capability, capability))
    .orderBy(asc(operatorGrant.userId))
    .for("update");
}

/** Grant a capability from the Owner console. Needs `staff.manage`; a sensitive capability also needs an approved, unused `grant.sensitive` request (IAM-15). */
export async function grantCapability(actor: OperatorScope, raw: unknown): Promise<void> {
  const input = grantInput.parse(raw);
  if (!isGrantable(input.capability)) throw new DomainError("dormant", "Izin ini belum diaktifkan (fase 2).");
  await requirePlatformCap(actor, "staff.manage");
  try {
    await actor.exec.transaction(async (tx) => {
      if (!(await holdsCapability(tx, actor.userId, "staff.manage"))) throw new DomainError("forbidden", "Akses ditolak: butuh izin staff.manage.");
      const [operator] = await tx.select({ id: platformOperator.userId }).from(platformOperator).where(eq(platformOperator.userId, input.userId));
      if (!operator) throw new DomainError("not_found", "Pengguna bukan staf Owner console.");
      let approvalRequestId: number | null = null;
      if (SENSITIVE_CAPABILITIES.includes(input.capability)) {
        if (input.approvalRequestId === undefined) throw new DomainError("approval_required", "Izin sensitif butuh persetujuan orang kedua (grant.sensitive).");
        const { decidedBy } = await consumeApproval(tx, actor, {
          approvalId: input.approvalRequestId,
          actionKey: "grant.sensitive",
          targetKind: "operator",
          targetId: input.userId,
          payloadSha256: grantPayloadHash(input),
        });
        // The approver is neither the requester (CHECK) nor the grantee (IAM-15 "Sensitive grants").
        if (decidedBy === input.userId) throw new DomainError("self_approval", "Penerima izin tidak boleh menjadi penyetuju.");
        approvalRequestId = input.approvalRequestId;
      }
      const [row] = await tx
        .insert(operatorGrant)
        .values({ userId: input.userId, capability: input.capability, expiresAt: input.expiresAt ?? null })
        .onConflictDoNothing()
        .returning({ c: operatorGrant.capability });
      if (!row) throw new DomainError("conflict", "Staf ini sudah memegang izin tersebut.");
      await writeEvent(tx, { userId: input.userId, capability: input.capability, action: "grant", source: "product", actorUserId: actor.userId, reason: input.reason, approvalRequestId });
      await revokeSessions(tx, input.userId);
    });
  } catch (err) {
    if (pgCode(err) === "23505") throw new DomainError("conflict", "Staf ini sudah memegang izin tersebut.");
    throw err;
  }
}

/**
 * Revoke a capability. Needs `staff.manage`. The last active holder of `staff.manage` or `break_glass.approve` cannot be
 * removed: the holders are locked in primary-key order first, so of two simultaneous demotions one aborts. The same
 * transaction records the event, cancels the open approval requests that operator made under that capability and
 * deletes their sessions.
 */
export async function revokeCapability(actor: OperatorScope, raw: unknown): Promise<void> {
  const input = revokeInput.parse(raw);
  await requirePlatformCap(actor, "staff.manage");
  await actor.exec.transaction(async (tx) => {
    const protectedCap = (LAST_HOLDER_PROTECTED as readonly string[]).includes(input.capability);
    const holders = protectedCap ? await lockHolders(tx, input.capability) : null;
    // Re-read after the locks: the actor may have been demoted by the transaction we just waited for.
    if (!(await holdsCapability(tx, actor.userId, "staff.manage"))) throw new DomainError("forbidden", "Akses ditolak: butuh izin staff.manage.");
    if (holders) {
      if (!holders.some((h) => h.userId === input.userId)) throw new DomainError("not_found", "Staf ini tidak memegang izin tersebut.");
      if (!holders.some((h) => h.userId !== input.userId && h.standing)) throw new DomainError("last_holder", `Pemegang aktif terakhir izin ${input.capability} tidak dapat dicabut.`);
    }
    const removed = await tx
      .delete(operatorGrant)
      .where(and(eq(operatorGrant.userId, input.userId), eq(operatorGrant.capability, input.capability)))
      .returning({ c: operatorGrant.capability });
    if (removed.length === 0) throw new DomainError("not_found", "Staf ini tidak memegang izin tersebut.");
    await writeEvent(tx, { userId: input.userId, capability: input.capability, action: "revoke", source: "product", actorUserId: actor.userId, reason: input.reason });
    // IAM-15: revocation terminates the queued approvals the operator requested under this capability.
    await tx
      .update(approvalRequest)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(approvalRequest.requestedBy, input.userId),
          inArray(approvalRequest.status, ["pending", "approved"]),
          inArray(approvalRequest.actionKey, tx.select({ k: fourEyesRule.actionKey }).from(fourEyesRule).where(eq(fourEyesRule.capability, input.capability))),
        ),
      );
    await revokeSessions(tx, input.userId);
  });
}

/**
 * Out-of-band grants (IAM-15 bootstrap and recovery, the local seed): no actor, no approval, a reason naming the runbook
 * entry. Idempotent per capability; sessions of the operator are revoked when anything was granted.
 */
export async function grantAsSystem(
  exec: Executor,
  input: { userId: string; capabilities: readonly PlatformCapability[]; source: Exclude<GrantSource, "product">; reason: string },
): Promise<PlatformCapability[]> {
  return exec.transaction(async (tx) => {
    const granted: PlatformCapability[] = [];
    for (const capability of input.capabilities) {
      const [row] = await tx.insert(operatorGrant).values({ userId: input.userId, capability }).onConflictDoNothing().returning({ c: operatorGrant.capability });
      if (!row) continue;
      await writeEvent(tx, { userId: input.userId, capability, action: "grant", source: input.source, actorUserId: null, reason: input.reason });
      granted.push(capability);
    }
    if (granted.length > 0) await revokeSessions(tx, input.userId);
    return granted;
  });
}
