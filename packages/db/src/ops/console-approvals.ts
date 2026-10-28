import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLog } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { operatorCapabilities, requirePlatformCap } from "./capabilities.ts";
import { consumeStepUpProof, decideApproval, expireApprovals, issueStepUpProof, STEP_UP_WINDOW_SECONDS } from "./capabilities-approvals.ts";
import { approvalRequest, fourEyesRule, FOUR_EYES_MATRIX } from "./schema-ops.ts";
import { consoleMutation } from "./console.ts";
import { registerPlatformHandler } from "./jobs/jobs.ts";
import { registerSchedule } from "./jobs/scheduler.ts";
import type { PlatformCapability } from "./schema-ops.ts";
const TRANSFER_ACTIONS = /^(payout|refund|affiliate_payout)\.approve_transfer$/;
async function inboxCap(op: OperatorScope) {
  const caps = await operatorCapabilities(op.exec, op.userId);
  return FOUR_EYES_MATRIX.find((r) => r.active && caps.includes(r.capability))?.capability ?? "staff.manage";
}
export type InboxTab = "waiting" | "mine" | "decided";
/**
 * SA-28. `waiting`: pending requests the viewer could decide (they hold the rule's capability) and that have not expired;
 * `mine`: everything the viewer requested; `decided`: everything else visible to a holder, including expired ones (computed
 * from `expires_at`, so a read never writes; the JOB-12 sweeper persists the state). Each row carries the exact canonical
 * payload the approver reads and its SHA-256. The immutable bank snapshot of a transfer approval is a disclosure of a bank
 * value: it is recorded as a `full` access event in the same transaction, before the rows are returned.
 */
export type InboxItem = typeof approvalRequest.$inferSelect & { capability: PlatformCapability; own: boolean };
export async function approvalInbox(op: OperatorScope, tab: InboxTab = "waiting"): Promise<InboxItem[]> {
  await requirePlatformCap(op, await inboxCap(op));
  const caps = await operatorCapabilities(op.exec, op.userId);
  const live = sql`${approvalRequest.expiresAt} > now()`;
  const where =
    tab === "mine"
      ? eq(approvalRequest.requestedBy, op.userId)
      : and(
          inArray(fourEyesRule.capability, caps),
          tab === "waiting" ? and(eq(approvalRequest.status, "pending"), live) : or(inArray(approvalRequest.status, ["approved", "executed", "rejected", "expired", "cancelled"]), and(inArray(approvalRequest.status, ["pending", "approved"]), sql`not (${live})`)),
        );
  return op.exec.transaction(async (tx) => {
    const rows = await tx
      .select({ request: approvalRequest, capability: fourEyesRule.capability, live: sql<boolean>`(${live})` })
      .from(approvalRequest)
      .innerJoin(fourEyesRule, eq(fourEyesRule.actionKey, approvalRequest.actionKey))
      .where(where)
      .orderBy(desc(approvalRequest.id))
      .limit(50);
    for (const { request, live: isLive } of rows) {
      if (!TRANSFER_ACTIONS.test(request.actionKey)) continue; // every transfer row whose snapshot is shown, whatever its status (wave 2 review)
      await tx.execute(sql`select public.console_record_access(${op.userId}, 'approval', ${String(request.id)}, 'bank', 'payout_review', ${`approval:${request.id}`}, 'bank snapshot of an approval request', 'full', ${new Date(Date.now() + STEP_UP_WINDOW_SECONDS * 1000).toISOString()}::timestamptz, null::bigint)`);
    }
    await tx.insert(auditLog).values({ actorUserId: op.userId, action: "approval.read", accessLevel: "masked", outcome: "allowed", reason: `count:${rows.length}` });
    return rows.map(({ request, capability, live: isLive }) => ({
      ...request,
      status: (request.status === "pending" || request.status === "approved") && !isLive ? ("expired" as const) : request.status,
      capability,
      own: request.requestedBy === op.userId,
    }));
  });
}
export async function decideConsoleApproval(op: OperatorScope, sessionId: string, raw: unknown) {
  await requirePlatformCap(op, await inboxCap(op));
  const input = z.object({ approvalId: z.number().int().positive(), decision: z.enum(["approve", "reject"]), reason: z.string().trim().min(5).max(500) }).parse(raw);
  const [row] = await op.exec.select({ capability: fourEyesRule.capability, actionKey: approvalRequest.actionKey }).from(approvalRequest).innerJoin(fourEyesRule, eq(fourEyesRule.actionKey, approvalRequest.actionKey)).where(eq(approvalRequest.id, input.approvalId));
  if (!row) throw new DomainError("not_found", "Permintaan tidak ditemukan.");
  await requirePlatformCap(op, row.capability);
  const binding = { sessionId, userId: op.userId, actionKey: `approval.${input.decision}`, subjectKind: "approval", subjectId: String(input.approvalId) };
  const proofId = await issueStepUpProof(op.exec, binding);
  await consoleMutation(op, { capability: row.capability, action: "approval.decide", targetKind: "approval", targetId: String(input.approvalId), reason: input.reason, reasonCode: input.decision }, async (tx) => {
    await consumeStepUpProof(tx, proofId, binding);
    await decideApproval({ ...op, exec: tx }, input.approvalId, input.decision);
  });
}
registerSchedule({ kind: "approval.expire", period: "minute", catchUp: 0 });
registerPlatformHandler("approval.expire", async ({ db }) => { await expireApprovals(db); });
