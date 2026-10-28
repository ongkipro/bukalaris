import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalPayload, payloadHash, recordSessionMfa, requestApproval } from "../src/ops/capabilities-approvals.ts";
import { approvalInbox, decideConsoleApproval } from "../src/ops/console-approvals.ts";
import { consoleAccessEvents } from "../src/ops/console.ts";
import { getHandler, runOnce } from "../src/ops/jobs/jobs.ts";
import { registeredSchedules, schedulerTick } from "../src/ops/jobs/scheduler.ts";
import { approvalRequest } from "../src/ops/schema-ops.ts";
import { auditLog, session } from "../src/schema.ts";
import type { OperatorScope } from "../src/platform/scoped.ts";
import { admin, makeOperator, platform } from "./helpers.ts";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);
const BANK = { holder: "Budi Santoso", bank: "BCA", destination: "1234567890", amountIdr: 250_000 };

/** Move a request's life into the past (fixture only: the guard trigger is switched off for this one UPDATE). */
async function expireNow(id: number) {
  await admin.execute(sql`alter table approval_request disable trigger approval_request_guard`);
  try {
    await admin.execute(sql`update approval_request set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = ${id}`);
  } finally {
    await admin.execute(sql`alter table approval_request enable trigger approval_request_guard`);
  }
}

beforeEach(async () => {
  await admin.execute(sql`truncate personal_data_access_event`);
});

/** A real session of the operator, with (or without) its own verified second factor. */
async function sessionOf(op: OperatorScope, mfa: boolean) {
  const id = randomUUID();
  await admin.insert(session).values({ id, userId: op.userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  if (mfa) await recordSessionMfa(platform, { sessionId: id, userId: op.userId, method: "totp" });
  return id;
}
async function transferRequest(requester: OperatorScope, id = "p1") {
  return requestApproval(requester, { actionKey: "payout.approve_transfer", targetKind: "payout", targetId: id, payload: BANK, reason: "pencairan seller uji" });
}
const statusOf = async (id: number) => (await admin.select({ s: approvalRequest.status, by: approvalRequest.decidedBy }).from(approvalRequest).where(eq(approvalRequest.id, id)))[0]!;

describe("approvals inbox (SA-28)", () => {
  it("the approver reads the exact canonical payload and its hash; viewing a bank snapshot is a recorded `full` access event", async () => {
    const requester = await makeOperator(["payouts.process"]);
    const approver = await makeOperator(["payouts.process", "audit.read"]);
    const { id, payloadSha256 } = await transferRequest(requester);
    const [item] = await approvalInbox(approver, "waiting");
    expect(item).toMatchObject({ id, status: "pending", own: false, capability: "payouts.process", payloadSha256 });
    expect(item!.payloadCanonical).toBe(canonicalPayload(BANK));
    expect(payloadHash(BANK)).toBe(payloadSha256);
    const events = await consoleAccessEvents(approver);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorUserId: approver.userId, targetKind: "approval", targetId: String(id), fieldClass: "bank", accessLevel: "full" });
  });

  it("wave 2 review P2: the bank snapshot of a decided transfer approval is an access event too, on the decided tab", async () => {
    const requester = await makeOperator(["payouts.process"]);
    const approver = await makeOperator(["payouts.process", "audit.read"]);
    const { id } = await transferRequest(requester);
    await decideConsoleApproval(approver, await sessionOf(approver, true), { approvalId: id, decision: "approve", reason: "snapshot bank sudah dicek" });
    const before = (await consoleAccessEvents(approver)).length;
    const [decided] = await approvalInbox(approver, "decided");
    expect(decided).toMatchObject({ id, status: "approved" });
    expect(decided!.payloadCanonical).toContain("destination"); // the snapshot IS shown...
    const events = await consoleAccessEvents(approver);
    expect(events.length).toBe(before + 1); // ...so it is recorded
    expect(events[0]).toMatchObject({ targetId: String(id), fieldClass: "bank", accessLevel: "full" });
  });

  it("the requester sees their own request marked as own (the page disables the approve control) and under 'mine'; a plain request records no bank access", async () => {
    const requester = await makeOperator(["staff.manage", "audit.read"]);
    const { id } = await requestApproval(requester, { actionKey: "grant.sensitive", targetKind: "operator", targetId: "someone", payload: { capability: "ledger.adjust" }, reason: "beri izin ledger" });
    expect((await approvalInbox(requester, "waiting"))[0]).toMatchObject({ id, own: true });
    expect((await approvalInbox(requester, "mine")).map((i) => i.id)).toEqual([id]);
    expect(await consoleAccessEvents(requester)).toEqual([]);
  });

  it("an operator who holds no four-eyes capability is refused, and a holder of a different capability does not see the request", async () => {
    const requester = await makeOperator(["payouts.process"]);
    await transferRequest(requester);
    expect(await code(approvalInbox(await makeOperator(["logs.read"])))).toBe("forbidden");
    const other = await makeOperator(["billing.manage"]);
    expect(await approvalInbox(other, "waiting")).toEqual([]);
  });

  it("an expired request is listed as expired under 'decided', never as waiting, without the read writing anything", async () => {
    const requester = await makeOperator(["payouts.process"]);
    const approver = await makeOperator(["payouts.process"]);
    const { id } = await requestApproval(requester, { actionKey: "payout.approve_transfer", targetKind: "payout", targetId: "p9", payload: BANK, reason: "kedaluwarsa uji" });
    await expireNow(id);
    expect(await approvalInbox(approver, "waiting")).toEqual([]);
    const decided = await approvalInbox(approver, "decided");
    expect(decided.map((i) => [i.id, i.status])).toEqual([[id, "expired"]]);
    expect((await statusOf(id)).s).toBe("pending"); // persisted state is the sweeper's job
    expect(await code(decideConsoleApproval(approver, await sessionOf(approver, true), { approvalId: id, decision: "approve", reason: "terlambat" }))).toBe("conflict");
  });
});

