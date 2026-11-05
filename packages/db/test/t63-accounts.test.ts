import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_PROJECTIONS, accountDiagnostics, canonicalizeQuery, searchAccounts } from "../src/ops/accounts-governance-accounts.ts";
import { maskEmail, maskName, queryFingerprint } from "../src/ops/accounts-governance.ts";
import { openCase, moveCase } from "../src/ops/accounts-governance-cases.ts";
import { activeRevealedFields, activateBreakGlass, breakGlassReviewQueue, requestBreakGlass, revealAccountField, reviewBreakGlass, revokeBreakGlass } from "../src/ops/accounts-governance-reveal.ts";
import { executeMfaReset, recoverStoreOwnership, redeemSupportRecovery, requestMfaReset, revokeUserSessions, setIdentitySuspension, startSupportRecovery } from "../src/ops/accounts-governance-support.ts";
import { decideApproval, requestApproval } from "../src/ops/capabilities-approvals.ts";
import { consoleAccessEvents } from "../src/ops/console.ts";
import { withPersonalDataAccess } from "../src/ops/console-access.ts";
import { auditLog, mailOutbox, session, systemLog, twoFactor, user } from "../src/schema.ts";
import { sellerContext, type OperatorScope } from "../src/platform/scoped.ts";
import { supportAction, supportRecoveryLink, accountStatusEvent } from "../src/ops/schema-governance.ts";
import { operatorGrant, breakGlassGrant } from "../src/ops/schema-ops.ts";
import { admin, db, makeOperator, makeStore, makeUser, platform } from "./helpers.ts";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string }; name?: string }) => e.code ?? e.cause?.code ?? e.name);
const state = (p: Promise<unknown>) => p.then(() => "ok", (e: { cause?: { code?: string }; code?: string }) => e.cause?.code ?? e.code);

beforeEach(async () => {
  await admin.execute(sql`truncate support_case, support_case_note, account_status_event, account_verification, store_risk_ack, support_action, access_review_decision, support_recovery_link, personal_data_access_event, break_glass_grant, approval_request, operator_grant_event, mail_outbox, two_factor, system_log restart identity cascade`);
});

const SUPPORT = ["accounts.read", "accounts.support", "accounts.suspend", "accounts.reveal", "cases.read", "cases.write", "audit.read"] as const;
const key = () => `t63-${randomUUID()}`;
const RAW = "Siti Rahayu";

