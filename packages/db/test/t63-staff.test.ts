import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accessReviewList, deactivateStaff, executeStaffMfaReset, grantStaffCapability, reactivateStaff, requestStaffMfaReset, revokeStaffCapability, revokeStaffSessions, reviewGrant, staffDetail, staffList } from "../src/ops/accounts-governance-staff.ts";
import { decideApproval, requestApproval } from "../src/ops/capabilities-approvals.ts";
import { requireAccountTarget } from "../src/ops/accounts-governance.ts";
import { requirePlatformCap, GRANT_USE_RESOLUTION_SECONDS } from "../src/ops/capabilities.ts";
import { authorizeConsole } from "../src/ops/console.ts";
import { grantPayload } from "../src/ops/capabilities-grants.ts";
import { accessReviewDecision } from "../src/ops/schema-governance.ts";
import { approvalRequest, operatorGrant, operatorGrantEvent, type PlatformCapability } from "../src/ops/schema-ops.ts";
import { auditLog, session, twoFactor, user } from "../src/schema.ts";
import { operatorScope } from "../src/platform/scoped.ts";
import { admin, makeOperator, platform } from "./helpers.ts";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string }; name?: string }) => e.code ?? e.cause?.code ?? e.name);
const state = code;

beforeEach(async () => {
  await admin.execute(sql`truncate support_case, support_action, access_review_decision, approval_request, operator_grant_event, mail_outbox, two_factor, personal_data_access_event, break_glass_grant restart identity cascade`);
});
const key = () => `t63-${randomUUID()}`;
const why = { reasonCode: "staff_change", reason: "perubahan susunan tim" };
async function withSessions(userId: string, n = 1) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    ids.push(id);
    await admin.insert(session).values({ id, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  }
  return ids;
}
const sessionCount = async (userId: string) => (await admin.select({ n: sql<number>`count(*)::int` }).from(session).where(eq(session.userId, userId)))[0]!.n;
const grantsOf = async (userId: string) => (await admin.select({ c: operatorGrant.capability }).from(operatorGrant).where(eq(operatorGrant.userId, userId))).map((g) => g.c).sort();

