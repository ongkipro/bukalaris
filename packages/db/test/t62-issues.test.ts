import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { consoleIssues, ISSUE_CONTEXT_BYTES, reportConsoleIssue, sanitizeIssue } from "../src/ops/console-issues.ts";
import { issueReport, issueReportEvent } from "../src/ops/schema-console.ts";
import { recordLogEvent } from "../src/ops/ops.ts";
import { auditLog } from "../src/schema.ts";
import { admin, db, makeOperator, platform } from "./helpers.ts";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
const CANARY = "CANARY-tok-3f9a1c7e5b2d";
const base = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, clientRequestId: randomUUID(), pathname: "/admin/logs", category: "wrong_result", severity: "medium", description: "angka tidak cocok", ...over });
const rows = () => admin.select().from(issueReport).orderBy(issueReport.id);

beforeEach(async () => {
  await admin.execute(sql`truncate system_log, issue_report cascade`);
});

describe("who may report", () => {
  it("needs ops.issues.report: no grant and the wrong capability are refused, create nothing and leave a denial row", async () => {
    const none = await makeOperator([]);
    const manager = await makeOperator(["ops.issues.manage"]);
    expect(await code(reportConsoleIssue(none, base()))).toBe("forbidden");
    expect(await code(reportConsoleIssue(manager, base()))).toBe("forbidden");
    expect(await rows()).toEqual([]);
    expect((await admin.select().from(auditLog).where(eq(auditLog.actorUserId, manager.userId))).map((r) => r.action)).toEqual(["operator.denied"]);
  });

  it("the viewer needs ops.issues.manage: a reporter cannot read the queue, and every read is audited", async () => {
    const reporter = await makeOperator(["ops.issues.report"]);
    const { id } = await reportConsoleIssue(reporter, base());
    expect(await code(consoleIssues(reporter))).toBe("forbidden");
    const reader = await makeOperator(["ops.issues.manage"]);
    const list = await consoleIssues(reader);
    expect(list.items.map((i) => i.id)).toEqual([id]);
    await consoleIssues(reader, { id });
    const reads = (await admin.select().from(auditLog).where(eq(auditLog.actorUserId, reader.userId))).filter((r) => r.action === "issue.read");
    expect(reads).toHaveLength(2);
    expect((await admin.select().from(issueReportEvent)).map((e) => e.kind)).toEqual(["view"]); // opening one report is an event of that report
  });
});

