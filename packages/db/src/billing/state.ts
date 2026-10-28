import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { deriveBillingState, jakartaMidnight, type DerivedState } from "./period.ts";
import { effectivePlan } from "./plan.ts";
import { storeSubscription, subscriptionEvent, subscriptionInvoice } from "./schema-billing.ts";
import type { Invoice } from "./invoices.ts";

export type Subscription = typeof storeSubscription.$inferSelect;
export const BILLING_ACTOR = "system:billing";

export type EventInput = { storeId: number; kind: string; actor: string; invoiceId?: string; attemptId?: string; fromStatus?: string | null; toStatus?: string | null; detail?: Record<string, unknown> };
export async function recordEvent(tx: Tx, e: EventInput): Promise<void> {
  await tx.insert(subscriptionEvent).values({ storeId: e.storeId, kind: e.kind, actor: e.actor, invoiceId: e.invoiceId ?? null, attemptId: e.attemptId ?? null, fromStatus: e.fromStatus ?? null, toStatus: e.toStatus ?? null, detail: e.detail ?? {} });
}

/** The subscription row, locked: every state transition, settlement and comp takes this lock first, so they serialise per store (DATA-10). Caller is inside `withStore`. */
export async function lockSubscription(tx: Tx, storeId: number): Promise<Subscription> {
  const [sub] = await tx.select().from(storeSubscription).where(eq(storeSubscription.storeId, storeId)).for("update");
  if (!sub) throw new Error(`store ${storeId} has no subscription row`);
  return sub;
}

/**
 * Persist the billing state derived at `now` (trial / active / past_due / suspended, with the past-due and grace instants). Idempotent: a
 * second run at the same `now` changes nothing and writes no event. Never touches `store.suspended_at`, an invoice or money.
 */
export async function syncSubscriptionState(tx: Tx, storeId: number, now: Date, actor: string = BILLING_ACTOR): Promise<{ changed: boolean; from: Subscription["status"]; to: Subscription["status"]; derived: DerivedState }> {
  const sub = await lockSubscription(tx, storeId);
  const coveredUntil = sub.currentPeriodEnd && sub.currentPeriodEnd > sub.trialEndsAt ? sub.currentPeriodEnd : sub.trialEndsAt;
  const plan = await effectivePlan(tx, coveredUntil < now ? coveredUntil : now);
  const derived = deriveBillingState({ trialEndsAt: sub.trialEndsAt, coveredThrough: sub.currentPeriodEnd, graceDays: plan.graceDays, now });
  const same = sub.status === derived.state && sub.pastDueAt?.getTime() === derived.pastDueAt?.getTime() && sub.graceEndsAt?.getTime() === derived.graceEndsAt?.getTime();
  if (same) return { changed: false, from: sub.status, to: sub.status, derived };
  await tx.update(storeSubscription).set({ status: derived.state, pastDueAt: derived.pastDueAt, graceEndsAt: derived.graceEndsAt, updatedAt: now }).where(eq(storeSubscription.storeId, storeId));
  if (sub.status !== derived.state) {
    await recordEvent(tx, { storeId, kind: "status_changed", actor, fromStatus: sub.status, toStatus: derived.state, detail: { pastDueAt: derived.pastDueAt?.toISOString() ?? null, graceEndsAt: derived.graceEndsAt?.toISOString() ?? null } });
  }
  return { changed: true, from: sub.status, to: derived.state, derived };
}

/**
 * Apply an invoice's entitlement ONCE: mark the invoice covered, extend the covered end to the invoice's stored period end (never back-dated,
 * never shortened) and re-derive the state (`active` while the covered end is in the future). Exactly-once is enforced three ways: the
 * `coverage_applied_at IS NULL` condition of the update, the unique `coverage_applied` event per invoice, and the immutability trigger of the invoice.
 * The caller holds the subscription lock (`lockSubscription`). A manual bookkeeping mark-paid never calls this.
 */
export async function applyCoverage(tx: Tx, a: { storeId: number; invoice: Invoice; source: "provider" | "comp"; ref: string; actor: string; now: Date }): Promise<{ applied: boolean }> {
  const { invoice } = a;
  const paying = invoice.status === "pending";
  const [row] = await tx
    .update(subscriptionInvoice)
    .set({ coverageAppliedAt: a.now, ...(paying ? { status: "paid" as const, paidAt: a.now, settlementSource: a.source, settlementRef: a.ref, settledBy: a.actor } : {}) })
    .where(and(eq(subscriptionInvoice.storeId, a.storeId), eq(subscriptionInvoice.id, invoice.id), isNull(subscriptionInvoice.coverageAppliedAt), sql`${subscriptionInvoice.status} <> 'void'`))
    .returning();
  if (!row) return { applied: false };
  const start = jakartaMidnight(row.periodStart);
  const end = jakartaMidnight(row.periodEnd);
  await recordEvent(tx, { storeId: a.storeId, kind: "coverage_applied", actor: a.actor, invoiceId: row.id, detail: { periodIndex: row.periodIndex, periodEnd: row.periodEnd, source: a.source, ref: a.ref } });
  const sub = await lockSubscription(tx, a.storeId);
  if (!sub.currentPeriodEnd || end > sub.currentPeriodEnd) {
    await tx.update(storeSubscription).set({ currentPeriodStart: start, currentPeriodEnd: end, updatedAt: a.now }).where(eq(storeSubscription.storeId, a.storeId));
  }
  await syncSubscriptionState(tx, a.storeId, a.now, a.actor);
  return { applied: true };
}
