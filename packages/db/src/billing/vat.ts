import { sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { computeTax, resolveTaxPolicy, TaxRefusal, ZERO, type TaxPolicy } from "../tax/compute.ts";
import { jakartaDate } from "./period.ts";

// The PPN side of an invoice. There is no rate anywhere in this package: the rate is the flat rate of the effective, confirmed
// `vat_output` / `subscription` `tax_policy_version` of T-65, read through the `billing_effective_vat(date)` resolver (the seller Pay
// path cannot read the table itself) and computed by the T-65 engine (`computeTax`: base fraction, rounding). With no effective policy
// nothing is computed and the caller refuses (TaxRefusal `no_effective_policy`). The database guard `subscription_invoice_guard`
// recomputes the same amount in SQL on every insert, so a differing snapshot cannot be stored.

export type VatSnapshot = { taxPolicyVersionId: number; rateBps: number; ppnIdr: number };

type PolicyRow = { id: string | number; effective_from: string; effective_to: string | null; base_fraction_bps: number; brackets: TaxPolicy["brackets"]; rounding: string; rate_method: string };

/** Effective confirmed `vat_output` subscription policies on a Jakarta date (normally exactly one). */
export async function effectiveVatPolicies(exec: Executor, onDate: string): Promise<TaxPolicy[]> {
  const rows = (await exec.execute(sql`select id::text as id, effective_from::text as effective_from, effective_to::text as effective_to, base_fraction_bps, brackets, rounding, rate_method from billing_effective_vat(${onDate}::date)`)) as unknown as PolicyRow[];
  return rows.map((r) => ({
    id: Number(r.id), taxTypeCode: "vat_output", categoryCode: "subscription", status: "confirmed", effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
    baseFractionBps: r.base_fraction_bps, brackets: r.brackets, rounding: r.rounding, rateMethod: r.rate_method,
  }));
}

/**
 * PPN snapshot of a DPP amount at `at`. Throws `TaxRefusal("no_effective_policy")` when no confirmed policy is effective, and
 * `TaxRefusal("policy_invalid")` when the policy is ambiguous or is not a flat per-payment rate (a subscription invoice has one line).
 */
export async function vatSnapshot(exec: Executor, dppIdr: number, at: Date): Promise<VatSnapshot> {
  const asOf = jakartaDate(at);
  const policies = await effectiveVatPolicies(exec, asOf);
  const policy = resolveTaxPolicy(policies, "vat_output", "subscription", asOf);
  const [bracket] = policy.brackets;
  if (policy.rateMethod !== "per_payment" || policy.brackets.length !== 1 || !bracket || bracket.up_to_idr !== null) throw new TaxRefusal("policy_invalid");
  const result = computeTax(policies, { taxTypeCode: "vat_output", categoryCode: "subscription", asOfDate: asOf, grossIdr: BigInt(dppIdr), taxYear: Number(asOf.slice(0, 4)), ytdBaseBeforeIdr: ZERO, ytdTaxBeforeIdr: ZERO });
  return { taxPolicyVersionId: policy.id, rateBps: bracket.rate_bps, ppnIdr: Number(result.taxIdr) };
}
