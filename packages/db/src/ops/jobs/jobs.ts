import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db, Executor } from "../../client.ts";
import { fakeProviders, type Providers } from "../../payments/providers.ts";
import { job, JOB_PRIORITIES, type JobPriority } from "../../schema.ts";

// Durable outbox (T-32, SEC-18, ARCH-6). Business write + job intent commit in one
// transaction (`enqueue(tx, …)`); a separate worker process claims due rows in priority
// order with `FOR UPDATE SKIP LOCKED` under a per-kind lease (extended by heartbeat while the
// batch runs), runs the handler for the job's kind and marks the row done, or schedules a retry
// with exponential backoff until the attempt ceiling turns it into a terminal `dead` row.
// Remote I/O never runs inside the business transaction. Handlers must be idempotent unless
// they use the dispatch fence (`markDispatched`): a job whose external call was dispatched and
// then crashed or failed becomes `unknown` and is reconciled, never re-run (D-21, T-74).

export const JOB_CHANNEL = "bukalaris_jobs";
/** Default claim length; a kind may declare another (`KindPolicy.leaseMs`). Provider adapters must time out well below it. */
export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 15 * 60_000;
const ERROR_MAX_CHARS = 500;

export type Job = typeof job.$inferSelect;
export type JobContext = { db: Db; providers: Providers };
/** Handler of a store-scoped kind: the row always has a store. */
export type JobHandler = (ctx: JobContext, j: Job & { storeId: number }) => Promise<void>;
/** Handler of a platform-wide kind (periodic/retention jobs): the row never has a store. */
export type PlatformJobHandler = (ctx: JobContext, j: Job & { storeId: null }) => Promise<void>;

/** Per-kind settings, fixed on the row at enqueue. Unlisted kinds are bulk, default lease, not replay-safe. */
export type KindPolicy = { priority: JobPriority; leaseMs: number; replaySafe: boolean };
const DEFAULT_POLICY: KindPolicy = { priority: JOB_PRIORITIES.bulk, leaseMs: LEASE_MS, replaySafe: false };
// Money (payment, shipment) before identity/notification before bulk, so a bulk flood cannot starve payments (OBS-7).
// replaySafe = the handler is idempotent on its own record, so an audited requeue of a dead job cannot repeat an effect.
const BUILTIN_POLICY: Record<string, Partial<KindPolicy>> = {
  "payment.instruction": { priority: JOB_PRIORITIES.money, replaySafe: true }, // stable reff_id persisted at checkout; fenced; unknown outcomes are reconciled (T-49)
  "payment.verify": { priority: JOB_PRIORITIES.money, replaySafe: true }, // verify-by-pull inquiry of a callback (read-only, idempotent)
  "subscription.instruction": { priority: JOB_PRIORITIES.money, replaySafe: true }, // T-50: stable reff_id persisted with the attempt; fenced; unknown outcomes are reconciled
  "subscription.verify": { priority: JOB_PRIORITIES.money, replaySafe: true }, // T-50: verify-by-pull inquiry of a subscription callback (settles once)
  "billing.cycle": { replaySafe: true }, // T-50 JOB-09: idempotent per store and period (unique indexes, unique notices)
  "payment.advice_poll": { replaySafe: true }, // JOB-25 observe-only poll
  "payment.callback_redact": { replaySafe: true },
  "shipment.book": { priority: JOB_PRIORITIES.money }, // books a courier resi: reconciled by the owning service, never blindly requeued
  "shipment.track": { priority: JOB_PRIORITIES.money, replaySafe: true }, // read-only poll
  "order.notify": { priority: JOB_PRIORITIES.identity, replaySafe: true }, // order_notification unique per recipient
  "signal.deliver": { replaySafe: true }, // provider-side event_id dedup
  "retention.signal_event": { replaySafe: true },
  "retention.system_log": { replaySafe: true },
  "retention.audit_log": { replaySafe: true },
  "retention.job": { replaySafe: true },
  "retention.access_event": { replaySafe: true },
  "retention.issue_report": { replaySafe: true },
  "retention.affiliate_click": { replaySafe: true },
  "approval.expire": { replaySafe: true },
};

type Registered = { platform: boolean; run: (ctx: JobContext, j: Job) => Promise<void>; policy?: Partial<KindPolicy> };
const handlers = new Map<string, Registered>();
/** Register the handler for a store-scoped kind; the last registration wins. Settings override the built-in table. */
export function registerHandler(kind: string, handler: JobHandler, policy?: Partial<KindPolicy>): void {
  handlers.set(kind, { platform: false, run: (ctx, j) => handler(ctx, j as Job & { storeId: number }), policy });
}
/** As `registerHandler` for a kind registered in `platform_job_kind`; its rows have no store. */
export function registerPlatformHandler(kind: string, handler: PlatformJobHandler, policy?: Partial<KindPolicy>): void {
  handlers.set(kind, { platform: true, run: (ctx, j) => handler(ctx, j as Job & { storeId: null }), policy });
}
export const getHandler = (kind: string): ((ctx: JobContext, j: Job) => Promise<void>) | undefined => handlers.get(kind)?.run;
export const registeredKinds = (): string[] => [...handlers.keys()];
export const kindPolicy = (kind: string): KindPolicy => ({ ...DEFAULT_POLICY, ...BUILTIN_POLICY[kind], ...handlers.get(kind)?.policy });

