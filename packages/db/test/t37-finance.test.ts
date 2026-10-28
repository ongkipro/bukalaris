import { describe, expect, it } from "vitest";
import { allocateLargestRemainder, calculateOrderFinance, type FinanceInput } from "../src/ledger/finance.ts";

// T-37 (BILL-4, D-21 assertion e): gross-to-net allocation uses integer largest-remainder, so the parts always sum to the gross and no part is negative;
// the allocation identity of ADR-0006 decision 2 holds to the rupiah on fixtures. Pure functions, no database.

/** Deterministic PRNG so a failure is reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("largest-remainder allocation (D-21 e)", () => {
  it("fixtures: equal lines with an odd discount, a discount that equals one line, tied remainders, zero weights", () => {
    expect(allocateLargestRemainder(1, [100, 100, 100])).toEqual([1, 0, 0]); // ties go to the lower line number
    expect(allocateLargestRemainder(2, [100, 100, 100])).toEqual([1, 1, 0]);
    expect(allocateLargestRemainder(100, [100, 200, 300])).toEqual([17, 33, 50]); // 16.67, 33.33, 50: the one leftover rupiah goes to the largest remainder (.67)
    expect(allocateLargestRemainder(150_000, [150_000, 50_000])).toEqual([112_500, 37_500]);
    expect(allocateLargestRemainder(50_000, [50_000, 120_000, 30_000])).toEqual([12_500, 30_000, 7_500]);
    expect(allocateLargestRemainder(0, [5, 0, 7])).toEqual([0, 0, 0]);
    expect(allocateLargestRemainder(0, [])).toEqual([]);
    expect(() => allocateLargestRemainder(5, [0, 0])).toThrow(); // nothing to share it over
    expect(() => allocateLargestRemainder(-1, [1])).toThrow();
    expect(() => allocateLargestRemainder(1.5, [1])).toThrow();
  });

  it("property: over thousands of random cases the parts sum to the total, none is negative and none exceeds its weight", () => {
    const rng = prng(37);
    for (let i = 0; i < 3_000; i++) {
      const n = 1 + Math.floor(rng() * 7);
      const weights = Array.from({ length: n }, () => Math.floor(rng() * 400_000));
      const S = weights.reduce((a, b) => a + b, 0);
      if (S === 0) continue;
      const total = Math.floor(rng() * (S + 1));
      const parts = allocateLargestRemainder(total, weights);
      expect(parts.reduce((a, b) => a + b, 0), `sum case ${i}`).toBe(total);
      parts.forEach((p, k) => {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p, `part ${k} of case ${i} exceeds its weight`).toBeLessThanOrEqual(weights[k]!);
      });
    }
  });

  it("no precision loss near the safe-integer ceiling (BigInt arithmetic)", () => {
    const big = Number.MAX_SAFE_INTEGER;
    const parts = allocateLargestRemainder(big - 1, [big, 1]);
    expect(parts[0]! + parts[1]!).toBe(big - 1);
  });
});

const base: FinanceInput = { lines: [{ lineNo: 1, unitPrice: 100_000, quantity: 2 }, { lineNo: 2, unitPrice: 55_000, quantity: 1 }], checkoutShipping: 15_000 };

describe("order finance engine (BILL-4)", () => {
  it("the allocation identity holds to the rupiah, with and without tax, discount, COD fee and affiliate commission", () => {
    const rng = prng(4);
    for (let i = 0; i < 1_500; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rng() * 5) }, (_, k) => ({ lineNo: k + 1, unitPrice: 1 + Math.floor(rng() * 500_000), quantity: 1 + Math.floor(rng() * 9) }));
      const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
      const shipping = Math.floor(rng() * 80_000);
      const f = calculateOrderFinance({
        lines,
        goodsDiscount: Math.floor(rng() * (subtotal + 1)),
        priceMode: (["none", "tax_included", "tax_added"] as const)[Math.floor(rng() * 3)]!,
        salesTaxRateBps: Math.floor(rng() * 3_000),
        checkoutShipping: shipping,
        shippingDiscount: Math.floor(rng() * (shipping + 1)),
        codFee: Math.floor(rng() * 9_000),
        codFeeVat: Math.floor(rng() * 1_000),
        affiliateCommission: 0,
      });
      expect(f.payable).toBe(f.goodsProceeds + f.includedSalesTax + f.addedSalesTax + f.shippingCharged + f.codFee + f.codFeeVat);
      expect(f.saleAmount).toBe(f.goodsProceeds + f.includedSalesTax + f.addedSalesTax - f.affiliateCommission);
      expect(f.payable).toBe(f.saleAmount + f.affiliateCommission + f.shippingCharged + f.codFee + f.codFeeVat);
      expect(f.lines.reduce((s, l) => s + l.discountAlloc, 0)).toBe(f.goodsDiscount);
      for (const l of f.lines) {
        expect(l.netGoods).toBe(l.lineGross - l.discountAlloc);
        expect(l.commissionBase).toBe(l.netGoods - l.includedTax);
        expect(Math.min(l.discountAlloc, l.netGoods, l.includedTax, l.addedTax, l.commissionBase)).toBeGreaterThanOrEqual(0);
      }
      expect(f.subtotal).toBe(f.lines.reduce((s, l) => s + l.lineGross, 0));
    }
  });

  it("no discount, no tax: payable = subtotal + shipping and the sale is the whole goods value (what checkout freezes today)", () => {
    const f = calculateOrderFinance(base);
    expect(f).toMatchObject({ subtotal: 255_000, goodsProceeds: 255_000, shippingCharged: 15_000, payable: 270_000, saleAmount: 255_000, includedSalesTax: 0, addedSalesTax: 0 });
  });

  it("rounding is named per component: included tax floors, added tax rounds half up, the discount is exact", () => {
    const taxIncluded = (price: number) => calculateOrderFinance({ lines: [{ lineNo: 1, unitPrice: price, quantity: 1 }], priceMode: "tax_included", salesTaxRateBps: 1_100, checkoutShipping: 0 });
    expect(taxIncluded(1_000).includedSalesTax).toBe(99); // 99.099
    expect(taxIncluded(1_029).includedSalesTax).toBe(101); // 101.97 floors; a Math.round rule would say 102
    const half = calculateOrderFinance({ lines: [{ lineNo: 1, unitPrice: 50, quantity: 1 }], priceMode: "tax_added", salesTaxRateBps: 1_100, checkoutShipping: 0 });
    expect(half.addedSalesTax).toBe(6); // 5.5 rounds half UP
    const below = calculateOrderFinance({ lines: [{ lineNo: 1, unitPrice: 49, quantity: 1 }], priceMode: "tax_added", salesTaxRateBps: 1_100, checkoutShipping: 0 });
    expect(below.addedSalesTax).toBe(5); // 5.39
    expect(half.payable).toBe(50 + 6); // tax added on top is part of what the buyer pays and of the seller's sale
    expect(half.saleAmount).toBe(56);
  });

  it("a discount over lines is allocated pro rata with largest remainders and never exceeds the goods", () => {
    const f = calculateOrderFinance({ lines: [{ lineNo: 1, unitPrice: 100, quantity: 1 }, { lineNo: 2, unitPrice: 100, quantity: 1 }, { lineNo: 3, unitPrice: 100, quantity: 1 }], goodsDiscount: 1, checkoutShipping: 0 });
    expect(f.lines.map((l) => l.discountAlloc)).toEqual([1, 0, 0]);
    expect(() => calculateOrderFinance({ lines: base.lines, goodsDiscount: 255_001, checkoutShipping: 0 })).toThrow(/Diskon/);
    const all = calculateOrderFinance({ lines: base.lines, goodsDiscount: 255_000, checkoutShipping: 0 });
    expect(all).toMatchObject({ goodsProceeds: 0, saleAmount: 0, payable: 0 });
  });

  it("refuses what it cannot allocate: no lines, a negative or fractional amount, a commission above the goods side, a rate above 100%", () => {
    expect(() => calculateOrderFinance({ lines: [], checkoutShipping: 0 })).toThrow();
    expect(() => calculateOrderFinance({ ...base, checkoutShipping: -1 })).toThrow();
    expect(() => calculateOrderFinance({ ...base, checkoutShipping: 1.5 })).toThrow();
    expect(() => calculateOrderFinance({ ...base, affiliateCommission: 255_001 })).toThrow(/Komisi/);
    expect(() => calculateOrderFinance({ ...base, priceMode: "tax_added", salesTaxRateBps: 10_001 })).toThrow(/basis poin/);
    expect(() => calculateOrderFinance({ ...base, shippingDiscount: 15_001 })).toThrow(/Diskon ongkir/);
  });
});