/** A seller team member of a store, with a verified e-mail and `n` live sessions. */
async function seller(slug: string, role: "owner" | "staff" = "staff", sessions = 1) {
  const s = await makeStore(slug);
  const userId = role === "owner" ? s.ownerId : await makeUser(`${slug}-anggota`);
  await admin.update(user).set({ name: RAW, emailVerified: true }).where(eq(user.id, userId));
  if (role === "staff") await admin.execute(sql`insert into membership (store_id, user_id, role) values (${s.storeId}, ${userId}, 'staff')`);
  for (let i = 0; i < sessions; i++) await admin.insert(session).values({ id: randomUUID(), userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  const [u] = await admin.select().from(user).where(eq(user.id, userId));
  return { ...s, userId, email: u!.email };
}
const sessionCount = async (userId: string) => (await admin.select({ n: sql<number>`count(*)::int` }).from(session).where(eq(session.userId, userId)))[0]!.n;
async function caseFor(op: OperatorScope, userId: string) {
  return openCase(op, { subjectKind: "user", subjectId: userId, title: "bantuan akun", reason: "pelapor meminta bantuan" });
}
const actionRows = () => admin.select().from(supportAction);
const audits = (userId: string, action: string) => admin.select().from(auditLog).where(and(eq(auditLog.actorUserId, userId), eq(auditLog.action, action)));

describe("SA-23 search: canonical forms, masked hits, rate limit, no raw query in any record", () => {
  it("e-mail in any case or spacing and the internal id reach the same masked record; no raw contact is in the DTO", async () => {
    const m = await seller("toko-cari");
    const op = await makeOperator(SUPPORT);
    const variants = [m.email, m.email.toUpperCase(), `  ${m.email.slice(0, 4)} ${m.email.slice(4)}  `, m.userId];
    const hits = await Promise.all(variants.map((v) => searchAccounts(op, { query: v })));
    for (const h of hits) {
      expect(h.hits).toEqual([{ kind: "seller", id: m.userId, maskedName: "S*** R***", maskedEmail: maskEmail(m.email), status: "active", memberships: 1 }]);
      expect(h.buyerResults).toBe("needs_case_and_purpose");
    }
    const json = JSON.stringify(hits);
    expect(json).not.toContain(m.email);
    expect(json).not.toContain("Siti");
    expect(json).not.toContain("Rahayu");
  });

  it("a staff identity never appears; a phone query is canonicalized but matches no seller account; unknown input gives nothing", async () => {
    const op = await makeOperator(SUPPORT);
    const [staffUser] = await admin.select().from(user).where(eq(user.id, op.userId));
    expect((await searchAccounts(op, { query: staffUser!.email })).hits).toEqual([]);
    expect((await searchAccounts(op, { query: op.userId })).hits).toEqual([]);
    for (const phone of ["081234567890", "6281234567890", "+62 812-3456-7890"]) expect(canonicalizeQuery(phone)).toEqual({ kind: "phone", value: "6281234567890" });
    expect((await searchAccounts(op, { query: "+62 812-3456-7890" })).hits).toEqual([]);
    await expect(code(searchAccounts(op, { query: "ab" }))).resolves.toBe("query_invalid");
    expect(Object.keys(ACCOUNT_PROJECTIONS)).toEqual(["seller"]); // affiliate and buyer plug in with T-72
  });

  it("buyer results need an open case and a purpose on the search itself, whether or not any buyer matches", async () => {
    const m = await seller("toko-pembeli");
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    await expect(code(searchAccounts(op, { query: m.email, buyer: { caseRef: 999999, purposeCode: "support_case" } }))).resolves.toBe("case_required");
    await expect(code(searchAccounts(op, { query: m.email, buyer: { caseRef: c.id, purposeCode: "legal_request" } }))).resolves.toBe("purpose_not_allowed");
    expect((await searchAccounts(op, { query: m.email, buyer: { caseRef: c.id, purposeCode: "support_case" } })).buyerResults).toBe("not_available");
  });

  it("RL-ACCT-SEARCH: per staff member, counted without query text; concurrent searches cannot pass the limit; the refusal is audited without the query", async () => {
    const m = await seller("toko-batas");
    const op = await makeOperator(SUPPORT);
    const env = { ...process.env, ACCOUNT_SEARCH_LIMIT: "3", ACCOUNT_SEARCH_WINDOW_SECONDS: "600" };
    const results = await Promise.all(Array.from({ length: 6 }, () => code(searchAccounts(op, { query: m.email }, env))));
    expect(results.filter((r) => r === "ok")).toHaveLength(3);
    expect(results.filter((r) => r === "rate_limited")).toHaveLength(3);
    const rows = await audits(op.userId, "account.search");
    expect(rows.filter((r) => r.outcome === "denied")).toHaveLength(3);
    for (const r of rows) {
      expect(r.subjectId).toMatch(/^[0-9a-f]{16}$/); // keyed fingerprint, not the query
      expect(JSON.stringify(r)).not.toContain(m.email.split("@")[0]!);
    }
    const other = await makeOperator(SUPPORT);
    expect((await searchAccounts(other, { query: m.email }, env)).hits).toHaveLength(1); // another staff member has their own budget
  });

  it("accounts.read is required (denial row); the search is a recorded masked access without the query", async () => {
    const m = await seller("toko-izin");
    const none = await makeOperator(["cases.read"]);
    await expect(code(searchAccounts(none, { query: m.email }))).resolves.toBe("forbidden");
    expect(await audits(none.userId, "operator.denied")).toHaveLength(1);
    const op = await makeOperator(SUPPORT);
    await searchAccounts(op, { query: m.email });
    const [e] = await consoleAccessEvents(op);
    expect(e).toMatchObject({ actorUserId: op.userId, targetKind: "account_search", accessLevel: "masked" });
    expect(e!.targetId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("T-99: a search fingerprint that happens to contain 8+ consecutive digits is shown verbatim, not scrubbed", async () => {
    // Deterministic: pick a canonical query whose keyed fingerprint has a run of 8 digits (the scrubber's [digits] shape).
    let query = "";
    for (let i = 0; i < 200_000 && !query; i++) {
      const candidate = `cari-${i}@contoh.test`;
      const c = canonicalizeQuery(candidate)!;
      const fp = queryFingerprint(`${c.kind}:${c.value}`);
      if (fp && /\d{8}/.test(fp)) query = candidate;
    }
    expect(query, "found a fingerprint with an 8-digit run").not.toBe("");
    const op = await makeOperator(SUPPORT);
    await searchAccounts(op, { query });
    const [e] = await consoleAccessEvents(op);
    const c = canonicalizeQuery(query)!;
    expect(e!.targetId).toBe(queryFingerprint(`${c.kind}:${c.value}`));
    expect(e!.targetId).not.toContain("[digits]");
  });
});

describe("SA-24 diagnostic view: masked, no secrets, staff are never targets", () => {
  it("shows status, memberships, MFA yes or no, live sessions and open cases, all masked; a staff identity is not-found with a denial row", async () => {
    const m = await seller("toko-diag", "owner", 2);
    const op = await makeOperator(SUPPORT);
    await admin.insert(twoFactor).values({ id: randomUUID(), secret: "TOPSECRET-SEED", backupCodes: "CODES-XYZ", userId: m.userId });
    await admin.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, m.userId));
    const c = await caseFor(op, m.userId);
    const d = await accountDiagnostics(op, "seller", m.userId);
    expect(d).toMatchObject({ kind: "seller", status: "active", mfaEnrolled: true, activeSessions: 2, storeOwner: true, maskedEmail: maskEmail(m.email), maskedName: maskName(RAW), revealed: [] });
    expect(d.memberships.map((x) => [x.storeId, x.role])).toEqual([[m.storeId, "owner"]]);
    expect(d.openCases.map((x) => x.caseNumber)).toEqual([c.caseNumber]);
    const json = JSON.stringify(d);
    for (const leak of [m.email, "Siti", "TOPSECRET", "CODES-XYZ", "password", "token"]) expect(json).not.toContain(leak);
    // staff: never a target of accounts.*
    await expect(code(accountDiagnostics(op, "seller", op.userId))).resolves.toBe("not_found");
    expect((await audits(op.userId, "operator.denied")).some((r) => r.reason === "staff_target")).toBe(true);
    await expect(code(accountDiagnostics(op, "buyer", m.userId))).resolves.toBe("not_found"); // kinds without a projection do not exist yet
  });
});

describe("SA-24 support actions: case and reason, one transaction, idempotent, outcome as written", () => {
  it("revoke sessions: the sessions end, one support_action and one audit row are written, and the outcome reports the count", async () => {
    const m = await seller("toko-revoke", "staff", 3);
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    const out = await revokeUserSessions(op, m.userId, { caseRef: c.caseNumber, reasonCode: "lost_device", reason: "perangkat hilang", idempotencyKey: key() });
    expect(out).toMatchObject({ outcome: "sessions_revoked", count: 3, replayed: false });
    expect(await sessionCount(m.userId)).toBe(0);
    const rows = await actionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actionKind: "revoke_sessions", status: "executed", resultCode: "revoked:3", requestedBy: op.userId, caseId: c.id, subjectId: m.userId });
    expect(await audits(op.userId, "support.revoke_sessions")).toHaveLength(1);
    expect((await audits(op.userId, "support.revoke_sessions"))[0]).toMatchObject({ caseId: c.caseNumber, purposeCode: "lost_device", actorCapability: "accounts.support", outcome: "allowed" });
  });

  it("without an open case, with a closed case or a case about someone else: refused, no session touched, no row written", async () => {
    const m = await seller("toko-kasus", "staff", 2);
    const other = await seller("toko-lain", "staff", 1);
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    const foreign = await caseFor(op, other.userId);
    await moveCase(op, c.id, { from: "open", to: "in_progress", reason: "dikerjakan" });
    await moveCase(op, c.id, { from: "in_progress", to: "resolved", resolutionCode: "done", reason: "selesai" });
    for (const [caseRef, expected] of [[undefined, "ZodError"], [999999, "case_required"], [c.id, "case_required"], [foreign.id, "case_mismatch"]] as const) {
      await expect(code(revokeUserSessions(op, m.userId, { caseRef, reasonCode: "x_y", reason: "alasan cukup", idempotencyKey: key() })), String(caseRef)).resolves.toBe(expected);
    }
    await expect(code(revokeUserSessions(op, m.userId, { caseRef: foreign.id, reasonCode: "x_y", reason: "ab", idempotencyKey: key() }))).resolves.toBe("ZodError"); // reason too short
    expect(await sessionCount(m.userId)).toBe(2);
    expect(await actionRows()).toHaveLength(0);
  });

  it("a replay with the same idempotency key acts once (unique index), including a concurrent double submit; the key cannot be reused for another subject", async () => {
    const m = await seller("toko-ulang", "staff", 1);
    const o = await seller("toko-ulang-lain", "staff", 1);
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    const k = key();
    const input = { caseRef: c.id, reasonCode: "lost_device", reason: "klik ganda", idempotencyKey: k };
    const [x, y] = await Promise.all([revokeUserSessions(op, m.userId, input), revokeUserSessions(op, m.userId, input)]);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    expect(await actionRows()).toHaveLength(1);
    // the replay does not act again: a session created afterwards survives
    await admin.insert(session).values({ id: randomUUID(), userId: m.userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
    expect((await revokeUserSessions(op, m.userId, input)).replayed).toBe(true);
    expect(await sessionCount(m.userId)).toBe(1);
    const c2 = await caseFor(op, o.userId);
    await expect(code(revokeUserSessions(op, o.userId, { ...input, caseRef: c2.id }))).resolves.toBe("idempotency_conflict");
    expect(await sessionCount(o.userId)).toBe(1);
    // a failed attempt leaves no claim behind: the same key can be used once the cause is fixed
    const failKey = key();
    await expect(code(revokeUserSessions(op, randomUUID().replaceAll("-", ""), { caseRef: c.id, reasonCode: "x_y", reason: "akun tidak ada", idempotencyKey: failKey }))).resolves.toBe("case_mismatch");
    expect((await actionRows()).filter((r) => r.idempotencyKey === failKey)).toHaveLength(0);
  });

  it("suspend: sessions end, one status event, the seller scope refuses the identity (a stale session cannot mutate), reinstate restores it", async () => {
    const m = await seller("toko-tangguh", "owner", 2);
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    expect((await sellerContext(db, m.userId)).ok).toBe(true);
    const out = await setIdentitySuspension(op, m.userId, { suspend: true, caseRef: c.id, reasonCode: "fraud_suspected", reason: "dugaan penipuan", idempotencyKey: key() });
    expect(out).toMatchObject({ outcome: "identity_suspended", count: 2 });
    expect(await sessionCount(m.userId)).toBe(0);
    expect(await sellerContext(db, m.userId)).toEqual({ ok: false, reason: "identity_suspended" });
    expect((await admin.select().from(accountStatusEvent).where(eq(accountStatusEvent.subjectKind, "user")).orderBy(accountStatusEvent.id)).map((e) => [e.fromStatus, e.toStatus, e.reasonCode, e.caseId])).toEqual([["active", "suspended", "fraud_suspected", c.id]]);
    await expect(code(setIdentitySuspension(op, m.userId, { suspend: true, caseRef: c.id, reasonCode: "fraud_suspected", reason: "sekali lagi", idempotencyKey: key() }))).resolves.toBe("conflict");
    await setIdentitySuspension(op, m.userId, { suspend: false, caseRef: c.id, reasonCode: "cleared", reason: "terbukti keliru", idempotencyKey: key() });
    expect((await sellerContext(db, m.userId)).ok).toBe(true);
    expect((await admin.select().from(accountStatusEvent).where(eq(accountStatusEvent.subjectKind, "user")).orderBy(accountStatusEvent.id)).map((e) => e.toStatus)).toEqual(["suspended", "active"]);
  });

  it("two staff members suspending the same identity at once yield one transition and one conflict", async () => {
    const m = await seller("toko-serempak", "staff", 1);
    const x = await makeOperator(SUPPORT);
    const y = await makeOperator(SUPPORT);
    const c = await caseFor(x, m.userId);
    const res = await Promise.all([x, y].map((o) => code(setIdentitySuspension(o, m.userId, { suspend: true, caseRef: c.id, reasonCode: "risk_review", reason: "tinjauan risiko", idempotencyKey: key() }))));
    expect(res.sort()).toEqual(["conflict", "ok"]);
    expect(await admin.select().from(accountStatusEvent).where(eq(accountStatusEvent.subjectKind, "user"))).toHaveLength(1);
    expect((await actionRows()).filter((r) => r.status === "executed")).toHaveLength(1);
  });

  it("suspension needs accounts.suspend (not accounts.support); the owner-side function re-checks the actor and the target class itself", async () => {
    const m = await seller("toko-izin2", "staff", 1);
    const support = await makeOperator(["accounts.support", "accounts.read", "cases.write", "cases.read"]);
    const c = await caseFor(support, m.userId);
    await expect(code(setIdentitySuspension(support, m.userId, { suspend: true, caseRef: c.id, reasonCode: "x_y", reason: "tanpa izin suspend", idempotencyKey: key() }))).resolves.toBe("forbidden");
    // direct calls on the platform login (a login role may call it with any actor id): the function refuses by itself
    await expect(state(platform.execute(sql`select console_set_user_suspension(${support.userId}, ${m.userId}, true)`))).resolves.toBe("42501");
    const suspender = await makeOperator(["accounts.suspend"]);
    await expect(state(platform.execute(sql`select console_set_user_suspension(${suspender.userId}, ${suspender.userId}, true)`))).resolves.toBe("P0002"); // staff target
    await expect(state(platform.execute(sql`select console_set_user_suspension(${"ghost"}, ${m.userId}, true)`))).resolves.toBe("42501");
    await expect(state(db.execute(sql`select console_set_user_suspension(${suspender.userId}, ${m.userId}, true)`))).resolves.toBe("42501"); // the app role has no EXECUTE
    expect((await sellerContext(db, m.userId)).ok).toBe(true);
  });

  it("staff-executed store ownership recovery is disabled in Phase 1: not-found for everyone, nothing changes, an attempt leaves a denial row, and no approval can exist", async () => {
    const s = await makeStore("toko-pemilik");
    const withCap = await makeOperator(["members.recover", "staff.manage", "tenants.manage"]);
    const without = await makeOperator([]);
    for (const op of [withCap, without]) await expect(code(recoverStoreOwnership(op, s.storeId))).resolves.toBe("not_found");
    expect(await actionRows()).toHaveLength(0);
    expect((await audits(withCap.userId, "operator.denied"))[0]).toMatchObject({ reason: "ownership_recovery_disabled_phase1", outcome: "denied" });
    await expect(code(requestApproval(withCap, { actionKey: "ownership.recover", targetKind: "store", targetId: String(s.storeId), payload: { to: "x" }, reason: "pindah pemilik" }))).resolves.toBe("not_found");
    expect((await admin.execute(sql`select count(*)::int as n from membership where store_id = ${s.storeId} and role = 'owner'`))[0]).toEqual({ n: 1 });
  });
});

describe("MFA reset: four-eyes for a store owner, single approver with a notice for a team member", () => {
  async function withFactor(userId: string) {
    await admin.insert(twoFactor).values({ id: randomUUID(), secret: "SEED", backupCodes: "CODES", userId });
    await admin.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, userId));
  }
  const factors = async (userId: string) => (await admin.select().from(twoFactor).where(eq(twoFactor.userId, userId))).length;

  it("a store owner's reset only records the request; self-approval is refused; a different holder approves the exact payload; only the requester executes it, once", async () => {
    const m = await seller("toko-mfa", "owner", 2);
    await withFactor(m.userId);
    const requester = await makeOperator(SUPPORT);
    const approver = await makeOperator(["accounts.support"]);
    const c = await caseFor(requester, m.userId);
    const asked = await requestMfaReset(requester, m.userId, { caseRef: c.id, reasonCode: "lost_device", reason: "perangkat TOTP hilang", idempotencyKey: key() });
    expect(asked).toMatchObject({ outcome: "mfa_reset_awaiting_approval", replayed: false });
    expect(await factors(m.userId)).toBe(1); // nothing happened yet
    expect((await actionRows())[0]).toMatchObject({ status: "awaiting_approval", actionKey: "mfa.reset", approvalRequestId: asked.approvalRequestId });
    await expect(code(executeMfaReset(requester, asked.supportActionId))).resolves.toBe("awaiting_approval");
    await expect(code(decideApproval(requester, asked.approvalRequestId!, "approve"))).resolves.toBe("self_approval"); // service
    await expect(state(admin.execute(sql`update approval_request set status = 'approved', decided_by = requested_by, decided_at = now() where id = ${asked.approvalRequestId}`))).resolves.toBe("23514"); // database CHECK
    const outsider = await makeOperator(["accounts.read"]);
    await expect(code(decideApproval(outsider, asked.approvalRequestId!, "approve"))).resolves.toBe("forbidden");
    await decideApproval(approver, asked.approvalRequestId!, "approve");
    await expect(code(executeMfaReset(approver, asked.supportActionId))).resolves.toBe("not_found"); // the approver cannot ride the approval
    const done = await executeMfaReset(requester, asked.supportActionId);
    expect(done).toMatchObject({ outcome: "mfa_reset_done", replayed: false });
    expect(await factors(m.userId)).toBe(0);
    expect((await admin.select().from(user).where(eq(user.id, m.userId)))[0]!.twoFactorEnabled).toBe(false);
    expect(await sessionCount(m.userId)).toBe(0);
    expect((await actionRows())[0]).toMatchObject({ status: "executed", resultCode: "mfa_reset" });
    expect((await executeMfaReset(requester, asked.supportActionId)).replayed).toBe(true); // second execution: no second effect
    expect((await admin.select().from(mailOutbox)).filter((r) => /direset/.test(r.subject))).toHaveLength(1); // the previous contact is told
  });

  it("a rejected or changed request never executes; a payload for another target cannot be reused", async () => {
    const a = await seller("toko-mfa-a", "owner");
    const b = await seller("toko-mfa-b", "owner");
    await withFactor(a.userId);
    await withFactor(b.userId);
    const requester = await makeOperator(SUPPORT);
    const approver = await makeOperator(["accounts.support"]);
    const ca = await caseFor(requester, a.userId);
    const cb = await caseFor(requester, b.userId);
    const first = await requestMfaReset(requester, a.userId, { caseRef: ca.id, reasonCode: "lost_device", reason: "perangkat hilang A", idempotencyKey: key() });
    await decideApproval(approver, first.approvalRequestId!, "reject");
    expect(await executeMfaReset(requester, first.supportActionId)).toMatchObject({ outcome: "mfa_reset_cancelled" });
    expect((await actionRows())[0]!.status).toBe("cancelled");
    expect(await factors(a.userId)).toBe(1);
    // the approval of B cannot be spent on A: point A's action row at B's approval (fixture) and the binding refuses it
    const forB = await requestMfaReset(requester, b.userId, { caseRef: cb.id, reasonCode: "lost_device", reason: "perangkat hilang B", idempotencyKey: key() });
    await decideApproval(approver, forB.approvalRequestId!, "approve");
    const again = await requestMfaReset(requester, a.userId, { caseRef: ca.id, reasonCode: "lost_device", reason: "perangkat hilang A lagi", idempotencyKey: key() });
    await admin.execute(sql`alter table support_action disable trigger support_action_guard`);
    await admin.execute(sql`update support_action set approval_request_id = ${forB.approvalRequestId} where id = ${again.supportActionId}`);
    await admin.execute(sql`alter table support_action enable trigger support_action_guard`);
    await expect(code(executeMfaReset(requester, again.supportActionId))).resolves.toBe("approval_invalid");
    expect(await factors(a.userId)).toBe(1);
    expect(await factors(b.userId)).toBe(1);
  });

  it("the database refuses `executed` for a four-eyes action without its own executed approval (trigger, not only the service)", async () => {
    const m = await seller("toko-mfa-db", "owner");
    const requester = await makeOperator(SUPPORT);
    const c = await caseFor(requester, m.userId);
    const asked = await requestMfaReset(requester, m.userId, { caseRef: c.id, reasonCode: "lost_device", reason: "perangkat hilang", idempotencyKey: key() });
    await expect(state(platform.execute(sql`update support_action set status = 'approved' where id = ${asked.supportActionId}`))).resolves.toBe("ok");
    await expect(state(platform.execute(sql`update support_action set status = 'executed', executed_at = now() where id = ${asked.supportActionId}`))).resolves.toBe("42501");
  });

  it("a team member who owns no store is reset by one approver at once, with the case, the reason and a notice to the contact on file", async () => {
    const m = await seller("toko-mfa-staff", "staff", 1);
    await withFactor(m.userId);
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    const out = await requestMfaReset(op, m.userId, { caseRef: c.id, reasonCode: "lost_device", reason: "perangkat hilang", idempotencyKey: key() });
    expect(out).toMatchObject({ outcome: "mfa_reset_done", replayed: false });
    expect(await factors(m.userId)).toBe(0);
    const mails = (await admin.select().from(mailOutbox)).filter((r) => r.toEmail === m.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toMatch(/direset/);
  });

  it("staff are never reset through accounts.*: the accounts service answers not-found, the owner-side function refuses the wrong class", async () => {
    const target = await makeOperator(["staff.manage"]);
    const op = await makeOperator(SUPPORT);
    const c = await openCase(op, { title: "uji", reason: "uji target staf" });
    await expect(code(requestMfaReset(op, target.userId, { caseRef: c.id, reasonCode: "x_y", reason: "mencoba staf", idempotencyKey: key() }))).resolves.toBe("not_found");
    await expect(state(platform.execute(sql`select console_reset_user_mfa(${op.userId}, ${target.userId}, 'accounts.support')`))).resolves.toBe("P0002");
    const m = await seller("toko-kelas", "owner");
    const manager = await makeOperator(["staff.manage"]);
    await expect(state(platform.execute(sql`select console_reset_user_mfa(${manager.userId}, ${m.userId}, 'staff.manage')`))).resolves.toBe("P0002"); // an account is not a staff target
    await expect(state(platform.execute(sql`select console_reset_user_mfa(${manager.userId}, ${manager.userId}, 'staff.manage')`))).resolves.toBe("42501"); // never one's own
  });
});

describe("support recovery link: queued through the outbox, never shown, single use, expiry", () => {
  const linkMail = async (userId: string) => {
    const [u] = await admin.select().from(user).where(eq(user.id, userId));
    return (await admin.select().from(mailOutbox)).filter((r) => r.toEmail === u!.email);
  };
  const tokenOf = (body: string) => /\/account\/support-recovery\/([A-Za-z0-9_-]{30,})/.exec(body)![1]!;
  const redeem = (token: string) => redeemSupportRecovery(db, token); // the production wrapper the identity page calls, on the app pool

  it("queues one support_recovery mail with an expiry; the operator, the audit rows, the action row and the logs never see the link or the token", async () => {
    const m = await seller("toko-link");
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    const out = await startSupportRecovery(op, m.userId, { caseRef: c.id, reasonCode: "locked_out", reason: "seller kehilangan akses", idempotencyKey: key() });
    expect(out).toMatchObject({ outcome: "recovery_link_queued", replayed: false });
    const [mail] = await linkMail(m.userId);
    expect(mail).toMatchObject({ oneTimePurpose: "support_recovery", deliveryStatus: expect.any(String) });
    expect(mail!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    const token = tokenOf(mail!.textBody);
    const everything = JSON.stringify([out, await admin.select().from(auditLog), await actionRows(), await admin.select().from(systemLog), await admin.select().from(accountStatusEvent)]);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("support-recovery");
    const [stored] = await admin.select().from(supportRecoveryLink);
    expect(stored!.tokenSha256).not.toBe(token);
    expect(stored!.tokenSha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(state(db.execute(sql`select * from support_recovery_link`))).resolves.toBe("42501"); // the app role cannot read the table
    await expect(state(platform.execute(sql`update support_recovery_link set consumed_at = now()`))).resolves.toBe("42501"); // nor can the platform login consume
  });

  it("the link redeems exactly once, also under concurrent redemption; a wrong or truncated token redeems nothing", async () => {
    const m = await seller("toko-sekali");
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    await startSupportRecovery(op, m.userId, { caseRef: c.id, reasonCode: "locked_out", reason: "seller kehilangan akses", idempotencyKey: key() });
    const token = tokenOf((await linkMail(m.userId))[0]!.textBody);
    expect(await redeem(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(await redeem("short")).toBeNull();
    const results = await Promise.all(Array.from({ length: 6 }, () => redeem(token)));
    expect(results.filter((r) => r === m.userId)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(5);
    expect(await redeem(token)).toBeNull();
    await expect(state(admin.execute(sql`update support_recovery_link set consumed_at = null`))).resolves.toBe("23514"); // consumed once, immutable after
  });

  it("an expired link redeems nothing; neither does a link of a suspended identity or of a staff identity", async () => {
    const m = await seller("toko-kedaluwarsa");
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    const act = await startSupportRecovery(op, m.userId, { caseRef: c.id, reasonCode: "locked_out", reason: "seller kehilangan akses", idempotencyKey: key() });
    const plant = async (userId: string, token: string, expired: boolean) => {
      const hash = ((await admin.execute(sql`select encode(sha256(convert_to(${token}, 'UTF8')), 'hex') as h`)) as unknown as { h: string }[])[0]!.h;
      await admin.insert(supportRecoveryLink).values({ tokenSha256: hash, userId, supportActionId: act.supportActionId, createdAt: new Date(Date.now() - 7_200_000), expiresAt: new Date(Date.now() + (expired ? -3_600_000 : 3_600_000)) });
    };
    const t1 = "e".repeat(43);
    const t2 = "s".repeat(43);
    const t3 = "o".repeat(43);
    await plant(m.userId, t1, true);
    expect(await redeem(t1)).toBeNull();
    await plant(m.userId, t2, false);
    await admin.execute(sql`update "user" set suspended_at = now() where id = ${m.userId}`);
    expect(await redeem(t2)).toBeNull(); // suspension is lifted first, on purpose
    await plant(op.userId, t3, false);
    expect(await redeem(t3)).toBeNull(); // staff identities never recover through support links
  });

  it("refused without a verified contact or for a suspended identity, and a replay queues no second mail", async () => {
    const m = await seller("toko-tak-terverifikasi");
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    await admin.update(user).set({ emailVerified: false }).where(eq(user.id, m.userId));
    await expect(code(startSupportRecovery(op, m.userId, { caseRef: c.id, reasonCode: "locked_out", reason: "kontak belum terverifikasi", idempotencyKey: key() }))).resolves.toBe("contact_unverified");
    await admin.update(user).set({ emailVerified: true, suspendedAt: new Date() }).where(eq(user.id, m.userId));
    await expect(code(startSupportRecovery(op, m.userId, { caseRef: c.id, reasonCode: "locked_out", reason: "akun ditangguhkan", idempotencyKey: key() }))).resolves.toBe("account_suspended");
    await admin.update(user).set({ suspendedAt: null }).where(eq(user.id, m.userId));
    const k = key();
    await startSupportRecovery(op, m.userId, { caseRef: c.id, reasonCode: "locked_out", reason: "kirim tautan", idempotencyKey: k });
    await startSupportRecovery(op, m.userId, { caseRef: c.id, reasonCode: "locked_out", reason: "kirim tautan", idempotencyKey: k });
    expect(await linkMail(m.userId)).toHaveLength(1);
    expect(await admin.select().from(supportRecoveryLink)).toHaveLength(1);
  });

  it("the link, the mail and the action row are one transaction: when the audit row cannot be written, no link and no mail exist", async () => {
    const m = await seller("toko-atomik");
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    await admin.execute(sql`create or replace function t63_audit_fail() returns trigger language plpgsql as $$ begin if new.action = 'support.start_recovery' then raise exception 'audit down' using errcode = '53100'; end if; return new; end $$`);
    await admin.execute(sql`create trigger t63_audit_fail before insert on audit_log for each row execute function t63_audit_fail()`);
    try {
      await expect(code(startSupportRecovery(op, m.userId, { caseRef: c.id, reasonCode: "locked_out", reason: "audit mati", idempotencyKey: key() }))).resolves.toBe("53100");
    } finally {
      await admin.execute(sql`drop trigger if exists t63_audit_fail on audit_log`);
      await admin.execute(sql`drop function if exists t63_audit_fail()`);
    }
    expect(await linkMail(m.userId)).toHaveLength(0);
    expect(await admin.select().from(supportRecoveryLink)).toHaveLength(0);
    expect(await actionRows()).toHaveLength(0);
  });
});

/** Fixture only: age every access event by two hours (the append-only trigger is switched off for this one UPDATE). */
async function backdateRevealWindows() {
  await admin.execute(sql`alter table personal_data_access_event disable trigger personal_data_access_event_append_only`);
  try {
    await admin.execute(sql`update personal_data_access_event set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where access_level = 'full'`);
  } finally {
    await admin.execute(sql`alter table personal_data_access_event enable trigger personal_data_access_event_append_only`);
  }
}
async function backdateBreakGlass(grantId: number) {
  await admin.execute(sql`alter table break_glass_grant disable trigger break_glass_grant_guard`);
  try {
    await admin.execute(sql`update break_glass_grant set starts_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = ${grantId}`);
  } finally {
    await admin.execute(sql`alter table break_glass_grant enable trigger break_glass_grant_guard`);
  }
}

describe("PRIV-9 reveal: purpose, open case, expiry, evidence before the value", () => {
  it("returns exactly the requested field with one full access event (case, purpose, expiry); refused with no side effect without a case, a purpose or a reason", async () => {
    const m = await seller("toko-ungkap");
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    const base = { field: "email" as const, purposeCode: "support_case", caseRef: c.caseNumber, reason: "memastikan alamat seller" };
    for (const bad of [{ caseRef: 999999 }, { caseRef: undefined }, { purposeCode: "legal_request" }, { purposeCode: "" }, { reason: "x" }]) {
      await expect(code(revealAccountField(op, "seller", m.userId, { ...base, ...bad })), JSON.stringify(bad)).resolves.toMatch(/case_required|ZodError|purpose_not_allowed/);
    }
    expect(await consoleAccessEvents(op)).toEqual([]); // refused with no side effect
    const out = await revealAccountField(op, "seller", m.userId, base);
    expect(out).toMatchObject({ field: "email", value: m.email });
    const events = await consoleAccessEvents(op);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorUserId: op.userId, targetKind: "user", targetId: m.userId, fieldClass: "email", accessLevel: "full", purposeCode: "support_case", caseId: c.caseNumber });
    expect(events[0]!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(await admin.select().from(auditLog))).not.toContain(m.email); // no raw value in any audit row
  });

  it("evidence is written before the value leaves: when the evidence row cannot be written the loader never runs and nothing is returned", async () => {
    const m = await seller("toko-bukti");
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    await admin.execute(sql`create or replace function t63_evidence_fail() returns trigger language plpgsql as $$ begin raise exception 'evidence down' using errcode = '53100'; end $$`);
    await admin.execute(sql`create trigger t63_evidence_fail before insert on personal_data_access_event for each row execute function t63_evidence_fail()`);
    let loaded = false;
    try {
      await expect(code(withPersonalDataAccess(op, { capability: "accounts.reveal", targetKind: "user", targetId: m.userId, fieldClass: "email", purposeCode: "support_case", caseId: c.caseNumber, reason: "uji bukti", accessLevel: "full", expiresAt: new Date(Date.now() + 60_000) }, async () => void (loaded = true)))).resolves.toBe("53100");
      await expect(code(revealAccountField(op, "seller", m.userId, { field: "email", purposeCode: "support_case", caseRef: c.id, reason: "uji bukti gagal" }))).resolves.toBe("53100");
    } finally {
      await admin.execute(sql`drop trigger if exists t63_evidence_fail on personal_data_access_event`);
      await admin.execute(sql`drop function if exists t63_evidence_fail()`);
    }
    expect(loaded).toBe(false);
  });

  it("the capability is re-checked inside the transaction: a grant revoked while the value is being read aborts the read and its evidence row", async () => {
    const m = await seller("toko-recheck");
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    let leaked: string | undefined;
    await expect(
      code(
        withPersonalDataAccess(op, { capability: "accounts.reveal", targetKind: "user", targetId: m.userId, fieldClass: "email", purposeCode: "support_case", caseId: c.caseNumber, reason: "uji cabut di tengah", accessLevel: "full", expiresAt: new Date(Date.now() + 60_000) }, async (tx) => {
          // another request revokes the grant and commits while this transaction is open
          await admin.delete(operatorGrant).where(and(eq(operatorGrant.userId, op.userId), eq(operatorGrant.capability, "accounts.reveal")));
          const [u] = await tx.select({ e: user.email }).from(user).where(eq(user.id, m.userId));
          leaked = u!.e;
          return u!.e;
        }),
      ),
    ).resolves.toBe("forbidden");
    expect(leaked).toBeDefined(); // the loader ran, but its result was not returned (the promise rejected)
    expect(await admin.execute(sql`select count(*)::int as n from personal_data_access_event`)).toEqual([{ n: 0 }]); // the evidence row rolled back with it
  });

  it("without accounts.reveal, for a staff identity, or with a case about someone else: no value and no evidence", async () => {
    const m = await seller("toko-tolak");
    const other = await seller("toko-tolak-lain");
    const reader = await makeOperator(["accounts.read", "cases.write", "cases.read"]);
    const c = await caseFor(reader, m.userId);
    const foreign = await caseFor(reader, other.userId);
    const input = { field: "email" as const, purposeCode: "support_case", caseRef: c.id, reason: "uji penolakan" };
    await expect(code(revealAccountField(reader, "seller", m.userId, input))).resolves.toBe("forbidden");
    expect((await audits(reader.userId, "operator.denied")).filter((r) => r.actorCapability === "accounts.reveal")).toHaveLength(1);
    const op = await makeOperator(SUPPORT);
    await expect(code(revealAccountField(op, "seller", op.userId, { ...input, caseRef: (await caseFor(op, op.userId)).id }))).resolves.toBe("not_found");
    await expect(code(revealAccountField(op, "seller", m.userId, { ...input, caseRef: foreign.id }))).resolves.toBe("case_mismatch");
    await expect(code(revealAccountField(op, "buyer", m.userId, input))).resolves.toBe("not_found");
    expect(await consoleAccessEvents(op)).toEqual([]);
  });

  it("the value shows inside the reveal window (every read an access event) and is masked again after it expires", async () => {
    const m = await seller("toko-jendela");
    const op = await makeOperator(SUPPORT);
    const c = await caseFor(op, m.userId);
    await revealAccountField(op, "seller", m.userId, { field: "email", purposeCode: "support_case", caseRef: c.id, reason: "uji jendela waktu" });
    const inside = await accountDiagnostics(op, "seller", m.userId);
    expect(inside.revealed.map((r) => [r.field, r.value])).toEqual([["email", m.email]]);
    expect(inside.maskedEmail).toBe(maskEmail(m.email)); // the masked value is always there too
    const before = (await consoleAccessEvents(op)).filter((e) => e.accessLevel === "full").length;
    expect(before).toBeGreaterThanOrEqual(2); // the reveal and the in-window read
    await backdateRevealWindows(); // the database clock decides expiry: move the window into the past instead of waiting
    const after = await accountDiagnostics(op, "seller", m.userId);
    expect(after.revealed).toEqual([]);
    expect(JSON.stringify(after)).not.toContain(m.email);
    expect((await consoleAccessEvents(op)).filter((e) => e.accessLevel === "full")).toHaveLength(before);
    // another staff member never sees someone else's window
    const colleague = await makeOperator(SUPPORT);
    await revealAccountField(op, "seller", m.userId, { field: "name", purposeCode: "support_case", caseRef: c.id, reason: "jendela baru" });
    expect(await activeRevealedFields(colleague, m.userId)).toEqual([]);
    expect((await activeRevealedFields(op, m.userId)).map((r) => r.field)).toEqual(["name"]);
  });
});

describe("PRIV-9 break-glass: approved by a different holder, allowlisted, expiring, notified, reviewed", () => {
  async function setup(slug: string) {
    const m = await seller(slug);
    const requester = await makeOperator(["break_glass.approve", "cases.write", "cases.read", "accounts.read", "audit.read"]);
    const approver = await makeOperator(["break_glass.approve"]);
    const reviewer = await makeOperator(["access.review", "audit.read"]);
    const c = await caseFor(requester, m.userId);
    return { m, requester, approver, reviewer, c };
  }
  const ask = (requester: OperatorScope, userId: string, caseRef: number, over: Record<string, unknown> = {}) => requestBreakGlass(requester, { userId, caseRef, capabilities: ["accounts.reveal"], durationSeconds: 600, reason: "seller terkunci, pemilik tidak bisa dihubungi", ...over });

  it("needs a second holder (self-approval refused); the requester activates; a grant window starts; every audit.read holder is notified in the same transaction", async () => {
    const { m, requester, approver, reviewer, c } = await setup("toko-darurat");
    const asked = await ask(requester, m.userId, c.id);
    await expect(code(decideApproval(requester, asked.approvalId, "approve"))).resolves.toBe("self_approval");
    await expect(code(activateBreakGlass(requester, asked.approvalId))).resolves.toBe("approval_invalid"); // still pending
    await decideApproval(approver, asked.approvalId, "approve");
    await expect(code(activateBreakGlass(approver, asked.approvalId))).resolves.toBe("approval_invalid"); // not the requester
    const g = await activateBreakGlass(requester, asked.approvalId);
    expect(g.expiresAt.getTime() - g.startsAt.getTime()).toBe(600_000);
    const [row] = await admin.select().from(breakGlassGrant);
    expect(row).toMatchObject({ requestedBy: requester.userId, approvedBy: approver.userId, caseId: c.caseNumber, targetKind: "user", targetId: m.userId, capabilities: ["accounts.reveal"] });
    const notified = (await admin.select().from(mailOutbox)).filter((r) => /Akses darurat/.test(r.subject)).map((r) => r.toEmail).sort();
    // every holder of audit.read: the requester, the reviewer and the default fixture operator that makeStore created
    const holders = ((await admin.execute(sql`select u.email from operator_grant g join "user" u on u.id = g.user_id where g.capability = 'audit.read'`)) as unknown as { email: string }[]).map((r) => r.email).sort();
    expect(holders).toHaveLength(3);
    expect(notified).toEqual(holders);
    expect(JSON.stringify(await admin.select().from(mailOutbox))).not.toContain(m.email); // ids only: no contact of the target
    await expect(code(activateBreakGlass(requester, asked.approvalId))).resolves.toBe("approval_invalid"); // single use
  });

  it("confers only the allowlisted read and reveal capabilities: staff, audit, ledger and write capabilities are refused by the service and by the database", async () => {
    const { m, requester, c } = await setup("toko-allowlist");
    for (const cap of ["staff.manage", "audit.read", "ledger.adjust", "accounts.suspend", "break_glass.approve"]) {
      await expect(code(ask(requester, m.userId, c.id, { capabilities: [cap] })), cap).resolves.toBe("ZodError");
    }
    await expect(state(platform.execute(sql`insert into break_glass_grant (requested_by, approved_by, capabilities, target_kind, target_id, case_id, reason, starts_at, expires_at) values (${requester.userId}, ${requester.userId}, array['staff.manage'], 'user', 'x', 'C-000001', 'r', now(), now() + interval '1 hour')`))).resolves.toBe("23514");
    expect(await admin.select().from(breakGlassGrant)).toHaveLength(0);
  });

  it("a reveal through the grant works for exactly its target and case, writes an access event that names the grant, and is refused for another target, case, capability or person", async () => {
    const { m, requester, approver, c } = await setup("toko-pakai");
    const other = await seller("toko-pakai-lain");
    const stranger = await makeOperator(["accounts.read"]);
    const asked = await ask(requester, m.userId, c.id);
    await decideApproval(approver, asked.approvalId, "approve");
    const { grantId } = await activateBreakGlass(requester, asked.approvalId);
    // the requester holds NO accounts.reveal: without the grant the same call is refused
    const base = { field: "email" as const, purposeCode: "support_case", caseRef: c.id, reason: "pemulihan darurat" };
    await expect(code(revealAccountField(requester, "seller", m.userId, base))).resolves.toBe("forbidden");
    const out = await revealAccountField(requester, "seller", m.userId, { ...base, breakGlassGrantId: grantId });
    expect(out.value).toBe(m.email);
    const [e] = await consoleAccessEvents(await makeOperator(["audit.read"]));
    expect(e).toMatchObject({ actorUserId: requester.userId, targetId: m.userId, accessLevel: "full" });
    expect((await admin.execute(sql`select break_glass_grant_id from personal_data_access_event order by id desc limit 1`))[0]).toEqual({ break_glass_grant_id: String(grantId) });
    const otherCase = await caseFor(requester, other.userId);
    await expect(code(revealAccountField(requester, "seller", other.userId, { ...base, caseRef: otherCase.id, breakGlassGrantId: grantId }))).resolves.toBe("forbidden"); // another target
    await expect(code(revealAccountField(requester, "seller", m.userId, { ...base, caseRef: otherCase.id, breakGlassGrantId: grantId }))).resolves.toMatch(/forbidden|case_mismatch/); // another case
    const strangerCase = await caseFor(await makeOperator(["cases.write", "cases.read"]), m.userId);
    await expect(code(revealAccountField(stranger, "seller", m.userId, { ...base, caseRef: strangerCase.id, breakGlassGrantId: grantId }))).resolves.toBe("forbidden"); // not their grant
    expect((await audits(stranger.userId, "operator.denied")).some((r) => r.reason === `break_glass:${grantId}`)).toBe(true);
  });

  it("expires by itself and stops on revocation; the review comes after the end, by someone else, once", async () => {
    const { m, requester, approver, reviewer, c } = await setup("toko-berakhir");
    const asked = await ask(requester, m.userId, c.id);
    await decideApproval(approver, asked.approvalId, "approve");
    const { grantId } = await activateBreakGlass(requester, asked.approvalId);
    const base = { field: "email" as const, purposeCode: "support_case", caseRef: c.id, reason: "pemulihan darurat", breakGlassGrantId: grantId };
    expect((await revealAccountField(requester, "seller", m.userId, base)).value).toBe(m.email);
    await expect(code(reviewBreakGlass(reviewer, grantId))).resolves.toBe("conflict"); // not ended yet
    await backdateBreakGlass(grantId);
    await expect(code(revealAccountField(requester, "seller", m.userId, base))).resolves.toBe("forbidden"); // expired
    expect((await breakGlassReviewQueue(reviewer)).map((g) => g.id)).toEqual([grantId]);
    await expect(code(reviewBreakGlass(requester, grantId))).resolves.toMatch(/forbidden|conflict/); // the requester neither holds access.review nor reviews their own
    await reviewBreakGlass(reviewer, grantId);
    await expect(code(reviewBreakGlass(reviewer, grantId))).resolves.toBe("conflict"); // once
    expect(await breakGlassReviewQueue(reviewer)).toEqual([]);

    const second = await ask(requester, m.userId, c.id);
    await decideApproval(approver, second.approvalId, "approve");
    const g2 = await activateBreakGlass(requester, second.approvalId);
    await revokeBreakGlass(approver, g2.grantId);
    await expect(code(revealAccountField(requester, "seller", m.userId, { ...base, breakGlassGrantId: g2.grantId }))).resolves.toBe("forbidden"); // revoked
    await expect(code(revokeBreakGlass(approver, g2.grantId))).resolves.toBe("conflict"); // revoked once
  });

  it("never satisfies a four-eyes approval: an operator whose only authority is a break-glass grant cannot approve", async () => {
    const { m, requester, approver, c } = await setup("toko-bukan-empat-mata");
    const asked = await ask(requester, m.userId, c.id);
    await decideApproval(approver, asked.approvalId, "approve");
    await activateBreakGlass(requester, asked.approvalId);
    // requester now holds a live break-glass grant for accounts.reveal; a mfa.reset approval needs a STANDING accounts.support holder
    const owner = await seller("toko-bukan-empat-mata-b", "owner");
    const supportOp = await makeOperator(SUPPORT);
    const cc = await caseFor(supportOp, owner.userId);
    const req = await requestMfaReset(supportOp, owner.userId, { caseRef: cc.id, reasonCode: "lost_device", reason: "perangkat hilang", idempotencyKey: key() });
    await expect(code(decideApproval(requester, req.approvalRequestId!, "approve"))).resolves.toBe("forbidden");
  });
});
