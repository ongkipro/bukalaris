import { eq, sql } from "drizzle-orm";
import type { Db, Executor } from "../../client.ts";
import { schedulerCursor, schedulerHeartbeat } from "../../schema.ts";
import { enqueuePlatform } from "./jobs.ts";

// Periodic enqueuer (JOB-21, T-74). One tick = one transaction that takes the heartbeat row's lock, inserts one
// platform-wide job per registered kind and period (`UNIQUE(kind, key)` with the period as key, so two enqueuers,
// a restart or a repeated tick cannot create a second job for a period), catches up the periods missed since the
// kind's cursor and records the heartbeat. All time logic takes the injected `now`; periods are Asia/Jakarta
// (UTC+7, no DST). The cursor, not the job table, remembers what was enqueued: purging old `done` jobs
// (retention) can never re-create a period.

export type SchedulePeriod = "minute" | "hour" | "day" | "month";
/**
 * `catchUp`: how many missed periods before the current one are enqueued after downtime (older ones are skipped).
 * The kind must be registered in `platform_job_kind` (a migration) and have a platform handler.
 */
export type Schedule = { kind: string; period: SchedulePeriod; catchUp: number };

export const SCHEDULER_NAME = "periodic-enqueuer";
const JAKARTA_OFFSET_MS = 7 * 3_600_000;

const schedules = new Map<string, Schedule>();
export function registerSchedule(s: Schedule): void {
  schedules.set(s.kind, s);
}
export const registeredSchedules = (): Schedule[] => [...schedules.values()];

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Start (as an instant) of the Asia/Jakarta period that contains `at`. */
export function periodStart(period: SchedulePeriod, at: Date): Date {
  const j = new Date(at.getTime() + JAKARTA_OFFSET_MS); // fields read with getUTC* are Jakarta wall-clock
  const [y, mo, d, h, mi] = [j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate(), j.getUTCHours(), j.getUTCMinutes()];
  const wall = period === "month" ? Date.UTC(y, mo, 1) : period === "day" ? Date.UTC(y, mo, d) : period === "hour" ? Date.UTC(y, mo, d, h) : Date.UTC(y, mo, d, h, mi);
  return new Date(wall - JAKARTA_OFFSET_MS);
}

/** The idempotency key of a period: `2026-10-28` (day), `2026-10` (month), `2026-10-28T09` (hour), `2026-10-28T09:05` (minute). */
export function periodKey(period: SchedulePeriod, at: Date): string {
  const j = new Date(periodStart(period, at).getTime() + JAKARTA_OFFSET_MS);
  const date = `${pad(j.getUTCFullYear(), 4)}-${pad(j.getUTCMonth() + 1)}`;
  if (period === "month") return date;
  const day = `${date}-${pad(j.getUTCDate())}`;
  if (period === "day") return day;
  const hour = `${day}T${pad(j.getUTCHours())}`;
  return period === "hour" ? hour : `${hour}:${pad(j.getUTCMinutes())}`;
}

const previousStart = (period: SchedulePeriod, start: Date): Date => {
  if (period === "month") return periodStart("month", new Date(start.getTime() - 1)); // any instant of the month before
  return new Date(start.getTime() - { minute: 60_000, hour: 3_600_000, day: 86_400_000 }[period]);
};

/** SchedulePeriod starts to enqueue, oldest first: those after `cursor` (at most `catchUp` before the current one), plus the current one. */
export function dueStarts(s: Schedule, cursor: Date | null, now: Date): Date[] {
  const current = periodStart(s.period, now);
  if (!cursor || cursor.getTime() >= current.getTime()) return cursor ? [] : [current];
  const out = [current];
  for (let start = previousStart(s.period, current); out.length <= s.catchUp && start.getTime() > cursor.getTime(); start = previousStart(s.period, start)) out.unshift(start);
  return out;
}

export type TickResult = { enqueued: { kind: string; key: string }[] };

