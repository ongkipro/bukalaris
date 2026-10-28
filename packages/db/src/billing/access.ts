import { eq } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { withStore } from "../platform/tenant.ts";
import { deriveBillingState, type DerivedState } from "./period.ts";
import { effectivePlan } from "./plan.ts";
import { storeSubscription } from "./schema-billing.ts";

/**
 * The seller access policy (BILL-7, UX-18). It is a pure function of the stored subscription facts and the clock, evaluated on every
 * seller request, so a store goes read-only the instant coverage ends whether or not the billing cron has run. The cron only persists
 * the state (status, past-due and grace instants) for dashboards, dunning and the Owner console.
 *
 * Billing debt or billing suspension restricts Seller Admin writes only: the storefront and buyer checkout are untouched, no data is
 * deleted, and billing, payment and the data export stay usable. The independent operator restriction is `store.suspended_at`.
 */
export type BillingAccess = DerivedState & {
  trialEndsAt: Date;
  anchor: string;
  /** The status the cron last stored (may lag the derived `state` by one cron run). */
  storedStatus: "trial" | "active" | "past_due" | "suspended";
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  planId: number;
};

export async function billingAccess(scope: { exec: Executor; storeId: number }, now: Date = new Date()): Promise<BillingAccess> {
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const [sub] = await tx.select().from(storeSubscription).where(eq(storeSubscription.storeId, scope.storeId));
    if (!sub) throw new Error(`store ${scope.storeId} has no subscription row`); // every store gets one from the store insert trigger
    const coveredUntil = sub.currentPeriodEnd && sub.currentPeriodEnd > sub.trialEndsAt ? sub.currentPeriodEnd : sub.trialEndsAt;
    // The grace length is the plan value in force when coverage ended (or now, while still covered).
    const plan = await effectivePlan(tx, coveredUntil < now ? coveredUntil : now);
    const derived = deriveBillingState({ trialEndsAt: sub.trialEndsAt, coveredThrough: sub.currentPeriodEnd, graceDays: plan.graceDays, now });
    return { ...derived, trialEndsAt: sub.trialEndsAt, anchor: sub.billingAnchorDate, storedStatus: sub.status, currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, planId: sub.planId };
  });
}
