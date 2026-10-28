import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLog, systemLog } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { holdsCapability, operatorCapabilities, requirePlatformCap } from "./capabilities.ts";
import { redactIssueContext, type IssueContextView } from "./console-redaction.ts";
import { CONSOLE_ROUTES, resolveConsolePath } from "./console-routes.ts";
import { consoleMutation } from "./console.ts";
import { withPersonalDataAccess } from "./console-access.ts";
import { MODULE_MAP, scrubText } from "./ops.ts";
import { ISSUE_CATEGORIES, ISSUE_SEVERITIES, ISSUE_STATUSES, issueNotification, issueReport, issueReportEvent } from "./schema-console.ts";
const safeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const requestContext = z.object({ requestId: safeId, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]), status: z.number().int().min(0).max(599), durationMs: z.number().min(0).max(3_600_000), outcome: z.enum(["ok", "failed"]), pathname: z.string().max(300).optional() });
export const issueInput = z.object({
  schemaVersion: z.literal(1), clientRequestId: z.uuid(), pathname: z.string().max(500), category: z.enum(ISSUE_CATEGORIES), severity: z.enum(ISSUE_SEVERITIES), description: z.string().trim().min(5).max(2000),
  controlId: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/).optional(), controlRole: z.string().max(30).optional(), controlName: z.string().max(80).optional(),
  viewport: z.object({ width: z.number().int().min(0).max(20000), height: z.number().int().min(0).max(20000) }).optional(),
  userAgent: z.string().max(1000).optional(), partial: z.boolean().optional(),
  recentRequests: z.array(requestContext).max(100).default([]), failedActions: z.array(z.object({ name: z.string().max(80), code: z.string().max(80) })).max(100).default([]),
  recentClientErrors: z.array(z.object({ name: z.string().max(80), message: z.string().max(2000), digest: z.string().max(100).optional() })).max(100).default([]),
});
export const ISSUE_CONTEXT_BYTES = 16384;
const configuredLimit = (name: string, fallback: number) => { const n = Number(process.env[name] ?? fallback); return Number.isSafeInteger(n) && n > 0 ? n : fallback; };
export function sanitizeIssue(raw: unknown, trusted: { caps: readonly string[]; release?: string; userAgent?: string }) {
  const i = issueInput.parse(raw); // unknown browser keys (including pageId and event ids) are dropped at every level.
  const route = resolveConsolePath(i.pathname);
  const requests = i.recentRequests.slice(-20).map(({ pathname, ...r }) => ({ ...r, route: resolveConsolePath(pathname ?? "")?.path ?? "unmapped" }));
  const context: Record<string, unknown> = {
    schemaVersion: 1, release: scrubText(trusted.release ?? "unknown", 64), userAgent: scrubText(trusted.userAgent ?? "", 200), viewport: i.viewport ?? null, capabilities: trusted.caps,
    recentRequests: requests.slice(-20), failedActions: i.failedActions.slice(-10).map((a) => ({ name: scrubText(a.name, 80), code: scrubText(a.code, 80) })),
    recentClientErrors: i.recentClientErrors.slice(-10).map((e) => ({ name: scrubText(e.name, 80), message: scrubText(e.message), digest: e.digest && /^[A-Za-z0-9_-]{1,100}$/.test(e.digest) ? e.digest : undefined })),
    partial: i.partial ?? false, controlRole: scrubText(i.controlRole ?? "", 30), controlName: scrubText(i.controlName ?? "", 80),
  };
  // Bound the stored context by dropping oldest diagnostics, not the description or identity binding.
  while (Buffer.byteLength(JSON.stringify(context)) > ISSUE_CONTEXT_BYTES) {
    const longest = ["recentRequests", "failedActions", "recentClientErrors"].find((k) => (context[k] as unknown[]).length);
    if (!longest) throw new DomainError("too_large", "Konteks teknis melebihi 16 KiB.");
    (context[longest] as unknown[]).shift(); context.partial = true;
  }
  const description = scrubText(i.description, 2000);
  return { input: i, pageId: route?.pageId ?? "unmapped", route: route?.path ?? "unmapped", context, description, scrubbed: description !== i.description };
}
export async function reportConsoleIssue(op: OperatorScope, raw: unknown, trusted: { release?: string; userAgent?: string; now?: Date } = {}) {
  await requirePlatformCap(op, "ops.issues.report");
  const data = sanitizeIssue(raw, { ...trusted, caps: await operatorCapabilities(op.exec, op.userId) });
  const now = trusted.now ?? new Date();
  return op.exec.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue:${op.userId}`}, 0))`);
    const [existing] = await tx.select({ id: issueReport.id }).from(issueReport).where(and(eq(issueReport.reporterId, op.userId), eq(issueReport.clientRequestId, data.input.clientRequestId)));
    if (existing) return existing;
    const [counts] = await tx.select({ hour: sql<number>`count(*)::int`, minute: sql<number>`count(*) filter (where created_at > ${new Date(now.getTime() - 60_000).toISOString()}::timestamptz)::int` }).from(issueReport).where(and(eq(issueReport.reporterId, op.userId), gte(issueReport.createdAt, new Date(now.getTime() - 3_600_000))));
    if (counts!.hour >= configuredLimit("ISSUE_REPORT_HOURLY_LIMIT", 10) || counts!.minute >= configuredLimit("ISSUE_REPORT_BURST_LIMIT", 3)) throw new DomainError("rate_limited", "Batas laporan sementara tercapai. Teks tetap tersimpan; coba lagi nanti.");
    const ids = (data.context.recentRequests as { requestId: string }[]).map((r) => r.requestId);
    const linked = ids.length ? await tx.select({ id: systemLog.id }).from(systemLog).where(and(inArray(systemLog.requestId, ids), gte(systemLog.time, new Date(now.getTime() - 3_600_000)))).limit(100) : [];
    const errors = data.context.recentClientErrors as { name: string }[];
    const dedupeKey = createHash("sha256").update(JSON.stringify([data.pageId, data.input.category, data.input.controlId ?? null, errors.at(-1)?.name ?? null])).digest("hex");
    const [row] = await tx.insert(issueReport).values({ reporterId: op.userId, clientRequestId: data.input.clientRequestId, pageId: data.pageId, route: data.route, category: data.input.category, severity: data.input.severity, description: data.description, scrubbed: data.scrubbed, controlId: data.input.controlId ?? null, context: data.context, linkedLogEventIds: linked.map((r) => r.id), dedupeKey, createdAt: now, updatedAt: now }).returning({ id: issueReport.id });
    await tx.insert(issueNotification).values({ reportId: row!.id, urgency: ["high", "blocking"].includes(data.input.severity) ? "immediate" : "digest" });
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "ops.issues.report", action: "issue.create", subjectKind: "issue", subjectId: String(row!.id), outcome: "allowed", accessLevel: "write", reason: `page_id:${data.pageId}` });
    return row!;
  });
}
/** The viewer re-redacts stored text and context too: a row written by another path cannot smuggle a credential into a DTO. */
export interface IssueView {
  id: number;
  pageId: string;
  route: string;
  category: string;
  severity: string;
  description: string;
  scrubbed: boolean;
  context: IssueContextView;
  linkedLogEventIds: number[];
  status: string;
  createdAt: Date;
  controlId: string | null;
  assigneeId: string | null;
  duplicateOf: number | null;
  resolutionNote: string | null;
  pageTitle: string;
  pageTask: string;
}
function issueDto(row: typeof issueReport.$inferSelect): IssueView {
  const page = issuePageIdentity(row.pageId);
  return { id: row.id, pageId: row.pageId, pageTitle: page.title, pageTask: page.task, route: row.route, category: row.category, severity: row.severity, description: scrubText(row.description, 2000), scrubbed: row.scrubbed, context: redactIssueContext(row.context), linkedLogEventIds: row.linkedLogEventIds, status: row.status, createdAt: row.createdAt, controlId: row.controlId, assigneeId: row.assigneeId, duplicateOf: row.duplicateOf, resolutionNote: row.resolutionNote ? scrubText(row.resolutionNote, 2000) : null };
}
export const issueFilters = z.object({
  id: z.coerce.number().int().positive().optional(), cursor: z.coerce.number().int().min(0).max(100000).optional(),
  pageId: z.string().regex(/^(?:[A-Z]{2,5}-\d+|unmapped)$/).optional(), status: z.enum(ISSUE_STATUSES).optional(),
  category: z.enum(ISSUE_CATEGORIES).optional(), severity: z.enum(ISSUE_SEVERITIES).optional(),
  assigneeId: safeId.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(),
  hasLog: z.enum(["yes", "no"]).optional(), q: z.string().trim().max(120).optional(), sort: z.enum(["newest", "severity"]).default("newest"),
}).refine((f) => !f.from || !f.to || f.to >= f.from, "Rentang tanggal tidak valid.");
type IssueFilters = z.infer<typeof issueFilters>;
function whereIssues(f: IssueFilters) {
  // LIKE metacharacters are literal, and the query itself is always a bound parameter.
  const text = f.q?.replace(/[\\%_]/g, "\\$&");
  return and(f.id ? eq(issueReport.id, f.id) : undefined, f.pageId ? eq(issueReport.pageId, f.pageId) : undefined,
    f.status ? eq(issueReport.status, f.status) : undefined, f.category ? eq(issueReport.category, f.category) : undefined,
    f.severity ? eq(issueReport.severity, f.severity) : undefined, f.assigneeId ? (f.assigneeId === "unassigned" ? sql`${issueReport.assigneeId} is null` : eq(issueReport.assigneeId, f.assigneeId)) : undefined,
    f.from ? gte(issueReport.createdAt, f.from) : undefined, f.to ? lte(issueReport.createdAt, f.to) : undefined,
    f.hasLog ? sql`cardinality(${issueReport.linkedLogEventIds}) ${f.hasLog === "yes" ? sql`>` : sql`=` } 0` : undefined,
    text ? sql`${issueReport.description} ilike ${`%${text}%`}` : undefined);
}
function issueOrder(f: IssueFilters) {
  return f.sort === "severity" ? [asc(sql`case ${issueReport.severity} when 'blocking' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`), desc(issueReport.id)] : [desc(issueReport.id)];
}
export interface IssuePage {
  items: IssueView[];
  nextCursor: number | null;
  counts: { status: string; count: number }[];
  events: (typeof issueReportEvent.$inferSelect)[];
  duplicates: IssueView[];
}
export async function consoleIssues(op: OperatorScope, raw: unknown = {}): Promise<IssuePage> {
  await requirePlatformCap(op, "ops.issues.manage");
  const f = issueFilters.parse(raw);
  return withPersonalDataAccess(op, { capability: "ops.issues.manage", targetKind: "issue", targetId: String(f.id ?? "queue"), fieldClass: "name", purposeCode: "issue_triage", reason: "Scrubbed issue diagnostics", accessLevel: "masked" }, async (tx) => {
    const rows = await tx.select().from(issueReport).where(whereIssues(f)).orderBy(...issueOrder(f)).limit(51).offset(f.cursor ?? 0);
    const counts = await tx.select({ status: issueReport.status, count: sql<number>`count(*)::int` }).from(issueReport).where(whereIssues({ ...f, status: undefined, id: undefined })).groupBy(issueReport.status);
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "ops.issues.manage", action: "issue.read", subjectKind: "issue", subjectId: f.id ? String(f.id) : null, accessLevel: "masked", outcome: "allowed", reason: `count:${Math.min(rows.length, 50)}` });
    if (f.id && rows[0]) await tx.insert(issueReportEvent).values({ reportId: f.id, actorUserId: op.userId, kind: "view" });
    const events = f.id ? await tx.select().from(issueReportEvent).where(eq(issueReportEvent.reportId, f.id)).orderBy(desc(issueReportEvent.id)).limit(200) : [];
    const duplicates = f.id && rows[0] ? await tx.select().from(issueReport).where(and(eq(issueReport.dedupeKey, rows[0].dedupeKey), ne(issueReport.id, f.id))).orderBy(desc(issueReport.id)).limit(20) : [];
    return { items: rows.slice(0, 50).map(issueDto), nextCursor: rows.length > 50 ? (f.cursor ?? 0) + 50 : null, counts, events: events.map((e) => ({ ...e, reason: e.reason ? scrubText(e.reason, 2000) : null })), duplicates: duplicates.map(issueDto) };
  });
}

