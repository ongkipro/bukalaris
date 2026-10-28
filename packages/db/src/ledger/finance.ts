import { DomainError } from "../platform/scoped.ts";

// Order financial allocation (BILL-4 "Per-line allocation and rounding", ADR-0006 decision 2). One pure, integer-only engine: checkout
// freezes its result in `order_financials` / `order_line_financials`; later setting edits never change an order. All arithmetic is
// BigInt, so a product can never lose precision and no `Math.round` appears anywhere. Rounding is named per component:
// discount = exact largest remainder, included tax = floor, added tax = half up, COD fee and affiliate commission are inputs here.

const big = (n: number) => BigInt(n);
const num = (n: bigint): number => {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError("amount_overflow", "Jumlah di luar batas.");
  return Number(n);
};
const nonNegInt = (n: number, name: string) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new DomainError("bad_amount", `${name} harus bilangan bulat rupiah tidak negatif.`);
};

/**
 * Split `total` over `weights` in proportion, with the largest-remainder rule: `floor(total * w_i / S)` first, then the leftover
 * rupiah one at a time to the largest remainder, ties to the lower index. The parts always sum to `total`, none is negative and none
 * exceeds its weight when `total <= S`. Zero total over zero weights is all zeros; any other total over zero weights is an error.
 */
