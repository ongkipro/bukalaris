import { and, desc, eq, lte } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { subscriptionPlan } from "./schema-billing.ts";
import { PLAN_CODE } from "./settings.ts";

export type Plan = typeof subscriptionPlan.$inferSelect;

/** The plan/config version in force at `at` (the latest version whose `effective_from` has passed). The seed row is in force for every instant. */
export async function effectivePlan(exec: Executor, at: Date): Promise<Plan> {
  const [row] = await exec
    .select()
    .from(subscriptionPlan)
    .where(and(eq(subscriptionPlan.planCode, PLAN_CODE), lte(subscriptionPlan.effectiveFrom, at)))
    .orderBy(desc(subscriptionPlan.effectiveFrom))
    .limit(1);
  if (!row) throw new Error("no subscription plan is in force");
  return row;
}
