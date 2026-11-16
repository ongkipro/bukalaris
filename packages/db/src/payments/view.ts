import { and, desc, eq } from "drizzle-orm";
import type { Executor } from "../client.ts";
import type { ProviderEnvironment } from "../shipping/schema-accounts.ts";
import { paymentAttempt } from "./schema-payments.ts";

/** What a buyer or the owning seller may see of a payment attempt: never the provider transaction id, provider fee or callback data. */
export type OrderPaymentView = {
  channelCode: string;
  requestState: "in_progress" | "accepted" | "failed" | "unknown";
  status: "pending" | "paid" | "unknown";
  amountIdr: number;
  adminFeeIdr: number;
  totalIdr: number;
  expiresAt: Date;
  instruction: { virtualAccount: string | null; qr: string | null; paymentCode: string | null; url: string | null; expiresAt: string } | null;
  /** T-106: the attempt number (a retry adds one), whether it runs on the store's own AutoLaris account, and that account's environment (sandbox = test order). */
  attemptNo: number;
  sellerAccount: boolean;
  environment: ProviderEnvironment | null;
  /** The buyer may ask for a new instruction: store's own account, and the latest attempt failed or expired (the order state is checked by the caller and the service). */
  retryable: boolean;
};

/** The order's latest attempt. Caller supplies an executor that already carries the store context (`withStore`/`inStore`). */
export async function orderPaymentView(tx: Executor, storeId: number, orderId: number, now = new Date()): Promise<OrderPaymentView | null> {
  const [a] = await tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, storeId), eq(paymentAttempt.orderId, orderId))).orderBy(desc(paymentAttempt.attemptNo)).limit(1);
  if (!a) return null;
  const i = a.instruction;
  return {
    channelCode: a.channelCode, requestState: a.requestState, status: a.status,
    amountIdr: a.amountIdr, adminFeeIdr: a.adminFeeIdr, totalIdr: a.totalIdr, expiresAt: a.expiresAt,
    instruction: i ? { virtualAccount: i.virtualAccount, qr: i.qr, paymentCode: i.paymentCode, url: i.url, expiresAt: i.expiresAt } : null,
    attemptNo: a.attemptNo, sellerAccount: a.paymentAccountId !== null, environment: a.environment,
    retryable: a.paymentAccountId !== null && a.status !== "paid" && (a.requestState === "failed" || (a.requestState === "accepted" && a.expiresAt <= now)),
  };
}
