import { and, eq } from "drizzle-orm";
import type { Executor } from "../client.ts";
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
};

/** Caller supplies an executor that already carries the store context (`withStore`/`inStore`). */
export async function orderPaymentView(tx: Executor, storeId: number, orderId: number): Promise<OrderPaymentView | null> {
  const [a] = await tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, storeId), eq(paymentAttempt.orderId, orderId)));
  if (!a) return null;
  const i = a.instruction;
  return {
    channelCode: a.channelCode, requestState: a.requestState, status: a.status,
    amountIdr: a.amountIdr, adminFeeIdr: a.adminFeeIdr, totalIdr: a.totalIdr, expiresAt: a.expiresAt,
    instruction: i ? { virtualAccount: i.virtualAccount, qr: i.qr, paymentCode: i.paymentCode, url: i.url, expiresAt: i.expiresAt } : null,
  };
}
