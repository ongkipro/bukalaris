import { desc, inArray, sql } from "drizzle-orm";
import type { Executor } from "../../client.ts";
import { auditLog, job } from "../../schema.ts";
import { kindPolicy } from "./jobs.ts";

// Queryable job-system metrics (OBS-6, OBS-7, T-74): lag per kind, dead letters, replay audit. Plain functions over
// the database for the Owner console health view and alert checks; no external metrics stack. Platform role only
// (the app role cannot read platform jobs or the audit log). The caller supplies the clock.

export type KindLag = {
  kind: string;
  priority: number;
  pending: number;
  running: number;
  dead: number;
  unknown: number;
  /** Age of the oldest `pending` job that is already due (OBS-6 "outbox lag"); null when nothing is waiting. */
  oldestDueAgeMs: number | null;
};

/** One row per kind and priority class, for kinds that have at least one live, dead or unknown job. */
export async function jobLagByKind(db: Executor, now: Date): Promise<KindLag[]> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const rows = await db.execute<{ kind: string; priority: number; pending: string; running: string; dead: string; unknown: string; lag_ms: string | null }>(sql`
    select kind, priority,
      count(*) filter (where status = 'pending') as pending,
      count(*) filter (where status = 'running') as running,
      count(*) filter (where status = 'dead') as dead,
      count(*) filter (where status = 'unknown') as unknown,
      floor(extract(epoch from (${at} - min(next_attempt_at) filter (where status = 'pending' and next_attempt_at <= ${at}))) * 1000) as lag_ms
    from job
    where status in ('pending', 'running', 'dead', 'unknown')
    group by kind, priority
    order by priority, kind`);
  return rows.map((r) => ({
    kind: r.kind,
    priority: r.priority,
    pending: Number(r.pending),
    running: Number(r.running),
    dead: Number(r.dead),
    unknown: Number(r.unknown),
    oldestDueAgeMs: r.lag_ms === null ? null : Number(r.lag_ms),
  }));
}

export type DeadLetter = {
  id: number;
  kind: string;
  storeId: number | null;
  status: "dead" | "unknown";
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
  /** `dead` and replay-safe: an audited requeue is allowed. */
  requeueable: boolean;
};

/** Dead and unknown jobs, newest first, with counts per kind and state (alert: any `dead` money kind). */
export async function deadLetters(db: Executor, opts: { limit?: number } = {}): Promise<{ counts: { kind: string; status: "dead" | "unknown"; count: number }[]; jobs: DeadLetter[] }> {
  const counts = await db
    .select({ kind: job.kind, status: job.status, count: sql<number>`count(*)::int` })
    .from(job)
    .where(inArray(job.status, ["dead", "unknown"]))
    .groupBy(job.kind, job.status)
    .orderBy(job.kind, job.status);
  const rows = await db
    .select({ id: job.id, kind: job.kind, storeId: job.storeId, status: job.status, attempts: job.attempts, lastError: job.lastError, updatedAt: job.updatedAt })
    .from(job)
    .where(inArray(job.status, ["dead", "unknown"]))
    .orderBy(desc(job.updatedAt), desc(job.id))
    .limit(opts.limit ?? 50);
  return {
    counts: counts.map((c) => ({ ...c, status: c.status as "dead" | "unknown" })),
    jobs: rows.map((r) => ({ ...r, status: r.status as "dead" | "unknown", requeueable: r.status === "dead" && kindPolicy(r.kind).replaySafe })),
  };
}

/** Replay and reconciliation audit (OBS-7): who requeued, reconciled, rebuilt or changed a retention period, newest first. */
export const REPLAY_AUDIT_ACTIONS = ["jobs.requeue", "jobs.reconcile", "projection.rebuild", "retention.set"] as const;
export function replayAudit(db: Executor, opts: { limit?: number } = {}) {
  return db
    .select({ id: auditLog.id, actorUserId: auditLog.actorUserId, action: auditLog.action, storeId: auditLog.storeId, reason: auditLog.reason, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(inArray(auditLog.action, [...REPLAY_AUDIT_ACTIONS]))
    .orderBy(desc(auditLog.id))
    .limit(opts.limit ?? 50);
}
