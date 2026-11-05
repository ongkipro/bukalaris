import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Tx } from "../client.ts";
import { auditLog, store } from "../schema.ts";
import { DomainError, operatorScope, type OperatorScope } from "../platform/scoped.ts";
import { hasPlatformCap, holdsCapability, operatorCapabilities, requirePlatformCap } from "./capabilities.ts";
import { consoleRoute } from "./console-routes.ts";
import { auditView, type AuditEntry } from "./console-redaction.ts";
import { scrubText } from "./ops.ts";
import { approvalRequest, fourEyesRule, FOUR_EYES_MATRIX, PLATFORM_CAPABILITIES, type PlatformCapability } from "./schema-ops.ts";
import { issueReport } from "./schema-console.ts";
import { deadLetters, jobLagByKind, replayAudit, type DeadLetter, type KindLag } from "./jobs/observability.ts";
import { schedulerHealth, type SchedulerHealth } from "./jobs/scheduler.ts";

/** Raw driver rows and aggregates return timestamps as text; a Date is what every caller of this module expects. */
const toDate = (v: Date | string | null | undefined) => (v == null ? null : new Date(v));
// Owner console services (T-62). Every function takes the OperatorScope and calls `requirePlatformCap` first.

/**
 * The request boundary of the console. The caller supplies only the user id of a verified session: the operator row and
 * the grant rows are read again here, the route template must be registered and active (P1), and a refusal writes a denial
 * audit row. Nothing in a cookie or a previous request is believed.
 */
export async function authorizeConsole(exec: Executor, userId: string, template: string, capability?: PlatformCapability) {
  const op = await operatorScope(exec, userId);
  if (!op) {
    await exec.insert(auditLog).values({ actorUserId: userId, action: "console.denied", subjectKind: "route", subjectId: template.slice(0, 200), outcome: "denied", reason: "not_operator" });
    throw new DomainError("operator_inactive", "Sesi ini tidak lagi memiliki akses Owner console. Keluar dan masuk kembali.");
  }
  const route = consoleRoute(template);
  if (!route || route.phase !== "P1") {
    await exec.insert(auditLog).values({ actorUserId: userId, action: "console.denied", subjectKind: "route", subjectId: template.slice(0, 200), outcome: "denied", reason: "unlisted_or_dormant_route" });
    throw new DomainError("not_found", "Halaman tidak ditemukan.");
  }
  const caps = await operatorCapabilities(exec, userId);
  // A page names its own capability when its routes accept several (approvals, ops); otherwise the first one the operator holds.
  const needed = capability ?? route.capabilities.find((c) => caps.includes(c)) ?? route.capabilities[0]!;
  await requirePlatformCap(op, needed);
  return { op, caps, route };
}

/**
 * The one wrapper of a console mutation (UX-22 slice 4): capability first, a reason code and reason, then the change and its
 * audit row (actor, capability, target, case, reason code, outcome) in the SAME transaction. When the audit row cannot be
 * written the whole mutation rolls back, so no change is ever without its audit row.
 */
export async function consoleMutation<T>(
  op: OperatorScope,
  input: { capability: PlatformCapability; action: string; targetKind: string; targetId: string; reason: string; reasonCode: string; caseId?: string },
  mutate: (tx: Tx) => Promise<T>,
): Promise<T> {
  await requirePlatformCap(op, input.capability);
  if (!input.reason.trim() || !/^[a-z][a-z0-9_.-]{1,63}$/.test(input.reasonCode)) throw new DomainError("reason_required", "Kode alasan dan alasan wajib diisi.");
  return op.exec.transaction(async (tx) => {
    const stillHeld = async () => {
      if (!(await holdsCapability(tx, op.userId, input.capability))) throw new DomainError("forbidden", `Akses ditolak: butuh izin ${input.capability}.`);
    };
    // Checked inside the transaction, and again after the change just before its audit row: a grant revoked meanwhile
    // (another request, committed) aborts the whole mutation instead of letting an already-revoked operator finish.
    await stillHeld();
    const result = await mutate(tx);
    await stillHeld();
    await tx.insert(auditLog).values({
      actorUserId: op.userId,
      actorCapability: input.capability,
      action: input.action,
      subjectKind: input.targetKind,
      subjectId: input.targetId,
      caseId: input.caseId ?? null,
      purposeCode: input.reasonCode,
      reason: scrubText(input.reason),
      accessLevel: "write",
      outcome: "allowed",
    });
    return result;
  });
}

