import { sql } from "drizzle-orm";
import type { Executor } from "../../client.ts";
import type { OperatorScope } from "../../platform/scoped.ts";
import { requirePlatformCap } from "../capabilities.ts";
import { auditLog } from "../../schema.ts";
import { registerPlatformHandler } from "./jobs.ts";
import { registerSchedule } from "./scheduler.ts";

// Retention framework (JOB-28 to JOB-32, T-74). Every purge is OFF until the owner records a period: no period
// is hard-coded or defaulted here or in SQL; no `retention_policy` row means the purge function deletes nothing.
// The deleting code is a SQL function per data class (migration `0011_chain_a_foundation.sql`, T-74 section): SECURITY DEFINER as the table
// owner with a fixed search_path, refusing a spoofed catalog, skipping rows still referenced by a foreign key,
// callable by the platform role only. Sweeps are periodic platform jobs (`UNIQUE(kind, key)` per day), so they
// are coordinated through the database. Partitioning of the log tables is NOT done here (see docs/tracks/t74-jobs.md).

/** Purge function per retention class (each registered in `retention_class`). */
export const RETENTION_PURGE_FN = {
  signal_event: "retention_purge_signal_event",
  system_log: "retention_purge_system_log",
  audit_log: "retention_purge_audit_log",
  job: "retention_purge_job",
  job_dead: "retention_purge_job_dead",
  access_event: "retention_purge_access_event",
  issue_report: "retention_purge_issue_report",
  affiliate_click: "retention_purge_affiliate_click", // JOB-27 (T-52): off until the privacy owner records a period (PRIV-7); detaches attribution evidence, then removes the raw click
} as const;
export type RetentionClass = keyof typeof RETENTION_PURGE_FN;

/** Rows deleted per function call, and calls per sweep: one sweep is bounded (JOB-27 "bounded batch per run"). */
export const PURGE_BATCH = 1000;
export const PURGE_MAX_BATCHES = 50;

/**
 * Set (days >= 1) or clear (null) the retention period of a class; clearing turns the purge off again. Requires the
 * capability `ops.jobs.manage`. The change itself runs in the owner-side function `retention_set_period`, which
 * re-checks the actor's grant in the database, validates the input and records an append-only event in a table that
 * no purge class touches: the platform login cannot write the period table directly.
 */
export async function setRetentionPeriod(op: OperatorScope, input: { dataClass: RetentionClass; days: number | null; reason: string }): Promise<void> {
  await requirePlatformCap(op, "ops.jobs.manage");
  if (input.days !== null && (!Number.isInteger(input.days) || input.days < 1)) throw new Error("retention period must be a whole number of days >= 1");
  if (!input.reason.trim()) throw new Error("a reason is required");
  const reason = input.reason.trim();
  await op.exec.transaction(async (tx) => {
    await tx.execute(sql`select retention_set_period(${input.dataClass}, ${input.days}::integer, ${op.userId}, ${reason})`);
    // The audit viewer reads audit_log; the append-only retention_policy_event is the copy no purge class can delete.
    await tx.insert(auditLog).values({ actorUserId: op.userId, action: "retention.set", storeId: null, reason: `class:${input.dataClass} days:${input.days ?? "off"} ${reason}`.slice(0, 500) });
  });
}

/** One bounded batch through the class's purge function; returns the number of rows deleted (0 when disabled). */
export async function purgeBatch(exec: Executor, dataClass: RetentionClass, batch = PURGE_BATCH): Promise<number> {
  const fn = RETENTION_PURGE_FN[dataClass];
  const rows = await exec.execute<{ n: string }>(`select ${fn}(${Math.trunc(batch)}) as n`);
  return Number(rows[0]!.n);
}

/** Purge a class until a batch comes back short or the sweep bound is reached. */
export async function purgeClass(exec: Executor, dataClass: RetentionClass): Promise<number> {
  let total = 0;
  for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
    const n = await purgeBatch(exec, dataClass);
    total += n;
    if (n < PURGE_BATCH) break;
  }
  return total;
}

// Sweep kinds: one daily platform job per kind (registered in `platform_job_kind` by the migration). catchUp 0:
// a missed day needs no second sweep, the next one covers it.
const SWEEPS: Record<string, RetentionClass[]> = {
  "retention.signal_event": ["signal_event"],
  "retention.system_log": ["system_log"],
  "retention.audit_log": ["audit_log"],
  "retention.job": ["job", "job_dead"],
  "retention.access_event": ["access_event"],
  "retention.issue_report": ["issue_report"],
  "retention.affiliate_click": ["affiliate_click"],
};
for (const [kind, classes] of Object.entries(SWEEPS)) {
  registerSchedule({ kind, period: "day", catchUp: 0 });
  registerPlatformHandler(kind, async ({ db }) => {
    for (const c of classes) await purgeClass(db, c);
  });
}
