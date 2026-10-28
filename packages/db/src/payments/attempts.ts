import { createHash, randomBytes } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { enqueue } from "../ops/jobs/jobs.ts";
import { order } from "../schema.ts";
import { bookPrepaidSale, openRefundForPaidOrder } from "../ledger/ledger.ts";
import { applyTransition } from "../seller/commerce/orders.ts";
import { withStore } from "../platform/tenant.ts";
import { surfaceOriginsFromEnv } from "../platform/host.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { requirePlatformCap } from "../ops/capabilities.ts";
import { latePaymentObligation, paymentAttempt, paymentAttemptEvent, paymentObservation } from "./schema-payments.ts";
import { classifyAdvice, PaymentContractError, type AdviceClassification, type PaymentCreateInput, type PaymentCustomer, type PaymentInstruction, type PaymentOwner } from "./contract.ts";
import { ADVICE_INTERVAL_MS, ADVICE_SETTLED, PAYMENT_INSTRUCTION_LIFETIME_MS, REDACT_BATCH_SIZE } from "./settings.ts";
import { callbackToken } from "./signature.ts";

export type PaymentScope = { exec: Executor; storeId: number };
export type Attempt = typeof paymentAttempt.$inferSelect;
export const PAYMENT_INSTRUCTION = "payment.instruction";
export const PAYMENT_VERIFY = "payment.verify";
export const PAYMENT_ADVICE_POLL = "payment.advice_poll";
/** Order states in which a verified payment is only quarantined (buyer refund obligation), never applied. */
export const QUARANTINE_ORDER_STATUSES: readonly string[] = ["cancelled", "returned"];
export const PAYMENT_SYSTEM_ACTOR = "system:payment-inquiry";

/**
 * Called in the checkout transaction (a store-bound executor). Persists the stable `reff_id`, the immutable
 * amounts and the first event BEFORE any provider call, and enqueues the instruction job in the same commit.
 * One attempt per order (UNIQUE(store_id, order_id)): a terminal order never gets one and a second attempt is refused.
 */
export async function createOrderPaymentAttempt(
  scope: PaymentScope,
  input: { orderId: number; requestKey: string; channelCode: string; customer: PaymentCustomer; amountIdr: number; adminFeeIdr: number; now?: Date },
): Promise<Attempt> {
  return withStore(scope.exec, scope.storeId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payment.order:${scope.storeId}:${input.orderId}`}, 0))`);
    const [o] = await tx.select().from(order).where(and(eq(order.storeId, scope.storeId), eq(order.id, input.orderId))).for("update");
    if (!o || o.paymentMethod !== "manual_transfer") throw new DomainError("not_found", "Pesanan pembayaran tidak ditemukan.");
    const [old] = await tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.orderId, input.orderId)));
    if (old) {
      // The same request replays the same attempt (same reff_id); anything else is a second attempt and refused.
      if (old.requestKey !== input.requestKey || old.channelCode !== input.channelCode || old.amountIdr !== input.amountIdr || old.adminFeeIdr !== input.adminFeeIdr) throw new DomainError("payment_conflict", "Pesanan ini sudah memiliki percobaan pembayaran.");
      return old;
    }
    if (o.status !== "awaiting_payment") throw new DomainError("terminal_order", "Pesanan tidak menerima tagihan baru.");
    if (o.total !== input.amountIdr) throw new DomainError("payment_amount", "Total pembayaran berbeda dari pesanan.");
    const now = input.now ?? new Date();
    const [attempt] = await tx
      .insert(paymentAttempt)
      .values({
        storeId: scope.storeId, orderId: o.id, ownerId: String(o.id), requestKey: input.requestKey,
        // Digits only, at most 30 (the provider's documented reff_id limit); 96 random bits, never derived from guessable data.
        reffId: BigInt(`0x${randomBytes(12).toString("hex")}`).toString().padStart(29, "0"),
        channelCode: input.channelCode, customer: input.customer, amountIdr: input.amountIdr, adminFeeIdr: input.adminFeeIdr, totalIdr: input.amountIdr + input.adminFeeIdr,
        expiresAt: new Date(now.getTime() + PAYMENT_INSTRUCTION_LIFETIME_MS), nextAdviceAt: new Date(now.getTime() + ADVICE_INTERVAL_MS),
      })
      .returning();
    await tx.insert(paymentAttemptEvent).values({ storeId: scope.storeId, attemptId: attempt!.id, revision: 1, kind: "created" });
    await enqueue(tx, { kind: PAYMENT_INSTRUCTION, storeId: scope.storeId, key: `order:${o.id}`, payload: { orderId: o.id } });
    return attempt!;
  });
}

