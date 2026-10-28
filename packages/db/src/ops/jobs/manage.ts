import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db, Executor } from "../../client.ts";
import type { OperatorScope } from "../../platform/scoped.ts";
import { auditLog, job } from "../../schema.ts";
import { requirePlatformCap } from "../capabilities.ts";
import { JOB_CHANNEL, type Job, kindPolicy } from "./jobs.ts";

// Operator-side job management (JOB-22, OBS-7, D-21, T-74). Every service takes the Owner console scope and
// requires the capability `ops.jobs.manage` (IAM-15) before it touches a job, then writes an audit row in the same
// transaction as the change. The automatic reconciler is the only caller that acts as the system actor instead.

export const JOBS_MANAGE_CAPABILITY = "ops.jobs.manage";
export const SYSTEM_RECONCILER = "system:job-reconciler";

export type JobManageErrorCode = "reason_required" | "not_found" | "not_dead" | "not_replay_safe" | "not_unknown" | "unknown_projection";
export class JobManageError extends Error {
  readonly code: JobManageErrorCode;
  constructor(code: JobManageErrorCode, message: string) {
    super(message);
    this.name = "JobManageError";
    this.code = code;
  }
}

const needReason = (reason: string) => {
  if (!reason.trim()) throw new JobManageError("reason_required", "a reason is required");
  return reason.trim();
};
const audit = (tx: Executor, actorUserId: string, action: string, storeId: number | null, reason: string) =>
  tx.insert(auditLog).values({ actorUserId, action, storeId, reason: reason.slice(0, 500) });

/**
 * Put a `dead` job back to `pending` with a fresh attempt budget. Only kinds flagged replay-safe (their handler is
 * idempotent on its own record); money kinds such as `shipment.book` are reconciled by their owning service, and
 * `unknown` jobs only through `resolveUnknownJob`. Audited as `jobs.requeue` with the actor and reason.
 */
export async function requeueDeadJob(op: OperatorScope, input: { jobId: number; reason: string }): Promise<void> {
  await requirePlatformCap(op, JOBS_MANAGE_CAPABILITY);
  const reason = needReason(input.reason);
  await op.exec.transaction(async (tx) => {
    const [j] = await tx.select().from(job).where(eq(job.id, input.jobId)).for("update");
    if (!j) throw new JobManageError("not_found", `job ${input.jobId} not found`);
    if (j.status !== "dead") throw new JobManageError("not_dead", `job ${j.id} is ${j.status}, only dead jobs are requeued`);
    if (!kindPolicy(j.kind).replaySafe) throw new JobManageError("not_replay_safe", `kind ${j.kind} is not flagged replay-safe`);
    await tx.update(job).set({ status: "pending", attempts: 0, nextAttemptAt: sql`now()`, updatedAt: sql`now()` }).where(eq(job.id, j.id));
    await audit(tx, op.userId, "jobs.requeue", j.storeId, `job:${j.id} kind:${j.kind} ${reason}`);
    await tx.execute(sql`select pg_notify(${JOB_CHANNEL}, ${j.kind})`);
  });
}

/**
 * Settle an `unknown` job once someone has established whether its external effect happened: `effect_confirmed`
 * completes it, `effect_absent` clears the dispatch mark and queues it again (the only way a dispatched job is
 * ever re-run). Audited as `jobs.reconcile`.
 */
export async function resolveUnknownJob(op: OperatorScope, input: { jobId: number; outcome: "effect_confirmed" | "effect_absent"; evidence: string }): Promise<void> {
  await requirePlatformCap(op, JOBS_MANAGE_CAPABILITY);
  await settleUnknownJob(op.exec, { ...input, actorUserId: op.userId });
}