export function allocateLargestRemainder(total: number, weights: readonly number[]): number[] {
  nonNegInt(total, "Jumlah yang dialokasikan");
  weights.forEach((w) => nonNegInt(w, "Bobot alokasi"));
  const S = weights.reduce((s, w) => s + big(w), BigInt(0));
  if (S === BigInt(0)) {
    if (total !== 0) throw new DomainError("bad_allocation", "Tidak ada bobot untuk membagi jumlah ini.");
    return weights.map(() => 0);
  }
  const T = big(total);
  const parts = weights.map((w) => (T * big(w)) / S);
  const rems = weights.map((w, i) => ({ i, r: (T * big(w)) % S }));
  let left = Number(T - parts.reduce((s, p) => s + p, BigInt(0))); // 0 <= left < weights.length
  rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const out = parts.map(num);
  for (const { i } of rems) {
    if (left === 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

export type PriceMode = "tax_included" | "tax_added" | "none";
export type FinanceLineInput = { lineNo: number; unitPrice: number; quantity: number };
export type FinanceInput = {
  lines: readonly FinanceLineInput[];
  /** Store-funded goods discount over all lines (scope `all`); `0` when none. */
  goodsDiscount?: number;
  /** Ordered store-funded discounts, each limited to its eligible line numbers. Allocated over the remaining net, never the original gross. */
  goodsDiscounts?: readonly { amount: number; lineNos: readonly number[] }[];
  priceMode?: PriceMode;
  /** Store sales-tax rate in basis points (0 to 10000); ignored for `none`. */
  salesTaxRateBps?: number;
  /** Shipping the checkout charged before a store-funded shipping discount. */
  checkoutShipping: number;
  shippingDiscount?: number;
  codFee?: number;
  codFeeVat?: number;
  /** Frozen affiliate commission of the order (BILL-8); `0` until the affiliate programme exists. */
  affiliateCommission?: number;
};
export type FinanceLine = {
  lineNo: number;
  lineGross: number;
  discountAlloc: number;
  shippingDiscountAlloc: number;
  netGoods: number;
  includedTax: number;
  addedTax: number;
  /** `netGoods - includedTax`: the base the affiliate commission reads (BILL-8). */
  commissionBase: number;
};
export type OrderFinance = {
  lines: FinanceLine[];
  subtotal: number;
  goodsDiscount: number;
  shippingDiscount: number;
  includedSalesTax: number;
  addedSalesTax: number;
  goodsProceeds: number;
  shippingCharged: number;
  codFee: number;
  codFeeVat: number;
  affiliateCommission: number;
  /** `order.total`; the gateway admin fee is separate (`buyer_payable = payable + admin_fee`). */
  payable: number;
  /** What the `sale` ledger entry credits the store. */
  saleAmount: number;
};

/** `round_half_up(n / d) = floor((BigInt(2) + d) / (2d))` for non-negative n and positive d (BILL-4). */
const halfUp = (n: bigint, d: bigint) => (BigInt(2) * n + d) / (BigInt(2) * d);

export function calculateOrderFinance(input: FinanceInput): OrderFinance {
  if (input.lines.length === 0) throw new DomainError("empty", "Pesanan tanpa baris tidak bisa dialokasikan.");
  const mode = input.priceMode ?? "none";
  const rate = mode === "none" ? 0 : (input.salesTaxRateBps ?? 0);
  if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) throw new DomainError("bad_rate", "Tarif pajak harus 0 sampai 10000 basis poin.");
  const lines = [...input.lines].sort((a, b) => a.lineNo - b.lineNo);
  if (new Set(lines.map((l) => l.lineNo)).size !== lines.length) throw new DomainError("bad_lines", "Nomor baris harus unik.");
  const gross = lines.map((l) => {
    nonNegInt(l.unitPrice, "Harga");
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1) throw new DomainError("bad_amount", "Jumlah harus bilangan bulat positif.");
    return num(big(l.unitPrice) * big(l.quantity));
  });
  const subtotal = num(gross.reduce((s, g) => s + big(g), BigInt(0)));
  const alloc = gross.map(() => 0);
  const discounts = [
    { amount: input.goodsDiscount ?? 0, lineNos: lines.map((l) => l.lineNo) },
    ...(input.goodsDiscounts ?? []),
  ];
  let discount = 0;
  for (const d of discounts) {
    nonNegInt(d.amount, "Diskon barang");
    const eligible = new Set(d.lineNos);
    if (d.lineNos.some((n) => !lines.some((l) => l.lineNo === n))) throw new DomainError("bad_lines", "Baris diskon tidak ditemukan.");
    const weights = gross.map((g, i) => eligible.has(lines[i]!.lineNo) ? g - alloc[i]! : 0);
    if (big(d.amount) > weights.reduce((s, w) => s + big(w), BigInt(0))) throw new DomainError("discount_exceeds", "Diskon melebihi nilai barang dalam cakupannya.");
    const parts = allocateLargestRemainder(d.amount, weights);
    parts.forEach((p, i) => { alloc[i]! += p; });
    discount = num(big(discount) + big(d.amount));
  }
  const out: FinanceLine[] = lines.map((l, i) => {
    const net = gross[i]! - alloc[i]!;
    const included = mode === "tax_included" ? num((big(net) * big(rate)) / (BigInt(10_000) + big(rate))) : 0;
    const added = mode === "tax_added" ? num(halfUp(big(net) * big(rate), BigInt(10_000))) : 0;
    return { lineNo: l.lineNo, lineGross: gross[i]!, discountAlloc: alloc[i]!, shippingDiscountAlloc: 0, netGoods: net, includedTax: included, addedTax: added, commissionBase: net - included };
  });
  const sum = (f: (l: FinanceLine) => number) => out.reduce((s, l) => s + f(l), 0);
  const includedSalesTax = sum((l) => l.includedTax);
  const addedSalesTax = sum((l) => l.addedTax);
  const goodsProceeds = sum((l) => l.commissionBase);
  nonNegInt(input.checkoutShipping, "Ongkir");
  const shippingDiscount = input.shippingDiscount ?? 0;
  nonNegInt(shippingDiscount, "Diskon ongkir");
  if (shippingDiscount > input.checkoutShipping) throw new DomainError("discount_exceeds", "Diskon ongkir melebihi ongkir.");
  const shippingCharged = input.checkoutShipping - shippingDiscount;
  const shippingAlloc = allocateLargestRemainder(shippingDiscount, gross.some((g) => g > 0) ? gross : gross.map(() => 1));
  out.forEach((l, i) => { l.shippingDiscountAlloc = shippingAlloc[i]!; });
  const codFee = input.codFee ?? 0;
  const codFeeVat = input.codFeeVat ?? 0;
  const affiliateCommission = input.affiliateCommission ?? 0;
  nonNegInt(codFee, "Biaya COD");
  nonNegInt(codFeeVat, "PPN biaya COD");
  nonNegInt(affiliateCommission, "Komisi afiliasi");
  const goodsSide = goodsProceeds + includedSalesTax + addedSalesTax;
  if (affiliateCommission > goodsSide) throw new DomainError("commission_exceeds", "Komisi melebihi hasil penjualan barang.");
  return {
    lines: out,
    subtotal,
    goodsDiscount: discount,
    shippingDiscount,
    includedSalesTax,
    addedSalesTax,
    goodsProceeds,
    shippingCharged,
    codFee,
    codFeeVat,
    affiliateCommission,
    payable: goodsSide + shippingCharged + codFee + codFeeVat,
    saleAmount: goodsSide - affiliateCommission,
  };
}

/**
 * The same finance with the affiliate commission deducted from the seller's goods proceeds (BILL-8, T-52): `saleAmount` falls by the commission,
 * the buyer's `payable` and every allocation line are untouched (shipping, tax, COD and gateway amounts are never in the commission). The commission
 * is computed from this finance's own `lines[].commissionBase` by the caller; it can never exceed the goods side.
 */
export function withAffiliateCommission(finance: OrderFinance, commission: number): OrderFinance {
  nonNegInt(commission, "Komisi afiliasi");
  const goodsSide = finance.goodsProceeds + finance.includedSalesTax + finance.addedSalesTax;
  if (commission > goodsSide) throw new DomainError("commission_exceeds", "Komisi melebihi hasil penjualan barang.");
  return { ...finance, affiliateCommission: commission, saleAmount: goodsSide - commission };
}
