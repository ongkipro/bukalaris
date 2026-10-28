import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { hasPlatformCap, holdsCapability, type PlatformCapability } from "../src/ops/capabilities.ts";
import {
  consumeApproval,
  consumeStepUpProof,
  decideApproval,
  expireApprovals,
  issueStepUpProof,
  payloadHash,
  recordSessionMfa,
  requestApproval,
  sessionMfaVerified,
} from "../src/ops/capabilities-approvals.ts";
import { grantCapability, grantPayloadHash, revokeCapability } from "../src/ops/capabilities-grants.ts";
import { BOOTSTRAP_CAPABILITIES, bootstrapConsole } from "../src/ops/capabilities-bootstrap.ts";
import type { OperatorScope } from "../src/platform/scoped.ts";
import { approvalRequest, operatorGrant, operatorGrantEvent, operatorStepUpProof, platformOperator, session, sessionMfa, user } from "../src/schema.ts";
import { admin, makeOperator, makeUser, platform } from "./helpers.ts";

// Real waits on purpose: approval expiry is judged by the database clock (now()), and lock queueing is observed in pg_stat_activity;
// neither can be driven by fake timers.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function newSession(userId: string) {
  const id = randomUUID();
  await platform.insert(session).values({ id, token: id, userId, expiresAt: new Date(Date.now() + 3_600_000) });
  return id;
}
const sessionsOf = async (userId: string) => (await platform.select({ id: session.id }).from(session).where(eq(session.userId, userId))).length;
const ask = (op: OperatorScope, over: Record<string, unknown> = {}) =>
  requestApproval(op, { actionKey: "payout.approve_transfer", targetKind: "payout", targetId: "7", payload: { payoutId: 7, amountIdr: 150_000 }, reason: "uji persetujuan", ...over });
const statusOf = async (id: number) => (await platform.select({ s: approvalRequest.status }).from(approvalRequest).where(eq(approvalRequest.id, id)))[0]!.s;
/** Runs `fn` in a real transaction on the platform pool that is rolled back when `fn` throws. */
const inTx = <T>(fn: (tx: Parameters<Parameters<typeof platform.transaction>[0]>[0]) => Promise<T>) => platform.transaction(fn);
const holders = async (cap: PlatformCapability) => (await platform.select({ u: operatorGrant.userId }).from(operatorGrant).where(eq(operatorGrant.capability, cap)).orderBy(asc(operatorGrant.userId))).map((r) => r.u);

