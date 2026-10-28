import { eq, sql } from "drizzle-orm";
import { beforeEach } from "vitest";
import { storeSubscription, subscriptionInvoice, subscriptionPaymentAttempt } from "../src/billing/schema-billing.ts";
import { sellerContext, type OperatorScope, type SellerScope } from "../src/platform/scoped.ts";
import { taxPolicyVersion } from "../src/tax/schema-tax.ts";
import { jakartaDate } from "../src/billing/period.ts";
import { setPaymentAdapter } from "../src/payments/jobs.ts";
import { FakeAutoLaris } from "../src/payments/fake.ts";
import { fakeProviders, type Providers } from "../src/payments/providers.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { grantAsSystem } from "../src/ops/capabilities-grants.ts";
import { requestApproval, decideApproval } from "../src/ops/capabilities-approvals.ts";
import { operatorScope } from "../src/platform/scoped.ts";
import { platformOperator } from "../src/schema.ts";
import type { PlatformCapability } from "../src/ops/schema-ops.ts";
import { admin, db, makeStore, makeUser, platform } from "./helpers.ts";
import "../src/billing/jobs.ts";

// Shared fixtures of the T-50 tests. Everything is a fixture: a rate below is an arbitrary test value, never a statutory one.

/** The plan table is append-only, so tests reset it by truncation (which bypasses row triggers) and re-seed version 1 exactly as the migration does. */
export async function resetBilling() {
  await admin.execute(sql`truncate subscription_plan, subscription_notice, tax_policy_version, mail_outbox, job restart identity cascade`);
  await admin.execute(sql`update billing_control set jobs_frozen = false, dunning_enabled = false`);
  await admin.execute(sql`insert into subscription_plan (plan_code, version, effective_from, monthly_dpp_idr, trial_days, grace_days, ppn_enabled, reason, created_by) values ('all_feature', 1, '2000-01-01 00:00:00+07', 175000, 3, 3, false, 'fixture seed', 'system:test')`);
}
/** Registers the reset for every test of the calling file. */
export function billingTestSetup() {
  beforeEach(async () => {
    await resetBilling();
    setPaymentAdapter(null);
  });
}

export const providersOf = (p: FakeAutoLaris): Providers => ({ ...fakeProviders, payment: p });

/** Run the worker until it has nothing due. */
export async function drain(p: FakeAutoLaris, workerId = "t50") {
  const all = [];
  for (let i = 0; i < 6; i++) {
    const out = await runOnce(platform, { workerId, providers: providersOf(p) });
    if (out.length === 0) break;
    all.push(...out);
  }
  return all;
}

export type BillingStore = Awaited<ReturnType<typeof makeStore>> & { sellerAt: (now?: Date) => Promise<SellerScope> };
export async function billingStore(slug: string): Promise<BillingStore> {
  const s = await makeStore(slug);
  return { ...s, sellerAt: (now?: Date) => sellerAs(s.ownerId, s.storeId, now) };
}
export async function sellerAs(userId: string, storeId: number, now?: Date): Promise<SellerScope> {
  const ctx = await sellerContext(db, userId, storeId, now);
  if (!ctx.ok) throw new Error(`no seller scope: ${ctx.reason}`);
  return ctx.scope;
}
export const subscriptionOf = async (storeId: number) => (await platform.select().from(storeSubscription).where(eq(storeSubscription.storeId, storeId)))[0]!;
export const invoicesOf = (storeId: number) => platform.select().from(subscriptionInvoice).where(eq(subscriptionInvoice.storeId, storeId)).orderBy(subscriptionInvoice.periodIndex, subscriptionInvoice.createdAt);
export const attemptsOf = (invoiceId: string) => platform.select().from(subscriptionPaymentAttempt).where(eq(subscriptionPaymentAttempt.invoiceId, invoiceId)).orderBy(subscriptionPaymentAttempt.createdAt);
export const eventsOf = async (storeId: number, kind?: string) =>
  ((await platform.execute(sql`select * from subscription_event where store_id = ${storeId} ${kind ? sql`and kind = ${kind}` : sql``} order by id`)) as unknown as Record<string, unknown>[]);