/** The state change itself, without a capability check: reached by an authorised operator above or by the automatic reconciler. */
async function settleUnknownJob(db: Executor, input: { jobId: number; outcome: "effect_confirmed" | "effect_absent"; actorUserId: string; evidence: string }): Promise<void> {
  const evidence = needReason(input.evidence);
  await db.transaction(async (tx) => {
    const [j] = await tx.select().from(job).where(eq(job.id, input.jobId)).for("update");
    if (!j) throw new JobManageError("not_found", `job ${input.jobId} not found`);
    if (j.status !== "unknown") throw new JobManageError("not_unknown", `job ${j.id} is ${j.status}, only unknown jobs are reconciled`);
    await tx
      .update(job)
      .set(
        input.outcome === "effect_confirmed"
          ? { status: "done", lastError: null, updatedAt: sql`now()` }
          // A fresh attempt budget: without it a job dispatched on its last attempt would be `pending` yet never claimable again.
          : { status: "pending", dispatchedAt: null, attempts: 0, nextAttemptAt: sql`now()`, updatedAt: sql`now()` },
      )
      .where(eq(job.id, j.id));
    await audit(tx, input.actorUserId, "jobs.reconcile", j.storeId, `job:${j.id} kind:${j.kind} ${input.outcome} ${evidence}`);
    if (input.outcome === "effect_absent") await tx.execute(sql`select pg_notify(${JOB_CHANNEL}, ${j.kind})`);
  });
}

/**
 * Decides, from the owning system of record (the provider's inquiry, our own tables), what happened to a dispatched
 * job: `done` (effect happened), `absent` (it did not) or `unknown` (cannot tell yet; try again later).
 */
export type Reconciler = (db: Db, j: Job) => Promise<"done" | "absent" | "unknown">;
const reconcilers = new Map<string, Reconciler>();
export function registerReconciler(kind: string, fn: Reconciler): void {
  reconcilers.set(kind, fn);
}

/** Run the registered reconcilers over `unknown` jobs (oldest first). Kinds without one stay `unknown` for an operator. */
export async function reconcileUnknownJobs(db: Db, opts: { limit?: number } = {}): Promise<{ settled: number; pending: number }> {
  const kinds = [...reconcilers.keys()];
  if (kinds.length === 0) return { settled: 0, pending: 0 };
  // Only kinds that have a reconciler: a backlog of operator-only kinds must not hide the reconcilable ones.
  const rows = await db.select().from(job).where(and(eq(job.status, "unknown"), inArray(job.kind, kinds))).orderBy(asc(job.updatedAt), asc(job.id)).limit(opts.limit ?? 50);
  let settled = 0;
  for (const j of rows) {
    const fn = reconcilers.get(j.kind);
    if (!fn) continue;
    let verdict: "done" | "absent" | "unknown";
    try {
      verdict = await fn(db, j);
    } catch {
      continue; // one failing reconciler must not stop the others; the job stays `unknown` for the next pass
    }
    if (verdict === "unknown") continue;
    try {
      await settleUnknownJob(db, { jobId: j.id, outcome: verdict === "done" ? "effect_confirmed" : "effect_absent", actorUserId: SYSTEM_RECONCILER, evidence: `reconciler verdict ${verdict}` });
      settled++;
    } catch (err) {
      if (!(err instanceof JobManageError && err.code === "not_unknown")) throw err; // settled by someone else meanwhile
    }
  }
  return { settled, pending: rows.length - settled };
}

// ── Rebuildable projections (JOB-20 `affiliate_catalog`, T-52) ──────────────────────────────────────────────────

/** Replaces the whole projection from its source tables inside the given transaction; returns the rows written. Must be a pure replace so a repeat leaves the same state. */
export type ProjectionRebuild = (tx: Executor) => Promise<number>;
const projections = new Map<string, ProjectionRebuild>();
/** Register a projection that supports a full rebuild (T-52 registers `affiliate_catalog`). */
export function registerProjection(name: string, rebuild: ProjectionRebuild): void {
  projections.set(name, rebuild);
}
export const rebuildableProjections = (): string[] => [...projections.keys()];

/**
 * Full rebuild of a registered projection, audited as `projection.rebuild`. One rebuild per projection at a time
 * (a transaction-scoped advisory lock keyed by the name); a concurrent call waits and then rebuilds again, so the
 * end state is always a complete rebuild. Replaying it any number of times is harmless.
 */
export async function rebuildProjection(op: OperatorScope, input: { name: string; reason: string }): Promise<{ rows: number }> {
  await requirePlatformCap(op, JOBS_MANAGE_CAPABILITY);
  const reason = needReason(input.reason);
  const rebuild = projections.get(input.name);
  if (!rebuild) throw new JobManageError("unknown_projection", `projection ${input.name} is not registered`);
  return op.exec.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`projection.rebuild:${input.name}`}, 0))`);
    const rows = await rebuild(tx);
    await audit(tx, op.userId, "projection.rebuild", null, `projection:${input.name} rows:${rows} ${reason}`);
    return { rows };
  });
}
