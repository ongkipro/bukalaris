import { createHash } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { enqueue } from "../ops/jobs/jobs.ts";
import { callbackBodyShape, acceptPaymentCallback, type CallbackOutcome } from "../payments/callback.ts";
import { PaymentContractError, safeIdr } from "../payments/contract.ts";
import { CALLBACK_BODY_MAX_BYTES } from "../payments/settings.ts";
import { verifyCallbackToken } from "../payments/signature.ts";
import { resolvePaymentAttemptStore, resolveSubscriptionAttemptStore } from "../platform/resolvers.ts";
import { withStore } from "../platform/tenant.ts";
import { SUBSCRIPTION_VERIFY } from "./attempts.ts";
import { subscriptionPaymentAttempt, subscriptionPaymentCallback } from "./schema-billing.ts";
import { SUBSCRIPTION_CALLBACK_MAX_PER_ATTEMPT } from "./settings.ts";

const idOf = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");

/**
 * HTTP-17 core for a subscription attempt (app pool; the store comes from the signed reference through a definer resolver, never from the
 * body). Same contract as an order callback: a valid signed reference is only a TRIGGER; it records the digest and shape of the body (never
 * the body) and enqueues the verification job that calls the provider inquiry. It never changes an invoice, a subscription or money.
 */
export async function acceptSubscriptionCallback(exec: Executor, input: { token: string | null; rawBody: string; secret?: string }): Promise<CallbackOutcome> {
  const reffId = verifyCallbackToken(input.token, input.secret);
  if (Buffer.byteLength(input.rawBody) > CALLBACK_BODY_MAX_BYTES) throw new PaymentContractError("too_large", "callback body too large");
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.rawBody);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    throw new PaymentContractError("malformed", "callback body is not a JSON object");
  }
  const bodyReff = idOf(body.reff_id);
  const bodyTransaction = idOf(body.transaction_id) || idOf(body.trx_id);
  if (!bodyReff && !bodyTransaction) throw new PaymentContractError("identity", "callback carries no payment identity");
  const storeId = await resolveSubscriptionAttemptStore(exec, reffId);
  if (storeId === null) throw new PaymentContractError("not_found", "unknown payment reference");
  return withStore(exec, storeId, async (tx) => {
    const [a] = await tx.select().from(subscriptionPaymentAttempt).where(and(eq(subscriptionPaymentAttempt.storeId, storeId), eq(subscriptionPaymentAttempt.reffId, reffId)));
    if (!a) throw new PaymentContractError("not_found", "unknown payment reference");
    // The signed reference is bound to THIS attempt: a body (or provider transaction) of another payment is refused.
    if (bodyReff && bodyReff !== a.reffId) throw new PaymentContractError("binding", "callback body belongs to another payment");
    if (bodyTransaction && a.transactionId && bodyTransaction !== a.transactionId) throw new PaymentContractError("binding", "callback transaction does not match the payment");
    if (safeIdr(body.amount) !== a.totalIdr) throw new PaymentContractError("amount", "callback amount does not match the payment total");
    const [{ n }] = await tx.select({ n: count() }).from(subscriptionPaymentCallback).where(and(eq(subscriptionPaymentCallback.storeId, storeId), eq(subscriptionPaymentCallback.attemptId, a.id)));
    if (n >= SUBSCRIPTION_CALLBACK_MAX_PER_ATTEMPT) return { outcome: "replayed" as const, quarantined: false };
    const [row] = await tx
      .insert(subscriptionPaymentCallback)
      .values({ storeId, attemptId: a.id, bodySha256: createHash("sha256").update(input.rawBody).digest("hex"), bodyShape: callbackBodyShape(body) })
      .onConflictDoNothing({ target: [subscriptionPaymentCallback.attemptId, subscriptionPaymentCallback.bodySha256] })
      .returning({ id: subscriptionPaymentCallback.id });
    if (!row) return { outcome: "replayed" as const, quarantined: false };
    await enqueue(tx, { kind: SUBSCRIPTION_VERIFY, storeId, key: `callback:${row.id}`, payload: { attemptId: a.id } });
    return { outcome: "accepted" as const, quarantined: false };
  });
}

/**
 * The one callback entry point of the route: the signed reference decides whether it belongs to a buyer order attempt or to a subscription
 * attempt (the reference spaces cannot overlap: both are 96 random bits). An order reference is handled exactly as before; a reference nobody
 * holds is `not_found`. The order attempt is looked up first.
 */
export async function acceptAutoLarisCallback(exec: Executor, input: { token: string | null; rawBody: string; secret?: string }): Promise<CallbackOutcome> {
  const reffId = verifyCallbackToken(input.token, input.secret);
  if ((await resolvePaymentAttemptStore(exec, reffId)) !== null) return acceptPaymentCallback(exec, input);
  return acceptSubscriptionCallback(exec, input);
}
