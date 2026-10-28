import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { ledgerEntry, order, orderFinancials, orderLineFinancials, refund, type LedgerKind } from "../schema.ts";
import { paymentAttempt } from "../payments/schema-payments.ts";
import { type OrderFinance } from "./finance.ts";

// The seller ledger core (ADR-0006 decisions 3 and 4, BILL-5, DATA-7). Single-entry, append-only: balances are ALWAYS `SUM(amount_idr)` over
// `ledger_entry`, never a stored counter and never a join with `order` (a payout entry has a NULL order_id, so an inner join silently drops it).
// Every writer here is idempotent through a partial unique index (`ON CONFLICT DO NOTHING`), and the database guards in migration 0013 are the
// backstop: even a caller that forgets a rule here cannot book a second sale, release an unreconciled COD sale or make `available` negative.
// Lock order of every money writer, never reversed: (1) the order row, (2) the per-store lock below, (3) ledger rows in ascending id.

export const PAYOUT_STORE_LOCK = "bukalaris.payout.store";

/** The per-store two-key advisory lock (ADR-0006 decision 4). Transaction-scoped and re-entrant: the database guards take the same lock themselves. */
export async function lockStore(tx: Executor, storeId: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${PAYOUT_STORE_LOCK}), hashtext(${String(storeId)}))`);
}

/** The balance of one store: derived by SUM over `ledger_entry` alone. */
export async function ledgerBalance(exec: Executor, storeId: number): Promise<{ availableIdr: number; pendingIdr: number }> {
  const [row] = await exec
    .select({
      available: sql<string>`coalesce(sum(${ledgerEntry.amountIdr}) filter (where ${ledgerEntry.status} = 'available'), 0)`,
      pending: sql<string>`coalesce(sum(${ledgerEntry.amountIdr}) filter (where ${ledgerEntry.status} = 'pending'), 0)`,
    })
    .from(ledgerEntry)
    .where(eq(ledgerEntry.storeId, storeId));
  return { availableIdr: Number(row!.available), pendingIdr: Number(row!.pending) };
}

/** Freeze the checkout allocation with the order, in the order's own transaction (BILL-4). The deferred constraint checks the lines add up. */
export async function writeOrderFinancials(tx: Executor, input: {
  storeId: number;
  orderId: number;
  finance: OrderFinance;
  platformShippingDiscountIdr: number;
  variantIds: readonly number[];
  expectedGatewayFeeIdr: number;
  /** T-52: the attributed affiliate and the rate frozen on each line (index = line order, 0 for a line that is not opted in); omitted when no commission was earned. */
  affiliate?: { affiliateId: number; ratesBps: readonly number[] } | undefined;
}): Promise<void> {
  const f = input.finance;
  await tx.insert(orderFinancials).values({
    orderId: input.orderId,
    storeId: input.storeId,
    subtotalIdr: f.subtotal,
    goodsDiscountIdr: f.goodsDiscount,
    shippingDiscountIdr: f.shippingDiscount,
    platformShippingDiscountIdr: input.platformShippingDiscountIdr,
    includedSalesTaxIdr: f.includedSalesTax,
    addedSalesTaxIdr: f.addedSalesTax,
    goodsProceedsIdr: f.goodsProceeds,
    shippingChargedIdr: f.shippingCharged,
    affiliateId: input.affiliate?.affiliateId ?? null,
    affiliateCommissionIdr: f.affiliateCommission,
    codFeeIdr: f.codFee,
    codFeeVatIdr: f.codFeeVat,
    payableIdr: f.payable,
    saleAmountIdr: f.saleAmount,
    expectedGatewayFeeIdr: input.expectedGatewayFeeIdr,
  });
  await tx.insert(orderLineFinancials).values(
    f.lines.map((l, i) => ({
      orderId: input.orderId,
      lineNo: l.lineNo,
      storeId: input.storeId,
      variantId: input.variantIds[i]!,
      lineGrossIdr: l.lineGross,
      discountAllocIdr: l.discountAlloc,
      shippingDiscountIdr: l.shippingDiscountAlloc,
      netGoodsIdr: l.netGoods,
      includedTaxIdr: l.includedTax,
      addedTaxIdr: l.addedTax,
      commissionBaseIdr: l.commissionBase,
      commissionRateBps: input.affiliate ? input.affiliate.ratesBps[i]! : null,
    })),
  );
}

type Booked = { booked: boolean };

/**
 * Book the `sale` (and the seller's `cashback` when > 0) of an order as `pending`. Idempotent: a replayed call finds the existing row and inserts
 * nothing. Callers: a prepaid order when its payment is verified `paid` (`bookPrepaidSale`), a COD order when the provider's DELIVERED status
 * or an approved manual completion moves it to `completed` (`bookCodSale`). The database refuses a sale for a cancelled or returned order.
 */
async function bookSale(tx: Executor, storeId: number, orderId: number): Promise<Booked> {
  const [fin] = await tx.select({ sale: orderFinancials.saleAmountIdr, cashback: orderFinancials.sellerCashbackIdr }).from(orderFinancials).where(and(eq(orderFinancials.storeId, storeId), eq(orderFinancials.orderId, orderId)));
  if (!fin) return { booked: false };
  await lockStore(tx, storeId);
  const rows = await tx
    .insert(ledgerEntry)
    .values({ storeId, orderId, kind: "sale", status: "pending", amountIdr: fin.sale })
    .onConflictDoNothing()
    .returning({ id: ledgerEntry.id });
  if (fin.cashback > 0) await tx.insert(ledgerEntry).values({ storeId, orderId, kind: "cashback", status: "pending", amountIdr: fin.cashback }).onConflictDoNothing();
  return { booked: rows.length > 0 };
}

/** A sale with a zero amount is not a ledger row (`ledger_sign_chk` needs > 0): an order whose seller share is nil books nothing. */
export async function bookPrepaidSale(tx: Executor, storeId: number, orderId: number): Promise<Booked> {
  const [o] = await tx.select({ status: order.status, method: order.paymentMethod }).from(order).where(and(eq(order.storeId, storeId), eq(order.id, orderId)));
  if (!o || o.method === "cod" || !["placed", "processing", "shipped", "completed"].includes(o.status)) return { booked: false };
  const [a] = await tx.select({ s: paymentAttempt.status }).from(paymentAttempt).where(and(eq(paymentAttempt.storeId, storeId), eq(paymentAttempt.orderId, orderId)));
  if (a?.s !== "paid") return { booked: false };
  const [fin] = await tx.select({ sale: orderFinancials.saleAmountIdr }).from(orderFinancials).where(and(eq(orderFinancials.storeId, storeId), eq(orderFinancials.orderId, orderId)));
  if (!fin || fin.sale <= 0) return { booked: false };
  return bookSale(tx, storeId, orderId);
}

export async function bookCodSale(tx: Executor, storeId: number, orderId: number): Promise<Booked> {
  const [o] = await tx.select({ status: order.status, method: order.paymentMethod }).from(order).where(and(eq(order.storeId, storeId), eq(order.id, orderId)));
  if (!o || o.method !== "cod" || o.status !== "completed") return { booked: false };
  const [fin] = await tx.select({ sale: orderFinancials.saleAmountIdr }).from(orderFinancials).where(and(eq(orderFinancials.storeId, storeId), eq(orderFinancials.orderId, orderId)));
  if (!fin || fin.sale <= 0) return { booked: false };
  return bookSale(tx, storeId, orderId);
}

/**
 * An order became `cancelled` or `returned` (before delivery, by construction): reverse its still-pending sale once, pending against pending, so both
 * net to zero in the held pool and `available` can never go negative. Opens the buyer refund when a gateway payment was verified. Both inside
 * the caller's transaction (the order row is already locked by the status writer). COD never earned a credit, so there is nothing to reverse.
 */
export async function settleTerminalOrder(tx: Executor, storeId: number, orderId: number, reason: "order_cancelled" | "order_returned"): Promise<{ reversed: boolean; refundOpened: boolean }> {
  await lockStore(tx, storeId);
  // The seller login holds no UPDATE privilege, so no `FOR UPDATE` here: the per-store lock (taken above, also by the release job) serialises the two writers, and the
  // definer insert guard locks the sale row itself before it accepts the reversal.
  const [sale] = await tx.select({ id: ledgerEntry.id, status: ledgerEntry.status, amount: ledgerEntry.amountIdr }).from(ledgerEntry).where(and(eq(ledgerEntry.storeId, storeId), eq(ledgerEntry.orderId, orderId), eq(ledgerEntry.kind, "sale")));
  let reversed = false;
  if (sale) {
    if (sale.status !== "pending") throw new Error(`invariant: the sale of order ${orderId} was already released when the order became terminal`);
    const rows = await tx
      .insert(ledgerEntry)
      .values({ storeId, orderId, kind: "return_reversal", status: "pending", amountIdr: -sale.amount, note: reason === "order_returned" ? "Pesanan dikembalikan (RTS) sebelum diterima" : "Pesanan dibatalkan sebelum diterima" })
      .onConflictDoNothing()
      .returning({ id: ledgerEntry.id });
    reversed = rows.length > 0;
  }
  return { reversed, refundOpened: await openRefundForPaidOrder(tx, storeId, orderId, reason) };
}

/** The full buyer refund of a verified gateway payment on a terminal order: goods + shipping + the admin fee the buyer paid (D-20, BILL-5). */
export async function openRefundForPaidOrder(tx: Executor, storeId: number, orderId: number, reason: "order_cancelled" | "order_returned" | "late_payment"): Promise<boolean> {
  const [a] = await tx.select({ id: paymentAttempt.id, status: paymentAttempt.status, total: paymentAttempt.totalIdr, fee: paymentAttempt.adminFeeIdr }).from(paymentAttempt).where(and(eq(paymentAttempt.storeId, storeId), eq(paymentAttempt.orderId, orderId)));
  if (!a || a.status !== "paid") return false;
  const [f] = await tx.select().from(orderFinancials).where(and(eq(orderFinancials.storeId, storeId), eq(orderFinancials.orderId, orderId)));
  if (!f) return false;
  const rows = await tx
    .insert(refund)
    .values({
      storeId,
      orderId,
      paymentAttemptId: a.id,
      goodsRefundIdr: f.goodsProceedsIdr + f.includedSalesTaxIdr + f.addedSalesTaxIdr,
      shippingRefundIdr: f.shippingChargedIdr,
      feeRefundIdr: a.fee,
      amountIdr: a.total,
      reason,
    })
    .onConflictDoNothing()
    .returning({ id: refund.id });
  return rows.length > 0;
}

export type LedgerRow = typeof ledgerEntry.$inferSelect;
export const SELLER_KIND_LABEL: Record<LedgerKind, string> = {
  sale: "Penjualan",
  cashback: "Cashback ongkir",
  shipping_debit: "Selisih ongkir (potongan)",
  shipping_debit_reversal: "Pembatalan potongan ongkir",
  return_reversal: "Pembatalan penjualan (pesanan kembali)",
  payout: "Penarikan dana",
  payout_reversal: "Penarikan dana dibatalkan",
  adjustment: "Penyesuaian",
};