describe("four-eyes approvals (IAM-15, DATA-14)", { timeout: 60_000 }, () => {
  it("requester and approver are different people: refused by the service and by the database", async () => {
    const a = await makeOperator(["payouts.process"]);
    const b = await makeOperator(["payouts.process"]);
    const req = await ask(a);
    await expect(decideApproval(a, req.id, "approve")).rejects.toMatchObject({ code: "self_approval" });
    // The CHECK holds without the service: the requester as decided_by violates requested_by <> decided_by.
    await expect(platform.execute(sql`update approval_request set status = 'approved', decided_by = ${a.userId}, decided_at = now() where id = ${req.id}`)).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await statusOf(req.id)).toBe("pending");
    await decideApproval(b, req.id, "approve");
    expect(await statusOf(req.id)).toBe("approved");
  });

  it("the approver must hold the rule's capability, the requester too, and inactive or unknown actions are refused", async () => {
    const a = await makeOperator(["payouts.process"]);
    const none = await makeOperator([]);
    const wrong = await makeOperator(["refunds.process"]);
    await expect(ask(none)).rejects.toMatchObject({ code: "forbidden" });
    const req = await ask(a);
    await expect(decideApproval(none, req.id, "approve")).rejects.toMatchObject({ code: "forbidden" });
    await expect(decideApproval(wrong, req.id, "reject")).rejects.toMatchObject({ code: "forbidden" });
    await expect(ask(a, { actionKey: "merge.execute" })).rejects.toMatchObject({ code: "not_found" }); // decided disabled in Phase 1
    await expect(ask(a, { actionKey: "billing.ppn_toggle" })).rejects.toMatchObject({ code: "not_found" }); // not a four-eyes action
    await expect(decideApproval(a, 99_999, "approve")).rejects.toMatchObject({ code: "not_found" });
  });

  it("an identical open request is refused; a changed payload is a new request and the old approval cannot execute it", async () => {
    const a = await makeOperator(["payouts.process"]);
    const b = await makeOperator(["payouts.process"]);
    const first = await ask(a);
    await expect(ask(a)).rejects.toMatchObject({ code: "conflict" });
    const second = await ask(a, { payload: { payoutId: 7, amountIdr: 999_999 } });
    expect(second.payloadSha256).not.toBe(first.payloadSha256);
    await decideApproval(b, first.id, "approve");
    // The approval of payload 1 does not authorize payload 2 (nor another target or action).
    for (const bad of [{ payloadSha256: second.payloadSha256 }, { targetId: "8" }, { targetKind: "refund" }, { actionKey: "cod.manual_complete" as const }]) {
      await expect(
        inTx((tx) => consumeApproval(tx, a, { approvalId: first.id, actionKey: "payout.approve_transfer", targetKind: "payout", targetId: "7", payloadSha256: first.payloadSha256, ...bad })),
      ).rejects.toMatchObject({ code: "approval_invalid" });
    }
    expect(await statusOf(first.id)).toBe("approved");
    expect(payloadHash({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(payloadHash({ a: [1, { c: 3, d: 2 }], b: 1 }));
    expect(() => payloadHash({ a: undefined })).toThrow();
  });

  it("a decision, an execution or an edit after expiry is refused; the sweeper marks them expired", async () => {
    const a = await makeOperator(["payouts.process"]);
    const b = await makeOperator(["payouts.process"]);
    const stale = await ask(a, { ttlSeconds: 2 });
    const approvedThenStale = await ask(a, { targetId: "8", ttlSeconds: 2 });
    await decideApproval(b, approvedThenStale.id, "approve");
    await sleep(2300);
    await expect(decideApproval(b, stale.id, "approve")).rejects.toMatchObject({ code: "conflict" });
    await expect(inTx((tx) => consumeApproval(tx, a, { approvalId: approvedThenStale.id, actionKey: "payout.approve_transfer", targetKind: "payout", targetId: "8", payloadSha256: approvedThenStale.payloadSha256 }))).rejects.toMatchObject({ code: "approval_invalid" });
    expect(await expireApprovals(platform)).toBe(2);
    expect([await statusOf(stale.id), await statusOf(approvedThenStale.id)]).toEqual(["expired", "expired"]);
    expect(await expireApprovals(platform)).toBe(0);
    // Validity is bounded by the rule: a longer request is cut to max_validity (24h placeholder), never extended.
    const long = await ask(a, { targetId: "9", ttlSeconds: 10 * 365 * 24 * 3600 });
    const [{ ok }] = (await platform.execute(sql`select (expires_at <= now() + interval '24 hours 1 minute') as ok from approval_request where id = ${long.id}`)) as unknown as { ok: boolean }[];
    expect(ok).toBe(true);
    await expect(platform.execute(sql`insert into approval_request (action_key, target_kind, target_id, payload_sha256, requested_by, reason, expires_at) values ('payout.approve_transfer', 'payout', '77', ${"a".repeat(64)}, ${a.userId}, 'terlalu lama', now() + interval '30 days')`)).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("two approvers racing on one request: exactly one decision lands", async () => {
    const a = await makeOperator(["payouts.process"]);
    const b = await makeOperator(["payouts.process"]);
    const c = await makeOperator(["payouts.process"]);
    for (let round = 0; round < 6; round++) {
      const req = await ask(a, { targetId: `race-${round}` });
      const results = await Promise.allSettled([decideApproval(b, req.id, "approve"), decideApproval(c, req.id, "reject")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")[0]).toMatchObject({ reason: { code: "conflict" } });
      const [row] = await platform.select().from(approvalRequest).where(eq(approvalRequest.id, req.id));
      expect(row!.decidedBy).toBe(row!.status === "approved" ? b.userId : c.userId);
    }
  });

  it("an approval is consumed once, by its requester, atomically with the write; a failed write leaves it unused", async () => {
    const a = await makeOperator(["payouts.process"]);
    const b = await makeOperator(["payouts.process"]);
    const req = await ask(a);
    await decideApproval(b, req.id, "approve");
    const binding = { approvalId: req.id, actionKey: "payout.approve_transfer" as const, targetKind: "payout", targetId: "7", payloadSha256: req.payloadSha256 };
    // The write fails after the proof is consumed: the transaction rolls both back.
    await expect(inTx(async (tx) => {
      await consumeApproval(tx, a, binding);
      throw new Error("write failed");
    })).rejects.toThrow("write failed");
    expect(await statusOf(req.id)).toBe("approved");
    // Someone other than the requester cannot ride the proof, even with the capability.
    await expect(inTx((tx) => consumeApproval(tx, b, binding))).rejects.toMatchObject({ code: "approval_invalid" });
    // Two concurrent executions: one wins.
    const race = await Promise.allSettled([inTx((tx) => consumeApproval(tx, a, binding)), inTx((tx) => consumeApproval(tx, a, binding))]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await statusOf(req.id)).toBe("executed");
    await expect(inTx((tx) => consumeApproval(tx, a, binding))).rejects.toMatchObject({ code: "approval_invalid" });
    // executed is final, also against a direct write.
    await expect(platform.execute(sql`update approval_request set status = 'approved', executed_at = null where id = ${req.id}`)).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("the approver's capability is re-checked at execution, and revoking the requester's capability cancels their open requests", async () => {
    const boss = await makeOperator(["staff.manage"]);
    const a = await makeOperator(["payouts.process"]);
    const b = await makeOperator(["payouts.process"]);
    const lost = await ask(a);
    await decideApproval(b, lost.id, "approve");
    await platform.delete(operatorGrant).where(eq(operatorGrant.userId, b.userId));
    await expect(inTx((tx) => consumeApproval(tx, a, { approvalId: lost.id, actionKey: "payout.approve_transfer", targetKind: "payout", targetId: "7", payloadSha256: lost.payloadSha256 }))).rejects.toMatchObject({ code: "approval_invalid" });
    expect(await statusOf(lost.id)).toBe("approved");

    const queued = await ask(a, { targetId: "11" });
    const other = await ask(a, { actionKey: "cod.manual_complete", targetKind: "order", targetId: "11", payload: { o: 11 } });
    await revokeCapability(boss, { userId: a.userId, capability: "payouts.process", reason: "uji pencabutan" });
    expect(await statusOf(queued.id)).toBe("cancelled");
    expect(await statusOf(other.id)).toBe("cancelled"); // cod.manual_complete is also a payouts.process action
    expect(await statusOf(lost.id)).toBe("cancelled");
  });

  it("rows are immutable except their decision, and the legal moves are the only moves", async () => {
    const a = await makeOperator(["payouts.process"]);
    const req = await ask(a);
    for (const stmt of [
      sql`update approval_request set payload_sha256 = ${"b".repeat(64)} where id = ${req.id}`,
      sql`update approval_request set target_id = '8' where id = ${req.id}`,
      sql`update approval_request set expires_at = expires_at + interval '1 hour' where id = ${req.id}`,
      sql`update approval_request set status = 'executed', decided_by = ${a.userId}, decided_at = now(), executed_at = now() where id = ${req.id}`,
      sql`delete from approval_request where id = ${req.id}`,
    ]) {
      await expect(platform.execute(stmt)).rejects.toBeDefined();
    }
    expect(await statusOf(req.id)).toBe("pending");
    await platform.update(approvalRequest).set({ status: "cancelled" }).where(eq(approvalRequest.id, req.id));
    await expect(platform.update(approvalRequest).set({ status: "pending" }).where(eq(approvalRequest.id, req.id))).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});

describe("MFA is bound to the session (D-21)", () => {
  it("a session without a verified second-factor record is refused even when the account flag is set; the verification hook's write admits it", async () => {
    const op = await makeOperator([]);
    await platform.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, op.userId));
    const beforeEnrolment = await newSession(op.userId); // e.g. created before TOTP enrolment, or a stolen cookie
    const verified = await newSession(op.userId);
    expect((await platform.select({ f: user.twoFactorEnabled }).from(user).where(eq(user.id, op.userId)))[0]!.f).toBe(true);
    expect(await sessionMfaVerified(platform, beforeEnrolment, op.userId)).toBe(false);
    expect(await sessionMfaVerified(platform, verified, op.userId)).toBe(false);
    await recordSessionMfa(platform, { sessionId: verified, userId: op.userId, method: "totp" });
    expect(await sessionMfaVerified(platform, verified, op.userId)).toBe(true);
    expect(await sessionMfaVerified(platform, beforeEnrolment, op.userId)).toBe(false);
    // The record belongs to one user and one session.
    const stranger = await makeUser("stranger");
    expect(await sessionMfaVerified(platform, verified, stranger)).toBe(false);
    // Re-verifying refreshes the same row (no duplicate), and ending the session ends the proof.
    await recordSessionMfa(platform, { sessionId: verified, userId: op.userId, method: "backup_code" });
    expect(await platform.select().from(sessionMfa)).toHaveLength(1);
    await platform.delete(session).where(eq(session.id, verified));
    expect(await platform.select().from(sessionMfa)).toHaveLength(0);
  });

  it("revoking a grant deletes the operator's session, and with it the MFA record", async () => {
    const boss = await makeOperator(["staff.manage"]);
    const op = await makeOperator(["logs.read"]);
    const s = await newSession(op.userId);
    await recordSessionMfa(platform, { sessionId: s, userId: op.userId, method: "totp" });
    await revokeCapability(boss, { userId: op.userId, capability: "logs.read", reason: "uji sesi" });
    expect(await sessionMfaVerified(platform, s, op.userId)).toBe(false);
  });
});

describe("reauthentication proofs are single-use and bound to session, action and subject (D-21)", () => {
  async function fresh() {
    const op = await makeOperator([]);
    const sessionId = await newSession(op.userId);
    await recordSessionMfa(platform, { sessionId, userId: op.userId, method: "totp" });
    return { op, sessionId, bind: { sessionId, userId: op.userId, actionKey: "payout.approve_transfer", subjectKind: "payout", subjectId: "42" } };
  }

  it("is issued only after a fresh code in this very session", async () => {
    const op = await makeOperator([]);
    const noCode = await newSession(op.userId);
    const bind = { sessionId: noCode, userId: op.userId, actionKey: "payout.approve_transfer", subjectKind: "payout", subjectId: "42" };
    await expect(issueStepUpProof(platform, bind)).rejects.toMatchObject({ code: "reauth_required" });
    await recordSessionMfa(platform, { sessionId: noCode, userId: op.userId, method: "totp" });
    await expect(issueStepUpProof(platform, bind)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    // A code verified long ago is not fresh.
    await platform.update(sessionMfa).set({ verifiedAt: new Date(Date.now() - 3_600_000) }).where(eq(sessionMfa.sessionId, noCode));
    await expect(issueStepUpProof(platform, bind)).rejects.toMatchObject({ code: "reauth_required" });
    // Another session of the same user, or another user's session, gets nothing from this one.
    const sibling = await newSession(op.userId);
    await expect(issueStepUpProof(platform, { ...bind, sessionId: sibling })).rejects.toMatchObject({ code: "reauth_required" });
  });

  it("works once, only for its session, action and subject", async () => {
    const { op, sessionId, bind } = await fresh();
    const otherSession = await newSession(op.userId);
    await recordSessionMfa(platform, { sessionId: otherSession, userId: op.userId, method: "totp" });
    const proof = await issueStepUpProof(platform, bind);
    for (const bad of [{ sessionId: otherSession }, { actionKey: "refund.approve_transfer" }, { subjectKind: "refund" }, { subjectId: "43" }, { userId: "someone-else" }]) {
      await expect(inTx((tx) => consumeStepUpProof(tx, proof, { ...bind, ...bad }))).rejects.toMatchObject({ code: "reauth_required" });
    }
    await expect(inTx((tx) => consumeStepUpProof(tx, "not-a-uuid", bind))).rejects.toMatchObject({ code: "reauth_required" });
    expect((await platform.select().from(operatorStepUpProof))[0]!.consumedAt).toBeNull(); // wrong bindings did not burn it
    await inTx((tx) => consumeStepUpProof(tx, proof, bind));
    await expect(inTx((tx) => consumeStepUpProof(tx, proof, bind))).rejects.toMatchObject({ code: "reauth_required" });
  });

  it("is consumed with the write: a failed write leaves it usable, two concurrent writes use it once, expiry and session end kill it", async () => {
    const { bind, sessionId } = await fresh();
    const proof = await issueStepUpProof(platform, bind);
    await expect(inTx(async (tx) => {
      await consumeStepUpProof(tx, proof, bind);
      throw new Error("write failed");
    })).rejects.toThrow("write failed");
    expect((await platform.select().from(operatorStepUpProof).where(eq(operatorStepUpProof.id, proof)))[0]!.consumedAt).toBeNull();

    const race = await Promise.allSettled([inTx((tx) => consumeStepUpProof(tx, proof, bind)), inTx((tx) => consumeStepUpProof(tx, proof, bind)), inTx((tx) => consumeStepUpProof(tx, proof, bind))]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const expired = await issueStepUpProof(platform, bind);
    await platform.update(operatorStepUpProof).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(operatorStepUpProof.id, expired));
    await expect(inTx((tx) => consumeStepUpProof(tx, expired, bind))).rejects.toMatchObject({ code: "reauth_required" });

    const orphan = await issueStepUpProof(platform, bind);
    await platform.delete(session).where(eq(session.id, sessionId));
    expect(await platform.select().from(operatorStepUpProof).where(eq(operatorStepUpProof.id, orphan))).toHaveLength(0);
  });
});

describe("granting and revoking capabilities (IAM-15)", () => {
  it("needs staff.manage; every change writes its event and revokes the operator's sessions in the same transaction", async () => {
    const boss = await makeOperator(["staff.manage"]);
    const nobody = await makeOperator([]);
    const target = await makeOperator([]);
    const bystander = await makeOperator([]);
    const s1 = await newSession(target.userId);
    await recordSessionMfa(platform, { sessionId: s1, userId: target.userId, method: "totp" });
    await newSession(target.userId);
    await newSession(bystander.userId);

    await expect(grantCapability(nobody, { userId: target.userId, capability: "logs.read", reason: "uji hibah" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await sessionsOf(target.userId)).toBe(2);

    await grantCapability(boss, { userId: target.userId, capability: "logs.read", reason: "uji hibah" });
    expect(await holdsCapability(platform, target.userId, "logs.read")).toBe(true);
    expect(await sessionsOf(target.userId)).toBe(0); // a grant change signs the operator out
    expect(await sessionsOf(bystander.userId)).toBe(1); // nobody else is touched

    await newSession(target.userId);
    await revokeCapability(boss, { userId: target.userId, capability: "logs.read", reason: "uji pencabutan" });
    expect(await holdsCapability(platform, target.userId, "logs.read")).toBe(false);
    expect(await sessionsOf(target.userId)).toBe(0);

    const events = await platform.select().from(operatorGrantEvent).where(eq(operatorGrantEvent.operatorUserId, target.userId)).orderBy(asc(operatorGrantEvent.id));
    expect(events.map((e) => [e.action, e.capability, e.source, e.actorUserId])).toEqual([
      ["grant", "logs.read", "product", boss.userId],
      ["revoke", "logs.read", "product", boss.userId],
    ]);
    await expect(grantCapability(boss, { userId: target.userId, capability: "not.a.capability", reason: "uji hibah" })).rejects.toThrow();
    await expect(grantCapability(boss, { userId: target.userId, capability: "compliance.read", reason: "uji hibah" })).rejects.toMatchObject({ code: "dormant" });
    await grantCapability(boss, { userId: boss.userId, capability: "logs.read", reason: "uji hibah" });
    await expect(grantCapability(boss, { userId: boss.userId, capability: "logs.read", reason: "uji hibah" })).rejects.toMatchObject({ code: "conflict" });
    await expect(grantCapability(boss, { userId: "no-such-user", capability: "logs.read", reason: "uji hibah" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("a refused revocation (last holder) keeps the grant, the event log and the sessions untouched", async () => {
    const only = await makeOperator(["staff.manage"]);
    const keep = await newSession(only.userId);
    await expect(revokeCapability(only, { userId: only.userId, capability: "staff.manage", reason: "uji pemegang terakhir" })).rejects.toMatchObject({ code: "last_holder" });
    expect(await holders("staff.manage")).toEqual([only.userId]);
    expect(await sessionsOf(only.userId)).toBe(1);
    expect(await platform.select().from(operatorGrantEvent).where(eq(operatorGrantEvent.action, "revoke"))).toHaveLength(0);
  });

  it("a sensitive capability needs an approved grant.sensitive request bound to that grant; the approver is neither requester nor grantee", async () => {
    const boss = await makeOperator(["staff.manage"]);
    const second = await makeOperator(["staff.manage"]);
    const target = await makeOperator([]);
    const input = { userId: target.userId, capability: "payouts.process" as const, reason: "uji hibah sensitif" };
    await expect(grantCapability(boss, input)).rejects.toMatchObject({ code: "approval_required" });
    const req = await requestApproval(boss, { actionKey: "grant.sensitive", targetKind: "operator", targetId: target.userId, payload: { userId: target.userId, capability: "payouts.process", expiresAt: null }, reason: "uji hibah sensitif" });
    expect(req.payloadSha256).toBe(grantPayloadHash({ userId: target.userId, capability: "payouts.process" }));
    await expect(grantCapability(boss, { ...input, approvalRequestId: req.id })).rejects.toMatchObject({ code: "approval_invalid" }); // not approved yet
    await decideApproval(second, req.id, "approve");
    // A different capability is not covered by this approval.
    await expect(grantCapability(boss, { ...input, capability: "refunds.process", approvalRequestId: req.id })).rejects.toMatchObject({ code: "approval_invalid" });
    // Another staff member cannot use boss's approval.
    await expect(grantCapability(second, { ...input, approvalRequestId: req.id })).rejects.toMatchObject({ code: "approval_invalid" });
    expect(await statusOf(req.id)).toBe("approved");
    await grantCapability(boss, { ...input, approvalRequestId: req.id });
    expect(await statusOf(req.id)).toBe("executed");
    const [event] = await platform.select().from(operatorGrantEvent).where(and(eq(operatorGrantEvent.operatorUserId, target.userId), eq(operatorGrantEvent.action, "grant")));
    expect(event).toMatchObject({ source: "product", actorUserId: boss.userId, approvalRequestId: req.id });
    // The approval is spent: the same grant cannot be replayed.
    await revokeCapability(boss, { userId: target.userId, capability: "payouts.process", reason: "uji ulang" });
    await expect(grantCapability(boss, { ...input, approvalRequestId: req.id })).rejects.toMatchObject({ code: "approval_invalid" });
  });

  it("the grantee cannot be the approver of their own sensitive grant (the transaction rolls back, the approval stays unused)", async () => {
    const boss = await makeOperator(["staff.manage"]);
    const grantee = await makeOperator(["staff.manage"]);
    const req = await requestApproval(boss, { actionKey: "grant.sensitive", targetKind: "operator", targetId: grantee.userId, payload: { userId: grantee.userId, capability: "ledger.adjust", expiresAt: null }, reason: "uji penerima = penyetuju" });
    await decideApproval(grantee, req.id, "approve");
    await expect(grantCapability(boss, { userId: grantee.userId, capability: "ledger.adjust", reason: "uji penerima = penyetuju", approvalRequestId: req.id })).rejects.toMatchObject({ code: "self_approval" });
    expect(await holdsCapability(platform, grantee.userId, "ledger.adjust")).toBe(false);
    expect(await statusOf(req.id)).toBe("approved");
  });

  it("revoking a capability also removes break_glass.approve safely: the last holder of each protected capability stays", async () => {
    const boss = await makeOperator(["staff.manage"]);
    const bg = await makeOperator(["break_glass.approve"]);
    await expect(revokeCapability(boss, { userId: bg.userId, capability: "break_glass.approve", reason: "uji pemegang terakhir" })).rejects.toMatchObject({ code: "last_holder" });
    await expect(revokeCapability(boss, { userId: boss.userId, capability: "logs.read", reason: "uji tidak ada" })).rejects.toMatchObject({ code: "not_found" });
    // An expired holder does not count as active, so the live one is the last.
    const expired = await makeOperator([]);
    await platform.insert(operatorGrant).values({ userId: expired.userId, capability: "break_glass.approve", expiresAt: new Date(Date.now() - 1000) });
    await expect(revokeCapability(boss, { userId: bg.userId, capability: "break_glass.approve", reason: "uji kedaluwarsa" })).rejects.toMatchObject({ code: "last_holder" });
  });
});

describe("the last holder of a critical capability cannot be removed, with holders locked in a fixed order (D-21)", { timeout: 60_000 }, () => {
  async function blockedOnLock() {
    for (let i = 0; i < 400; i++) {
      const rows = (await admin.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)) as unknown as { n: number }[];
      if (rows[0]!.n > 0) return;
      await sleep(25);
    }
    throw new Error("the second demotion never queued on the holder lock");
  }

  it("deterministic: a demotion that queues behind the first one re-reads the survivors and aborts as the last holder", async () => {
    const z1 = await makeOperator(["staff.manage"]);
    const z2 = await makeOperator(["staff.manage"]);
    const a = await makeOperator(["break_glass.approve"]);
    const b = await makeOperator(["break_glass.approve"]);
    const [first, second] = [a.userId, b.userId].sort();
    let queued: Promise<unknown> | undefined;
    await platform.transaction(async (tx) => {
      // Demotion 1 holds every holder row (primary-key order) and removes the first one.
      await tx.select().from(operatorGrant).where(eq(operatorGrant.capability, "break_glass.approve")).orderBy(asc(operatorGrant.userId)).for("update");
      await tx.delete(operatorGrant).where(and(eq(operatorGrant.capability, "break_glass.approve"), eq(operatorGrant.userId, first!)));
      // Demotion 2 (of the other holder) must queue, not read the pre-demotion state.
      queued = revokeCapability(z2, { userId: second!, capability: "break_glass.approve", reason: "uji demosi serentak" }).then(() => "revoked", (e: { code: string }) => e.code);
      await blockedOnLock();
    });
    expect(await queued).toBe("last_holder");
    expect(await holders("break_glass.approve")).toEqual([second]);
  });

  it("two simultaneous demotions of the only two break_glass.approve holders: exactly one aborts, one holder remains (repeated)", async () => {
    const z1 = await makeOperator(["staff.manage"]);
    const z2 = await makeOperator(["staff.manage"]);
    for (let round = 0; round < 8; round++) {
      const a = await makeOperator(["break_glass.approve"]);
      const b = await makeOperator(["break_glass.approve"]);
      const results = await Promise.allSettled([
        revokeCapability(z1, { userId: a.userId, capability: "break_glass.approve", reason: "uji demosi serentak" }),
        revokeCapability(z2, { userId: b.userId, capability: "break_glass.approve", reason: "uji demosi serentak" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")[0]).toMatchObject({ reason: { code: "last_holder" } });
      expect(await holders("break_glass.approve")).toHaveLength(1);
      await platform.delete(operatorGrant).where(eq(operatorGrant.capability, "break_glass.approve"));
    }
  });

  it("two staff.manage holders demoting each other at once: one demotion lands, the other is refused, one holder always remains", async () => {
    for (let round = 0; round < 8; round++) {
      const a = await makeOperator(["staff.manage"]);
      const b = await makeOperator(["staff.manage"]);
      const results = await Promise.allSettled([
        revokeCapability(a, { userId: b.userId, capability: "staff.manage", reason: "uji demosi serentak" }),
        revokeCapability(b, { userId: a.userId, capability: "staff.manage", reason: "uji demosi serentak" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")[0]).toMatchObject({ reason: { code: expect.stringMatching(/^(forbidden|last_holder)$/) } });
      expect(await holders("staff.manage")).toHaveLength(1);
      await platform.delete(operatorGrant).where(eq(operatorGrant.capability, "staff.manage"));
    }
  });

  it("a holder demoted by someone else loses the right to demote anyone else in the same breath", async () => {
    const a = await makeOperator(["staff.manage"]);
    const b = await makeOperator(["staff.manage"]);
    const c = await makeOperator(["staff.manage", "logs.read"]);
    await revokeCapability(a, { userId: b.userId, capability: "staff.manage", reason: "uji demosi" });
    await expect(revokeCapability(b, { userId: c.userId, capability: "logs.read", reason: "uji hak habis" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await hasPlatformCap(c, "logs.read")).toBe(true);
  });
});

describe("bootstrap and recovery (IAM-15)", () => {
  async function account(name: string) {
    const id = await makeUser(name);
    const [row] = await platform.select({ email: user.email }).from(user).where(eq(user.id, id));
    return { id, email: row!.email };
  }

  it("creates the first staff.manage and break_glass.approve holders with system_bootstrap events and no actor or approval", async () => {
    const one = await account("first");
    const two = await account("second");
    const done = await bootstrapConsole(platform, { emails: [one.email.toUpperCase(), ` ${two.email} `], runbook: "RB-1 dua orang bernama" });
    expect(done.map((d) => d.granted)).toEqual([[...BOOTSTRAP_CAPABILITIES], [...BOOTSTRAP_CAPABILITIES]]);
    expect(await holders("staff.manage")).toEqual([one.id, two.id].sort());
    expect(await holders("break_glass.approve")).toEqual([one.id, two.id].sort());
    expect((await platform.select().from(platformOperator)).map((o) => o.userId).sort()).toEqual([one.id, two.id].sort());
    const events = await platform.select().from(operatorGrantEvent);
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.source === "system_bootstrap" && e.action === "grant" && e.actorUserId === null && e.approvalRequestId === null && e.reason.includes("RB-1"))).toBe(true);
  });

  it("recovery records system_recovery, revokes the holder's sessions and is idempotent", async () => {
    const one = await account("lonely");
    await bootstrapConsole(platform, { emails: [one.email], runbook: "RB-1" });
    await platform.delete(operatorGrant).where(eq(operatorGrant.userId, one.id));
    await newSession(one.id);
    const done = await bootstrapConsole(platform, { emails: [one.email], runbook: "RB-9 pemulihan", recovery: true });
    expect(done[0]!.granted).toEqual([...BOOTSTRAP_CAPABILITIES]);
    expect(await sessionsOf(one.id)).toBe(0);
    const recovery = (await platform.select().from(operatorGrantEvent)).filter((e) => e.source === "system_recovery");
    expect(recovery).toHaveLength(2);
    expect((await bootstrapConsole(platform, { emails: [one.email], runbook: "RB-9 pemulihan", recovery: true }))[0]!.granted).toEqual([]);
    expect(await platform.select().from(operatorGrantEvent)).toHaveLength(4);
  });

  it("refuses when two or more active staff.manage holders exist, and changes nothing", async () => {
    const a = await makeOperator(["staff.manage"]);
    const b = await makeOperator(["staff.manage"]);
    const fresh = await account("newcomer");
    await expect(bootstrapConsole(platform, { emails: [fresh.email], runbook: "RB-2" })).rejects.toMatchObject({ code: "refused" });
    await expect(bootstrapConsole(platform, { emails: [fresh.email], runbook: "RB-2", recovery: true })).rejects.toMatchObject({ code: "refused" });
    expect(await holders("staff.manage")).toEqual([a.userId, b.userId].sort());
    expect(await platform.select().from(platformOperator).where(eq(platformOperator.userId, fresh.id))).toHaveLength(0);
    // An expired holder is not active: with one live holder the command runs again.
    await platform.update(operatorGrant).set({ expiresAt: new Date(Date.now() - 1000) }).where(and(eq(operatorGrant.userId, b.userId), eq(operatorGrant.capability, "staff.manage")));
    await expect(bootstrapConsole(platform, { emails: [fresh.email], runbook: "RB-2" })).resolves.toHaveLength(1);
  });

  it("rejects unknown accounts and a missing runbook entry with no partial effect", async () => {
    const real = await account("real");
    await expect(bootstrapConsole(platform, { emails: [real.email, "ghost@test.local"], runbook: "RB-3" })).rejects.toMatchObject({ code: "not_found" });
    expect(await platform.select().from(platformOperator)).toHaveLength(0);
    expect(await platform.select().from(operatorGrantEvent)).toHaveLength(0);
    await expect(bootstrapConsole(platform, { emails: [real.email], runbook: " " })).rejects.toMatchObject({ code: "invalid" });
    await expect(bootstrapConsole(platform, { emails: [], runbook: "RB-3" })).rejects.toMatchObject({ code: "invalid" });
  });
});
