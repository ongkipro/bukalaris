import { sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { rateLimit } from "../schema.ts";

// The fixed-window counter shared by checkout (T-30, SEC-16) and the affiliate click and code limits (T-52, RL-CLICK, RL-CODE): one upsert per key in
// Postgres, no extra service. A key never holds a raw contact; callers pass opaque ids or keyed fingerprints.

export type LimitRule = { limit: number; windowSec: number };

/** Count one hit on `key` in its current window; returns the count and seconds until the window ends. */
export async function hit(exec: Executor, key: string, rule: LimitRule): Promise<{ count: number; retryAfterSec: number }> {
  const rows = (await exec.execute(sql`
    insert into ${rateLimit} (key, window_start, count)
    values (${key}, to_timestamp(floor(extract(epoch from now()) / ${rule.windowSec}) * ${rule.windowSec}), 1)
    on conflict (key, window_start) do update set count = ${rateLimit}.count + 1
    returning count, ceil(extract(epoch from (window_start + ${rule.windowSec} * interval '1 second' - now())))::int as retry_after_sec
  `)) as unknown as { count: number; retry_after_sec: number }[];
  return { count: Number(rows[0]!.count), retryAfterSec: Math.max(1, Number(rows[0]!.retry_after_sec)) };
}

/** The count of `key` in its current window without counting a hit (0 when the window has no row yet). */
export async function peekHits(exec: Executor, key: string, rule: LimitRule): Promise<number> {
  const rows = (await exec.execute(sql`
    select count from ${rateLimit}
    where key = ${key} and window_start = to_timestamp(floor(extract(epoch from now()) / ${rule.windowSec}) * ${rule.windowSec})
  `)) as unknown as { count: number }[];
  return Number(rows[0]?.count ?? 0);
}
