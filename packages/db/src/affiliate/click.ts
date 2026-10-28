import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { hit } from "../platform/rate-limit.ts";
import { LINK_TOKEN_RE, type ClickDecision } from "./code.ts";
import { RL_CLICK } from "./settings.ts";

// The click entry point's service (HTTP-27 `GET /r/[token]`, SEC-20, T-52 slice 2). The route handler is thin: it classifies the request (code.ts), calls this and
// redirects. Nothing here accepts a destination: the target store and product come from the link record, never from the request.

export type ClickOutcome = {
  /** The destination derived from the link record: the store front page, or one product of that store. */
  target: { storeSlug: string; productPath: string | null };
  /** The new click id when one was captured; null when the request was redirected without a click. */
  clickId: string | null;
  /** When the captured click stops counting (its own frozen window); the continuity cookie lives as long. Null with no click. */
  expiresAt: Date | null;
  mode: "capture" | "refused_rate" | "non_navigation" | "redirect_only";
};

/**
 * Handle one request for a link token. Returns null for every token that is not an eligible link (malformed, unknown, revoked, expired, blocked by its store, or the
 * affiliate or store is suspended): the caller answers one identical not-found. For an eligible link it always returns the destination; a click is recorded only
 * for a top-level navigation inside the RL-CLICK limits (per client IP and per link). Over the limit, or for a non-navigation request, the buyer is redirected
 * without a click and, at most once per window per dimension, the event is counted for the risk queue.
 */
export async function captureReferralClick(exec: Executor, input: { token: string; decision: ClickDecision; clientIp?: string | undefined }): Promise<ClickOutcome | null> {
  if (!LINK_TOKEN_RE.test(input.token)) return null;
  // Wave 5 review: the IP is checked FIRST and the link's own budget is spent only by a capture-eligible navigation of an IP under its limit. Before, any request
  // (HEAD, an <img>, a non-navigation fetch, one noisy IP) used up the link's budget, so real visitors lost their click, and the link's owner was flagged for it.
  const ip = input.clientIp ? await hit(exec, `click:ip:${input.clientIp}`, RL_CLICK.ip) : null;
  const ipOver = ip !== null && ip.count > RL_CLICK.ip.limit;
  const link = !ipOver && input.decision === "capture" ? await hit(exec, `click:link:${createHash("sha256").update(input.token).digest("hex").slice(0, 32)}`, RL_CLICK.link) : null;
  const linkOver = link !== null && link.count > RL_CLICK.link.limit;
  // Only the LINK dimension is charged to the link's owner in the risk counters; a refusal caused by the visitor's IP is not the affiliate's doing.
  const mode: ClickOutcome["mode"] = ipOver ? "redirect_only" : linkOver ? (link!.count === RL_CLICK.link.limit + 1 ? "refused_rate" : "redirect_only") : input.decision === "capture" ? "capture" : "non_navigation";
  const rows = (await exec.execute(sql`select * from public.affiliate_capture_click(${input.token}::text, ${mode}::text)`)) as unknown as { r_store_slug: string; r_product_path: string | null; r_click_id: string | null; r_expires_at: string | Date | null }[];
  const r = rows[0];
  if (!r) return null;
  return { target: { storeSlug: r.r_store_slug, productPath: r.r_product_path }, clickId: r.r_click_id, expiresAt: r.r_expires_at ? new Date(r.r_expires_at) : null, mode };
}
