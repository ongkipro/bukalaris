import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { consoleAccessEvents, consoleAudit, AUDIT_MAX_RANGE_MS } from "../src/ops/console.ts";
import { withPersonalDataAccess } from "../src/ops/console-access.ts";
import { AUDIT_VIEW, assertSafeAllowlist, auditView, CREDENTIAL_LIKE_KEY, ISSUE_CONTEXT_FIELDS, redactIssueContext } from "../src/ops/console-redaction.ts";
import { purgeClass, setRetentionPeriod } from "../src/ops/jobs/retention.ts";
import { auditLog } from "../src/schema.ts";
import { admin, db, makeOperator, platform } from "./helpers.ts";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
const CANARY = "CANARY-hunter2-9f8e7d6c";

beforeEach(async () => {
  await admin.execute(sql`truncate personal_data_access_event`);
  await admin.execute(sql`truncate retention_policy`);
});

describe("redaction allowlists: no credential-like key can be allowlisted (import-time assertion)", () => {
  it("refuses every credential-shaped key in any action's list, in any spelling", () => {
    for (const key of ["password", "passwd", "apiKey", "api_key", "x-api-key", "session_token", "Token", "authorization", "Cookie", "otp", "secret", "client_secret", "recovery_link", "privateKey", "bearer", "signature", "payload", "body"]) {
      expect(() => assertSafeAllowlist({ "some.action": ["job", key] }), key).toThrow(/looks like a credential/);
    }
    expect(() => assertSafeAllowlist({ "some.action": ["job", "kind", "page_id", "count", "capability"] })).not.toThrow();
  });

  it("the shipped allowlists themselves pass the same check (the module imported, so the app starts)", () => {
    for (const [action, rule] of Object.entries(AUDIT_VIEW)) for (const key of rule.fields) expect(CREDENTIAL_LIKE_KEY.test(key), `${action}.${key}`).toBe(false);
    for (const key of [...ISSUE_CONTEXT_FIELDS.top, ...ISSUE_CONTEXT_FIELDS.nested]) expect(CREDENTIAL_LIKE_KEY.test(key), key).toBe(false);
  });
});