describe("deciding", () => {
  it("approves with a reason: the decider is recorded, one audit row is written and the request is approved, not executed", async () => {
    const requester = await makeOperator(["payouts.process"]);
    const approver = await makeOperator(["payouts.process"]);
    const { id } = await transferRequest(requester);
    await decideConsoleApproval(approver, await sessionOf(approver, true), { approvalId: id, decision: "approve", reason: "snapshot bank sudah dicek" });
    expect(await statusOf(id)).toEqual({ s: "approved", by: approver.userId });
    const [row] = (await admin.select().from(auditLog).where(eq(auditLog.action, "approval.decide")));
    expect(row).toMatchObject({ actorUserId: approver.userId, actorCapability: "payouts.process", subjectKind: "approval", subjectId: String(id), purposeCode: "approve", outcome: "allowed" });
  });

  it("self-approval is refused by the service and the request stays pending; the database CHECK refuses it too", async () => {
    const requester = await makeOperator(["payouts.process"]);
    const { id } = await transferRequest(requester);
    expect(await code(decideConsoleApproval(requester, await sessionOf(requester, true), { approvalId: id, decision: "approve", reason: "setujui sendiri" }))).toBe("self_approval");
    expect((await statusOf(id)).s).toBe("pending");
    await expect(admin.execute(sql`update approval_request set status = 'approved', decided_by = requested_by, decided_at = now() where id = ${id}`)).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("needs a fresh second-factor verification of THIS session: none, or one in another session, leaves the request pending", async () => {
    const requester = await makeOperator(["payouts.process"]);
    const approver = await makeOperator(["payouts.process"]);
    const { id } = await transferRequest(requester);
    await sessionOf(approver, true); // another session of the approver is verified
    expect(await code(decideConsoleApproval(approver, await sessionOf(approver, false), { approvalId: id, decision: "approve", reason: "tanpa kode" }))).toBe("reauth_required");
    expect((await statusOf(id)).s).toBe("pending");
    expect((await admin.select().from(auditLog).where(eq(auditLog.action, "approval.decide")))).toEqual([]);
  });

  it("a different capability cannot decide, and the reason is mandatory", async () => {
    const requester = await makeOperator(["payouts.process"]);
    const { id } = await transferRequest(requester);
    const wrong = await makeOperator(["billing.manage"]);
    expect(await code(decideConsoleApproval(wrong, await sessionOf(wrong, true), { approvalId: id, decision: "approve", reason: "bukan wewenang" }))).toBe("forbidden");
    const approver = await makeOperator(["payouts.process"]);
    await expect(decideConsoleApproval(approver, await sessionOf(approver, true), { approvalId: id, decision: "approve", reason: "x" })).rejects.toThrow();
    expect((await statusOf(id)).s).toBe("pending");
  });

  it("two approvers racing on one request: exactly one decision is written", async () => {
    const requester = await makeOperator(["payouts.process"]);
    const a = await makeOperator(["payouts.process"]);
    const b = await makeOperator(["payouts.process"]);
    const { id } = await transferRequest(requester);
    const [sa, sb] = [await sessionOf(a, true), await sessionOf(b, true)];
    const results = await Promise.all([
      code(decideConsoleApproval(a, sa, { approvalId: id, decision: "approve", reason: "setuju dari A" })),
      code(decideConsoleApproval(b, sb, { approvalId: id, decision: "reject", reason: "tolak dari B" })),
    ]);
    expect(results.sort()).toEqual(["conflict", "ok"]);
    expect((await admin.select().from(auditLog).where(eq(auditLog.action, "approval.decide"))).length).toBe(1);
  });

  it("a rejected request cannot be approved afterwards", async () => {
    const requester = await makeOperator(["payouts.process"]);
    const a = await makeOperator(["payouts.process"]);
    const { id } = await transferRequest(requester);
    await decideConsoleApproval(a, await sessionOf(a, true), { approvalId: id, decision: "reject", reason: "bank tidak cocok" });
    expect(await code(decideConsoleApproval(a, await sessionOf(a, true), { approvalId: id, decision: "approve", reason: "berubah pikiran" }))).toBe("conflict");
    expect((await statusOf(id)).s).toBe("rejected");
  });
});

describe("expiry sweeper (JOB-12)", () => {
  it("the scheduled approval.expire job persists the expired state, through the real worker path", async () => {
    const requester = await makeOperator(["payouts.process"]);
    const { id } = await requestApproval(requester, { actionKey: "payout.approve_transfer", targetKind: "payout", targetId: "p7", payload: BANK, reason: "sapu kedaluwarsa" });
    await expireNow(id);
    expect(registeredSchedules().map((s) => s.kind)).toContain("approval.expire");
    expect(getHandler("approval.expire")).toBeTypeOf("function");
    await schedulerTick(platform, { now: new Date(), tickIntervalMs: 30_000, schedules: registeredSchedules().filter((s) => s.kind === "approval.expire") });
    const out = await runOnce(platform, { workerId: "t62" });
    expect(out.map((o) => [o.kind, o.status])).toEqual([["approval.expire", "done"]]);
    expect((await statusOf(id)).s).toBe("expired");
  });
});
