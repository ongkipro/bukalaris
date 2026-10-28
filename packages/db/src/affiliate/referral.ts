import { sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { withAffiliateCommission, type OrderFinance } from "../ledger/finance.ts";
import { hit, peekHits } from "../platform/rate-limit.ts";
import { withStore } from "../platform/tenant.ts";
import { normalizeAffiliateCode } from "./code.ts";
import { calculateAffiliateCommission } from "./commission.ts";
import { RL_CODE } from "./settings.ts";

// The checkout side of the affiliate programme (T-52 slices 2 and 3): one resolver shared by every checkout entry (hosted checkout, landing page order form,
// API handoff all end in `placeOrder`), the commission plan and the attribution record. All decisions are made by the database functions of migration 0016
// inside the order transaction; this module only calls them in order and does the integer arithmetic once, through the one BILL-4 allocation.

/** What the buyer's request may carry: a typed code and the click ids of the continuity cookie. Both are selectors, never authority. */
export type ReferralInput = { code?: string | null | undefined; clickIds?: readonly string[] | undefined };

export type CommissionPlan = {
  affiliateId: number;
  method: "code" | "link";
  /** The finance with the commission deducted from the seller's proceeds (`order_financials.sale_amount_idr`). */
  finance: OrderFinance;
  /** Rate frozen on each cart line, in line order; 0 for a line whose product is not opted in. */
  ratesBps: number[];
  commissionIdr: number;
};

const textArray = (ids: readonly string[]) => (ids.length === 0 ? sql`null::text[]` : sql`array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]`);
type Row = Record<string, unknown>;

/**
 * RL-CODE: a typed code is checked BEFORE the order transaction (outside it, so a rolled-back order still spends the budget) and counted as an invalid guess
 * when it is unusable in this store. Past the per-cart limit the typed code is ignored and checkout continues: a code never fails an order, and a captured click
 * may still win. Returns the normalised code to hand to the transaction, or null.
 */
export async function usableTypedCode(exec: Executor, storeId: number, cartId: string, raw: unknown): Promise<string | null> {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const key = `code:cart:${cartId}`;
  if ((await peekHits(exec, key, RL_CODE.invalid)) >= RL_CODE.invalid.limit) return null;
  const code = normalizeAffiliateCode(raw);
  const ok = code !== null && (await withStore(exec, storeId, async (tx) => ((await tx.execute(sql`select public.affiliate_code_valid(${storeId}::bigint, ${code}::text) as ok`)) as unknown as { ok: boolean }[])[0]!.ok));
  if (ok) return code;
  await hit(exec, key, RL_CODE.invalid);
  await withStore(exec, storeId, (tx) => tx.execute(sql`select public.affiliate_count_code_failure()`));
  return null;
}

/**
 * Slice 2 and 3, inside the order transaction after the order row, its lines and its stock are written: resolve the affiliate (code wins, else the latest
 * eligible click of this store inside its window; a self-referral earns nothing and nothing else is tried), read each line's rate from the live offer rules
 * (the same database function the attribution guard re-checks with), and compute the single-floor commission from the frozen line bases. Returns null when no
 * affiliate earns anything: no selector, an ineligible one, a self-referral, no opted-in line, a zero base, or a commission that would leave the seller less than
 * the shipping discount the seller funds. Never throws for a bad selector.
 */
export async function planAffiliateCommission(
  tx: Executor,
  input: { storeId: number; orderId: number; productIds: readonly number[]; finance: OrderFinance; referral: ReferralInput },
): Promise<CommissionPlan | null> {
  const clickIds = input.referral.clickIds ?? [];
  if (!input.referral.code && clickIds.length === 0) return null;
  const rows = (await tx.execute(sql`select * from public.affiliate_resolve(${input.storeId}::bigint, ${input.orderId}::bigint, ${input.referral.code ?? null}::text, ${textArray(clickIds)})`)) as unknown as Row[];
  const r = rows[0];
  if (!r || r.r_outcome !== "selected") return null;
  // One rate per distinct product, asked in ascending product order so concurrent orders share-lock the offers in one order.
  const rates = new Map<number, number>();
  for (const productId of [...new Set(input.productIds)].sort((a, b) => a - b)) {
    const [row] = (await tx.execute(sql`select public.affiliate_line_rate(${input.storeId}::bigint, ${productId}::bigint) as rate`)) as unknown as { rate: number }[];
    rates.set(productId, Number(row!.rate));
  }
  const ratesBps = input.productIds.map((p) => rates.get(p)!);
  const commissionIdr = calculateAffiliateCommission(input.finance.lines.map((l, i) => ({ commissionBase: l.commissionBase, rateBps: ratesBps[i]! })));
  if (commissionIdr <= 0) return null;
  // The seller funds a shipping discount out of the sale: a commission that would take the sale below it is not earned (an order never fails for it).
  if (input.finance.saleAmount - commissionIdr < input.finance.shippingDiscount) return null;
  return { affiliateId: Number(r.r_affiliate_id), method: r.r_method as "code" | "link", finance: withAffiliateCommission(input.finance, commissionIdr), ratesBps, commissionIdr };
}

/** After `writeOrderFinancials` carried the affiliate and the line rates: the one writer of the attribution (it re-runs the selection and re-derives every rate itself). */
export async function recordAffiliateAttribution(tx: Executor, input: { storeId: number; orderId: number; referral: ReferralInput }): Promise<number> {
  const rows = (await tx.execute(sql`select public.affiliate_record_attribution(${input.storeId}::bigint, ${input.orderId}::bigint, ${input.referral.code ?? null}::text, ${textArray(input.referral.clickIds ?? [])}) as id`)) as unknown as { id: string }[];
  return Number(rows[0]!.id);
}
