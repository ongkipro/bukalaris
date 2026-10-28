import { and, asc, eq, gt, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../client.ts";
import { type JobContext, markDispatched, registerHandler, registerPlatformHandler } from "../ops/jobs/jobs.ts";
import { registerReconciler } from "../ops/jobs/manage.ts";
import { registerSchedule } from "../ops/jobs/scheduler.ts";
import { order } from "../schema.ts";
import { withStore } from "../platform/tenant.ts";
import { getOrderAttempt, markCreationOutcome, paymentCreateInput, PAYMENT_ADVICE_POLL, PAYMENT_INSTRUCTION, PAYMENT_VERIFY, recordPaymentInquiry, redactPaymentCallbacks, storeInstruction, type PaymentScope } from "./attempts.ts";
import { PaymentContractError } from "./contract.ts";
import { fakeAutoLaris } from "./fake.ts";
import type { PaymentAdapter } from "./providers.ts";
import { paymentAttempt } from "./schema-payments.ts";
import { ADVICE_BATCH_SIZE, ADVICE_INTERVAL_MS, ADVICE_MAX_POLLS, REDACT_BATCH_SIZE } from "./settings.ts";

// Worker side of the AutoLaris contract (T-49): instruction creation, verify-by-pull, the advice observation poll
// (JOB-25) and the callback-body redaction sweep. Importing this module registers the kinds, the reconcilers and the
// schedules (side effect, like notify.ts and fulfillment.ts); the web app imports it through checkout.ts so the enqueuing
// process knows the kind policies. Every provider call sits behind the T-74 dispatch fence.

export const PAYMENT_CALLBACK_REDACT = "payment.callback_redact";

let override: PaymentAdapter | null = null;
/** The adapter the reconcilers pull from (they run without a job context). Tests inject theirs; production uses the one `Providers` carries. */
export const setPaymentAdapter = (adapter: PaymentAdapter | null): void => {
  override = adapter;
};
export const activePaymentAdapter = (): PaymentAdapter => override ?? fakeAutoLaris;

const instructionPayload = z.object({ orderId: z.number().int().positive() });
const verifyPayload = z.object({ attemptId: z.uuid() });

/**
 * Create the payment instruction for a persisted attempt. The `reff_id` already exists (checkout transaction), so every
 * retry replays the same one. Channels are checked against the provider's own list first. The dispatch fence is set
 * right before the single `/submit` call: a crash or error after it leaves the job `unknown`, never a second bill.
 * A definite provider rejection (`rc` not `00`) ends the attempt as `failed`; everything else is an unknown outcome.
 */
registerHandler(PAYMENT_INSTRUCTION, async ({ db, providers }, j) => {
  const { orderId } = instructionPayload.parse(j.payload);
  const scope: PaymentScope = { exec: db, storeId: j.storeId };
  const a = await getOrderAttempt(scope, orderId);
  if (!a || a.requestState === "accepted" || a.requestState === "failed") return;
  const [o] = await withStore(db, j.storeId, (tx) => tx.select({ status: order.status }).from(order).where(and(eq(order.storeId, j.storeId), eq(order.id, orderId))));
  if (o?.status !== "awaiting_payment") {
    if (a.requestState === "in_progress") await markCreationOutcome(scope, a, "failed"); // never reached the provider
    return;
  }
  if (!(await providers.payment.listChannels()).some((c) => c.code === a.channelCode)) {
    await markCreationOutcome(scope, a, "failed"); // the provider no longer offers it; nothing was created
    return;
  }
  const input = paymentCreateInput(a);
  await markDispatched(db, j);
  try {
    await storeInstruction(scope, a, await providers.payment.submit(input));
  } catch (err) {
    if (err instanceof PaymentContractError && err.code === "rejected") {
      await markCreationOutcome(scope, a, "failed");
      return;
    }
    await markCreationOutcome(scope, a, "unknown");
    throw err; // dispatched: the job becomes `unknown` and the reconciler decides
  }
});

/**
 * `unknown` payment.instruction: ask the adapter whether it holds the bill for the same `reff_id`. A found bill is stored and
 * the job is done; a provider that knows nothing is `absent` (the job may run again with the same `reff_id`); an adapter
 * that cannot tell (no recovery call exists on a live account) stays `unknown` for manual recovery.
 */
registerReconciler(PAYMENT_INSTRUCTION, async (db, j) => {
  if (j.storeId === null) return "done";
  const { orderId } = instructionPayload.parse(j.payload);
  const scope: PaymentScope = { exec: db, storeId: j.storeId };
  const a = await getOrderAttempt(scope, orderId);
  if (!a || a.requestState === "accepted" || a.requestState === "failed") return "done";
  const adapter = activePaymentAdapter();
  if (!adapter.recoverCreate) return "unknown";
  try {
    const found = await adapter.recoverCreate(paymentCreateInput(a));
    if (!found) return "absent";
    await storeInstruction(scope, a, found);
    return "done";
  } catch {
    return "unknown";
  }
});

/** Verification by pull (D-21 K): the callback only enqueued this; the provider inquiry decides. */
registerHandler(PAYMENT_VERIFY, async ({ db, providers }, j) => {
  const { attemptId } = verifyPayload.parse(j.payload);
  const scope: PaymentScope = { exec: db, storeId: j.storeId };
  const [a] = await withStore(db, j.storeId, (tx) => tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, j.storeId), eq(paymentAttempt.id, attemptId))));
  if (!a || a.status === "paid") return;
  if (!a.transactionId) throw new Error("payment instruction not stored yet"); // not dispatched: retried with backoff
  await markDispatched(db, j);
  await recordPaymentInquiry(scope, a.id, await providers.payment.advice({ transactionId: a.transactionId }), { source: "callback", mode: providers.payment.mode });
});