// ── Dashboard SA-14 ─────────────────────────────────────────────────────────────────────────────────────────────────

type Card<T> = { state: "hidden" } | { state: "error" } | { state: "ok"; data: T };
async function card<T>(visible: boolean, load: () => Promise<T>): Promise<Card<T>> {
  if (!visible) return { state: "hidden" };
  try {
    return { state: "ok", data: await load() };
  } catch {
    return { state: "error" }; // a failing source is its own error, never an empty or zero value
  }
}

/** Cards whose sources exist today. Each is gated by its own capability and fails on its own; the planned ones are listed by the page as "belum tersedia". */
export async function consoleDashboard(op: OperatorScope) {
  await requirePlatformCap(op, "dashboard.read");
  const caps = await operatorCapabilities(op.exec, op.userId);
  const asOf = new Date();
  const approvalCaps = [...new Set(FOUR_EYES_MATRIX.filter((r) => r.active).map((r) => r.capability))].filter((c) => caps.includes(c));
  const [stores, approvals, issues, jobs] = await Promise.all([
    card(caps.includes("tenants.read"), async () => {
      const rows = await op.exec.select({ status: store.status, count: sql<number>`count(*)::int` }).from(store).groupBy(store.status);
      const by = (s: string) => rows.find((r) => r.status === s)?.count ?? 0;
      return { total: rows.reduce((n, r) => n + r.count, 0), active: by("active"), suspended: by("suspended") };
    }),
    card(approvalCaps.length > 0, async () => {
      const [row] = await op.exec
        .select({ pending: sql<number>`count(*)::int`, oldest: sql<Date | string | null>`min(${approvalRequest.createdAt})` })
        .from(approvalRequest)
        .innerJoin(fourEyesRule, eq(fourEyesRule.actionKey, approvalRequest.actionKey))
        .where(and(eq(approvalRequest.status, "pending"), sql`${approvalRequest.expiresAt} > now()`, inArray(fourEyesRule.capability, approvalCaps)));
      return { pending: row!.pending, oldest: toDate(row!.oldest) };
    }),
    card(caps.includes("ops.issues.manage"), () =>
      op.exec
        .select({ pageId: issueReport.pageId, open: sql<number>`count(*)::int` })
        .from(issueReport)
        .where(inArray(issueReport.status, ["new", "triaged", "in_progress"]))
        .groupBy(issueReport.pageId)
        .orderBy(desc(sql`count(*)`), issueReport.pageId)
        .limit(5),
    ),
    card(caps.includes("ops.read"), async () => {
      const { counts } = await deadLetters(op.exec, { limit: 1 });
      return { dead: counts.filter((c) => c.status === "dead").reduce((n, c) => n + c.count, 0), unknown: counts.filter((c) => c.status === "unknown").reduce((n, c) => n + c.count, 0) };
    }),
  ]);
  return { asOf, caps, stores, approvals, issues, jobs };
}

// ── System health SA-36 ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ConsoleJobHealth {
  asOf: Date;
  lag: KindLag[];
  letters: { counts: { kind: string; status: "dead" | "unknown"; count: number }[]; jobs: DeadLetter[] };
  scheduler: SchedulerHealth;
  /** Replay history without free-text reasons; null unless the viewer also holds `audit.read`. */
  replay: { id: number; actorUserId: string; action: string; storeId: number | null; createdAt: Date }[] | null;
}
export async function consoleJobHealth(op: OperatorScope): Promise<ConsoleJobHealth> {
  await requirePlatformCap(op, "ops.read");
  const now = new Date();
  const [lag, letters, scheduler] = await Promise.all([jobLagByKind(op.exec, now), deadLetters(op.exec), schedulerHealth(op.exec, { now })]);
  // Replay history is audit data: ops.read alone must not widen audit.read, and the free-text reason stays out of this view.
  const replay = (await hasPlatformCap(op, "audit.read")) ? (await replayAudit(op.exec)).map(({ reason: _reason, ...row }) => row) : null;
  return { asOf: now, lag, letters: { ...letters, jobs: letters.jobs.map((j) => ({ ...j, lastError: j.lastError ? scrubText(j.lastError) : null })) }, scheduler, replay };
}

