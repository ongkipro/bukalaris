import { sql } from "drizzle-orm";
import type { OperatorScope } from "../platform/scoped.ts";
import { auditLog, systemLog } from "../schema.ts";
import { requirePlatformCap } from "./capabilities.ts";
import { CONSOLE_ROUTES } from "./console-routes.ts";
import { MODULE_MAP } from "./ops.ts";
import { issueReport } from "./schema-console.ts";
import { issuePageIdentity } from "./console-issues.ts";

export interface FunctionHealthRow { pageId: string; title: string; task: string; low: number; medium: number; high: number; blocking: number; oldestAgeMs: number | null; week: number; errors: number }
export async function consoleFunctionHealth(op: OperatorScope, now = new Date()): Promise<FunctionHealthRow[]> {
  await requirePlatformCap(op, "ops.issues.manage");
  return op.exec.transaction(async (tx) => {
    const reports = await tx.select({ pageId: issueReport.pageId,
      low: sql<number>`count(*) filter (where status in ('new','triaged','in_progress') and severity = 'low')::int`,
      medium: sql<number>`count(*) filter (where status in ('new','triaged','in_progress') and severity = 'medium')::int`,
      high: sql<number>`count(*) filter (where status in ('new','triaged','in_progress') and severity = 'high')::int`,
      blocking: sql<number>`count(*) filter (where status in ('new','triaged','in_progress') and severity = 'blocking')::int`,
      oldest: sql<string | null>`min(created_at) filter (where status in ('new','triaged','in_progress'))`,
      week: sql<number>`count(*) filter (where created_at >= ${new Date(now.getTime() - 7 * 86400000).toISOString()}::timestamptz)::int`,
    }).from(issueReport).groupBy(issueReport.pageId);
    const errors = await tx.select({ module: systemLog.module, count: sql<number>`count(*)::int` }).from(systemLog).where(sql`${systemLog.level} in ('error','fatal') and ${systemLog.time} >= ${new Date(now.getTime() - 86400000).toISOString()}::timestamptz`).groupBy(systemLog.module);
    const ids = new Set([...CONSOLE_ROUTES.filter((r) => r.phase === "P1" && r.pageId.startsWith("SA-")).map((r) => r.pageId), ...Object.values(MODULE_MAP).map((r) => r.pageId), ...reports.map((r) => r.pageId), "unmapped"]);
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "ops.issues.manage", action: "issue.health", subjectKind: "issue", accessLevel: "masked", outcome: "allowed", reason: "aggregate_by_page" });
    return [...ids].sort().map((pageId) => {
      const r = reports.find((r) => r.pageId === pageId);
      const modules = errors.filter((e) => (MODULE_MAP[e.module ?? ""]?.pageId ?? "unmapped") === pageId);
      const identity = issuePageIdentity(pageId);
      return { pageId, ...identity, low: r?.low ?? 0, medium: r?.medium ?? 0, high: r?.high ?? 0, blocking: r?.blocking ?? 0, oldestAgeMs: r?.oldest ? Math.max(0, now.getTime() - new Date(r.oldest).getTime()) : null, week: r?.week ?? 0, errors: modules.reduce((n, r) => n + r.count, 0) };
    });
  });
}

/** OBS-6 delivery boundary. Only durable alert metadata may leave; configuring a real sink is owner-gated. */
export interface IssueAlertSink { notify(alert: { reportId: number; urgency: "immediate" | "digest" }): Promise<void> }
export class FakeIssueAlertSink implements IssueAlertSink {
  readonly alerts: { reportId: number; urgency: "immediate" | "digest" }[] = [];
  async notify(alert: { reportId: number; urgency: "immediate" | "digest" }) { this.alerts.push({ ...alert }); }
}
