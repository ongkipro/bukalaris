import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type JobContext, markDispatched, registerHandler, registerPlatformHandler } from "../ops/jobs/jobs.ts";
import { registerReconciler } from "../ops/jobs/manage.ts";
import { registerSchedule } from "../ops/jobs/scheduler.ts";
import { PaymentContractError } from "../payments/contract.ts";
import { activePaymentAdapter } from "../payments/jobs.ts";
import { withStore } from "../platform/tenant.ts";
import { getAttempt, markSubscriptionCreationOutcome, recordSubscriptionInquiry, storeSubscriptionInstruction, SUBSCRIPTION_INSTRUCTION, SUBSCRIPTION_VERIFY, subscriptionCreateInput, type SubscriptionScope } from "./attempts.ts";
import { runBillingCycle } from "./cycle.ts";
import { getInvoice } from "./invoices.ts";
import { subscriptionPaymentAttempt } from "./schema-billing.ts";

// Worker side of the subscription billing (T-50): the instruction creation and the verify-by-pull settlement of a subscription attempt on the T-49
// contract (owner kind `subscription_invoice`), and the hourly billing cycle (JOB-09, enqueued by the T-74 periodic enqueuer as JOB-21). Importing this
// module registers the kinds, the reconcilers and the schedule (side effect, like payments/jobs.ts). Every provider call sits behind the T-74 dispatch fence.

export const BILLING_CYCLE = "billing.cycle";

const attemptPayload = z.object({ attemptId: z.uuid() });

/**
 * Create the payment instruction of a persisted attempt. The `reff_id` already exists (committed with the invoice and the attempt), so every retry
 * replays that same reference. The provider's own channel list is checked first. The dispatch fence is set right before the single `/submit`: a crash
 * or error after it leaves the job `unknown` and the attempt `unknown` (still the invoice's live attempt), never a second bill. A definite rejection
 * (`rc` not `00`) ends the attempt as `failed`, which frees the invoice for a new controlled attempt.
 */
registerHandler(SUBSCRIPTION_INSTRUCTION, async ({ db, providers }, j) => {
  const { attemptId } = attemptPayload.parse(j.payload);
  const scope: SubscriptionScope = { exec: db, storeId: j.storeId };
  const a = await getAttempt(scope, attemptId);
  if (!a || a.requestState === "accepted" || a.requestState === "failed" || a.status === "expired" || a.status === "paid") return;
  const invoice = await getInvoice(db, j.storeId, a.invoiceId);
  if (invoice?.status !== "pending") {
    if (a.requestState === "in_progress") await markSubscriptionCreationOutcome(scope, a, "failed"); // never reached the provider
    return;
  }
  if (!(await providers.payment.listChannels()).some((c) => c.code === a.channelCode)) {
    await markSubscriptionCreationOutcome(scope, a, "failed"); // the provider no longer offers it; nothing was created
    return;
  }
  const input = subscriptionCreateInput(a);
  await markDispatched(db, j);
  try {
    await storeSubscriptionInstruction(scope, a, await providers.payment.submit(input));
  } catch (err) {
    if (err instanceof PaymentContractError && err.code === "rejected") {
      await markSubscriptionCreationOutcome(scope, a, "failed");
      return;
    }
    await markSubscriptionCreationOutcome(scope, a, "unknown");
    throw err; // dispatched: the job becomes `unknown` and the reconciler decides
  }
});

/** `unknown` subscription.instruction: ask the adapter whether it holds the bill for the same `reff_id`; an adapter that cannot tell stays `unknown` for the Owner console. */
registerReconciler(SUBSCRIPTION_INSTRUCTION, async (db, j) => {
  if (j.storeId === null) return "done";
  const { attemptId } = attemptPayload.parse(j.payload);
  const scope: SubscriptionScope = { exec: db, storeId: j.storeId };
  const a = await getAttempt(scope, attemptId);
  if (!a || a.requestState === "accepted" || a.requestState === "failed") return "done";
  const adapter = activePaymentAdapter();
  if (!adapter.recoverCreate) return "unknown";
  try {
    const found = await adapter.recoverCreate(subscriptionCreateInput(a));
    if (!found) return "absent";
    await storeSubscriptionInstruction(scope, a, found);
    return "done";
  } catch {
    return "unknown";
  }
});

/** Verification by pull (D-21 K): the callback only enqueued this; the provider inquiry decides. */
registerHandler(SUBSCRIPTION_VERIFY, async ({ db, providers }, j) => {
  const { attemptId } = attemptPayload.parse(j.payload);
  const a = await getAttempt({ exec: db, storeId: j.storeId }, attemptId);
  if (!a || a.status === "paid") return;
  if (!a.transactionId) throw new Error("payment instruction not stored yet"); // not dispatched: retried with backoff
  await markDispatched(db, j);
  await recordSubscriptionInquiry({ exec: db, storeId: j.storeId }, a.id, await providers.payment.advice({ transactionId: a.transactionId }), { source: "callback", mode: providers.payment.mode });
});

/** An inquiry that crashed after dispatch is reconciled by pulling again, never by re-dispatching the job blindly. */
registerReconciler(SUBSCRIPTION_VERIFY, async (db, j) => {
  if (j.storeId === null) return "done";
  const { attemptId } = attemptPayload.parse(j.payload);
  const [a] = await withStore(db, j.storeId, (tx) => tx.select().from(subscriptionPaymentAttempt).where(and(eq(subscriptionPaymentAttempt.storeId, j.storeId!), eq(subscriptionPaymentAttempt.id, attemptId))));
  if (!a || a.status === "paid") return "done";
  if (!a.transactionId) return "unknown";
  const adapter = activePaymentAdapter();
  try {
    await recordSubscriptionInquiry({ exec: db, storeId: j.storeId }, a.id, await adapter.advice({ transactionId: a.transactionId }), { source: "reconcile", mode: adapter.mode });
    return "done";
  } catch {
    return "unknown";
  }
});

/** JOB-09: hourly evaluator, invoice scheduler and dunning intents. The state is derived from the stored facts, so a missed hour only delays persistence. */
registerPlatformHandler(BILLING_CYCLE, async ({ db }: JobContext) => {
  await runBillingCycle(db);
});
registerSchedule({ kind: BILLING_CYCLE, period: "hour", catchUp: 0 });