// ── Provider health SA-35 and platform settings SA-34 ─────────────────────────────────────────────────────────────

const KNOWN_PROVIDERS = ["mengantar", "autolaris", "meta", "tiktok", "google"] as const;
/**
 * Present / last sanitized result / unknown (UX-22 SA-35): never a secret and never a credential value. The console does not
 * read credential stores, so "present" is not claimed; the last result comes from sanitized `system_log` events that carry a
 * `provider` field, and a provider without events is "unknown", not healthy.
 */
export async function consoleProviderHealth(op: OperatorScope) {
  await requirePlatformCap(op, "providers.read");
  const rows = await op.exec.execute<{ provider: string; last_event: Date | null; last_failure: Date | null }>(sql`
    select fields->>'provider' as provider, max(time) as last_event, max(time) filter (where level in ('warn','error','fatal')) as last_failure
    from system_log where fields ? 'provider' and time > now() - interval '30 days' group by 1`);
  const seen = new Map(rows.map((r) => [r.provider, r]));
  const names = [...new Set<string>([...KNOWN_PROVIDERS, ...seen.keys()])].filter((n) => /^[a-z0-9_-]{1,32}$/.test(n));
  return {
    providers: names.map((provider) => ({ provider, lastEventAt: toDate(seen.get(provider)?.last_event), lastFailureAt: toDate(seen.get(provider)?.last_failure) })),
    liveGates: [
      { name: "MENGANTAR_WRITE_ENABLED", on: process.env.MENGANTAR_WRITE_ENABLED === "1" },
      { name: "SIGNALS_LIVE", on: process.env.SIGNALS_LIVE === "1" },
    ],
  };
}

export async function consoleSettings(op: OperatorScope) {
  await requirePlatformCap(op, "settings.manage");
  const rate = (name: string, fallback: number) => (Number.isSafeInteger(Number(process.env[name])) && Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
  return {
    rootDomain: process.env.STORE_ROOT_DOMAIN ?? null,
    rateLimits: [
      { key: "Masuk (Better Auth)", policy: "3 percobaan per 10 detik per IP" },
      { key: "RL-ISSUE Lapor masalah", policy: `${rate("ISSUE_REPORT_BURST_LIMIT", 3)} per menit dan ${rate("ISSUE_REPORT_HOURLY_LIMIT", 10)} per jam per staf (nilai bawaan konservatif, bukan keputusan pemilik)` },
    ],
  };
}

// ── Audit viewer SA-37 ──────────────────────────────────────────────────────────────────────────────────────────────

/** Widest window of one audit query. A named conservative default (D-22 item 3), not an owner decision. */
export const AUDIT_MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
const optional = <T extends z.ZodType>(s: T) => z.preprocess((v) => (v === "" || v == null ? undefined : v), s.optional());
export const auditFilters = z.object({
  actor: optional(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "Aktor tidak valid.")),
  capability: optional(z.enum(PLATFORM_CAPABILITIES as unknown as [PlatformCapability, ...PlatformCapability[]])),
  subjectKind: optional(z.string().regex(/^[a-z_]{1,32}$/, "Jenis target tidak valid.")),
  subjectId: optional(z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, "ID target tidak valid.")),
  caseId: optional(z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, "ID kasus tidak valid.")),
  outcome: optional(z.enum(["allowed", "denied"])),
  from: optional(z.coerce.date()),
  to: optional(z.coerce.date()),
  cursor: optional(z.string().regex(/^\d{1,16}$/, "Kursor tidak valid.")),
  limit: optional(z.coerce.number().int().min(1).max(200)),
});

