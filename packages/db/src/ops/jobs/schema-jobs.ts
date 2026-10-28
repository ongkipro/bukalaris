// M2 jobs track (T-32, SEC-18, ARCH-6): durable outbox for post-commit side effects; T-74 (JOB-21, JOB-22,
// JOB-28 to JOB-32): platform-wide periodic jobs, priority/lease/dispatch fence, retention registry.
// Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, unique } from "drizzle-orm/pg-core";
import { store } from "../../schema.ts";

/**
 * `dead`: terminal after the attempt ceiling, kept for the dead-letter view and an audited requeue.
 * `unknown`: the external effect was dispatched (`markDispatched`) and the worker then crashed or failed; the
 * outcome is not known, so the job is never re-dispatched until a reconciliation proves what happened (D-21).
 */
export const JOB_STATUSES = ["pending", "running", "done", "dead", "unknown"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Claim order: money (payment, shipment) before identity/notification before bulk. Lower claims first. */
export const JOB_PRIORITIES = { money: 0, identity: 1, bulk: 2 } as const;
export type JobPriority = (typeof JOB_PRIORITIES)[keyof typeof JOB_PRIORITIES];

/**
 * One row per side effect, inserted in the same transaction as the business write
 * that needs it. Payload holds ids and enum-like scalars only (never buyer data or
 * secrets; the handler re-reads the database). `(kind, key)` is the idempotency
 * key: a duplicate enqueue is a no-op. `store_id` is NULL only for the platform-wide
 * kinds registered in `platform_job_kind` (trigger `job_platform_kind_guard`); RLS
 * hides those rows from the app role entirely.
 */
export const job = pgTable(
  "job",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").notNull(),
    storeId: bigint("store_id", { mode: "number" }).references(() => store.id),
    key: text("key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** Lease: a `running` row whose lease has expired is reclaimable (crashed worker). */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lockedBy: text("locked_by"),
    /** Priority class (`JOB_PRIORITIES`), fixed at enqueue from the kind's policy. */
    priority: smallint("priority").notNull().default(2),
    /** Lease length granted at each claim and each heartbeat, fixed at enqueue from the kind's policy. */
    leaseMs: integer("lease_ms").notNull().default(60_000),
    /** Set by `markDispatched` right before the external call; a job with it set is never re-run, only reconciled. */
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    /** Sanitized and truncated message of the last failure. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("job_kind_key_uq").on(t.kind, t.key),
    // Claim scan: only live rows, in claim order.
    index("job_claim_idx")
      .on(t.priority, t.nextAttemptAt, t.id)
      .where(sql`${t.status} in ('pending', 'running')`),
    index("job_store_idx").on(t.storeId, t.id),
    check("job_status_chk", sql`${t.status} in ('pending', 'running', 'done', 'dead', 'unknown')`),
    check("job_attempts_chk", sql`${t.attempts} >= 0`),
    check("job_payload_chk", sql`octet_length(${t.payload}::text) <= 4096`),
    check("job_lock_chk", sql`(${t.status} = 'running') = (${t.lockedBy} is not null and ${t.lockedUntil} is not null)`),
    check("job_priority_chk", sql`${t.priority} in (0, 1, 2)`),
    check("job_lease_chk", sql`${t.leaseMs} > 0`),
    // The never-re-dispatch invariant in the database: a dispatched job cannot go back to `pending`.
    check("job_dispatch_chk", sql`${t.status} <> 'pending' or ${t.dispatchedAt} is null`),
  ],
);

/**
 * Kinds that may run without a store (periodic and retention jobs). Written by migrations only (the
 * platform role has SELECT); the trigger on `job` refuses a NULL `store_id` for any other kind.
 */
export const platformJobKind = pgTable("platform_job_kind", {
  kind: text("kind").primaryKey(),
});

/** Liveness of the periodic enqueuer (JOB-21, DATA-16): one row per scheduler name, rewritten each tick. */
export const schedulerHeartbeat = pgTable(
  "scheduler_heartbeat",
  {
    name: text("name").primaryKey(),
    lastTickAt: timestamp("last_tick_at", { withTimezone: true }).notNull(),
    lastEnqueuedCount: integer("last_enqueued_count").notNull().default(0),
    /** The tick interval the scheduler runs with; liveness is judged in multiples of it. */
    tickIntervalMs: integer("tick_interval_ms").notNull(),
  },
  (t) => [check("scheduler_heartbeat_interval_chk", sql`${t.tickIntervalMs} > 0 and ${t.lastEnqueuedCount} >= 0`)],
);

/**
 * Per-kind cursor of the periodic enqueuer: the start of the newest period already enqueued. Catch-up after
 * downtime and "never twice" both follow from it, so purging old `done` jobs can never re-create a period.
 */
export const schedulerCursor = pgTable("scheduler_cursor", {
  kind: text("kind").primaryKey(),
  lastPeriodStart: timestamp("last_period_start", { withTimezone: true }).notNull(),
});

/**
 * Retention registry (JOB-28 to JOB-32): the data classes a purge exists for. Written by migrations only.
 * `table_name`/`time_column`/`row_filter` are owner-written fixed text interpolated by the purge function.
 */
export const retentionClass = pgTable("retention_class", {
  class: text("class").primaryKey(),
  tableName: text("table_name").notNull(),
  timeColumn: text("time_column").notNull(),
  /** Fixed SQL predicate over the table (e.g. only terminal jobs); `true` for the whole table. */
  rowFilter: text("row_filter").notNull().default("true"),
});

/**
 * Retention period per class in days. No row = purge disabled: no period is defaulted or hard-coded
 * (the privacy owner decides, T-74); written through `setRetentionPeriod` (audited), which calls the owner-side function
 * `retention_set_period()`. Its append-only history table `retention_policy_event` is created by hand in migration 0011
 * (no Drizzle object: nothing in the app reads or writes it except that function).
 */
export const retentionPolicy = pgTable(
  "retention_policy",
  {
    class: text("class").notNull().references(() => retentionClass.class),
    periodDays: integer("period_days").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.class] }), check("retention_policy_period_chk", sql`${t.periodDays} >= 1`)],
);