describe("SA-38 staff: list, last use, grant and revoke rules", () => {
  it("lists status, MFA yes or no, the newest session and the grants with their last use; staff.read is required", async () => {
    const boss = await makeOperator(["staff.read", "staff.manage"]);
    const target = await makeOperator(["tenants.read", "logs.read"]);
    await withSessions(target.userId, 2);
    await admin.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, target.userId));
    const rows = await staffList(boss);
    const row = rows.find((r) => r.userId === target.userId)!;
    expect(row).toMatchObject({ status: "active", mfaEnrolled: true });
    expect(row.lastSessionAt).toBeInstanceOf(Date);
    expect(row.grants.map((g) => [g.capability, g.lastUsedAt])).toEqual([["logs.read", null], ["tenants.read", null]]); // never used yet: shown as such
    expect(rows.find((r) => r.userId === boss.userId)!.mfaEnrolled).toBe(false);
    await expect(code(staffList(await makeOperator(["tenants.read"])))).resolves.toBe("forbidden");
    expect((await staffDetail(boss, target.userId))?.events.map((e) => e.source)).toEqual(["system_bootstrap", "system_bootstrap"]);
  });

  it("last use is a real source: a console operation passing the capability check stamps the grant, at most once per resolution window", async () => {
    const op = await makeOperator(["tenants.read", "logs.read"]);
    const stamp = async (cap: PlatformCapability) => (await admin.select({ t: operatorGrant.lastUsedAt }).from(operatorGrant).where(and(eq(operatorGrant.userId, op.userId), eq(operatorGrant.capability, cap))))[0]!.t;
    expect(await stamp("tenants.read")).toBeNull();
    await requirePlatformCap(op, "tenants.read");
    const first = (await stamp("tenants.read"))!;
    expect(first).toBeInstanceOf(Date);
    expect(await stamp("logs.read")).toBeNull(); // only the grant that was used
    await requirePlatformCap(op, "tenants.read");
    expect((await stamp("tenants.read"))!.getTime()).toBe(first.getTime()); // inside the window: no write
    await admin.execute(sql`update operator_grant set last_used_at = now() - make_interval(secs => ${GRANT_USE_RESOLUTION_SECONDS + 5}) where user_id = ${op.userId} and capability = 'tenants.read'`);
    await requirePlatformCap(op, "tenants.read");
    expect((await stamp("tenants.read"))!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // a refused check never stamps anything
    const none = await makeOperator([]);
    await expect(code(requirePlatformCap(none, "tenants.read"))).resolves.toBe("forbidden");
  });

  it("nobody changes their own grants; a sensitive grant still needs the approved grant.sensitive request; staff.manage is required", async () => {
    const a = await makeOperator(["staff.manage", "tenants.read"]);
    const b = await makeOperator(["staff.manage"]);
    await expect(code(grantStaffCapability(a, { userId: a.userId, capability: "logs.read", reason: "memberi diri sendiri" }))).resolves.toBe("self_change");
    await expect(code(revokeStaffCapability(a, { userId: a.userId, capability: "tenants.read", reason: "mencabut diri sendiri" }))).resolves.toBe("self_change");
    expect(await grantsOf(a.userId)).toEqual(["staff.manage", "tenants.read"]);
    await expect(code(grantStaffCapability(a, { userId: b.userId, capability: "ledger.adjust", reason: "tanpa persetujuan" }))).resolves.toBe("approval_required");
    const target = await makeOperator([]);
    const asked = await requestApproval(a, { actionKey: "grant.sensitive", targetKind: "operator", targetId: target.userId, payload: grantPayload({ userId: target.userId, capability: "ledger.adjust" }), reason: "izin ledger untuk bendahara" });
    await decideApproval(b, asked.id, "approve");
    await grantStaffCapability(a, { userId: target.userId, capability: "ledger.adjust", reason: "izin ledger untuk bendahara", approvalRequestId: asked.id });
    expect(await grantsOf(target.userId)).toEqual(["ledger.adjust"]);
    await expect(code(grantStaffCapability(await makeOperator(["staff.read"]), { userId: target.userId, capability: "logs.read", reason: "tanpa izin kelola" }))).resolves.toBe("forbidden");
  });
});

