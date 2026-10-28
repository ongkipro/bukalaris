import { describe, expect, it } from "vitest";
import { calculateOrderFinance, type FinanceInput } from "../src/ledger/finance.ts";
import { percentDiscount } from "../src/promotions/checkout.ts";
import { jakartaInstant } from "../src/promotions/manage.ts";

// T-46 added assertion: the discount allocation is ONE pure function with committed fixtures. In every fixture the per-line shares sum exactly to the
// order-level discount and the shipping shares sum exactly to the shipping discount; nothing here depends on the database.
const L = (...prices: number[]) => prices.map((unitPrice, i) => ({ lineNo: i + 1, unitPrice, quantity: 1 }));

describe("T-46 allocation fixtures (BILL-4, committed numbers)", () => {
  const fixtures: { name: string; input: FinanceInput; goods: number[]; shipping?: number[] }[] = [
    { name: "equal lines with an odd discount: the leftover rupiah goes to the lowest line number", input: { lines: L(100, 100, 100), goodsDiscounts: [{ amount: 1, lineNos: [1, 2, 3] }], checkoutShipping: 0 }, goods: [1, 0, 0] },
    { name: "a discount that exactly equals one line", input: { lines: L(100_000, 50_000), goodsDiscounts: [{ amount: 100_000, lineNos: [1] }], checkoutShipping: 0 }, goods: [100_000, 0] },
    { name: "tied remainders resolve to the lower line number", input: { lines: L(10, 10, 10, 10), goodsDiscounts: [{ amount: 7, lineNos: [1, 2, 3, 4] }], checkoutShipping: 0 }, goods: [2, 2, 2, 1] },
    { name: "in-scope and out-of-scope lines mixed: the out-of-scope line gets nothing", input: { lines: L(30_000, 70_000, 45_000), goodsDiscounts: [{ amount: 10_001, lineNos: [1, 3] }], checkoutShipping: 0 }, goods: [4_000, 0, 6_001] },
    { name: "two sequential discounts allocate over the remaining net, not the gross", input: { lines: L(60_000, 40_000), goodsDiscounts: [{ amount: 50_000, lineNos: [1, 2] }, { amount: 25_000, lineNos: [1, 2] }], checkoutShipping: 0 }, goods: [45_000, 30_000] },
    { name: "tax-included store keeps the exact discount split and floors the tax per line", input: { lines: L(33_333, 33_333, 33_334), goodsDiscounts: [{ amount: 10_000, lineNos: [1, 2, 3] }], priceMode: "tax_included", salesTaxRateBps: 1_100, checkoutShipping: 0 }, goods: [3_333, 3_333, 3_334] },
    { name: "shipping discount shares follow gross and sum exactly", input: { lines: L(30_000, 70_000), checkoutShipping: 20_001, shippingDiscount: 20_001 }, goods: [0, 0], shipping: [6_000, 14_001] },
  ];
  for (const f of fixtures) {
    it(f.name, () => {
      const out = calculateOrderFinance(f.input);
      expect(out.lines.map((l) => l.discountAlloc)).toEqual(f.goods);
      expect(out.lines.reduce((s, l) => s + l.discountAlloc, 0)).toBe(out.goodsDiscount);
      expect(out.lines.reduce((s, l) => s + l.shippingDiscountAlloc, 0)).toBe(out.shippingDiscount);
      if (f.shipping) expect(out.lines.map((l) => l.shippingDiscountAlloc)).toEqual(f.shipping);
      expect(out.lines.every((l) => l.discountAlloc >= 0 && l.netGoods >= 0 && l.netGoods === l.lineGross - l.discountAlloc)).toBe(true);
      expect(out.payable).toBe(out.goodsProceeds + out.includedSalesTax + out.addedSalesTax + out.shippingCharged);
    });
  }

  it("property: 4 000 random carts, scopes and stacked discounts always sum exactly and never go negative", () => {
    let seed = 46;
    const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    for (let n = 0; n < 4_000; n++) {
      const prices = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => 1 + Math.floor(rnd() * 400_000));
      const lines = L(...prices);
      const goodsDiscounts: { amount: number; lineNos: number[] }[] = [];
      const net = prices.slice();
      for (let k = 0; k < Math.floor(rnd() * 3); k++) {
        const lineNos = lines.map((l) => l.lineNo).filter(() => rnd() < 0.7);
        if (lineNos.length === 0) continue;
        const cap = lineNos.reduce((s, no) => s + net[no - 1]!, 0);
        const amount = Math.floor(rnd() * (cap + 1));
        const out = calculateOrderFinance({ lines, goodsDiscounts: [...goodsDiscounts, { amount, lineNos }], checkoutShipping: 0 });
        out.lines.forEach((l, i) => { net[i] = l.netGoods; });
        goodsDiscounts.push({ amount, lineNos });
      }
      const shipping = Math.floor(rnd() * 90_000);
      const out = calculateOrderFinance({ lines, goodsDiscounts, checkoutShipping: shipping, shippingDiscount: Math.floor(rnd() * (shipping + 1)) });
      expect(out.lines.reduce((s, l) => s + l.discountAlloc, 0), `case ${n}`).toBe(out.goodsDiscount);
      expect(out.lines.reduce((s, l) => s + l.shippingDiscountAlloc, 0), `case ${n}`).toBe(out.shippingDiscount);
      expect(out.payable, `case ${n}`).toBeGreaterThanOrEqual(0);
      expect(out.lines.every((l) => l.netGoods >= 0), `case ${n}`).toBe(true);
    }
  });

  it("a discount larger than the goods in its scope is refused, so a total can never go negative", () => {
    expect(() => calculateOrderFinance({ lines: L(100, 900), goodsDiscounts: [{ amount: 101, lineNos: [1] }], checkoutShipping: 0 })).toThrow(/Diskon/);
    expect(() => calculateOrderFinance({ lines: L(100), goodsDiscounts: [{ amount: 60, lineNos: [1] }, { amount: 41, lineNos: [1] }], checkoutShipping: 0 })).toThrow(/Diskon/);
  });
});

describe("T-46 percent rounding is a named setting with a conservative default", () => {
  it("floor (default), half_up and ceil on 1 234 at 12.5% (1 250 bp) and an exact case", () => {
    expect([percentDiscount(1_234, 1_250, "floor"), percentDiscount(1_234, 1_250, "half_up"), percentDiscount(1_234, 1_250, "ceil")]).toEqual([154, 154, 155]); // 154.25
    expect([percentDiscount(1_236, 1_250, "floor"), percentDiscount(1_236, 1_250, "half_up"), percentDiscount(1_236, 1_250, "ceil")]).toEqual([154, 155, 155]); // 154.5
    expect([percentDiscount(1_000, 1_000, "floor"), percentDiscount(1_000, 1_000, "ceil")]).toEqual([100, 100]);
    expect(() => percentDiscount(1.5, 100, "floor")).toThrow();
    expect(() => percentDiscount(100, 10_001, "floor")).toThrow();
  });
});

describe("T-46 promotion windows are Asia/Jakarta wall clocks", () => {
  it("a datetime-local value is read as WIB (UTC+7), whatever the host timezone", () => {
    expect(jakartaInstant("2026-10-28T09:00").toISOString()).toBe("2026-10-28T02:00:00.000Z");
    expect(jakartaInstant("2026-01-01T00:00").toISOString()).toBe("2025-12-31T17:00:00.000Z");
    expect(() => jakartaInstant("2026-02-30T10:00")).toThrow();
    expect(() => jakartaInstant("besok")).toThrow();
  });
});
