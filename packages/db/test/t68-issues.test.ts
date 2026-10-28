import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { assignIssue, consoleIssues, exportIssues, issueCsvCell, reportConsoleIssue, transitionIssue, type IssueStatus } from "../src/ops/console-issues.ts";
import { consoleFunctionHealth, FakeIssueAlertSink } from "../src/ops/console-issue-health.ts";
import { ISSUE_STATUSES, issueNotification, issueReport, issueReportEvent } from "../src/ops/schema-console.ts";
import { auditLog, operatorGrant } from "../src/schema.ts";
import { purgeBatch, setRetentionPeriod } from "../src/ops/jobs/retention.ts";
import { scrubText } from "../src/ops/ops.ts";
import { admin, db, makeOperator, platform } from "./helpers.ts";
import type { OperatorScope } from "../src/platform/scoped.ts";

async function fixture(op: OperatorScope, status: IssueStatus = "new", extra: Partial<typeof issueReport.$inferInsert> = {}) {
  const [r] = await admin.insert(issueReport).values({ reporterId: op.userId, clientRequestId: randomUUID(), pageId: "SA-02", route: "/admin/stores", category: "other", severity: "high", description: "fixture issue", scrubbed: false, context: {}, dedupeKey: "same", status, duplicateOf: status === "duplicate" ? 99999 : null, ...extra }).returning();
  return r!;
}
const allowed: Record<IssueStatus, IssueStatus[]> = { new: ["triaged", "duplicate", "wont_fix"], triaged: ["in_progress", "resolved", "duplicate", "wont_fix"], in_progress: ["triaged", "resolved", "wont_fix"], resolved: ["triaged"], wont_fix: ["triaged"], duplicate: ["triaged"] };
for (const from of ISSUE_STATUSES) for (const to of ISSUE_STATUSES) it(`exact transition matrix ${from} → ${to} ${allowed[from].includes(to) ? "allows" : "refuses"}`, async () => {
  const op = await makeOperator(["ops.issues.manage"]);
  const r = await fixture(op, from); const target = await fixture(op);
  const call = transitionIssue(op, { id: r.id, from, to, note: "reason for resolution", duplicateOf: target.id });
  if (allowed[from].includes(to)) {
    await expect(call).resolves.toEqual({ id: r.id });
    expect((await admin.select().from(issueReportEvent).where(eq(issueReportEvent.reportId, r.id)))).toHaveLength(1);
    expect((await admin.select().from(auditLog).where(eq(auditLog.action, "issue.transition")))).toHaveLength(1);
  } else { await expect(call).rejects.toMatchObject({ code: "invalid_transition" }); expect(await admin.select().from(issueReportEvent)).toHaveLength(0); }
});

