import { createHash } from "node:crypto";
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

/**
 * Better Auth rate-limit storage on the shared counter (T-83, RL-LOGIN). Every web instance and every restart reads the
 * same Postgres rows, so the sign-in/reset budgets Better Auth computes (`rule`: its own numeric bounds, unchanged) are
 * global per surface and client key instead of per process. Better Auth's key is `<ip>|<path>`; it is stored only as a
 * SHA-256 digest under `auth:<surface>:`, so the table never holds a raw IP and the key length is bounded.
 *
 * Fixed window (`hit`) instead of Better Auth's rolling window: the same limit per window, with the usual boundary
 * ceiling (up to 2x the limit across two adjacent windows), recorded in docs/DECISIONS.md.
 *
 * A failing counter store refuses the request (`allowed: false`, retry after one window): a bounded, recoverable 429,
 * never a bypass. Broader per-bucket failure policy is T-90.
 */
export function authRateLimitStorage(exec: () => Executor, surface: string, onError: (err: unknown) => void = () => {}) {
  return {
    async consume(key: string, rule: { window: number; max: number }): Promise<{ allowed: boolean; retryAfter: number | null }> {
      const digest = createHash("sha256").update(key).digest("hex");
      try {
        const { count, retryAfterSec } = await hit(exec(), `auth:${surface}:${digest}`, { limit: rule.max, windowSec: rule.window });
        return count <= rule.max ? { allowed: true, retryAfter: null } : { allowed: false, retryAfter: retryAfterSec };
      } catch (err) {
        onError(err);
        return { allowed: false, retryAfter: rule.window };
      }
    },
  };
}

/** The count of `key` in its current window without counting a hit (0 when the window has no row yet). */
export async function peekHits(exec: Executor, key: string, rule: LimitRule): Promise<number> {
  const rows = (await exec.execute(sql`
    select count from ${rateLimit}
    where key = ${key} and window_start = to_timestamp(floor(extract(epoch from now()) / ${rule.windowSec}) * ${rule.windowSec})
  `)) as unknown as { count: number }[];
  return Number(rows[0]?.count ?? 0);
}
