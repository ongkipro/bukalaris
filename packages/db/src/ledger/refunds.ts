import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor } from "../client.ts";
import { requirePlatformCap } from "../ops/capabilities.ts";
import { verifyOrderLink } from "../ops/jobs/notify.ts";
import { auditLog, latePaymentObligation, order, refund } from "../schema.ts";
import { resolveOrderStore } from "../platform/resolvers.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { withStore } from "../platform/tenant.ts";
import { openRefundForPaidOrder } from "./ledger.ts";

// Buyer refunds (ADR-0006 decision 5, BILL-5, D-20 closes OPEN-F4). A refund exists for a VERIFIED gateway payment on a cancelled/returned order or for a late
// payment, for the FULL payment (goods + shipping + the admin fee the buyer paid). The buyer supplies the destination on the signed one-order status page; a typed
// phone or e-mail never authorises anything. An operator approves it for transfer (four-eyes, `refund.approve_transfer`, `transfer.ts`), makes the transfer by
// hand and records the evidence. It never touches the seller ledger: the seller's `return_reversal` and the buyer refund are separate effects.

const destinationInput = z.strictObject({
  bank: z.string().trim().min(2, "Pilih bank atau e-wallet.").max(20).regex(/^[A-Za-z0-9_-]+$/, "Kode bank tidak valid."),
  account: z.string().trim().regex(/^[0-9]{5,24}$/, "Nomor rekening harus 5 sampai 24 angka."),
  holder: z.string().trim().min(2, "Nama pemilik rekening wajib diisi.").max(120),
});

export type RefundForLink = { id: number; status: string; amountIdr: number; goodsRefundIdr: number; shippingRefundIdr: number; feeRefundIdr: number; reason: string; destinationSet: boolean; destinationLast4: string | null; destinationBank: string | null };

/** The refund of the order behind a signed link (app pool, store resolved through the definer function). Never echoes the account number. */
export async function getRefundForLink(exec: Executor, token: string, now = Date.now()): Promise<RefundForLink | null> {
  const orderId = verifyOrderLink(token, now);
  if (orderId === null) return null;
  const storeId = await resolveOrderStore(exec, orderId);
  if (!storeId) return null;
  return withStore(exec, storeId, async (tx) => {
    const [r] = await tx
      .select({ id: refund.id, status: refund.status, amountIdr: refund.amountIdr, goodsRefundIdr: refund.goodsRefundIdr, shippingRefundIdr: refund.shippingRefundIdr, feeRefundIdr: refund.feeRefundIdr, reason: refund.reason, last4: sql<string | null>`right(${refund.destinationAccount}, 4)`, bank: refund.destinationBank })
      .from(refund)
      .where(and(eq(refund.storeId, storeId), eq(refund.orderId, orderId), sql`${refund.status} <> 'failed'`));
    return r ? { id: r.id, status: r.status, amountIdr: r.amountIdr, goodsRefundIdr: r.goodsRefundIdr, shippingRefundIdr: r.shippingRefundIdr, feeRefundIdr: r.feeRefundIdr, reason: r.reason, destinationSet: r.last4 !== null, destinationLast4: r.last4, destinationBank: r.bank } : null;
  });
}

/**
 * The buyer submits (or corrects) the refund destination on the signed status page. Only while the refund is `pending`: once an operator approved it the destination is
 * frozen (the approval hash covers it), and the database refuses any other column from this login.
 */
export async function submitRefundDestination(exec: Executor, token: string, raw: unknown, now = Date.now()): Promise<void> {
  const input = destinationInput.parse(raw);
  const orderId = verifyOrderLink(token, now);
  const storeId = orderId === null ? null : await resolveOrderStore(exec, orderId);
  if (orderId === null || !storeId) throw new DomainError("not_found", "Tautan tidak valid atau sudah kedaluwarsa.");
  await withStore(exec, storeId, async (tx) => {
    const rows = await tx
      .update(refund)
      .set({ destinationBank: input.bank.toUpperCase(), destinationAccount: input.account, destinationHolder: input.holder, destinationSubmittedAt: new Date() })
      .where(and(eq(refund.storeId, storeId), eq(refund.orderId, orderId), eq(refund.status, "pending")))
      .returning({ id: refund.id });
    if (rows.length === 0) throw new DomainError("not_editable", "Rekening refund sudah tidak bisa diubah.");
  });
}

/**
 * Every `late_payment_obligation` T-49 opened gets its refund row (idempotent: `refund_one_per_order`). The payment path creates the refund in the same transaction, so this
 * only catches obligations that predate it or were left by an interrupted run.
 */
export async function convertLateObligations(db: Db): Promise<number> {
  const open = await db
    .select({ storeId: latePaymentObligation.storeId, orderId: latePaymentObligation.orderId })
    .from(latePaymentObligation)
    .innerJoin(order, and(eq(order.storeId, latePaymentObligation.storeId), eq(order.id, latePaymentObligation.orderId)))
    .where(sql`not exists (select 1 from refund r where r.store_id = ${latePaymentObligation.storeId} and r.order_id = ${latePaymentObligation.orderId})`);
  let opened = 0;
  for (const o of open) if (await withStore(db, o.storeId, (tx) => openRefundForPaidOrder(tx, o.storeId, o.orderId, "late_payment"))) opened += 1;
  return opened;
}

/**
 * A failed refund is still owed to the buyer (it stays in `platform_money_position` as `refunds_failed`). This opens a NEW pending refund for the same order and payment
 * (the buyer supplies the destination again; the failed row is never edited), after which the normal four-eyes approve-for-transfer applies. `refunds.process`, audited.
 * Idempotent: an order that already has a live refund opens nothing.
 */
export async function reopenFailedRefund(op: OperatorScope, refundId: number, reason: string): Promise<{ refundId: number }> {
  await requirePlatformCap(op, "refunds.process");
  const why = z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500).parse(reason);
  const [f] = await op.exec.select().from(refund).where(eq(refund.id, refundId));
  if (!f || f.status !== "failed") throw new DomainError("invalid_state", "Hanya refund yang gagal yang bisa dibuka kembali.");
  return withStore(op.exec, f.storeId, async (tx) => {
    const [live] = await tx.select({ id: refund.id }).from(refund).where(and(eq(refund.storeId, f.storeId), eq(refund.orderId, f.orderId), sql`${refund.status} <> 'failed'`));
    if (live) return { refundId: live.id };
    const [n] = await tx
      .insert(refund)
      .values({ storeId: f.storeId, orderId: f.orderId, paymentAttemptId: f.paymentAttemptId, goodsRefundIdr: f.goodsRefundIdr, shippingRefundIdr: f.shippingRefundIdr, feeRefundIdr: f.feeRefundIdr, amountIdr: f.amountIdr, reason: f.reason })
      .returning({ id: refund.id });
    await tx.insert(auditLog).values({ storeId: f.storeId, actorUserId: op.userId, actorCapability: "refunds.process", action: "refund.reopen", subjectKind: "refund", subjectId: String(n!.id), outcome: "allowed", reason: `from:${refundId} ${why}`.slice(0, 200) });
    return { refundId: n!.id };
  });
}
