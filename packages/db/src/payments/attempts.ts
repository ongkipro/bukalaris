import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { enqueue } from "../ops/jobs/jobs.ts";
import { order } from "../schema.ts";
import { bookPrepaidSale, openRefundForPaidOrder } from "../ledger/ledger.ts";
import { applyTransition } from "../seller/commerce/orders.ts";
import { withStore } from "../platform/tenant.ts";
import { surfaceOriginsFromEnv } from "../platform/host.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { requirePlatformCap } from "../ops/capabilities.ts";
import { latePaymentObligation, paymentAnomaly, paymentAttempt, paymentAttemptEvent, paymentManualConfirmation, paymentObservation } from "./schema-payments.ts";
import { adviceStatusWord, classifyAdvice, PaymentContractError, type AdviceClassification, type PaymentCreateInput, type PaymentCustomer, type PaymentInstruction, type PaymentOwner, type SubmitProfile } from "./contract.ts";
import { ADVICE_INTERVAL_MS, ADVICE_SETTLED, AUTOLARIS_PAID, PAYMENT_INSTRUCTION_LIFETIME_MS, REDACT_BATCH_SIZE } from "./settings.ts";
import type { ProviderEnvironment } from "../shipping/schema-accounts.ts";
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
  input: {
    orderId: number; requestKey: string; channelCode: string; customer: PaymentCustomer; amountIdr: number; adminFeeIdr: number; now?: Date;
    /** T-106: the store's own account (null = platform account) and the frozen fee decision. */
    paymentAccountId?: number | null; environment?: ProviderEnvironment | null; feeBearer?: "buyer" | "seller"; feeRateVersion?: number | null; expectedFeeIdr?: number | null;
  },
): Promise<Attempt> {
  return withStore(scope.exec, scope.storeId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payment.order:${scope.storeId}:${input.orderId}`}, 0))`);
    const [o] = await tx.select().from(order).where(and(eq(order.storeId, scope.storeId), eq(order.id, input.orderId))).for("update");
    if (!o || o.paymentMethod !== "manual_transfer") throw new DomainError("not_found", "Pesanan pembayaran tidak ditemukan.");
    const [old] = await tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.orderId, input.orderId), eq(paymentAttempt.attemptNo, 1)));
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
        paymentAccountId: input.paymentAccountId ?? null, environment: input.environment ?? null, feeBearer: input.feeBearer ?? "buyer",
        feeRateVersion: input.feeRateVersion ?? null, expectedFeeIdr: input.expectedFeeIdr ?? null,
      })
      .returning();
    await tx.insert(paymentAttemptEvent).values({ storeId: scope.storeId, attemptId: attempt!.id, revision: 1, kind: "created" });
    await enqueue(tx, { kind: PAYMENT_INSTRUCTION, storeId: scope.storeId, key: `order:${o.id}`, payload: { orderId: o.id } });
    return attempt!;
  });
}

/** The order's latest attempt (T-106: a retry adds attempts; the platform account keeps exactly one). */
export const getOrderAttempt = (scope: PaymentScope, orderId: number): Promise<Attempt | null> =>
  withStore(scope.exec, scope.storeId, async (tx) => (await tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.orderId, orderId))).orderBy(desc(paymentAttempt.attemptNo)).limit(1))[0] ?? null);
/** One attempt by id (the instruction job of a retry names its attempt). */
export const getPaymentAttempt = (scope: PaymentScope, attemptId: string): Promise<Attempt | null> =>
  withStore(scope.exec, scope.storeId, async (tx) => (await tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.id, attemptId))))[0] ?? null);

/** An order attempt never settles an invoice reference and the reverse (BILL-7): every settlement path asserts the owner kind and id of the attempt it settles (orders: T-49, invoices: T-50 `recordSubscriptionInquiry`). */
export function assertPaymentOwner(a: Pick<Attempt, "ownerKind" | "ownerId">, owner: PaymentOwner): void {
  if (a.ownerKind !== owner.kind || a.ownerId !== owner.id) throw new PaymentContractError("binding", "payment owner mismatch");
}