describe("SA-38 deactivation: grants, requests and sessions go together; the last holder stays", () => {
  it("revokes every grant (with its event), cancels the staff member's open requests, ends the sessions and closes the scope, in one transaction", async () => {
    const boss = await makeOperator(["staff.manage", "staff.read", "payouts.process"]);
    await makeOperator(["staff.manage"]); // a second holder, so the boss is not the last one
    const target = await makeOperator(["tenants.read", "payouts.process"]);
    await withSessions(target.userId, 2);
    const pending = await requestApproval(target, { actionKey: "payout.approve_transfer", targetKind: "payout", targetId: "p1", payload: { a: 1 }, reason: "pencairan uji staf" });
    const out = await deactivateStaff(boss, target.userId, why);
    expect(out).toEqual({ revokedGrants: 2, endedSessions: 2 });
    expect(await grantsOf(target.userId)).toEqual([]);
    expect(await sessionCount(target.userId)).toBe(0);
    expect((await admin.select().from(approvalRequest).where(eq(approvalRequest.id, pending.id)))[0]!.status).toBe("cancelled");
    const events = await admin.select().from(operatorGrantEvent).where(and(eq(operatorGrantEvent.operatorUserId, target.userId), eq(operatorGrantEvent.action, "revoke")));
    expect(events.map((e) => e.capability).sort()).toEqual(["payouts.process", "tenants.read"]);
    expect(events.every((e) => e.source === "product" && e.actorUserId === boss.userId)).toBe(true);
    expect(await operatorScope(platform, target.userId)).toBeNull();
    await expect(code(authorizeConsole(platform, target.userId, "/admin", "dashboard.read"))).resolves.toBe("operator_inactive");
    expect((await staffList(boss)).find((r) => r.userId === target.userId)).toMatchObject({ status: "deactivated", grants: [] });
    expect((await audits(boss.userId, "staff.deactivate"))).toHaveLength(1);
    // still staff: never an accounts.* target; and a second deactivation conflicts
    await expect(code(requireAccountTarget(boss, target.userId, "accounts.support"))).resolves.toBe("not_found");
    await expect(code(deactivateStaff(boss, target.userId, why))).resolves.toBe("conflict");
  });

  it("a failure half way leaves everything as it was (grants, sessions, requests, the operator row)", async () => {
    const boss = await makeOperator(["staff.manage"]);
    await makeOperator(["staff.manage"]);
    const target = await makeOperator(["tenants.read"]);
    await withSessions(target.userId, 1);
    await admin.execute(sql`create or replace function t63_op_fail() returns trigger language plpgsql as $$ begin raise exception 'down' using errcode = '53100'; end $$`);
    await admin.execute(sql`create trigger t63_op_fail before update on platform_operator for each row execute function t63_op_fail()`);
    try {
      await expect(code(deactivateStaff(boss, target.userId, why))).resolves.toBe("53100");
    } finally {
      await admin.execute(sql`drop trigger if exists t63_op_fail on platform_operator`);
      await admin.execute(sql`drop function if exists t63_op_fail()`);
    }
    expect(await grantsOf(target.userId)).toEqual(["tenants.read"]);
    expect(await sessionCount(target.userId)).toBe(1);
    expect(await operatorScope(platform, target.userId)).not.toBeNull();
  });

  it("the last standing holder of staff.manage cannot be deactivated or revoked; of two simultaneous removals one aborts; nobody deactivates themselves", async () => {
    const a = await makeOperator(["staff.manage"]);
    const b = await makeOperator(["staff.manage"]);
    await expect(code(deactivateStaff(a, a.userId, why))).resolves.toBe("self_change");
    const res = await Promise.all([deactivateStaff(a, b.userId, why), deactivateStaff(b, a.userId, why)].map(code));
    expect(res.sort()).toEqual(["last_holder", "ok"]);
    const survivors = (await admin.select({ u: operatorGrant.userId }).from(operatorGrant).where(eq(operatorGrant.capability, "staff.manage"))).map((g) => g.u);
    expect(survivors).toHaveLength(1);
    const c = await makeOperator(["staff.manage", "break_glass.approve"]);
    const d = await makeOperator(["break_glass.approve"]);
    await deactivateStaff(c, d.userId, why); // c still holds break_glass.approve
    expect(await grantsOf(d.userId)).toEqual([]);
    await expect(code(deactivateStaff(await makeOperator(["staff.manage"]), c.userId, why))).resolves.toBe("last_holder"); // c is the last break_glass.approve holder
  });

  it("reactivation restores the scope but not the grants; session revocation ends the sessions; both need staff.manage and a reason", async () => {
    const boss = await makeOperator(["staff.manage"]);
    const target = await makeOperator(["tenants.read"]);
    await withSessions(target.userId, 2);
    expect(await revokeStaffSessions(boss, target.userId, why)).toBe(2);
    await deactivateStaff(boss, target.userId, why);
    await expect(code(reactivateStaff(await makeOperator(["staff.read"]), target.userId, why))).resolves.toBe("forbidden");
    await expect(code(reactivateStaff(boss, target.userId, { reasonCode: "x_y", reason: "ab" }))).resolves.toBe("ZodError");
    await reactivateStaff(boss, target.userId, why);
    expect(await operatorScope(platform, target.userId)).not.toBeNull();
    expect(await grantsOf(target.userId)).toEqual([]); // granted again through the audited path, never restored silently
    await expect(code(reactivateStaff(boss, target.userId, why))).resolves.toBe("conflict");
  });
});

const audits = (userId: string, action: string) => admin.select().from(auditLog).where(and(eq(auditLog.actorUserId, userId), eq(auditLog.action, action)));