/**
 * Audit rows through the per-action allowlist (`auditView`), newest first, bounded window (default 24 hours), cursor paging.
 * The read itself is written to the audit log in the same transaction (after the select, so a page never lists its own read).
 * No update or delete exists here or anywhere in the console.
 */
export interface AuditPage {
  from: Date;
  to: Date;
  items: AuditEntry[];
  nextCursor: string | null;
}
export async function consoleAudit(op: OperatorScope, raw: unknown = {}, clock: () => Date = () => new Date()): Promise<AuditPage> {
  await requirePlatformCap(op, "audit.read");
  const f = auditFilters.parse(raw);
  const to = f.to ?? clock();
  const from = f.from ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);
  if (!(from < to)) throw new DomainError("invalid_range", "Rentang waktu tidak valid: 'dari' harus sebelum 'sampai'.");
  if (to.getTime() - from.getTime() > AUDIT_MAX_RANGE_MS) throw new DomainError("range_too_wide", "Rentang waktu maksimal 7 hari.");
  const limit = f.limit ?? 50;
  const conds = [gte(auditLog.createdAt, from), lte(auditLog.createdAt, to)];
  if (f.actor) conds.push(eq(auditLog.actorUserId, f.actor));
  if (f.capability) conds.push(eq(auditLog.actorCapability, f.capability));
  if (f.subjectKind) conds.push(eq(auditLog.subjectKind, f.subjectKind));
  if (f.subjectId) conds.push(eq(auditLog.subjectId, f.subjectId));
  if (f.caseId) conds.push(eq(auditLog.caseId, f.caseId));
  if (f.outcome) conds.push(eq(auditLog.outcome, f.outcome));
  if (f.cursor) conds.push(lt(auditLog.id, Number(f.cursor)));
  return op.exec.transaction(async (tx) => {
    const rows = await tx.select().from(auditLog).where(and(...conds)).orderBy(desc(auditLog.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "audit.read", action: "audit.read", accessLevel: "masked", outcome: "allowed", reason: `count:${page.length}` });
    return { from, to, items: page.map(auditView), nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null };
  });
}

/** Personal-data access evidence (DATA-14): the single read path of the restricted table, also audit.read and itself audited. */
export interface AccessEventView {
  id: number;
  actorUserId: string;
  targetKind: string;
  targetId: string;
  fieldClass: string;
  purposeCode: string;
  caseId: string | null;
  accessLevel: string;
  expiresAt: Date | null;
  createdAt: Date;
}
/** Opaque identifiers shown verbatim in access evidence: a UUID, or a lowercase hex fingerprint of 16 to 64 characters. */
export const isOpaqueId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || /^[0-9a-f]{16,64}$/.test(v);

export async function consoleAccessEvents(op: OperatorScope, raw: unknown = {}): Promise<AccessEventView[]> {
  await requirePlatformCap(op, "audit.read");
  const f = z.object({ before: optional(z.coerce.number().int().positive()), limit: optional(z.coerce.number().int().min(1).max(200)) }).parse(raw);
  return op.exec.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; actor_user_id: string; target_kind: string; target_id: string; field_class: string; purpose_code: string; case_id: string | null; access_level: string; expires_at: Date | null; created_at: Date }>(
      sql`select * from console_access_events(${f.limit ?? 50}, ${f.before ?? null}::bigint)`,
    );
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "audit.read", action: "access.read", accessLevel: "masked", outcome: "allowed", reason: `count:${rows.length}` });
    // A UUID or a keyed hex fingerprint (account search, 16 hex) is an id, not free text: the scrubber would read digit runs
    // inside it as numbers (T-99: a fingerprint with 8+ consecutive digits rendered as "e[digits]a7…").
    return [...rows].map((r) => ({ id: Number(r.id), actorUserId: r.actor_user_id, targetKind: r.target_kind, targetId: isOpaqueId(r.target_id) ? r.target_id : scrubText(r.target_id, 80), fieldClass: r.field_class, purposeCode: r.purpose_code, caseId: r.case_id, accessLevel: r.access_level, expiresAt: toDate(r.expires_at), createdAt: toDate(r.created_at)! }));
  });
}