describe("audit viewer (SA-37): per-action allowlist, canary values never reach the DTO", () => {
  const row = (over: Partial<Parameters<typeof auditView>[0]>) => ({ id: 1, createdAt: new Date(), actorUserId: "u1", action: "x", storeId: null, actorCapability: null, subjectKind: null, subjectId: null, caseId: null, outcome: null, accessLevel: null, reason: null, ...over });

  it("shows only allowlisted key:value tokens of a known action and scrubs its free-text reason", () => {
    const v = auditView(row({ action: "jobs.requeue", reason: `job:7 kind:order.notify password:${CANARY} token:${CANARY} Bearer ${CANARY}abcdefgh note for budi@example.com 0812345678901` }));
    expect(v.fields).toEqual({ job: "7", kind: "order.notify" });
    expect(JSON.stringify(v)).not.toContain(CANARY);
    expect(v.reason).not.toMatch(/budi@example|0812345678901/);
  });

  it("an action that is not allowlisted shows its family only: no reason, no fields, scrubbed ids", () => {
    const v = auditView(row({ action: `evil.action:${CANARY}`, reason: `job:1 ${CANARY}`, subjectId: `Bearer ${CANARY}abcdefghijk`, caseId: "CASE-1" }));
    expect(v.action).toBe("evil.action");
    expect(v.reason).toBeNull();
    expect(v.fields).toEqual({});
    expect(JSON.stringify(v)).not.toContain(CANARY);
  });

  it("an action whose reason is allowlisted still never shows a credential-shaped token a stored row might carry", () => {
    const v = auditView(row({ action: "store.suspended", reason: `fraud report api_key=${CANARY} secret:${CANARY}` }));
    expect(v.reason).toContain("fraud report");
    expect(JSON.stringify(v)).not.toContain(CANARY);
  });

  it("the issue context viewer drops every key outside its allowlist and scrubs the rest", () => {
    const v = redactIssueContext({
      release: "r1",
      cookie: CANARY,
      authorization: `Bearer ${CANARY}`,
      password: CANARY,
      recentRequests: [{ requestId: "abc", route: "/admin", method: "GET", status: 200, durationMs: 3, outcome: "ok", headers: { authorization: CANARY }, body: CANARY }],
      recentClientErrors: [{ name: "TypeError", message: `failed with token=${CANARY} for budi@example.com`, stack: CANARY }],
    });
    expect(JSON.stringify(v)).not.toContain(CANARY);
    expect(JSON.stringify(v)).not.toContain("budi@example.com");
    expect(v.recentRequests).toHaveLength(1);
    expect(Object.keys(v.recentRequests[0]!).sort()).toEqual(["durationMs", "method", "outcome", "requestId", "route", "status"]);
    expect(redactIssueContext("not an object")).toMatchObject({ recentRequests: [], failedActions: [] });
  });

  it("the paged viewer reads through the allowlist, audits its own read, never lists that read, and needs audit.read", async () => {
    const actor = await makeOperator(["audit.read"]);
    for (let i = 0; i < 5; i++) await admin.insert(auditLog).values({ actorUserId: "someone", action: "jobs.requeue", reason: `job:${i} kind:k password:${CANARY}`, outcome: "allowed" });
    const first = await consoleAudit(actor, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await consoleAudit(actor, { limit: 2, cursor: first.nextCursor, from: first.from, to: first.to });
    const third = await consoleAudit(actor, { limit: 2, cursor: second.nextCursor, from: first.from, to: first.to });
    const ids = [...first.items, ...second.items, ...third.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(JSON.stringify([first, second, third])).not.toContain(CANARY);
    const reads = await admin.select().from(auditLog).where(eq(auditLog.action, "audit.read"));
    expect(reads.length).toBe(3);
    expect(reads.every((r) => r.actorUserId === actor.userId && r.actorCapability === "audit.read")).toBe(true);
    expect(first.items.some((i) => i.action === "audit.read")).toBe(false);

    const without = await makeOperator(["logs.read"]);
    expect(await code(consoleAudit(without))).toBe("forbidden");
    expect((await admin.select().from(auditLog).where(eq(auditLog.actorUserId, without.userId))).map((r) => r.action)).toEqual(["operator.denied"]); // no audit.read row, only the denial
  });

  it("the window is bounded and ordered; filters are validated", async () => {
    const actor = await makeOperator(["audit.read"]);
    const to = new Date();
    expect(await code(consoleAudit(actor, { from: new Date(to.getTime() - AUDIT_MAX_RANGE_MS - 1000), to }))).toBe("range_too_wide");
    expect(await code(consoleAudit(actor, { from: to, to: new Date(to.getTime() - 1000) }))).toBe("invalid_range");
    await expect(consoleAudit(actor, { actor: "'; drop table audit_log; --" })).rejects.toThrow();
    await admin.insert(auditLog).values({ actorUserId: "x1", action: "store.create", outcome: "denied", actorCapability: "tenants.manage", caseId: "CASE-9", subjectKind: "store", subjectId: "5" });
    await admin.insert(auditLog).values({ actorUserId: "x2", action: "store.create", outcome: "allowed" });
    const denied = await consoleAudit(actor, { outcome: "denied", caseId: "CASE-9", subjectKind: "store", subjectId: "5", capability: "tenants.manage", actor: "x1" });
    expect(denied.items.map((i) => i.actorUserId)).toEqual(["x1"]);
  });
});

describe("personal_data_access_event (DATA-14, PRIV-9): restricted, append-only, fail closed", () => {
  const evidence = { capability: "accounts.reveal" as const, targetKind: "account", targetId: "a1", fieldClass: "phone" as const, purposeCode: "support_case", caseId: "CASE-1", reason: `needed for case; call 0812345678901`, accessLevel: "full" as const };

  it("a full read returns the value only after its evidence committed, in the same transaction, with the reason scrubbed", async () => {
    const op = await makeOperator(["accounts.reveal", "audit.read"]);
    const seen = await withPersonalDataAccess(op, { ...evidence, expiresAt: new Date(Date.now() + 60_000) }, async (tx) => {
      // inside the callback the evidence row is already visible to this transaction
      const [{ n }] = (await tx.execute(sql`select count(*)::int as n from console_access_events(10, null)`)) as unknown as { n: number }[];
      return n;
    });
    expect(seen).toBe(1);
    const events = await consoleAccessEvents(await makeOperator(["audit.read"]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorUserId: op.userId, targetKind: "account", fieldClass: "phone", purposeCode: "support_case", caseId: "CASE-1", accessLevel: "full" });
    expect(Object.keys(events[0]!)).not.toContain("reason"); // the viewer shows evidence, not rationale
    expect(events[0]!.createdAt).toBeInstanceOf(Date); // the raw driver text is converted: the page calls toISOString() on it
    expect(events[0]!.expiresAt).toBeInstanceOf(Date);
    const [raw] = (await admin.execute(sql`select reason from personal_data_access_event`)) as unknown as { reason: string }[];
    expect(raw!.reason).not.toContain("0812345678901");
  });

  it("when the evidence cannot be written the loader never runs and nothing is returned", async () => {
    const op = await makeOperator(["accounts.reveal"]);
    let loaded = false;
    const bad = { ...evidence, fieldClass: "not_a_class" as never, expiresAt: new Date(Date.now() + 60_000) };
    expect(await code(withPersonalDataAccess(op, bad, async () => void (loaded = true)))).toBe("23514");
    expect(loaded).toBe(false);
  });

  it("a full or export read needs a case and a future expiry; a masked read does not; a non-revealing capability can never reveal", async () => {
    const op = await makeOperator(["accounts.reveal", "tenants.read"]);
    let loaded = false;
    const load = async () => void (loaded = true);
    expect(await code(withPersonalDataAccess(op, { ...evidence, caseId: undefined, expiresAt: new Date(Date.now() + 60_000) }, load))).toBe("purpose_required");
    expect(await code(withPersonalDataAccess(op, { ...evidence, expiresAt: new Date(Date.now() - 1000) }, load))).toBe("purpose_required");
    expect(await code(withPersonalDataAccess(op, { ...evidence, purposeCode: " ", expiresAt: new Date(Date.now() + 60_000) }, load))).toBe("purpose_required");
    expect(await code(withPersonalDataAccess(op, { ...evidence, capability: "tenants.read", expiresAt: new Date(Date.now() + 60_000) }, load))).toBe("forbidden");
    expect(loaded).toBe(false);
    expect(await code(withPersonalDataAccess(op, { ...evidence, accessLevel: "masked", caseId: undefined }, load))).toBe("ok");
    expect(loaded).toBe(true);
  });

  it("no grant, or an expired one, gets no value and a denial row", async () => {
    const none = await makeOperator([]);
    let loaded = false;
    expect(await code(withPersonalDataAccess(none, { ...evidence, expiresAt: new Date(Date.now() + 60_000) }, async () => void (loaded = true)))).toBe("forbidden");
    expect(loaded).toBe(false);
    expect((await admin.select().from(auditLog).where(eq(auditLog.actorUserId, none.userId))).map((r) => r.action)).toEqual(["operator.denied"]);
    expect(((await admin.execute(sql`select count(*)::int as n from personal_data_access_event`)) as unknown as { n: number }[])[0]!.n).toBe(0);
  });

  it("neither login role can touch the table; the only ways in and out are the two functions, and rows are never updated", async () => {
    const op = await makeOperator(["accounts.reveal"]);
    await withPersonalDataAccess(op, { ...evidence, expiresAt: new Date(Date.now() + 60_000) }, async () => 1);
    for (const exec of [platform, db]) {
      for (const stmt of ["select * from personal_data_access_event", "insert into personal_data_access_event (actor_user_id, target_kind, target_id, field_class, purpose_code, reason, access_level) values ('a','b','c','phone','d','e','masked')", "update personal_data_access_event set reason = 'x'", "delete from personal_data_access_event", "truncate personal_data_access_event"]) {
        expect(await code(exec.execute(stmt)), stmt).toBe("42501");
      }
    }
    expect(await code(db.execute(sql`select console_access_events(1, null)`))).toBe("42501"); // the app role may not even call the reader
    expect(await code(admin.execute(sql`update personal_data_access_event set reason = 'tampered'`))).toBe("42501"); // trigger: append-only against the owner too
  });
});

describe("access evidence retention class (JOB-31)", () => {
  it("the class exists with no seeded period and no setter; the purge deletes only rows older than a period the owner enabled", async () => {
    const op = await makeOperator(["ops.jobs.manage"]);
    expect(await code(setRetentionPeriod(op, { dataClass: "access_event", days: 30, reason: "uji" }))).toBe("0A000");
    await admin.execute(sql`insert into personal_data_access_event (actor_user_id, target_kind, target_id, field_class, purpose_code, reason, access_level, created_at) values ('a','account','1','phone','support_case','old','masked', now() - interval '100 days'), ('a','account','2','phone','support_case','new','masked', now())`);
    expect(await purgeClass(platform, "access_event")).toBe(0); // no period: purge is off
    await admin.execute(sql`insert into retention_policy (class, period_days) values ('access_event', 30)`);
    expect(await purgeClass(platform, "access_event")).toBe(1);
    expect(((await admin.execute(sql`select reason from personal_data_access_event`)) as unknown as { reason: string }[]).map((r) => r.reason)).toEqual(["new"]);
    expect(await code(db.execute(sql`select retention_purge_access_event(10)`))).toBe("42501");
  });
});
