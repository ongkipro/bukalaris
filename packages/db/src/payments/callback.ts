import { createHash } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { enqueue } from "../ops/jobs/jobs.ts";
import { order } from "../schema.ts";
import { resolvePaymentAttemptStore } from "../platform/resolvers.ts";
import { withStore } from "../platform/tenant.ts";
import { PAYMENT_VERIFY, QUARANTINE_ORDER_STATUSES } from "./attempts.ts";
import { PaymentContractError, safeIdr } from "./contract.ts";
import { paymentAttempt, paymentCallback } from "./schema-payments.ts";
import { CALLBACK_BODY_MAX_BYTES, CALLBACK_MAX_PER_ATTEMPT } from "./settings.ts";
import { verifyCallbackToken } from "./signature.ts";

export type CallbackOutcome = { outcome: "accepted" | "replayed"; quarantined: boolean };

/** Sorted keys with value types and string lengths, never values: safe to log when a callback is refused. */
export function callbackBodyShape(body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { _: typeof body };
  return Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, typeof v === "string" ? `string(${v.length})` : Array.isArray(v) ? "array" : v === null ? "null" : typeof v]));
}
const idOf = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");

/**
 * HTTP-17 core (runs on the APP pool: the store comes from the signed reference through a definer resolver, never from
 * the body). A valid signed reference is only a trigger: this records the body digest and enqueues the verification job
 * that calls the provider inquiry. It never changes a payment, an order or money. Replays (same body for the attempt)
 * are no-ops; a callback for a cancelled/returned order is recorded as quarantined (the verification then opens the refund
 * obligation instead of settling). `secret` overrides the environment for tests; no secret means fail closed.
 */
export async function acceptPaymentCallback(exec: Executor, input: { token: string | null; rawBody: string; secret?: string }): Promise<CallbackOutcome> {
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
  const storeId = await resolvePaymentAttemptStore(exec, reffId);
  if (storeId === null) throw new PaymentContractError("not_found", "unknown payment reference");
  return withStore(exec, storeId, async (tx) => {
    const [a] = await tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, storeId), eq(paymentAttempt.reffId, reffId)));
    if (!a) throw new PaymentContractError("not_found", "unknown payment reference");
    // The signed reference is bound to THIS attempt: a body (or provider transaction) of another payment is refused.
    if (bodyReff && bodyReff !== a.reffId) throw new PaymentContractError("binding", "callback body belongs to another payment");
    if (bodyTransaction && a.transactionId && bodyTransaction !== a.transactionId) throw new PaymentContractError("binding", "callback transaction does not match the payment");
    if (safeIdr(body.amount) !== a.totalIdr) throw new PaymentContractError("amount", `callback amount does not match the payment total; shape ${JSON.stringify(callbackBodyShape(body))}`);
    const [o] = await tx.select({ status: order.status }).from(order).where(and(eq(order.storeId, storeId), eq(order.id, a.orderId)));
    const quarantined = o !== undefined && QUARANTINE_ORDER_STATUSES.includes(o.status);
    const [{ n }] = await tx.select({ n: count() }).from(paymentCallback).where(and(eq(paymentCallback.storeId, storeId), eq(paymentCallback.attemptId, a.id)));
    if (n >= CALLBACK_MAX_PER_ATTEMPT) return { outcome: "replayed" as const, quarantined }; // flood guard: no more evidence rows or inquiries for this attempt
    const [row] = await tx
      .insert(paymentCallback)
      .values({ storeId, attemptId: a.id, bodySha256: createHash("sha256").update(input.rawBody).digest("hex"), rawBody: input.rawBody, bodyShape: callbackBodyShape(body), quarantined: quarantined ? "terminal_order" : null })
      .onConflictDoNothing({ target: [paymentCallback.attemptId, paymentCallback.bodySha256] })
      .returning({ id: paymentCallback.id });
    if (!row) return { outcome: "replayed" as const, quarantined };
    await enqueue(tx, { kind: PAYMENT_VERIFY, storeId, key: `callback:${row.id}`, payload: { attemptId: a.id } });
    return { outcome: "accepted" as const, quarantined };
  });
}