/** Provider create input from the persisted attempt; the signed callback URL is built here from configuration only (fails closed without a secret). */
export function paymentCreateInput(a: Attempt, options: { callbackSecret?: string; callbackOrigin?: string } = {}, profile?: SubmitProfile): PaymentCreateInput {
  return {
    reffId: a.reffId, channelCode: a.channelCode, owner: { kind: "order", id: a.ownerId }, customer: a.customer,
    amountIdr: a.amountIdr, adminFeeIdr: a.adminFeeIdr, totalIdr: a.totalIdr, expiresAt: a.expiresAt, callbackUrl: signedCallbackUrl(a.reffId, options),
    ...(profile ? { profile } : {}),
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
/** T-106: on the seller's own key a live settlement additionally waits until the paid status words are confirmed by AutoLaris (`AUTOLARIS_PAID.verified`). */
export const sellerSettlementEnabled = (mode: "fake" | "live"): boolean => mode === "fake" || AUTOLARIS_PAID.verified;

// ── T-106 settlement helpers shared by the status check and the manual confirmation (decision 27) ─────────────────────
/** Raise the anomaly once per attempt and kind (unique); the caller carries the store context. */
export async function raiseAnomaly(tx: Executor, a: Pick<Attempt, "storeId" | "orderId" | "id">, kind: "second_settled" | "paid_after_close") {
  await tx.insert(paymentAnomaly).values({ storeId: a.storeId, orderId: a.orderId, attemptId: a.id, kind }).onConflictDoNothing();
}
/** Is another attempt of the order already settled (paid by the provider or confirmed by hand)? */
export async function otherAttemptSettled(tx: Executor, a: Pick<Attempt, "storeId" | "orderId" | "id">): Promise<boolean> {
  const [paid] = await tx.select({ id: paymentAttempt.id }).from(paymentAttempt).where(and(eq(paymentAttempt.storeId, a.storeId), eq(paymentAttempt.orderId, a.orderId), ne(paymentAttempt.id, a.id), eq(paymentAttempt.status, "paid"))).limit(1);
  if (paid) return true;
  const [manual] = await tx.select({ id: paymentManualConfirmation.id }).from(paymentManualConfirmation).where(and(eq(paymentManualConfirmation.storeId, a.storeId), eq(paymentManualConfirmation.orderId, a.orderId), ne(paymentManualConfirmation.attemptId, a.id))).limit(1);
  return !!manual;
}
/**
 * Apply one settled attempt of the store's own account to its order (the caller has locked the order and recorded the settlement): a second
 * settled attempt raises `second_settled`, a payment of a closed order raises `paid_after_close`, an order awaiting payment is paid. No ledger
 * row and no platform refund: the money went to the seller's own account (ADR-0013 section 8; refunds are the seller's, decision 26).
 */
export async function applySellerSettlement(tx: Executor, a: Pick<Attempt, "storeId" | "orderId" | "id">, orderStatus: string, note: string, actor: string): Promise<"paid" | "anomaly" | "none"> {
  let anomaly = false;
  if (await otherAttemptSettled(tx, a)) { await raiseAnomaly(tx, a, "second_settled"); anomaly = true; }
  if (QUARANTINE_ORDER_STATUSES.includes(orderStatus)) { await raiseAnomaly(tx, a, "paid_after_close"); return "anomaly"; }
  if (orderStatus === "awaiting_payment") { await applyTransition(tx, a.storeId, a.orderId, "pay", note, actor); return "paid"; }
  return anomaly ? "anomaly" : "none";
}



export type InquiryResult = { classification: AdviceClassification; applied: boolean; quarantined: boolean };

/**
 * Record one provider inquiry (Advice) result for an attempt. Only a pulled `rc 00` + `PAID` + equal amount is `paid`
 * (`classifyAdvice`); a callback body never reaches this function. The poll source is observe-only. The order is
 * locked first, then the attempt, in one transaction; `paid` is monotonic (`status <> 'paid'`), so duplicates and
 * replays settle once. A payment verified for a cancelled/returned order is marked paid for audit only and opens a
 * refund obligation: no order payment, no fulfillment, no credit.
 */
export async function recordPaymentInquiry(scope: PaymentScope, attemptId: string, raw: unknown, options: { source: "callback" | "reconcile" | "poll" | "status_check" | "recheck"; mode: "fake" | "live" }): Promise<InquiryResult> {
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
      responseSha256: createHash("sha256").update(JSON.stringify(raw) ?? "null").digest("hex"), statusWord: adviceStatusWord(raw),
    });
    const none = { classification, applied: false, quarantined: false };
    const seller = a.paymentAccountId !== null;
    if (options.source === "poll" || !(seller ? sellerSettlementEnabled(options.mode) : settlementEnabled(options.mode)) || a.status === "paid" || a.transactionId === null) return none;
    const [changed] = await tx
      .update(paymentAttempt)
      .set({ status: classification === "paid" ? "paid" : classification, ...(classification === "paid" ? { paidAt: new Date() } : {}), revision: sql`${paymentAttempt.revision} + 1` })
      .where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.id, attemptId), ne(paymentAttempt.status, "paid")))
      .returning();
    if (!changed) return none;
    await tx.insert(paymentAttemptEvent).values({ storeId: scope.storeId, attemptId, revision: changed.revision, kind: classification });
    if (classification !== "paid") return { classification, applied: true, quarantined: false };
    if (seller) {
      // T-106: the store's own account. The money is the seller's: no ledger row, no platform refund; a second settlement or a paid closed order is an anomaly.
      const outcome = await applySellerSettlement(tx, a, o.status, "Pembayaran diverifikasi lewat pemeriksaan status ke akun AutoLaris toko", PAYMENT_SYSTEM_ACTOR);
      return { classification, applied: true, quarantined: outcome === "anomaly" && QUARANTINE_ORDER_STATUSES.includes(o.status) };
    }
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