export type IssueStatus = typeof ISSUE_STATUSES[number];
export const ISSUE_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  new: ["triaged", "duplicate", "wont_fix"], triaged: ["in_progress", "resolved", "duplicate", "wont_fix"],
  in_progress: ["triaged", "resolved", "wont_fix"], resolved: ["triaged"], wont_fix: ["triaged"], duplicate: ["triaged"],
};
export async function transitionIssue(op: OperatorScope, raw: unknown) {
  await requirePlatformCap(op, "ops.issues.manage");
  const i = z.object({ id: z.number().int().positive(), from: z.enum(ISSUE_STATUSES), to: z.enum(ISSUE_STATUSES), note: z.string().trim().max(2000).default(""), duplicateOf: z.number().int().positive().optional() }).parse(raw);
  const note = scrubText(i.note, 2000);
  if (!ISSUE_TRANSITIONS[i.from].includes(i.to)) throw new DomainError("invalid_transition", "Perubahan status tidak diizinkan.");
  if (["resolved", "wont_fix", "duplicate"].includes(i.to) && !note) throw new DomainError("note_required", "Catatan penyelesaian wajib diisi.");
  return consoleMutation(op, { capability: "ops.issues.manage", action: "issue.transition", targetKind: "issue", targetId: String(i.id), reasonCode: "issue_triage", reason: note || `${i.from} → ${i.to}` }, async (tx) => {
    // Serialises the duplicate graph, including simultaneous A→B and B→A.
    await tx.execute(sql`select pg_advisory_xact_lock(680068)`);
    if (i.to === "duplicate") {
      const [target] = i.duplicateOf ? await tx.select().from(issueReport).where(eq(issueReport.id, i.duplicateOf)) : [];
      const [inbound] = await tx.select({ id: issueReport.id }).from(issueReport).where(eq(issueReport.duplicateOf, i.id)).limit(1);
      if (!target || target.id === i.id || target.status === "duplicate" || inbound) throw new DomainError("invalid_duplicate", "Target duplikat harus ada, bukan dirinya sendiri atau duplikat lain.");
    }
    const [r] = await tx.update(issueReport).set({ status: i.to, duplicateOf: i.to === "duplicate" ? i.duplicateOf! : null, resolutionNote: note || null, resolvedAt: ["resolved", "wont_fix", "duplicate"].includes(i.to) ? new Date() : null, updatedAt: new Date() }).where(and(eq(issueReport.id, i.id), eq(issueReport.status, i.from))).returning({ id: issueReport.id });
    if (!r) throw new DomainError("conflict", "Status sudah berubah. Muat ulang sebelum mencoba lagi.");
    await tx.insert(issueReportEvent).values({ reportId: i.id, actorUserId: op.userId, kind: "status", fromValue: i.from, toValue: i.to, reason: note || null });
    return r;
  });
}
export async function assignIssue(op: OperatorScope, raw: unknown) {
  await requirePlatformCap(op, "ops.issues.manage");
  const i = z.object({ id: z.number().int().positive(), expected: safeId.nullable(), assigneeId: safeId.nullable() }).parse(raw);
  return consoleMutation(op, { capability: "ops.issues.manage", action: "issue.assign", targetKind: "issue", targetId: String(i.id), reasonCode: "issue_assignment", reason: "Penugasan laporan" }, async (tx) => {
    if (i.assigneeId && !(await holdsCapability(tx, i.assigneeId, "ops.issues.manage"))) throw new DomainError("invalid_assignee", "Staf tujuan tidak memegang ops.issues.manage.");
    const [row] = await tx.update(issueReport).set({ assigneeId: i.assigneeId, updatedAt: new Date() }).where(and(eq(issueReport.id, i.id), i.expected === null ? sql`${issueReport.assigneeId} is null` : eq(issueReport.assigneeId, i.expected))).returning({ id: issueReport.id });
    if (!row) throw new DomainError("conflict", "Penugasan sudah berubah. Muat ulang.");
    await tx.insert(issueReportEvent).values({ reportId: i.id, actorUserId: op.userId, kind: "assign", fromValue: i.expected, toValue: i.assigneeId });
    return row;
  });
}
export const ISSUE_EXPORT_COLUMNS = ["id", "pageId", "pageTitle", "pageTask", "route", "category", "severity", "status", "description", "resolutionNote", "assigneeId", "duplicateOf", "createdAt"] as const;
export function issueCsvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return `"${(/^[=+\-@\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
}
export async function exportIssues(op: OperatorScope, raw: unknown, format: "csv" | "json") {
  await requirePlatformCap(op, "ops.issues.manage");
  const f = issueFilters.parse(raw);
  const limit = Math.min(configuredLimit("ISSUE_EXPORT_MAX_ROWS", 1000), 10_000);
  return withPersonalDataAccess(op, { capability: "ops.issues.manage", targetKind: "issue", targetId: "export", fieldClass: "name", purposeCode: "issue_triage", reason: "Scrubbed issue export", accessLevel: "masked" }, async (tx) => {
    const rows = await tx.select().from(issueReport).where(whereIssues(f)).orderBy(...issueOrder(f)).limit(limit + 1);
    if (rows.length > limit) throw new DomainError("export_too_large", `Persempit filter: maksimum ${limit} laporan.`);
    const data = rows.map((row) => { const dto = issueDto(row); return Object.fromEntries(ISSUE_EXPORT_COLUMNS.map((key) => [key, dto[key] instanceof Date ? dto[key].toISOString() : dto[key]])); });
    // Do not copy raw search text into an audit reason.
    const filter = { ...f, q: f.q ? { sha256: createHash("sha256").update(f.q).digest("hex"), length: f.q.length } : undefined };
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "ops.issues.manage", action: "issue.export", subjectKind: "issue", accessLevel: "export", outcome: "allowed", reason: JSON.stringify({ filter, rows: rows.length, format }) });
    if (rows.length) await tx.insert(issueReportEvent).values(rows.map((r) => ({ reportId: r.id, actorUserId: op.userId, kind: "export", toValue: format })));
    return format === "json" ? JSON.stringify(data) : [ISSUE_EXPORT_COLUMNS.map(issueCsvCell).join(","), ...data.map((r) => ISSUE_EXPORT_COLUMNS.map((k) => issueCsvCell(r[k])).join(","))].join("\r\n");
  });
}

/** Titles are taken from the same registry as ARCH-5 routes; detail-only pages have explicit names, never a guessed path label. */
export function issuePageIdentity(pageId: string) {
  const detail: Record<string, string> = { "SA-03": "Detail toko", "SA-06": "Detail log", "SA-10": "Detail invoice", "SA-16": "Verifikasi toko", "SA-17": "Buku besar toko", "SA-24": "Detail akun" };
  const task: Record<string, string> = { "SA-02": "T-62", "SA-03": "T-63", "SA-05": "T-23", "SA-06": "T-23", "SA-07": "T-48", "SA-08": "T-37", "SA-09": "T-50", "SA-10": "T-50", "SA-16": "T-63", "SA-17": "T-37", "SA-18": "T-63", "SA-20": "T-63", "SA-23": "T-63", "SA-24": "T-63", "SA-26": "T-37", "SA-36": "T-68", "SA-38": "T-63", "SA-39": "T-63", "SA-50": "T-68", "SA-53": "T-37" };
  return { title: detail[pageId] ?? CONSOLE_ROUTES.find((r) => r.pageId === pageId && r.label)?.label ?? Object.values(MODULE_MAP).find((r) => r.pageId === pageId)?.label ?? "Tidak terpetakan", task: task[pageId] ?? (pageId.startsWith("SA-") ? "T-62" : "—") };
}