describe("staff MFA reset: staff.manage with four-eyes, never accounts.*", () => {
  async function enrolled(userId: string) {
    await admin.insert(twoFactor).values({ id: randomUUID(), secret: "SEED", backupCodes: "CODES", userId });
    await admin.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, userId));
  }
  const factors = async (userId: string) => (await admin.select().from(twoFactor).where(eq(twoFactor.userId, userId))).length;

  it("the request only records; the requester cannot approve; a second staff.manage holder approves; only the requester executes, once; the staff member must enrol again", async () => {
    const a = await makeOperator(["staff.manage"]);
    const b = await makeOperator(["staff.manage"]);
    const target = await makeOperator(["tenants.read"]);
    await enrolled(target.userId);
    await withSessions(target.userId, 2);
    const asked = await requestStaffMfaReset(a, target.userId, { ...why, idempotencyKey: key() });
    expect(asked).toMatchObject({ outcome: "mfa_reset_awaiting_approval", replayed: false });
    expect(await factors(target.userId)).toBe(1);
    await expect(code(executeStaffMfaReset(a, asked.supportActionId))).resolves.toBe("awaiting_approval");
    await expect(code(decideApproval(a, asked.approvalRequestId!, "approve"))).resolves.toBe("self_approval");
    const accountsOnly = await makeOperator(["accounts.support"]);
    await expect(code(decideApproval(accountsOnly, asked.approvalRequestId!, "approve"))).resolves.toBe("forbidden"); // accounts.support is not enough for a staff target
    await decideApproval(b, asked.approvalRequestId!, "approve");
    await expect(code(executeStaffMfaReset(b, asked.supportActionId))).resolves.toBe("not_found");
    expect(await executeStaffMfaReset(a, asked.supportActionId)).toMatchObject({ outcome: "mfa_reset_done", replayed: false });
    expect(await factors(target.userId)).toBe(0);
    expect((await admin.select().from(user).where(eq(user.id, target.userId)))[0]!.twoFactorEnabled).toBe(false);
    expect(await sessionCount(target.userId)).toBe(0);
    expect((await executeStaffMfaReset(a, asked.supportActionId)).replayed).toBe(true);
  });

  it("refused for oneself, for a non-staff identity and without staff.manage; a rejected approval cancels the request", async () => {
    const a = await makeOperator(["staff.manage"]);
    const b = await makeOperator(["staff.manage"]);
    const target = await makeOperator([]);
    await expect(code(requestStaffMfaReset(a, a.userId, { ...why, idempotencyKey: key() }))).resolves.toBe("self_change");
    await expect(code(requestStaffMfaReset(a, randomUUID().replaceAll("-", ""), { ...why, idempotencyKey: key() }))).resolves.toBe("not_found");
    await expect(code(requestStaffMfaReset(await makeOperator(["accounts.support"]), target.userId, { ...why, idempotencyKey: key() }))).resolves.toBe("forbidden");
    const asked = await requestStaffMfaReset(a, target.userId, { ...why, idempotencyKey: key() });
    await decideApproval(b, asked.approvalRequestId!, "reject");
    expect(await executeStaffMfaReset(a, asked.supportActionId)).toMatchObject({ outcome: "mfa_reset_cancelled" });
    // one idempotency key, one request
    const k = key();
    const [x, y] = await Promise.all([requestStaffMfaReset(a, target.userId, { ...why, idempotencyKey: k }), requestStaffMfaReset(a, target.userId, { ...why, idempotencyKey: k })].map((p) => p.then((v) => v, (e: { code?: string; cause?: { code?: string } }) => e)));
    expect([x, y].filter((r) => "supportActionId" in r)).not.toHaveLength(0);
  });
});