describe("CAS, duplicate graph, assignments and evidence", () => {
  it("concurrent transitions have one winner, one typed conflict and one decision event", async () => {
    const op = await makeOperator(["ops.issues.manage"]); const r = await fixture(op);
    const out = await Promise.allSettled([transitionIssue(op, { id: r.id, from: "new", to: "triaged" }), transitionIssue(op, { id: r.id, from: "new", to: "wont_fix", note: "not an issue" })]);
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(out.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    expect(await admin.select().from(issueReportEvent)).toHaveLength(1);
  });
  it("duplicate target must exist, cannot be self, a duplicate, or become a cycle even concurrently", async () => {
    const op = await makeOperator(["ops.issues.manage"]); const a = await fixture(op); const b = await fixture(op);
    for (const target of [a.id, 999999]) await expect(transitionIssue(op, { id: a.id, from: "new", to: "duplicate", duplicateOf: target, note: "same issue" })).rejects.toMatchObject({ code: "invalid_duplicate" });
    const out = await Promise.allSettled([transitionIssue(op, { id: a.id, from: "new", to: "duplicate", duplicateOf: b.id, note: "same issue" }), transitionIssue(op, { id: b.id, from: "new", to: "duplicate", duplicateOf: a.id, note: "same issue" })]);
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = (await admin.select().from(issueReport)).find((r) => r.status === "duplicate")!;
    const c = await fixture(op);
    await expect(transitionIssue(op, { id: c.id, from: "new", to: "duplicate", duplicateOf: winner.id, note: "same" })).rejects.toMatchObject({ code: "invalid_duplicate" });
  });
  it.each(["resolved", "wont_fix", "duplicate"])("%s requires a scrubbed nonempty resolution note", async (to) => {
    const op = await makeOperator(["ops.issues.manage"]); const r = await fixture(op, "triaged");
    await expect(transitionIssue(op, { id: r.id, from: "triaged", to, note: "   " })).rejects.toMatchObject({ code: "note_required" });
  });
  it("assignment requires an active unexpired manage holder, is CAS, and writes event plus audit", async () => {
    const op = await makeOperator(["ops.issues.manage"]); const other = await makeOperator([]); const r = await fixture(op);
    await expect(assignIssue(op, { id: r.id, expected: null, assigneeId: other.userId })).rejects.toMatchObject({ code: "invalid_assignee" });
    await assignIssue(op, { id: r.id, expected: null, assigneeId: op.userId });
    await expect(assignIssue(op, { id: r.id, expected: null, assigneeId: null })).rejects.toMatchObject({ code: "conflict" });
    expect((await admin.select().from(issueReportEvent))[0]).toMatchObject({ kind: "assign", toValue: op.userId });
    expect(await admin.select().from(auditLog).where(eq(auditLog.action, "issue.assign"))).toHaveLength(1);
    await admin.update(operatorGrant).set({ expiresAt: new Date(0) }).where(eq(operatorGrant.userId, op.userId));
    const fresh = await makeOperator(["ops.issues.manage"]);
    await expect(assignIssue(fresh, { id: r.id, expected: op.userId, assigneeId: op.userId })).rejects.toMatchObject({ code: "invalid_assignee" });
  });
  it("audit insert failure rolls back transition and event", async () => {
    const op = await makeOperator(["ops.issues.manage"]); const r = await fixture(op);
    await admin.execute(sql`create function public.t68_audit_failure() returns trigger language plpgsql as $$ begin if new.action = 'issue.transition' then raise exception 'audit unavailable'; end if; return new; end $$`);
    await admin.execute(sql`create trigger t68_audit_failure before insert on public.audit_log for each row execute function public.t68_audit_failure()`);
    try { await expect(transitionIssue(op, { id: r.id, from: "new", to: "triaged" })).rejects.toThrow(); }
    finally { await admin.execute(sql`drop trigger t68_audit_failure on public.audit_log`); await admin.execute(sql`drop function public.t68_audit_failure()`); }
    expect((await admin.select().from(issueReport).where(eq(issueReport.id, r.id)))[0]!.status).toBe("new");
    expect(await admin.select().from(issueReportEvent)).toHaveLength(0);
  });
});

describe("queue, safe export and function health", () => {
  it("report-only staff are denied list, detail, export, transition and assignment with no report changes", async () => {
    const reporter = await makeOperator(["ops.issues.report"]); const r = await fixture(reporter);
    for (const call of [() => consoleIssues(reporter), () => consoleIssues(reporter, { id: r.id }), () => exportIssues(reporter, {}, "json"), () => assignIssue(reporter, { id: r.id, expected: null, assigneeId: reporter.userId }), () => transitionIssue(reporter, { id: r.id, from: "new", to: "triaged" })]) await expect(call()).rejects.toMatchObject({ code: "forbidden" });
    expect(await admin.select().from(issueReportEvent)).toHaveLength(0);
    expect(await admin.select().from(auditLog).where(eq(auditLog.outcome, "denied"))).toHaveLength(5);
  });
  it("non-staff sessions and app login cannot read or export reports", async () => {
    const op = await makeOperator(["ops.issues.manage"]); await fixture(op);
    const forged = { ...op, userId: randomUUID() };
    await expect(consoleIssues(forged)).rejects.toMatchObject({ code: "forbidden" });
    await expect(exportIssues(forged, {}, "json")).rejects.toMatchObject({ code: "forbidden" });
    await expect(db.execute(sql`select * from public.issue_notification`)).rejects.toMatchObject({ cause: { code: "42501" } });
  });
  it("all filters, literal parameterised search, status counts and severity order apply", async () => {
    const op = await makeOperator(["ops.issues.manage"]);
    const r = await fixture(op, "new", { description: "literal %_ query", linkedLogEventIds: [1], assigneeId: op.userId, createdAt: new Date("2026-10-28T02:00:00Z") });
    await fixture(op, "resolved", { pageId: "SA-05", severity: "low" });
    const f = { status: "new", severity: "high", category: "other", pageId: "SA-02", assigneeId: op.userId, from: "2026-10-28", to: "2026-10-29", hasLog: "yes", q: "%_", sort: "severity" };
    expect((await consoleIssues(op, f)).items.map((r) => r.id)).toEqual([r.id]);
    expect((await consoleIssues(op, { q: "' OR 1=1 --" })).items).toHaveLength(0);
    await expect(consoleIssues(op, { q: "x".repeat(121) })).rejects.toThrow();
    expect((await consoleIssues(op)).counts.reduce((n, r) => n + r.count, 0)).toBe(2);
    expect((await consoleIssues(op, { hasLog: "no" })).items).toHaveLength(1);
  });
  it("list, detail, every export are audited; export drops all context, credentials and non-allowlisted fields", async () => {
    const op = await makeOperator(["ops.issues.manage"]);
    const r = await fixture(op, "new", { description: "<script>alert('canary')</script>", context: { cookie: "CANARY-SECRET", recentClientErrors: [] } });
    const list = await consoleIssues(op); const detail = await consoleIssues(op, { id: r.id });
    expect(list.items[0]!.description).toBe("<script>alert('canary')</script>");
    expect(detail.items[0]!.pageTitle).toBe("Daftar toko"); expect(detail.items[0]!.pageTask).toBe("T-62");
    const json = await exportIssues(op, {}, "json"); await exportIssues(op, {}, "csv");
    expect(json).not.toMatch(/CANARY-SECRET|context|reporterId|dedupeKey|clientRequestId/);
    const actions = (await admin.select().from(auditLog)).map((r) => r.action);
    expect(actions.filter((a) => a === "issue.read")).toHaveLength(2); expect(actions.filter((a) => a === "issue.export")).toHaveLength(2);
    expect((await admin.select().from(issueReportEvent)).map((r) => r.kind)).toEqual(["view", "export", "export"]);
    expect((await admin.execute(sql`select count(*)::int as n from public.personal_data_access_event where actor_user_id = ${op.userId}`))[0]!.n).toBe(4);
  });
  it.each(["=cmd", "+cmd", "-cmd", "@cmd"])("CSV formula canary %s is neutralised in the real export", async (description) => {
    const op = await makeOperator(["ops.issues.manage"]); await fixture(op, "new", { description });
    expect(await exportIssues(op, {}, "csv")).toContain(`"'${description}"`);
    expect(issueCsvCell('a,"b')).toBe('"a,""b"');
  });
  it("export refuses over the named bound rather than silently truncating current filter", async () => {
    const op = await makeOperator(["ops.issues.manage"]); await fixture(op); await fixture(op);
    process.env.ISSUE_EXPORT_MAX_ROWS = "1";
    try { await expect(exportIssues(op, {}, "json")).rejects.toMatchObject({ code: "export_too_large" }); }
    finally { delete process.env.ISSUE_EXPORT_MAX_ROWS; }
  });
  it("per-page severity counts equal an independent SQL query; module errors, 7-day count, oldest and unmapped are honest", async () => {
    const op = await makeOperator(["ops.issues.manage"]); const now = new Date("2026-10-28T10:00:00Z");
    await fixture(op, "new", { severity: "blocking", createdAt: new Date("2026-10-27T10:00:00Z") });
    await fixture(op, "resolved", { createdAt: new Date("2026-10-26T10:00:00Z") });
    await fixture(op, "triaged", { pageId: "unmapped", severity: "low" });
    await admin.execute(sql`insert into public.system_log (level,module,message,time,fields,environment) values ('error','admin.stores','fixture',${now.toISOString()}::timestamptz,'{}','test')`);
    const health = await consoleFunctionHealth(op, now);
    const independently = await admin.execute(sql`select page_id, count(*)::int as n from public.issue_report where status in ('new','triaged','in_progress') group by page_id`);
    for (const r of independently) { const h = health.find((h) => h.pageId === r.page_id)!; expect(h.low + h.medium + h.high + h.blocking).toBe(r.n); }
    expect(health.find((h) => h.pageId === "SA-02")).toMatchObject({ blocking: 1, high: 0, week: 2, oldestAgeMs: 86400000, errors: 1 });
  });
});

describe("PRIV-9, OBS-6 and JOB-13", () => {
  it.each(["3171234567890123", "12.345.678.9-012.345", "1234 5678 9012"])("shared scrubText strips identifier canary %s", (value) => { expect(scrubText(`data ${value}`)).not.toContain(value); });
  it("new reports create one durable immediate or digest notification; replay never notifies twice; fake sink carries ids only", async () => {
    const op = await makeOperator(["ops.issues.report"]); const input = { schemaVersion: 1, clientRequestId: randomUUID(), pathname: "/admin/stores", category: "other", severity: "blocking", description: "a broken function" };
    const a = await reportConsoleIssue(op, input); await reportConsoleIssue(op, input);
    await reportConsoleIssue(op, { ...input, clientRequestId: randomUUID(), severity: "low" });
    const rows = await admin.select().from(issueNotification); expect(rows.map((r) => r.urgency)).toEqual(["immediate", "digest"]);
    const sink = new FakeIssueAlertSink(); await sink.notify({ reportId: a.id, urgency: "immediate" }); expect(sink.alerts).toEqual([{ reportId: a.id, urgency: "immediate" }]);
  });
  it("retention is off without an owner period, anonymises under injected clock once, preserves counts and decision evidence", async () => {
    const op = await makeOperator(["ops.issues.manage", "ops.jobs.manage"]); const r = await fixture(op, "new", { context: { release: "r1" }, createdAt: new Date("2026-01-01") });
    await transitionIssue(op, { id: r.id, from: "new", to: "wont_fix", note: "valid retained decision" });
    expect(await purgeBatch(platform, "issue_report")).toBe(0);
    await setRetentionPeriod(op, { dataClass: "issue_report", days: 30, reason: "local fixture policy" });
    const sweep = async (now: string) => Number((await admin.execute(sql`select public.retention_anonymize_issues(100, ${now}::timestamptz) as n`))[0]!.n);
    try {
      expect(await sweep("2026-01-15")).toBe(0); expect(await sweep("2026-03-01")).toBe(1); expect(await sweep("2026-03-01")).toBe(0);
      const [kept] = await admin.select().from(issueReport); expect(kept).toMatchObject({ status: "wont_fix", context: {}, description: "[retained metadata only]", resolutionNote: null });
      expect((await admin.select().from(issueReportEvent))[0]!.reason).toBe("valid retained decision");
    } finally { await setRetentionPeriod(op, { dataClass: "issue_report", days: null, reason: "clear local policy" }); }
  });
});

describe("wave 4 review: the database guard also covers INSERT and the identity of a report", () => {
  const pgCode = (p: Promise<unknown>) => p.then(() => "ok", (e: { cause?: { code?: string } }) => e.cause?.code);
  const base = (op: OperatorScope) => ({ reporterId: op.userId, clientRequestId: randomUUID(), pageId: "SA-02", route: "/admin/stores", category: "other" as const, severity: "high" as const, description: "insert probe", scrubbed: false, context: {}, dedupeKey: randomUUID() });
  it("a platform-login INSERT cannot create a resolved, duplicate or pre-assigned report", async () => {
    const op = await makeOperator(["ops.issues.manage"]);
    expect(await pgCode(platform.insert(issueReport).values({ ...base(op), status: "resolved", resolutionNote: "x" } as never))).toBe("23514");
    expect(await pgCode(platform.insert(issueReport).values({ ...base(op), assigneeId: op.userId } as never))).toBe("23514");
    expect(await pgCode(platform.insert(issueReport).values(base(op) as never))).toBe("ok");
  });
  it("the reporter, the creation time and the description of a report cannot be rewritten by the platform login", async () => {
    const op = await makeOperator(["ops.issues.manage"]); const r = await fixture(op);
    expect(await pgCode(platform.update(issueReport).set({ reporterId: (await makeOperator([])).userId }).where(eq(issueReport.id, r.id)))).toBe("23514");
    expect(await pgCode(platform.update(issueReport).set({ createdAt: new Date(0) }).where(eq(issueReport.id, r.id)))).toBe("23514");
    expect(await pgCode(platform.update(issueReport).set({ description: "rewritten" }).where(eq(issueReport.id, r.id)))).toBe("23514");
  });
  it.each(["\tcmd", "\rcmd"])("a leading TAB or CR is neutralised in a CSV cell too", (text) => {
    expect(issueCsvCell(text)).toBe(`"'${text}"`);
  });
});