/** An inquiry that crashed after dispatch is reconciled by pulling again, never by re-dispatching the job blindly. */
registerReconciler(PAYMENT_VERIFY, async (db, j) => {
  if (j.storeId === null) return "done";
  const { attemptId } = verifyPayload.parse(j.payload);
  const [a] = await withStore(db, j.storeId, (tx) => tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, j.storeId!), eq(paymentAttempt.id, attemptId))));
  if (!a || a.status === "paid") return "done";
  if (!a.transactionId) return "unknown";
  const adapter = activePaymentAdapter();
  try {
    await recordPaymentInquiry({ exec: db, storeId: j.storeId }, a.id, await adapter.advice({ transactionId: a.transactionId }), { source: "reconcile", mode: adapter.mode });
    return "done";
  } catch {
    return "unknown";
  }
});

/**
 * JOB-25: bounded, observe-only poll of the provider inquiry for open attempts (`ADVICE_MAX_POLLS` regular polls every
 * `ADVICE_INTERVAL_MS`, plus one final poll after expiry). It records the classified response and never changes a payment,
 * an order or money. Returns the number of attempts polled.
 */
export async function pollAdvice(db: Db, adapter: PaymentAdapter): Promise<number> {
  const due = await db
    .select({ id: paymentAttempt.id, storeId: paymentAttempt.storeId, transactionId: paymentAttempt.transactionId })
    .from(paymentAttempt)
    .where(
      and(
        eq(paymentAttempt.requestState, "accepted"), ne(paymentAttempt.status, "paid"), isNotNull(paymentAttempt.transactionId),
        or(
          and(sql`${paymentAttempt.advicePolls} < ${ADVICE_MAX_POLLS}`, lte(paymentAttempt.nextAdviceAt, sql`now()`), gt(paymentAttempt.expiresAt, sql`now()`)),
          and(lte(paymentAttempt.expiresAt, sql`now()`), sql`${paymentAttempt.finalAdviceAt} is null`),
        ),
      ),
    )
    .orderBy(asc(paymentAttempt.nextAdviceAt), asc(paymentAttempt.id))
    .limit(ADVICE_BATCH_SIZE);
  for (const a of due) {
    let raw: unknown;
    try {
      raw = await adapter.advice({ transactionId: a.transactionId! });
    } catch {
      raw = { rc: "error" }; // an unreachable provider is an unknown observation; the poll stays bounded either way
    }
    await recordPaymentInquiry({ exec: db, storeId: a.storeId }, a.id, raw, { source: "poll", mode: adapter.mode });
    await withStore(db, a.storeId, (tx) =>
      tx
        .update(paymentAttempt)
        .set({
          advicePolls: sql`${paymentAttempt.advicePolls} + 1`,
          nextAdviceAt: sql`now() + ${ADVICE_INTERVAL_MS} * interval '1 millisecond'`,
          finalAdviceAt: sql`case when ${paymentAttempt.expiresAt} <= now() then now() else ${paymentAttempt.finalAdviceAt} end`,
        })
        .where(and(eq(paymentAttempt.storeId, a.storeId), eq(paymentAttempt.id, a.id))),
    );
  }
  return due.length;
}

registerPlatformHandler(PAYMENT_ADVICE_POLL, async ({ db, providers }: JobContext) => {
  await pollAdvice(db, providers.payment);
});
registerSchedule({ kind: PAYMENT_ADVICE_POLL, period: "minute", catchUp: 0 });

/** Daily: blank the raw callback bodies older than the owner-set period (OFF until a period is set); digests stay. */
registerPlatformHandler(PAYMENT_CALLBACK_REDACT, async ({ db }: JobContext) => {
  while ((await redactPaymentCallbacks(db)) === REDACT_BATCH_SIZE);
});
registerSchedule({ kind: PAYMENT_CALLBACK_REDACT, period: "day", catchUp: 0 });
