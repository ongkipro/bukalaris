import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor } from "../../client.ts";
import { fakeProviders, type Providers } from "../../payments/providers.ts";
import { job, order } from "../../schema.ts";

// Durable outbox (T-32, SEC-18, ARCH-6). Business write + job intent commit in one
// transaction (`enqueue(tx, …)`); a separate worker process claims due rows with
// `FOR UPDATE SKIP LOCKED` under a lease, runs the handler for the job's kind and
// marks the row done, or schedules a retry with exponential backoff until the
// attempt ceiling turns it into a terminal `failed` row. Remote I/O never runs
// inside the business transaction. Every handler must be idempotent: a crashed
// worker's job is re-run by another worker once its lease expires.

export const JOB_CHANNEL = "bukalaris_jobs";
/** How long a claim is valid. Provider adapters must time out well below this. */
export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 15 * 60_000;
const ERROR_MAX_CHARS = 500;

export type Job = typeof job.$inferSelect;
export type JobContext = { db: Db; providers: Providers };
export type JobHandler = (ctx: JobContext, j: Job) => Promise<void>;

const handlers = new Map<string, JobHandler>();
/** Register the (idempotent) handler for a kind; the last registration wins. */
export function registerHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}
export const getHandler = (kind: string): JobHandler | undefined => handlers.get(kind);

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

/**
 * Insert job intent in the caller's transaction so it commits (or rolls back) with
 * the business write. Same `(kind, key)` again is a no-op (`created: false`).
 * `runAt` defers the first attempt (T-39 tracking polls); default: due immediately.
 */
export async function enqueue(
  exec: Executor,
  input: { kind: string; storeId: number; key: string; payload?: Record<string, unknown>; runAt?: Date },
): Promise<{ id: number | null; created: boolean }> {
  const [row] = await exec
    .insert(job)
    .values({ kind: input.kind, storeId: input.storeId, key: input.key, payload: input.payload ?? {}, ...(input.runAt && { nextAttemptAt: input.runAt }) })
    .onConflictDoNothing({ target: [job.kind, job.key] })
    .returning({ id: job.id });
  if (!row) return { id: null, created: false };
  // Wake idle workers; delivered at commit, so a rolled-back enqueue never notifies.
  await exec.execute(sql`select pg_notify(${JOB_CHANNEL}, ${input.kind})`);
  return { id: row.id, created: true };
}

/**
 * Atomically lease up to `n` due jobs for `workerId`. Rows locked by a concurrent
 * claimer are skipped; `running` rows whose lease expired are reclaimed.
 */
export async function claimBatch(db: Executor, workerId: string, n: number): Promise<Job[]> {
  const due = db
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        inArray(job.status, ["pending", "running"]),
        sql`${job.nextAttemptAt} <= now()`,
        or(isNull(job.lockedUntil), lt(job.lockedUntil, sql`now()`)),
      ),
    )
    .orderBy(asc(job.nextAttemptAt), asc(job.id))
    .limit(n)
    .for("update", { skipLocked: true });
  return db
    .update(job)
    .set({
      status: "running",
      lockedBy: workerId,
      lockedUntil: sql`now() + ${LEASE_MS} * interval '1 millisecond'`,
      attempts: sql`${job.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(job.id, due))
    .returning();
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

/** Schedule a retry with backoff, or mark terminally `failed` after MAX_ATTEMPTS. Returns the new status. */
export async function failJob(db: Executor, j: Job, err: unknown): Promise<"pending" | "failed" | "lost"> {
  const terminal = j.attempts >= MAX_ATTEMPTS;
  const rows = await db
    .update(job)
    .set({
      status: terminal ? "failed" : "pending",
      lockedBy: null,
      lockedUntil: null,
      lastError: sanitizeError(err),
      nextAttemptAt: terminal ? sql`now()` : sql`now() + ${backoffMs(j.attempts)} * interval '1 millisecond'`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(job.id, j.id), eq(job.status, "running"), eq(job.lockedBy, j.lockedBy!)))
    .returning({ id: job.id });
  return rows.length === 1 ? (terminal ? "failed" : "pending") : "lost";
}

export type JobOutcome = { id: number; kind: string; attempts: number; status: "done" | "pending" | "failed" | "lost"; error?: string };

/** Claim one batch and run it sequentially. Used by the worker loop, `--once`, and tests. */
export async function runOnce(
  db: Db,
  opts: { workerId: string; batch?: number; providers?: Providers },
): Promise<JobOutcome[]> {
  const ctx: JobContext = { db, providers: opts.providers ?? fakeProviders };
  const claimed = await claimBatch(db, opts.workerId, opts.batch ?? 10);
  const out: JobOutcome[] = [];
  for (const j of claimed) {
    try {
      const handler = handlers.get(j.kind);
      if (!handler) throw new Error(`no handler for kind ${j.kind}`);
      await handler(ctx, j);
      out.push({ id: j.id, kind: j.kind, attempts: j.attempts, status: (await completeJob(db, j)) ? "done" : "lost" });
    } catch (err) {
      out.push({ id: j.id, kind: j.kind, attempts: j.attempts, status: await failJob(db, j, err), error: sanitizeError(err) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const PAYMENT_INSTRUCTION = "payment.instruction";
const paymentPayload = z.object({ orderId: z.number().int().positive() });

/**
 * Transfer orders: ask the payment provider for an instruction using the stable
 * order reference, and store it only if still absent. Skips (and completes) when
 * the order already has a reference or is no longer awaiting payment, so a re-run
 * after a crash never requests a second instruction (D-5, TD-3).
 */
registerHandler(PAYMENT_INSTRUCTION, async ({ db, providers }, j) => {
  const { orderId } = paymentPayload.parse(j.payload);
  const [o] = await db
    .select({ method: order.paymentMethod, status: order.status, ref: order.paymentReference, total: order.total })
    .from(order)
    .where(and(eq(order.storeId, j.storeId), eq(order.id, orderId)));
  if (!o || o.method !== "manual_transfer" || o.ref || o.status !== "awaiting_payment") return;
  const { reference } = await providers.payment.createInstruction({ storeId: j.storeId, orderId, amount: o.total });
  await db
    .update(order)
    .set({ paymentReference: reference })
    .where(and(eq(order.storeId, j.storeId), eq(order.id, orderId), isNull(order.paymentReference)));
});