/**
 * Run one tick at `now`. Safe to run concurrently from any number of processes: the heartbeat row lock serialises
 * the transactions and the unique key makes each insert a no-op for a period that exists. A failure (for example
 * an unregistered kind) rolls the whole tick back, so the heartbeat goes stale and the failure is visible.
 */
export async function schedulerTick(
  db: Db,
  opts: { now: Date; tickIntervalMs: number; name?: string; schedules?: Schedule[] },
): Promise<TickResult> {
  const name = opts.name ?? SCHEDULER_NAME;
  const list = opts.schedules ?? registeredSchedules();
  return db.transaction(async (tx) => {
    // Take the lock: create the row on the first ever tick, otherwise lock the existing one.
    await tx
      .insert(schedulerHeartbeat)
      .values({ name, lastTickAt: opts.now, lastEnqueuedCount: 0, tickIntervalMs: opts.tickIntervalMs })
      .onConflictDoNothing();
    await tx.select().from(schedulerHeartbeat).where(eq(schedulerHeartbeat.name, name)).for("update");
    const cursors = new Map((await tx.select().from(schedulerCursor)).map((c) => [c.kind, c.lastPeriodStart]));
    const enqueued: TickResult["enqueued"] = [];
    for (const s of list) {
      const starts = dueStarts(s, cursors.get(s.kind) ?? null, opts.now);
      for (const start of starts) {
        const key = periodKey(s.period, start);
        const { created } = await enqueuePlatform(tx, { kind: s.kind, key, payload: { period: key } });
        if (created) enqueued.push({ kind: s.kind, key });
      }
      if (starts.length > 0) {
        const newest = starts[starts.length - 1]!;
        await tx
          .insert(schedulerCursor)
          .values({ kind: s.kind, lastPeriodStart: newest })
          .onConflictDoUpdate({ target: schedulerCursor.kind, set: { lastPeriodStart: sql`greatest(${schedulerCursor.lastPeriodStart}, excluded.last_period_start)` } });
      }
    }
    await tx
      .update(schedulerHeartbeat)
      .set({
        lastTickAt: sql`greatest(${schedulerHeartbeat.lastTickAt}, ${opts.now.toISOString()}::timestamptz)`,
        lastEnqueuedCount: enqueued.length,
        tickIntervalMs: opts.tickIntervalMs,
      })
      .where(eq(schedulerHeartbeat.name, name));
    return { enqueued };
  });
}

export type SchedulerHealth = {
  name: string;
  state: "ok" | "stale" | "absent" | "skewed";
  lastTickAt: Date | null;
  ageMs: number | null;
  tickIntervalMs: number | null;
};

/**
 * Liveness for the health view and alerts (OBS-6: heartbeat older than two intervals). `absent` = the scheduler
 * never ticked on this database. The caller supplies the clock.
 */
export async function schedulerHealth(
  db: Executor,
  opts: { now?: Date; name?: string; missedTicks?: number } = {},
): Promise<SchedulerHealth> {
  const name = opts.name ?? SCHEDULER_NAME;
  const [row] = await db.select().from(schedulerHeartbeat).where(eq(schedulerHeartbeat.name, name));
  if (!row) return { name, state: "absent", lastTickAt: null, ageMs: null, tickIntervalMs: null };
  // Default clock = the database's, the same one the worker writes the heartbeat with.
  const now = opts.now ?? new Date((await db.execute<{ now: string }>(sql`select now() as now`))[0]!.now);
  const ageMs = now.getTime() - row.lastTickAt.getTime();
  // A heartbeat from the future means some worker ticks with a wrong clock: it would hide a dead scheduler (age < 0 is never stale).
  const state = ageMs < -row.tickIntervalMs ? "skewed" : ageMs > (opts.missedTicks ?? 2) * row.tickIntervalMs ? "stale" : "ok";
  return { name, state, lastTickAt: row.lastTickAt, ageMs, tickIntervalMs: row.tickIntervalMs };
}