export const getOrderAttempt = (scope: PaymentScope, orderId: number): Promise<Attempt | null> =>
  withStore(scope.exec, scope.storeId, async (tx) => (await tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.orderId, orderId))))[0] ?? null);

/** An order attempt never settles an invoice reference and the reverse (BILL-7): every settlement path asserts the owner kind and id of the attempt it settles (orders: T-49, invoices: T-50 `recordSubscriptionInquiry`). */
export function assertPaymentOwner(a: Pick<Attempt, "ownerKind" | "ownerId">, owner: PaymentOwner): void {
  if (a.ownerKind !== owner.kind || a.ownerId !== owner.id) throw new PaymentContractError("binding", "payment owner mismatch");
}

/** Provider create input from the persisted attempt; the signed callback URL is built here from configuration only (fails closed without a secret). */
export function paymentCreateInput(a: Attempt, options: { callbackSecret?: string; callbackOrigin?: string } = {}): PaymentCreateInput {
  return {
    reffId: a.reffId, channelCode: a.channelCode, owner: { kind: "order", id: a.ownerId }, customer: a.customer,
    amountIdr: a.amountIdr, adminFeeIdr: a.adminFeeIdr, totalIdr: a.totalIdr, expiresAt: a.expiresAt, callbackUrl: signedCallbackUrl(a.reffId, options),
  };
}

/** The signed callback URL handed to the provider (HTTP-17), for order and subscription attempts alike: built from configuration only, fails closed without a secret or on a non-https origin. */
export function signedCallbackUrl(reffId: string, options: { callbackSecret?: string; callbackOrigin?: string } = {}): string {
  const url = new URL("/api/payments/autolaris/callback", options.callbackOrigin ?? surfaceOriginsFromEnv().platformOrigin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new PaymentContractError("configuration", "payment callback origin must be https");
  url.searchParams.set("cb", callbackToken(reffId, options.callbackSecret));
  return url.toString();
}

/** One transaction: transaction id and structured instruction together, once. */
export async function storeInstruction(scope: PaymentScope, a: Attempt, instruction: PaymentInstruction): Promise<void> {
  if (instruction.reference !== a.reffId || instruction.totalIdr !== a.totalIdr) throw new PaymentContractError("binding", "stored instruction mismatch");
  await withStore(scope.exec, scope.storeId, async (tx) => {
    const [row] = await tx
      .update(paymentAttempt)
      .set({ requestState: "accepted", transactionId: instruction.transactionId, instruction, providerFeeIdr: instruction.providerFeeIdr, revision: sql`${paymentAttempt.revision} + 1` })
      .where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.id, a.id), ne(paymentAttempt.requestState, "accepted")))
      .returning();
    if (row) await tx.insert(paymentAttemptEvent).values({ storeId: scope.storeId, attemptId: row.id, revision: row.revision, kind: "accepted" });
  });
}

/** `failed` for a definite provider rejection, `unknown` when the outcome cannot be told (never a second bill). */
export async function markCreationOutcome(scope: PaymentScope, a: Attempt, outcome: "failed" | "unknown"): Promise<void> {
  await withStore(scope.exec, scope.storeId, async (tx) => {
    const [row] = await tx
      .update(paymentAttempt)
      .set({ requestState: outcome, revision: sql`${paymentAttempt.revision} + 1` })
      .where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.id, a.id), ne(paymentAttempt.requestState, "accepted"), ne(paymentAttempt.requestState, "failed")))
      .returning();
    if (row) await tx.insert(paymentAttemptEvent).values({ storeId: scope.storeId, attemptId: row.id, revision: row.revision, kind: outcome });
  });
}

/** Live settlement stays operator-confirmed until the owner enables a vendor status in writing (ADR-0006 decision 6); the fake adapter exercises the whole path. */
export const settlementEnabled = (mode: "fake" | "live"): boolean => mode === "fake" || ADVICE_SETTLED.includes("PAID");

export type InquiryResult = { classification: AdviceClassification; applied: boolean; quarantined: boolean };

