import { sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { AFFILIATE_RISK_THRESHOLDS } from "./settings.ts";

// Phase-1 affiliate fraud counters (SEC-20, SA-18): the READ side only. T-63 left the risk-queue rule `affiliate_fraud` "unavailable" because the counters did not
// exist; they do now. No browser fingerprint is collected. The counters are written by the database functions that observe the event (click capture, the checkout
// resolver) and kept as daily aggregates, so deleting raw clicks under JOB-27 never changes them. Thresholds are OPEN (SEC-20): `AFFILIATE_RISK_THRESHOLDS` are
// placeholders and every caller may pass its own. Wiring the flags into the Owner console queue is the console's change (SA-18); `exec` is the platform pool.

export type AffiliateRiskRow = {
  affiliateId: number;
  displayName: string;
  status: string;
  clicksCaptured: number;
  /** Orders attributed to this affiliate in the window and how many of them were voided before delivery. */
  attributedOrders: number;
  voidedOrders: number;
  selfReferralSuppressed: number;
  clickRefusedRate: number;
  clickNonNavigation: number;
  /** Clicks per attributed order; null when there is no order (a flood without a single order is the flag itself). */
  clicksPerOrder: number | null;
  /** Voided share of attributed orders; null with no order. */
  voidedShare: number | null;
};

export type AffiliateRiskSnapshot = { since: string; affiliates: AffiliateRiskRow[]; platformCodeFailures: number };

/** Per-affiliate counters over the last `days` UTC days (default 30), busiest first. Affiliates with nothing to report are left out. */
export async function affiliateRiskCounters(exec: Executor, opts: { days?: number } = {}): Promise<AffiliateRiskSnapshot> {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 30), 1), 366);
  const rows = (await exec.execute(sql`
    with win as (select ((now() at time zone 'UTC')::date - (${days}::int - 1)) as since),
    counts as (
      select c.affiliate_id,
             coalesce(sum(c.n) filter (where c.kind = 'click_captured'), 0)::bigint as clicks,
             coalesce(sum(c.n) filter (where c.kind = 'self_referral_suppressed'), 0)::bigint as self_ref,
             coalesce(sum(c.n) filter (where c.kind = 'click_refused_rate'), 0)::bigint as refused,
             coalesce(sum(c.n) filter (where c.kind = 'click_non_navigation'), 0)::bigint as non_nav
        from affiliate_counter c, win where c.affiliate_id is not null and c.day >= win.since group by c.affiliate_id),
    orders as (
      select t.affiliate_id, count(*)::bigint as n, count(*) filter (where t.status = 'void')::bigint as voided
        from affiliate_attribution t, win where t.created_at >= win.since::timestamptz group by t.affiliate_id)
    select a.id as affiliate_id, a.display_name, a.status,
           coalesce(c.clicks, 0) as clicks, coalesce(o.n, 0) as orders, coalesce(o.voided, 0) as voided,
           coalesce(c.self_ref, 0) as self_ref, coalesce(c.refused, 0) as refused, coalesce(c.non_nav, 0) as non_nav
      from affiliate a left join counts c on c.affiliate_id = a.id left join orders o on o.affiliate_id = a.id
     where c.affiliate_id is not null or o.affiliate_id is not null
     order by coalesce(c.self_ref, 0) + coalesce(c.refused, 0) desc, coalesce(c.clicks, 0) desc, a.id
  `)) as unknown as { affiliate_id: string; display_name: string; status: string; clicks: string; orders: string; voided: string; self_ref: string; refused: string; non_nav: string }[];
  const [pc] = (await exec.execute(sql`select coalesce(sum(n), 0)::bigint as n from affiliate_counter where kind = 'code_failure' and affiliate_id is null and day >= ((now() at time zone 'UTC')::date - (${days}::int - 1))`)) as unknown as { n: string }[];
  const [since] = (await exec.execute(sql`select ((now() at time zone 'UTC')::date - (${days}::int - 1))::text as d`)) as unknown as { d: string }[];
  return {
    since: since!.d,
    platformCodeFailures: Number(pc!.n),
    affiliates: rows.map((r) => {
      const orders = Number(r.orders);
      return {
        affiliateId: Number(r.affiliate_id),
        displayName: r.display_name,
        status: r.status,
        clicksCaptured: Number(r.clicks),
        attributedOrders: orders,
        voidedOrders: Number(r.voided),
        selfReferralSuppressed: Number(r.self_ref),
        clickRefusedRate: Number(r.refused),
        clickNonNavigation: Number(r.non_nav),
        clicksPerOrder: orders > 0 ? Number(r.clicks) / orders : null,
        voidedShare: orders > 0 ? Number(r.voided) / orders : null,
      };
    }),
  };
}

export type RiskThresholds = { readonly [K in keyof typeof AFFILIATE_RISK_THRESHOLDS]: number };

export type AffiliateFraudFlag = { affiliateId: number; rule: "self_referral" | "click_flood" | "clicks_without_orders" | "voided_share"; observed: number; threshold: number };

/** The flags a counter row raises under the given thresholds; a pure function, so the Owner console queue and the tests share it. */
export function affiliateFraudFlags(rows: readonly AffiliateRiskRow[], t: RiskThresholds = AFFILIATE_RISK_THRESHOLDS): AffiliateFraudFlag[] {
  const out: AffiliateFraudFlag[] = [];
  for (const r of rows) {
    if (r.selfReferralSuppressed >= t.selfReferralSuppressed) out.push({ affiliateId: r.affiliateId, rule: "self_referral", observed: r.selfReferralSuppressed, threshold: t.selfReferralSuppressed });
    if (r.clickRefusedRate >= t.clickRefusedRate) out.push({ affiliateId: r.affiliateId, rule: "click_flood", observed: r.clickRefusedRate, threshold: t.clickRefusedRate });
    if (r.attributedOrders === 0 && r.clicksCaptured >= t.clicksPerOrder) out.push({ affiliateId: r.affiliateId, rule: "clicks_without_orders", observed: r.clicksCaptured, threshold: t.clicksPerOrder });
    else if (r.clicksPerOrder !== null && r.clicksPerOrder >= t.clicksPerOrder) out.push({ affiliateId: r.affiliateId, rule: "clicks_without_orders", observed: r.clicksPerOrder, threshold: t.clicksPerOrder });
    if (r.attributedOrders >= t.minOrdersForShares && r.voidedShare !== null && r.voidedShare >= t.voidedShare) out.push({ affiliateId: r.affiliateId, rule: "voided_share", observed: r.voidedShare, threshold: t.voidedShare });
  }
  return out;
}