/** Delay before attempt `attempts + 1`: 5s, 10s, 20s, … capped at 15 min. */
export const backoffMs = (attempts: number) => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);

/** Root cause's message only (no stack, no SQL), whitespace folded, obvious credentials redacted, truncated. */
export function sanitizeError(err: unknown): string {
  // Drizzle wraps driver errors as "Failed query: <sql>" with the Postgres error as `cause`.
  const e = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return msg
    .replace(/\s+/g, " ")
    .replace(/((?:bearer|token|key|secret|password|authorization)[=: ]+)\S+/gi, "$1[redacted]")
    .slice(0, ERROR_MAX_CHARS);
}

type NewJob = { kind: string; key: string; payload?: Record<string, unknown>; runAt?: Date };

async function insertJob(exec: Executor, storeId: number | null, input: NewJob): Promise<{ id: number | null; created: boolean }> {
  const { priority, leaseMs } = kindPolicy(input.kind);
  const [row] = await exec
    .insert(job)
    .values({ kind: input.kind, storeId, key: input.key, payload: input.payload ?? {}, priority, leaseMs, ...(input.runAt && { nextAttemptAt: input.runAt }) })
    .onConflictDoNothing({ target: [job.kind, job.key] })
    .returning({ id: job.id });
  if (!row) return { id: null, created: false };
  // Wake idle workers; delivered at commit, so a rolled-back enqueue never notifies.
  await exec.execute(sql`select pg_notify(${JOB_CHANNEL}, ${input.kind})`);
  return { id: row.id, created: true };
}

/**
 * Insert job intent in the caller's transaction so it commits (or rolls back) with
 * the business write. Same `(kind, key)` again is a no-op (`created: false`).
 * `runAt` defers the first attempt (T-39 tracking polls); default: due immediately.
 */
export const enqueue = (exec: Executor, input: NewJob & { storeId: number }) => insertJob(exec, input.storeId, input);

/**
 * Platform-wide job (no store): only for kinds registered in `platform_job_kind`; the database refuses any
 * other kind, and the app role can neither read nor write these rows (RLS).
 */
export const enqueuePlatform = (exec: Executor, input: NewJob) => insertJob(exec, null, input);

/**
 * Atomically lease up to `n` due jobs for `workerId`, money first, then by due time. Rows locked by a
 * concurrent claimer are skipped. A `running` row whose lease expired is reclaimed (the crash happened before
 * any dispatch) unless its external effect was dispatched, in which case it becomes `unknown` (never re-run),
 * or it already used all its attempts, in which case it becomes `dead`.
 */