/**
 * Record one provider inquiry (Advice) result for an attempt. Only a pulled `rc 00` + `PAID` + equal amount is `paid`
 * (`classifyAdvice`); a callback body never reaches this function. The poll source is observe-only. The order is
 * locked first, then the attempt, in one transaction; `paid` is monotonic (`status <> 'paid'`), so duplicates and
 * replays settle once. A payment verified for a cancelled/returned order is marked paid for audit only and opens a
 * refund obligation: no order payment, no fulfillment, no credit.
 */
export async function recordPaymentInquiry(scope: PaymentScope, attemptId: string, raw: unknown, options: { source: "callback" | "reconcile" | "poll"; mode: "fake" | "live" }): Promise<InquiryResult> {
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const [a0] = await tx.select({ orderId: paymentAttempt.orderId }).from(paymentAttempt).where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.id, attemptId)));
    if (!a0) throw new PaymentContractError("not_found", "payment attempt not found");
    const [o] = await tx.select().from(order).where(and(eq(order.storeId, scope.storeId), eq(order.id, a0.orderId))).for("update");
    const [a] = await tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.id, attemptId))).for("update");
    if (!o || !a) throw new PaymentContractError("not_found", "payment attempt not found");
    assertPaymentOwner(a, { kind: "order", id: String(o.id) });
    const classification = classifyAdvice(raw, a.totalIdr);
    await tx.insert(paymentObservation).values({
      storeId: scope.storeId, attemptId, source: options.source, classification,
      responseSha256: createHash("sha256").update(JSON.stringify(raw) ?? "null").digest("hex"),
    });
    const none = { classification, applied: false, quarantined: false };
    if (options.source === "poll" || !settlementEnabled(options.mode) || a.status === "paid" || a.transactionId === null) return none;
    const [changed] = await tx
      .update(paymentAttempt)
      .set({ status: classification === "paid" ? "paid" : classification, ...(classification === "paid" ? { paidAt: new Date() } : {}), revision: sql`${paymentAttempt.revision} + 1` })
      .where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.id, attemptId), ne(paymentAttempt.status, "paid")))
      .returning();
    if (!changed) return none;
    await tx.insert(paymentAttemptEvent).values({ storeId: scope.storeId, attemptId, revision: changed.revision, kind: classification });
    if (classification !== "paid") return { classification, applied: true, quarantined: false };
    if (QUARANTINE_ORDER_STATUSES.includes(o.status)) {
      // The buyer paid for an order that is already terminal: durable obligation plus the refund row to disburse it (D-20, BILL-5); no credit.
      await tx.insert(latePaymentObligation).values({ attemptId, storeId: scope.storeId, orderId: o.id, amountIdr: a.totalIdr }).onConflictDoNothing();
      await openRefundForPaidOrder(tx, scope.storeId, o.id, "late_payment");
      return { classification, applied: true, quarantined: true };
    }
    if (o.status === "awaiting_payment") await applyTransition(tx, scope.storeId, o.id, "pay", "Bukalaris Bayar: pembayaran diverifikasi lewat pemeriksaan ke penyedia pembayaran", PAYMENT_SYSTEM_ACTOR);
    // The sale of a verified payment is booked pending, once (unique index), even when the seller already moved the order past `awaiting_payment` by hand.
    await bookPrepaidSale(tx, scope.storeId, o.id);
    return { classification, applied: true, quarantined: false };
  });
}

/** Owner console: set (days >= 1) or clear (null) the callback-body retention period. Off by default; the period is OPEN (no default). */
export async function setCallbackRetention(op: OperatorScope, input: { days: number | null; reason: string }): Promise<void> {
  await requirePlatformCap(op, "ops.jobs.manage");
  if (input.days !== null && (!Number.isInteger(input.days) || input.days < 1)) throw new Error("retention period must be a whole number of days >= 1");
  const reason = input.reason.trim();
  if (!reason) throw new Error("a reason is required");
  await op.exec.execute(sql`select retention_set_period('payment_callback', ${input.days}::integer, ${op.userId}, ${reason})`);
}

/** One bounded batch: blank the raw callback body past the period (the digest stays); 0 while no period is set. */
export async function redactPaymentCallbacks(exec: Executor, batch = REDACT_BATCH_SIZE): Promise<number> {
  const rows = await exec.execute<{ n: string }>(sql`select redact_payment_callbacks(${batch}::integer) as n`);
  return Number(rows[0]!.n);
}
