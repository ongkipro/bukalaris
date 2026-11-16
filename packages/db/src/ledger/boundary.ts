import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { DomainError } from "../platform/scoped.ts";
import { storePaymentAccount } from "../payments/schema-payments.ts";
import { storeShippingAccount } from "../shipping/schema-accounts.ts";
import { orderFinancials, type MoneyMode } from "./schema-ledger.ts";

// T-107 — the money boundary (ADR-0013 section 8, BILL-5, D-27, D-31). One rule, stated here and in the database (`store_money_mode`, migration 0021):
// a store is `seller_owned` when it holds a seller-owned account of either provider. Its buyers pay the seller's own AutoLaris and Mengantar accounts,
// so Bukalaris writes no ledger entry, payout, payout destination, reconciliation item, shipment-cost reservation, platform refund or late-payment
// obligation for it, and never routes its orders to the platform's AutoLaris account. Each order freezes the mode in `order_financials.money_mode`.
// The services refuse here by rule; `money_boundary_guard` refuses the same rows in the database for every role. Money the platform does hold
// (`platform_held`) keeps every ADR-0006 invariant unchanged.

export type { MoneyMode };

/** The store's money mode now. Runs in the store's context (the application role reads only its own accounts; the platform role reads any). */
export async function storeMoneyMode(exec: Executor, storeId: number): Promise<MoneyMode> {
  const [row] = await exec.execute<{ own: boolean }>(sql`select (exists (select 1 from ${storeShippingAccount} where ${storeShippingAccount.storeId} = ${storeId} and ${storeShippingAccount.kind} = 'seller_owned')
    or exists (select 1 from ${storePaymentAccount} where ${storePaymentAccount.storeId} = ${storeId})) as own`);
  return row?.own ? "seller_owned" : "platform_held";
}

/** The mode an order froze at submit (`platform_held` for an order without a snapshot, which no money path accepts anyway). */
export async function orderMoneyMode(exec: Executor, storeId: number, orderId: number): Promise<MoneyMode> {
  const [f] = await exec.select({ mode: orderFinancials.moneyMode }).from(orderFinancials).where(and(eq(orderFinancials.storeId, storeId), eq(orderFinancials.orderId, orderId)));
  return f?.mode ?? "platform_held";
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
