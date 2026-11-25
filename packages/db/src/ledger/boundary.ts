import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { DomainError } from "../platform/scoped.ts";
import { storeBankAccount, storePaymentAccount } from "../payments/schema-payments.ts";
import { storeShippingAccount } from "../shipping/schema-accounts.ts";
import { orderFinancials, type MoneyMode } from "./schema-ledger.ts";

// T-107 — the money boundary (ADR-0013 section 8, BILL-5, D-27, D-31). One rule, stated here and in the database (`store_money_mode`, migration 0022):
// a store is `seller_owned` when it holds a seller-owned account of either provider, or a bank account for bank transfer (T-113, D-36). Its buyers pay the seller's own AutoLaris and Mengantar accounts,
// so Bukalaris writes no ledger entry, payout, payout destination, reconciliation item, shipment-cost reservation, platform refund or late-payment
// obligation for it, and never routes its orders to the platform's AutoLaris account. Each order freezes the mode in `order_financials.money_mode`.
// The services refuse here by rule; `money_boundary_guard` refuses the same rows in the database for every role. Money the platform does hold
// (`platform_held`) keeps every ADR-0006 invariant unchanged.

export type { MoneyMode };

/** The store's money mode now. Runs in the store's context (the application role reads only its own accounts; the platform role reads any). */
export async function storeMoneyMode(exec: Executor, storeId: number): Promise<MoneyMode> {
  const [row] = await exec.execute<{ own: boolean }>(sql`select (exists (select 1 from ${storeShippingAccount} where ${storeShippingAccount.storeId} = ${storeId} and ${storeShippingAccount.kind} = 'seller_owned')
    or exists (select 1 from ${storePaymentAccount} where ${storePaymentAccount.storeId} = ${storeId})
    or exists (select 1 from ${storeBankAccount} where ${storeBankAccount.storeId} = ${storeId})) as own`);
  return row?.own ? "seller_owned" : "platform_held";
}

/**
 * T-117 (D-37, ADR-0013 decision 14, ADR-0016 decision 21): the one activation rule. The catalog gate (`assertCanActivate`) and the setup
 * checklist both call these, so the checklist can never promise what the gate refuses. A physical product needs the store's own ready
 * Mengantar account, except on a pre-0027 (legacy) store whose money is still platform-held; a digital product needs one ready prepaid method.
 */
export const physicalActivationAllowed = (i: { moneyMode: MoneyMode; legacyPlatformShipping: boolean; shippingReady: boolean }): boolean =>
  i.shippingReady || (i.legacyPlatformShipping && i.moneyMode === "platform_held");
export const digitalPrepaidReady = (i: { qrisVaReady: boolean; bankTransferReady: boolean }): boolean => i.qrisVaReady || i.bankTransferReady;

/** The mode an order froze at submit (`platform_held` for an order without a snapshot, which no money path accepts anyway). */
export async function orderMoneyMode(exec: Executor, storeId: number, orderId: number): Promise<MoneyMode> {
  const [f] = await exec.select({ mode: orderFinancials.moneyMode }).from(orderFinancials).where(and(eq(orderFinancials.storeId, storeId), eq(orderFinancials.orderId, orderId)));
  return f?.mode ?? "platform_held";
}

/** SQLSTATEs of the database guards (migration 0022): a boundary refusal and a refused cut-over. */
export const BOUNDARY_SQLSTATE = "BKMB1";
export const CUTOVER_SQLSTATE = "BKMB2";
const sqlstate = (err: unknown): string | undefined => (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code;
const sqlMessage = (err: unknown): string => (err as { cause?: { message?: string }; message?: string })?.cause?.message ?? (err as { message?: string })?.message ?? "";
export const isBoundaryRefusal = (err: unknown): boolean => sqlstate(err) === BOUNDARY_SQLSTATE;

/** The seller's reason a store cannot move to its own accounts yet (review M2: a clean cut-over, nothing of the platform's money left in flight). */
const CUTOVER_REASON: Record<string, string> = {
  balance: "masih ada Saldo Bukalaris (tersedia atau dalam proses). Tarik atau selesaikan saldo itu lebih dulu",
  payout: "masih ada penarikan dana yang sedang diproses. Tunggu sampai selesai",
  refund: "masih ada refund pembeli yang dibayar Bukalaris dan belum selesai",
  order: "masih ada pesanan yang belum selesai, dibatalkan atau dikembalikan. Selesaikan pesanan itu lebih dulu",
};
/**
 * Maps the database's cut-over refusal (`money_cutover_guard`) to the seller's message; any other error is returned as it is. Used by the one
 * writer of the first seller-owned account row (`saveProviderKey`, T-104's save path).
 */
export function cutoverError(err: unknown): unknown {
  if (sqlstate(err) !== CUTOVER_SQLSTATE) return err;
  const reason = /: (\w+)$/.exec(sqlMessage(err))?.[1] ?? "";
  return new DomainError("platform_money_open", `Akun sendiri belum bisa dihubungkan: ${CUTOVER_REASON[reason] ?? "masih ada uang toko yang dipegang Bukalaris"}. Setelah itu toko dibayar langsung ke akun Anda.`);
}

export const SELLER_OWNED_MESSAGE = "Toko ini dibayar langsung ke akun pembayaran dan akun kurir milik toko sendiri. Bukalaris tidak memegang uangnya, jadi tidak ada saldo, penarikan dana, rekonsiliasi atau refund dari Bukalaris.";

/** Refuse a platform money action (payout, destination, release, reconciliation, platform refund) for a store on its own accounts. */
export async function assertPlatformHeldStore(exec: Executor, storeId: number): Promise<void> {
  if ((await storeMoneyMode(exec, storeId)) === "seller_owned") throw new DomainError("seller_owned_store", SELLER_OWNED_MESSAGE);
}

/** Refuse a platform money action for an order paid to the seller's own accounts. */
export async function assertPlatformHeldOrder(exec: Executor, storeId: number, orderId: number): Promise<void> {
  if ((await orderMoneyMode(exec, storeId, orderId)) === "seller_owned") throw new DomainError("seller_owned_order", SELLER_OWNED_MESSAGE);
}