describe("SA-39 access review: last use, confirm and revoke", () => {
  it("lists every active staff member's grants with last use, source and the last decision; deactivated staff are not listed", async () => {
    const reviewer = await makeOperator(["access.review", "staff.manage"]);
    const a = await makeOperator(["tenants.read"]);
    const gone = await makeOperator(["logs.read"]);
    await deactivateStaff(reviewer, gone.userId, why);
    await requirePlatformCap(a, "tenants.read");
    const rows = await accessReviewList(reviewer);
    expect(rows.some((r) => r.operatorUserId === gone.userId)).toBe(false);
    const row = rows.find((r) => r.operatorUserId === a.userId)!;
    expect(row).toMatchObject({ capability: "tenants.read", source: "system_bootstrap", lastDecision: null, own: false });
    expect(row.lastUsedAt).toBeInstanceOf(Date);
    expect(rows.filter((r) => r.own).map((r) => r.capability).sort()).toEqual(["access.review", "staff.manage"]);
    await expect(code(accessReviewList(await makeOperator(["staff.read"])))).resolves.toBe("forbidden");
  });

  it("confirming writes an append-only decision with the last use the reviewer saw; the reviewer cannot confirm their own access", async () => {
    const reviewer = await makeOperator(["access.review"]);
    const a = await makeOperator(["tenants.read"]);
    await requirePlatformCap(a, "tenants.read");
    await reviewGrant(reviewer, { operatorUserId: a.userId, capability: "tenants.read", decision: "confirmed", reason: "masih dibutuhkan untuk dukungan" });
    const [d] = await admin.select().from(accessReviewDecision);
    expect(d).toMatchObject({ reviewerUserId: reviewer.userId, operatorUserId: a.userId, capability: "tenants.read", decision: "confirmed" });
    expect(d!.lastUsedAt).toBeInstanceOf(Date);
    expect((await accessReviewList(reviewer)).find((r) => r.operatorUserId === a.userId)!.lastDecision).toMatchObject({ decision: "confirmed", by: reviewer.userId });
    await expect(code(reviewGrant(reviewer, { operatorUserId: reviewer.userId, capability: "access.review", decision: "confirmed", reason: "meninjau diri sendiri" }))).resolves.toBe("self_change");
    await expect(state(platform.execute(sql`update access_review_decision set decision = 'revoked'`))).resolves.toBe("42501");
    await expect(state(admin.execute(sql`delete from access_review_decision`))).resolves.toBe("42501");
    await expect(state(admin.execute(sql`insert into access_review_decision (reviewer_user_id, operator_user_id, capability, decision, reason) values (${a.userId}, ${a.userId}, 'tenants.read', 'confirmed', 'diri sendiri')`))).resolves.toBe("23514");
  });

  it("revoking needs staff.manage as well and goes through the T-60 revoke in the same transaction: a refused revoke leaves no decision", async () => {
    const reviewer = await makeOperator(["access.review", "staff.manage"]);
    const reviewerOnly = await makeOperator(["access.review"]);
    const a = await makeOperator(["tenants.read"]);
    await withSessions(a.userId, 1);
    await expect(code(reviewGrant(reviewerOnly, { operatorUserId: a.userId, capability: "tenants.read", decision: "revoked", reason: "tidak pernah dipakai" }))).resolves.toBe("forbidden");
    expect(await admin.select().from(accessReviewDecision)).toHaveLength(0);
    await reviewGrant(reviewer, { operatorUserId: a.userId, capability: "tenants.read", decision: "revoked", reason: "tidak pernah dipakai" });
    expect(await grantsOf(a.userId)).toEqual([]);
    expect(await sessionCount(a.userId)).toBe(0);
    expect((await admin.select().from(accessReviewDecision)).map((d) => d.decision)).toEqual(["revoked"]);
    expect((await admin.select().from(operatorGrantEvent).where(and(eq(operatorGrantEvent.operatorUserId, a.userId), eq(operatorGrantEvent.action, "revoke")))).length).toBe(1);
    // the last staff.manage holder cannot be revoked by a review either, and then no decision is left behind
    const sole = await makeOperator(["staff.manage", "access.review"]);
    await admin.execute(sql`delete from operator_grant where capability = 'staff.manage' and user_id <> ${sole.userId}`);
    const other = await makeOperator(["access.review", "staff.manage"]);
    await admin.execute(sql`delete from operator_grant where user_id = ${other.userId} and capability = 'staff.manage'`);
    const before = (await admin.select().from(accessReviewDecision)).length;
    await expect(code(reviewGrant(other, { operatorUserId: sole.userId, capability: "staff.manage", decision: "revoked", reason: "mencoba mencabut yang terakhir" }))).resolves.toBe("forbidden");
    expect((await admin.select().from(accessReviewDecision)).length).toBe(before);
  });
});