/**
 * Superuser time travel on a subscription: move the trial end (and the immutable anchor with it) and/or the covered period end. The guard trigger that
 * makes those columns write-once is the thing under test elsewhere, so it is lifted only here, around this one update.
 */
export async function setSubscription(storeId: number, patch: { trialEndsAt?: Date; currentPeriodStart?: Date | null; currentPeriodEnd?: Date | null; status?: string; pastDueAt?: Date | null; graceEndsAt?: Date | null }) {
  await admin.execute(sql`alter table store_subscription disable trigger store_subscription_guard`);
  try {
    const sets = [
      patch.trialEndsAt ? sql`trial_ends_at = ${patch.trialEndsAt.toISOString()}::timestamptz, billing_anchor_date = ((${patch.trialEndsAt.toISOString()}::timestamptz) at time zone 'Asia/Jakarta')::date` : null,
      patch.currentPeriodStart !== undefined ? sql`current_period_start = ${patch.currentPeriodStart?.toISOString() ?? null}::timestamptz` : null,
      patch.currentPeriodEnd !== undefined ? sql`current_period_end = ${patch.currentPeriodEnd?.toISOString() ?? null}::timestamptz` : null,
      patch.status ? sql`status = ${patch.status}` : null,
      patch.pastDueAt !== undefined ? sql`past_due_at = ${patch.pastDueAt?.toISOString() ?? null}::timestamptz` : null,
      patch.graceEndsAt !== undefined ? sql`grace_ends_at = ${patch.graceEndsAt?.toISOString() ?? null}::timestamptz` : null,
    ].filter((x): x is NonNullable<typeof x> => x !== null);
    await admin.execute(sql`update store_subscription set ${sql.join(sets, sql`, `)} where store_id = ${storeId}`);
  } finally {
    await admin.execute(sql`alter table store_subscription enable trigger store_subscription_guard`);
  }
}

/** A confirmed flat `vat_output` / `subscription` policy effective from the start of Jakarta today (draft -> submitted -> confirmed, the only way a version is confirmed). */
export async function confirmedVat(over: Partial<typeof taxPolicyVersion.$inferInsert> & { rateBps?: number } = {}) {
  const { rateBps = 1234, ...rest } = over; // an arbitrary fixture rate
  const [draft] = await platform
    .insert(taxPolicyVersion)
    .values({
      taxTypeCode: "vat_output", categoryCode: "subscription", version: 1, effectiveFrom: jakartaDate(new Date()), taxLabel: "fixture", sourceCitation: "fixture", baseFractionBps: 10_000, rateMethod: "per_payment",
      brackets: [{ up_to_idr: null, rate_bps: rateBps }], rounding: "half_up", recognitionEvent: "invoice_created", depositDueDay: null, reportDueDay: null, identityKindsAccepted: ["npwp"], authoredBy: "author", ...rest,
    })
    .returning();
  await platform.update(taxPolicyVersion).set({ status: "submitted" }).where(eq(taxPolicyVersion.id, draft!.id));
  const [row] = await platform
    .update(taxPolicyVersion)
    .set({ status: "confirmed", confirmedBy: "approver", confirmedAt: new Date(), confirmationBasis: "owner_decision" })
    .where(eq(taxPolicyVersion.id, draft!.id))
    .returning();
  return row!;
}

/** An operator who holds exactly these capabilities. */
export async function operatorWith(...caps: PlatformCapability[]): Promise<OperatorScope> {
  const id = await makeUser("op");
  await platform.insert(platformOperator).values({ userId: id });
  if (caps.length) await grantAsSystem(platform, { userId: id, capabilities: caps, source: "system_bootstrap", reason: "test fixture" });
  return (await operatorScope(platform, id))!;
}

/** requester asks, a second operator approves; returns the approval id the requester then executes with. */
export async function approved(requester: OperatorScope, approver: OperatorScope, request: { actionKey: string; targetKind: string; targetId: string; payload: unknown; reason?: string }): Promise<number> {
  const { id } = await requestApproval(requester, { reason: "fixture request", ...request });
  await decideApproval(approver, id, "approve");
  return id;
}

export const today = () => jakartaDate(new Date());
