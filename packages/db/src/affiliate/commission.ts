import { DomainError } from "../platform/scoped.ts";

// The affiliate commission arithmetic (T-52, BILL-8, ADR-0009 section 5). Pure and integer-only: BigInt throughout, no Math.round, no float.
//
//   commission = floor( sum over lines of ( commission_base_i * rate_bps_i ) / 10000 )
//
// ONE floor over the whole sum, never one per line: rounding each line down would lose up to one rupiah per line. `commission_base_i` is the
// line's net goods value minus its included tax, exactly what the single BILL-4 allocation froze in `order_line_financials.commission_base_idr`
// (largest-remainder discount already applied); shipping, gateway fees, platform fees and COD fees are not in it. The database re-proves the same
// formula in the attribution guard (`affiliate_attribution_guard`), and a parity test runs one corpus through both.

export type CommissionLine = { commissionBase: number; rateBps: number };

export function calculateAffiliateCommission(lines: readonly CommissionLine[]): number {
  let sum = BigInt(0);
  for (const l of lines) {
    if (!Number.isSafeInteger(l.commissionBase) || l.commissionBase < 0) throw new DomainError("bad_amount", "Dasar komisi harus bilangan bulat rupiah tidak negatif.");
    if (!Number.isInteger(l.rateBps) || l.rateBps < 0 || l.rateBps > 10_000) throw new DomainError("bad_rate", "Tarif komisi harus 0 sampai 10000 basis poin.");
    sum += BigInt(l.commissionBase) * BigInt(l.rateBps);
  }
  const commission = sum / BigInt(10_000); // BigInt division truncates toward zero: a floor, because the sum is never negative
  if (commission > BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError("amount_overflow", "Jumlah di luar batas.");
  return Number(commission);
}