describe("validation: what the browser sends is untrusted", () => {
  it("the page id comes from the route registry, never from the browser; query strings and concrete ids are stripped to the template", async () => {
    const op = await makeOperator(["ops.issues.report"]);
    await reportConsoleIssue(op, base({ pathname: "/admin/stores/42?token=abc#frag", pageId: "SA-99", route: "/evil" }));
    await reportConsoleIssue(op, base({ pathname: "/admin/nothing-here" }));
    await reportConsoleIssue(op, base({ pathname: "/admin/stores/new" }));
    expect((await rows()).map((r) => [r.pageId, r.route])).toEqual([["SA-03", "/admin/stores/[id]"], ["unmapped", "unmapped"], ["SA-03", "/admin/stores/new"]]);
  });

  it("linked log events are resolved on the server from request ids; client-supplied event ids are ignored", async () => {
    const op = await makeOperator(["ops.issues.report"]);
    const logId = await recordLogEvent(db, { level: "error", message: "boom", module: "admin.logs", fields: { request_id: "req-known-1" } });
    await recordLogEvent(db, { level: "error", message: "other", module: "admin.logs", fields: { request_id: "req-other" } });
    const req = (requestId: string) => ({ requestId, pathname: "/admin/logs", method: "GET", status: 500, durationMs: 12, outcome: "failed" });
    await reportConsoleIssue(op, base({ recentRequests: [req("req-known-1"), req("req-unknown")], linkedLogEventIds: [999_999, 1], logEvents: [7] }));
    const [r] = await rows();
    expect(r!.linkedLogEventIds).toEqual([logId]);
  });

  it("text is scrubbed of e-mail, phone, URL query, bearer token, NIK, NPWP and bank-number shapes (canaries), and flagged", async () => {
    const op = await makeOperator(["ops.issues.report"]);
    const dirty = `hubungi budi@example.com atau +62 812-3456-7890, lihat https://x.test/p?token=${CANARY}, Bearer ${CANARY}xyz, NIK 3171234567890123, NPWP 12.345.678.9-012.345, rek 12345678`;
    await reportConsoleIssue(op, base({ description: dirty, controlName: `Hapus ${CANARY}@mail.test`, recentClientErrors: [{ name: "Error", message: `fail password=${CANARY} for 081234567890` }] }));
    const [r] = await rows();
    const stored = JSON.stringify(r);
    for (const leak of ["budi@example.com", "812-3456-7890", CANARY, "3171234567890123", "12.345.678.9-012.345", "12345678"]) expect(stored, leak).not.toContain(leak);
    expect(r!.scrubbed).toBe(true);
    expect(r!.description).toContain("[email]");
  });

  it("100 buffered requests and errors are capped to the newest 20 and 10 and the stored context stays within 16 KiB; an oversize description or bad enum is refused", async () => {
    const op = await makeOperator(["ops.issues.report"]);
    const err = (i: number) => ({ name: "Error", message: `${"x".repeat(450)} ${i}` });
    await reportConsoleIssue(op, base({ recentClientErrors: Array.from({ length: 100 }, (_, i) => err(i)), recentRequests: Array.from({ length: 100 }, (_, i) => ({ requestId: `r${i}`, pathname: "/admin", method: "GET", status: 200, durationMs: 1, outcome: "ok" })) }));
    const [r] = await rows();
    expect(Buffer.byteLength(JSON.stringify(r!.context))).toBeLessThanOrEqual(ISSUE_CONTEXT_BYTES);
    const ctx = r!.context as { recentClientErrors: unknown[]; recentRequests: unknown[]; partial: boolean };
    expect(ctx.recentClientErrors.length).toBeLessThanOrEqual(10);
    expect(ctx.recentRequests.length).toBeLessThanOrEqual(20);
    await expect(reportConsoleIssue(op, base({ description: "y".repeat(2001) }))).rejects.toThrow();
    await expect(reportConsoleIssue(op, base({ category: "bogus" }))).rejects.toThrow();
    await expect(reportConsoleIssue(op, base({ schemaVersion: 2 }))).rejects.toThrow();
    expect(await rows()).toHaveLength(1);
  });

  it("the stored context is bound by the database too", async () => {
    const op = await makeOperator(["ops.issues.report"]);
    await expect(
      admin.insert(issueReport).values({ reporterId: op.userId, clientRequestId: randomUUID(), pageId: "SA-05", route: "/admin/logs", category: "other", severity: "low", description: "d", scrubbed: false, context: { blob: "z".repeat(17_000) }, dedupeKey: "k" }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("sanitizeIssue drops unknown keys at every level (nothing is persisted that the schema does not name)", () => {
    const s = sanitizeIssue(base({ cookie: CANARY, recentRequests: [{ requestId: "r1", pathname: "/admin", method: "GET", status: 200, durationMs: 1, outcome: "ok", headers: { authorization: CANARY } }], extra: { password: CANARY } }), { caps: ["ops.issues.report"] });
    expect(JSON.stringify(s.context)).not.toContain(CANARY);
  });
});

describe("idempotency and rate limit", () => {
  it("a double submit, even concurrent, creates exactly one report and returns the same id", async () => {
    const op = await makeOperator(["ops.issues.report"]);
    const payload = base();
    const ids = await Promise.all(Array.from({ length: 6 }, () => reportConsoleIssue(op, payload)));
    expect(new Set(ids.map((r) => r.id)).size).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect((await admin.select().from(auditLog).where(eq(auditLog.action, "issue.create"))).length).toBe(1);
  });

  it("two staff members never see each other's idempotency key", async () => {
    const a = await makeOperator(["ops.issues.report"]);
    const b = await makeOperator(["ops.issues.report"]);
    const payload = base();
    const ra = await reportConsoleIssue(a, payload);
    const rb = await reportConsoleIssue(b, payload);
    expect(ra.id).not.toBe(rb.id);
  });

  it("a burst of 3 per minute and 10 per hour per staff member are refused without a record and recover under an injected clock", async () => {
    const op = await makeOperator(["ops.issues.report"]);
    const other = await makeOperator(["ops.issues.report"]);
    const t0 = new Date("2026-10-28T08:00:00Z");
    const at = (s: number) => new Date(t0.getTime() + s * 1000);
    for (let i = 0; i < 3; i++) await reportConsoleIssue(op, base(), { now: at(i) });
    expect(await code(reportConsoleIssue(op, base(), { now: at(10) }))).toBe("rate_limited");
    expect((await rows()).length).toBe(3); // the refusal created no record
    await reportConsoleIssue(other, base(), { now: at(10) }); // another staff member is not throttled by this one
    await reportConsoleIssue(op, base(), { now: at(70) }); // the minute window moved on
    await reportConsoleIssue(op, base(), { now: at(71) });
    await reportConsoleIssue(op, base(), { now: at(72) });
    for (let i = 0; i < 3; i++) await reportConsoleIssue(op, base(), { now: at(140 + i) });
    expect((await rows()).filter((r) => r.reporterId === op.userId)).toHaveLength(9);
    await reportConsoleIssue(op, base(), { now: at(210) }); // tenth in the hour
    expect(await code(reportConsoleIssue(op, base(), { now: at(280) }))).toBe("rate_limited"); // eleventh
    await reportConsoleIssue(op, base(), { now: at(3_700) }); // the first window has aged out of the hour
    expect((await rows()).filter((r) => r.reporterId === op.userId)).toHaveLength(11);
  });
});

describe("storage and viewer isolation", () => {
  it("only the platform role can reach the tables, the app role has no grant, and events are append-only", async () => {
    const op = await makeOperator(["ops.issues.report"]);
    const { id } = await reportConsoleIssue(op, base());
    for (const t of ["issue_report", "issue_report_event"]) {
      expect(await code(db.execute(`select * from ${t}`)), t).toBe("42501");
      expect(await code(db.execute(`insert into ${t} default values`)), t).toBe("42501");
    }
    expect(await code(platform.execute(sql`delete from issue_report`))).toBe("42501");
    await admin.insert(issueReportEvent).values({ reportId: id, actorUserId: "x", kind: "note" });
    expect(await code(admin.execute(sql`update issue_report_event set kind = 'view'`))).toBe("42501");
    expect(await code(admin.execute(sql`delete from issue_report_event`))).toBe("42501");
    expect(await code(admin.execute(sql`update issue_report set status = 'duplicate' where id = ${id}`))).toBe("23514"); // duplicate needs duplicate_of
  });

  it("the viewer re-redacts a row written by any other path: foreign keys and credential values never reach the DTO", async () => {
    const op = await makeOperator(["ops.issues.report", "ops.issues.manage"]);
    await admin.insert(issueReport).values({
      reporterId: op.userId, clientRequestId: randomUUID(), pageId: "SA-05", route: "/admin/logs", category: "other", severity: "low",
      description: `tulis token=${CANARY} lalu Bearer ${CANARY}aaaaaaaa budi@example.com`, scrubbed: false,
      context: { release: "r1", cookie: CANARY, authorization: CANARY, recentClientErrors: [{ name: "E", message: `password=${CANARY}`, stack: CANARY }] }, dedupeKey: "k",
    });
    const dto = await consoleIssues(op);
    expect(JSON.stringify(dto)).not.toMatch(new RegExp(`${CANARY}|budi@example`));
    expect(dto.items[0]!.context.release).toBe("r1");
  });

  it("an identical page, category, control and error name produce the same dedupe key; a different page does not", async () => {
    const op = await makeOperator(["ops.issues.report"]);
    const err = [{ name: "TypeError", message: "x" }];
    await reportConsoleIssue(op, base({ recentClientErrors: err, controlId: "shell.report-issue" }), { now: new Date("2026-10-28T08:00:00Z") });
    await reportConsoleIssue(op, base({ recentClientErrors: err, controlId: "shell.report-issue" }), { now: new Date("2026-10-28T08:05:00Z") });
    await reportConsoleIssue(op, base({ pathname: "/admin/stores", recentClientErrors: err, controlId: "shell.report-issue" }), { now: new Date("2026-10-28T08:10:00Z") });
    const keys = (await rows()).map((r) => r.dedupeKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
