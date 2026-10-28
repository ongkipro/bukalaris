import { describe, expect, it } from "vitest";
import { canonicalTaxInputs, computeTax, resolveTaxPolicy, roundTaxRational, TaxRefusal, taxInputsHash, type ComputationInput, type TaxPolicy } from "../src/tax/compute.ts";

// Arbitrary fixture numbers from the BILL-9 illustration. They are test data, never statutory values.
const policy = (over: Partial<TaxPolicy> = {}): TaxPolicy => ({
  id: 1, taxTypeCode: "commission_withholding", categoryCode: "individual", status: "confirmed", effectiveFrom: "2030-01-01", effectiveTo: null,
  baseFractionBps: 5000, brackets: [{ up_to_idr: "60000000", rate_bps: 500 }, { up_to_idr: null, rate_bps: 1500 }], rounding: "floor", rateMethod: "cumulative_true_up", ...over,
});
const input = (over: Partial<ComputationInput> = {}): ComputationInput => ({
  taxTypeCode: "commission_withholding", categoryCode: "individual", asOfDate: "2030-06-15", grossIdr: 1_000_000n, taxYear: 2030, ytdBaseBeforeIdr: 0n, ytdTaxBeforeIdr: 0n, ...over,
});
const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof TaxRefusal ? e.code : String(e); } return "no refusal"; };

describe("T-65 computation contract: BILL-9 illustration", () => {
  it("bracketed cumulative true-up: first payout, then the second payout subtracts the tax already withheld", () => {
    const first = computeTax([policy()], input());
    expect([first.baseIdr, first.taxIdr, first.netIdr, first.clamped]).toEqual([500_000n, 25_000n, 975_000n, false]);
    const second = computeTax([policy()], input({ grossIdr: 130_000_000n, ytdBaseBeforeIdr: first.baseIdr, ytdTaxBeforeIdr: first.taxIdr }));
    expect([second.baseIdr, second.taxIdr, second.netIdr]).toEqual([65_000_000n, 3_800_000n, 126_200_000n]);
  });
  it("flat per_payment ignores earlier payments even when year-to-date values are supplied", () => {
    const flat = policy({ rateMethod: "per_payment", baseFractionBps: 10_000, brackets: [{ up_to_idr: null, rate_bps: 700 }] });
    const r = computeTax([flat], input({ grossIdr: 1_000_000n, ytdBaseBeforeIdr: 999_000_000n, ytdTaxBeforeIdr: 5_000_000n }));
    expect([r.baseIdr, r.taxIdr, r.netIdr]).toEqual([1_000_000n, 70_000n, 930_000n]);
  });
  it("a zero-rate tranche is a bracket like any other and gross = tax + net always holds", () => {
    const r = computeTax([policy({ brackets: [{ up_to_idr: "100", rate_bps: 0 }, { up_to_idr: null, rate_bps: 2000 }], baseFractionBps: 10_000 })], input({ grossIdr: 1_100n }));
    expect([r.taxIdr, r.netIdr]).toEqual([200n, 900n]);
  });
});

describe("T-65 computation contract: rounding is applied once, at the half boundary", () => {
  const flat = (rounding: string, rate: number, fraction = 10_000) => policy({ rounding, rateMethod: "per_payment", baseFractionBps: fraction, brackets: [{ up_to_idr: null, rate_bps: rate }] });
  it.each([
    ["floor", 0n, 1n, 0n], ["half_up", 1n, 2n, 1n], ["ceil", 1n, 2n, 1n],
  ])("tax of an exact half and one-and-a-half under %s", (rounding, half, oneAndHalf, _) => {
    expect(computeTax([flat(rounding, 5_000)], input({ grossIdr: 1n })).taxIdr).toBe(half);
    expect(computeTax([flat(rounding, 5_000)], input({ grossIdr: 3n })).taxIdr).toBe(oneAndHalf);
  });
  it("the base is rounded once and the tax is rounded once from the rounded base (not per bracket, not from the unrounded base)", () => {
    // gross 3 * 50% = 1.5 -> base 2 (half_up); tax 2 * 50% = 1 (exact). Rounding the unrounded base would give 0.75 -> 1 as well, so also test ceil:
    const p = policy({ rounding: "ceil", rateMethod: "per_payment", baseFractionBps: 5_000, brackets: [{ up_to_idr: "1", rate_bps: 5_000 }, { up_to_idr: null, rate_bps: 5_000 }] });
    const r = computeTax([p], input({ grossIdr: 3n }));
    expect([r.baseIdr, r.taxIdr]).toEqual([2n, 1n]); // per-bracket ceil would give 1 + 1 = 2
  });
  it("roundTaxRational refuses negative numerators and non-positive denominators", () => {
    expect(refusal(() => roundTaxRational(-1n, 2n, "floor"))).toBe("policy_invalid");
    expect(refusal(() => roundTaxRational(1n, 0n, "floor"))).toBe("policy_invalid");
  });
});

