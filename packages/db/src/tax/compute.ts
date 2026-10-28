import { createHash } from "node:crypto";

// BigInt literals (`0n`) are not available to the web app's compile target, so the few constants are built with BigInt().
export const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const BPS = BigInt(10_000); // basis-point scale: unit conversion, not a policy value
export const MAX_IDR = (ONE << BigInt(63)) - ONE; // PostgreSQL signed bigint storage bound

export type Rounding = "floor" | "half_up" | "ceil";
export interface PolicyBracket { up_to_idr: string | null; rate_bps: number }
export interface TaxPolicy {
  id: number; taxTypeCode: string; categoryCode: string; status: string;
  effectiveFrom: string; effectiveTo: string | null; baseFractionBps: number;
  brackets: PolicyBracket[]; rounding: string; rateMethod: string;
}
export class TaxRefusal extends Error {
  readonly code: "policy_invalid" | "no_effective_policy" | "tax_identity_missing" | "tax_not_activated" | "replay_mismatch" | "invalid_transition";
  constructor(code: TaxRefusal["code"]) { super(code); this.code = code; }
}
const fail = (): never => { throw new TaxRefusal("policy_invalid"); };
export function canonicalTaxInputs(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalTaxInputs).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalTaxInputs(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function taxInputsHash(value: unknown): string { return createHash("sha256").update(canonicalTaxInputs(value)).digest("hex"); }
function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
export function resolveTaxPolicy(policies: readonly TaxPolicy[], taxTypeCode: string, categoryCode: string, asOfDate: string): TaxPolicy {
  if (!validDate(asOfDate)) return fail();
  const matches = policies.filter((p) => p.status === "confirmed" && p.taxTypeCode === taxTypeCode && p.categoryCode === categoryCode && p.effectiveFrom <= asOfDate && (p.effectiveTo === null || asOfDate < p.effectiveTo));
  if (matches.length === 0) throw new TaxRefusal("no_effective_policy");
  if (matches.length !== 1) return fail();
  validateTaxPolicy(matches[0]!);
  return matches[0]!;
}
export function validateTaxPolicy(p: TaxPolicy): void {
  if (!validDate(p.effectiveFrom) || (p.effectiveTo !== null && (!validDate(p.effectiveTo) || p.effectiveTo <= p.effectiveFrom)) || !Number.isInteger(p.baseFractionBps) || p.baseFractionBps < 0 || BigInt(p.baseFractionBps) > BPS || !["floor", "half_up", "ceil"].includes(p.rounding) || !["per_payment", "cumulative_true_up"].includes(p.rateMethod) || !Array.isArray(p.brackets) || p.brackets.length === 0) return fail();
  let previous = ZERO;
  for (const [i, b] of p.brackets.entries()) {
    if (!Number.isInteger(b.rate_bps) || b.rate_bps < 0 || BigInt(b.rate_bps) > BPS) return fail();
    if (b.up_to_idr === null) { if (i !== p.brackets.length - 1) return fail(); }
    else {
      if (!/^\d+$/.test(b.up_to_idr)) return fail();
      const limit = BigInt(b.up_to_idr);
      if (limit <= previous || i === p.brackets.length - 1) return fail();
      previous = limit;
    }
  }
}
export function roundTaxRational(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (numerator < ZERO || denominator <= ZERO) return fail();
  if (rounding === "floor") return numerator / denominator;
  if (rounding === "ceil") return (numerator + denominator - ONE) / denominator;
  if (rounding === "half_up") return (TWO * numerator + denominator) / (TWO * denominator);
  return fail();
}
function bracketNumerator(base: bigint, brackets: PolicyBracket[]): bigint {
  let result = ZERO; let lower = ZERO;
  for (const b of brackets) {
    const upper = b.up_to_idr === null ? base : BigInt(b.up_to_idr);
    const width = (base < upper ? base : upper) - lower;
    if (width > ZERO) result += width * BigInt(b.rate_bps);
    if (base <= upper) break;
    lower = upper;
  }
  return result;
}
export interface ComputationInput { taxTypeCode: string; categoryCode: string; asOfDate: string; grossIdr: bigint; taxYear: number; ytdBaseBeforeIdr: bigint; ytdTaxBeforeIdr: bigint }
export function computeTax(policies: readonly TaxPolicy[], input: ComputationInput) {
  const p = resolveTaxPolicy(policies, input.taxTypeCode, input.categoryCode, input.asOfDate);
  if (input.grossIdr < ZERO || input.grossIdr > MAX_IDR || input.ytdBaseBeforeIdr < ZERO || input.ytdTaxBeforeIdr < ZERO || input.taxYear !== Number(input.asOfDate.slice(0, 4))) return fail();
  const rounding = p.rounding as Rounding;
  const baseIdr = roundTaxRational(input.grossIdr * BigInt(p.baseFractionBps), BPS, rounding);
  const cumulative = p.rateMethod === "cumulative_true_up";
  const rawTax = roundTaxRational(bracketNumerator(baseIdr + (cumulative ? input.ytdBaseBeforeIdr : ZERO), p.brackets), BPS, rounding) - (cumulative ? input.ytdTaxBeforeIdr : ZERO);
  const taxIdr = rawTax < ZERO ? ZERO : rawTax;
  if (taxIdr > input.grossIdr) return fail();
  const inputs = JSON.parse(canonicalTaxInputs({ ...input, policy: p })) as Record<string, unknown>;
  return { policyVersionId: p.id, baseIdr, taxIdr, netIdr: input.grossIdr - taxIdr, clamped: rawTax < ZERO, inputs, inputsSha256: taxInputsHash(inputs) };
}
