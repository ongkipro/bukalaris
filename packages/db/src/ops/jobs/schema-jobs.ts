// M2 jobs track (T-32, SEC-18, ARCH-6): durable outbox for post-commit side effects.
// Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { store } from "../../schema.ts";

export const JOB_STATUSES = ["pending", "running", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * One row per side effect, inserted in the same transaction as the business write
 * that needs it. Payload holds ids and enum-like scalars only (never buyer data or
 * secrets; the handler re-reads the database). `(kind, key)` is the idempotency
 * key: a duplicate enqueue is a no-op.
 */
export const job = pgTable(
  "job",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").notNull(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    key: text("key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** Lease: a `running` row whose lease has expired is reclaimable (crashed worker). */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lockedBy: text("locked_by"),
    /** Sanitized and truncated message of the last failure. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("job_kind_key_uq").on(t.kind, t.key),
    // Claim scan: only live rows, ordered by due time.
    index("job_claim_idx")
      .on(t.nextAttemptAt, t.id)
      .where(sql`${t.status} in ('pending', 'running')`),
    index("job_store_idx").on(t.storeId, t.id),
    check("job_status_chk", sql`${t.status} in ('pending', 'running', 'done', 'failed')`),
    check("job_attempts_chk", sql`${t.attempts} >= 0`),
    check("job_payload_chk", sql`octet_length(${t.payload}::text) <= 4096`),
    check("job_lock_chk", sql`(${t.status} = 'running') = (${t.lockedBy} is not null and ${t.lockedUntil} is not null)`),
  ],
);