describe("T-65 computation contract: limits, clamp and refusals", () => {
  it("zero gross and a gross next to the bigint maximum are exact (no float, no overflow)", () => {
    const flat = policy({ rateMethod: "per_payment", baseFractionBps: 10_000, brackets: [{ up_to_idr: null, rate_bps: 10_000 }] });
    expect(computeTax([flat], input({ grossIdr: 0n }))).toMatchObject({ baseIdr: 0n, taxIdr: 0n, netIdr: 0n });
    const max = (1n << 63n) - 1n;
    expect(computeTax([flat], input({ grossIdr: max }))).toMatchObject({ baseIdr: max, taxIdr: max, netIdr: 0n });
    const half = policy({ rateMethod: "per_payment", baseFractionBps: 10_000, brackets: [{ up_to_idr: null, rate_bps: 5_000 }] });
    expect(computeTax([half], input({ grossIdr: max - 1n })).taxIdr).toBe((max - 1n) / 2n); // max - 1 is even: exact half
    expect(refusal(() => computeTax([flat], input({ grossIdr: max + 1n })))).toBe("policy_invalid");
    expect(refusal(() => computeTax([flat], input({ grossIdr: -1n })))).toBe("policy_invalid");
  });
  it("cumulative true-up clamps a negative difference to zero and flags it", () => {
    const r = computeTax([policy({ brackets: [{ up_to_idr: null, rate_bps: 100 }] })], input({ grossIdr: 100n, ytdBaseBeforeIdr: 0n, ytdTaxBeforeIdr: 900n }));
    expect([r.taxIdr, r.netIdr, r.clamped]).toEqual([0n, 100n, true]);
  });
  it("tax above gross is policy_invalid, never a negative net", () => {
    expect(refusal(() => computeTax([policy()], input({ grossIdr: 10n, ytdBaseBeforeIdr: 1_000_000_000n })))).toBe("policy_invalid");
  });
  it.each([
    ["rate above 10000 bps", { brackets: [{ up_to_idr: null, rate_bps: 10_001 }] }],
    ["base fraction above 10000 bps", { baseFractionBps: 10_001 }],
    ["descending brackets", { brackets: [{ up_to_idr: "10", rate_bps: 1 }, { up_to_idr: "5", rate_bps: 1 }, { up_to_idr: null, rate_bps: 1 }] }],
    ["bounded last bracket", { brackets: [{ up_to_idr: "10", rate_bps: 1 }] }],
    ["unbounded bracket before the end", { brackets: [{ up_to_idr: null, rate_bps: 1 }, { up_to_idr: null, rate_bps: 1 }] }],
    ["no brackets", { brackets: [] }],
    ["unknown rounding", { rounding: "banker" }],
    ["fractional bracket bound", { brackets: [{ up_to_idr: "1.5", rate_bps: 1 }, { up_to_idr: null, rate_bps: 1 }] }],
  ] as [string, Partial<TaxPolicy>][])("%s is refused as policy_invalid", (_name, over) => {
    expect(refusal(() => computeTax([policy(over)], input()))).toBe("policy_invalid");
  });
  it("a tax year that disagrees with the as-of date is refused", () => {
    expect(refusal(() => computeTax([policy()], input({ taxYear: 2029 })))).toBe("policy_invalid");
  });
});

describe("T-65 policy resolution: exactly one confirmed version on the as-of date, or no_effective_policy", () => {
  const p = (id: number, from: string, to: string | null, over: Partial<TaxPolicy> = {}) => policy({ id, effectiveFrom: from, effectiveTo: to, ...over });
  it("selects by date range, end exclusive, and only confirmed rows of the same type and category", () => {
    const rows = [p(1, "2030-01-01", "2030-07-01"), p(2, "2030-07-01", null), p(3, "2029-01-01", null, { status: "submitted" }), p(4, "2030-01-01", null, { categoryCode: "entity" })];
    expect(resolveTaxPolicy(rows, "commission_withholding", "individual", "2030-06-30").id).toBe(1);
    expect(resolveTaxPolicy(rows, "commission_withholding", "individual", "2030-07-01").id).toBe(2);
    expect(refusal(() => resolveTaxPolicy(rows, "commission_withholding", "individual", "2029-12-31"))).toBe("no_effective_policy");
    expect(refusal(() => resolveTaxPolicy([], "vat_output", "subscription", "2030-01-01"))).toBe("no_effective_policy");
    expect(refusal(() => resolveTaxPolicy([p(1, "2030-01-01", null, { status: "retired" })], "commission_withholding", "individual", "2030-02-01"))).toBe("no_effective_policy");
  });
  it("two confirmed versions on one date are refused (the database forbids it; the pure function never picks one)", () => {
    expect(refusal(() => resolveTaxPolicy([p(1, "2030-01-01", null), p(2, "2030-03-01", null)], "commission_withholding", "individual", "2030-06-01"))).toBe("policy_invalid");
  });
  it("an invalid as-of date is refused", () => {
    expect(refusal(() => resolveTaxPolicy([p(1, "2030-01-01", null)], "commission_withholding", "individual", "2030-02-31"))).toBe("policy_invalid");
  });
});

describe("T-65 deterministic inputs_sha256", () => {
  it("is independent of key order and BigInt/number representation, and changes with any input", () => {
    const a = computeTax([policy()], input());
    expect(computeTax([policy()], input()).inputsSha256).toBe(a.inputsSha256);
    expect(a.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(taxInputsHash({ a: 1n, b: [1, { y: 2, x: 3 }] })).toBe(taxInputsHash({ b: [1, { x: 3, y: 2 }], a: 1n }));
    expect(canonicalTaxInputs({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(computeTax([policy()], input({ grossIdr: 1_000_001n })).inputsSha256).not.toBe(a.inputsSha256);
    expect(computeTax([policy({ rounding: "ceil" })], input()).inputsSha256).not.toBe(a.inputsSha256);
  });
  it("records the resolved policy parameters, so a snapshot can be audited without the policy row", () => {
    expect(computeTax([policy()], input()).inputs).toMatchObject({ policy: { baseFractionBps: 5000, rounding: "floor", rateMethod: "cumulative_true_up" }, grossIdr: "1000000" });
  });
});