export async function claimBatch(db: Executor, workerId: string, n: number): Promise<Job[]> {
  await db
    .update(job)
    .set({
      status: sql`case when ${job.dispatchedAt} is not null then 'unknown' else 'dead' end`,
      lockedBy: null,
      lockedUntil: null,
      lastError: sql`case when ${job.dispatchedAt} is not null then 'lease expired after dispatch: outcome unknown, reconcile before any re-run' else coalesce(${job.lastError}, 'lease expired on the last attempt') end`,
      updatedAt: sql`now()`,
    })
    .where(
      inArray(
        job.id,
        db
          .select({ id: job.id })
          .from(job)
          .where(and(eq(job.status, "running"), lt(job.lockedUntil, sql`now()`), or(sql`${job.dispatchedAt} is not null`, sql`${job.attempts} >= ${MAX_ATTEMPTS}`)))
          .for("update", { skipLocked: true }),
      ),
    );
  const due = db
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        inArray(job.status, ["pending", "running"]),
        sql`${job.nextAttemptAt} <= now()`,
        or(isNull(job.lockedUntil), lt(job.lockedUntil, sql`now()`)),
        isNull(job.dispatchedAt),
        sql`${job.attempts} < ${MAX_ATTEMPTS}`,
      ),
    )
    .orderBy(asc(job.priority), asc(job.nextAttemptAt), asc(job.id))
    .limit(n)
    .for("update", { skipLocked: true });
  const rows = await db
    .update(job)
    .set({
      status: "running",
      lockedBy: workerId,
      lockedUntil: sql`now() + ${job.leaseMs} * interval '1 millisecond'`,
      attempts: sql`${job.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(job.id, due))
    .returning();
  return rows.sort((a, b) => a.priority - b.priority || a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || a.id - b.id);
}

/**
 * Extend the lease of the still-running jobs `ids` held by `workerId` by their own lease length.
 * Returns the ids still held; a missing id lost its lease (reclaimed, or settled as unknown/dead).
 */
export async function heartbeatJobs(db: Executor, workerId: string, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(job)
    .set({ lockedUntil: sql`now() + ${job.leaseMs} * interval '1 millisecond'`, updatedAt: sql`now()` })
    .where(and(inArray(job.id, ids), eq(job.status, "running"), eq(job.lockedBy, workerId)))
    .returning({ id: job.id });
  return rows.map((r) => r.id);
}

export class LeaseLostError extends Error {
  constructor(jobId: number) {
    super(`job ${jobId}: lease lost before dispatch`);
    this.name = "LeaseLostError";
  }
}

/**
 * The dispatch fence. Call it after the intent is durable and immediately BEFORE the external call; it commits
 * `dispatched_at` while the caller still holds a live lease. From then on a crash, a lease expiry or a thrown error
 * makes the job `unknown` instead of retrying it, and the database refuses to put it back to `pending`. Throws
 * `LeaseLostError` (nothing was dispatched, do not call the provider) when the lease is no longer held.
 */
export async function markDispatched(db: Executor, j: Pick<Job, "id" | "lockedBy">): Promise<void> {
  const rows = await db
    .update(job)
    .set({ dispatchedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(job.id, j.id), eq(job.status, "running"), eq(job.lockedBy, j.lockedBy ?? ""), sql`${job.lockedUntil} > now()`))
    .returning({ id: job.id });
  if (rows.length !== 1) throw new LeaseLostError(j.id);
}

/** Mark done. Returns false when the lease was lost (another worker reclaimed the job). */
export async function completeJob(db: Executor, j: Job): Promise<boolean> {
  const rows = await db
    .update(job)
    .set({ status: "done", lockedBy: null, lockedUntil: null, lastError: null, updatedAt: sql`now()` })
    .where(and(eq(job.id, j.id), eq(job.status, "running"), eq(job.lockedBy, j.lockedBy!)))
    .returning({ id: job.id });
  return rows.length === 1;
}

/**
 * Schedule a retry with backoff, or mark terminally `dead` after MAX_ATTEMPTS. A job that was dispatched
 * (`markDispatched`) becomes `unknown` instead: the effect may have happened. Returns the new status.
 */
export async function failJob(db: Executor, j: Job, err: unknown): Promise<"pending" | "dead" | "unknown" | "lost"> {
  const terminal = j.attempts >= MAX_ATTEMPTS;
  const rows = await db
    .update(job)
    .set({
      status: sql`case when ${job.dispatchedAt} is not null then 'unknown' else ${terminal ? "dead" : "pending"} end`,
      lockedBy: null,
      lockedUntil: null,
      lastError: sanitizeError(err),
      nextAttemptAt: terminal ? sql`now()` : sql`now() + ${backoffMs(j.attempts)} * interval '1 millisecond'`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(job.id, j.id), eq(job.status, "running"), eq(job.lockedBy, j.lockedBy!)))
    .returning({ status: job.status });
  return rows[0] ? (rows[0].status as "pending" | "dead" | "unknown") : "lost";
}

export type JobOutcome = { id: number; kind: string; attempts: number; status: "done" | "pending" | "dead" | "unknown" | "lost"; error?: string };

/**
 * Claim one batch and run it sequentially. Used by the worker loop, `--once`, and tests. While the batch runs, the
 * leases of its unfinished jobs are extended at a third of the shortest lease, so a long handler (or a long
 * queue position inside the batch) keeps its claim and no other worker re-runs it.
 */
export async function runOnce(
  db: Db,
  opts: { workerId: string; batch?: number; providers?: Providers },
): Promise<JobOutcome[]> {
  const ctx: JobContext = { db, providers: opts.providers ?? fakeProviders };
  const claimed = await claimBatch(db, opts.workerId, opts.batch ?? 10);
  const unfinished = new Set(claimed.map((j) => j.id));
  const beat = claimed.length
    ? setInterval(() => void heartbeatJobs(db, opts.workerId, [...unfinished]).catch(() => {}), Math.max(10, Math.min(...claimed.map((j) => j.leaseMs)) / 3))
    : undefined;
  const out: JobOutcome[] = [];
  try {
    for (const j of claimed) {
      try {
        const h = handlers.get(j.kind);
        if (!h) throw new Error(`no handler for kind ${j.kind}`);
        if (h.platform !== (j.storeId === null)) throw new Error(`kind ${j.kind} is registered as ${h.platform ? "platform-wide" : "store-scoped"} but the job ${j.storeId === null ? "has no store" : "has a store"}`);
        await h.run(ctx, j);
        unfinished.delete(j.id);
        out.push({ id: j.id, kind: j.kind, attempts: j.attempts, status: (await completeJob(db, j)) ? "done" : "lost" });
      } catch (err) {
        unfinished.delete(j.id);
        out.push({ id: j.id, kind: j.kind, attempts: j.attempts, status: await failJob(db, j, err), error: sanitizeError(err) });
      }
    }
  } finally {
    clearInterval(beat);
  }
  return out;
}
