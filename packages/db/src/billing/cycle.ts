import { asc, eq, gt } from "drizzle-orm";
import type { Db, Executor } from "../client.ts";
import { store } from "../schema.ts";
import { withStore } from "../platform/tenant.ts";
import { TaxRefusal } from "../tax/compute.ts";
import { DomainError } from "../platform/scoped.ts";
import { queueNotice, type DunningContext } from "./dunning.ts";
import { closeLapsedInvoices, ensureSubscriptionInvoice, openInvoices } from "./invoices.ts";
import { billingControl, storeSubscription } from "./schema-billing.ts";
import { CYCLE_BATCH_SIZE, DUNNING_GRACE_ENDING_LEAD_MS, DUNNING_TRIAL_ENDING_LEAD_MS } from "./settings.ts";
import { BILLING_ACTOR, recordEvent, syncSubscriptionState } from "./state.ts";

export type CycleSummary = {
  frozen: boolean;
  stores: number;
  transitions: number;
  lapsed: number;
  invoicesCreated: number;
  notices: number;
  errors: { storeId: number; error: string }[];
};

export async function billingControls(db: Executor) {
  const [row] = await db.select().from(billingControl).where(eq(billingControl.id, 1));
  if (!row) throw new Error("billing_control row is missing");
  return row;
}

/**
 * JOB-09 (T-50): the billing-state evaluator and the invoice scheduler, on the platform pool, run by the hourly `billing.cycle` schedule (T-74). For
 * every store, in its own transactions: close elapsed unpaid invoices as `void`/`lapsed` (no back-billing), persist the derived billing state
 * (trial to past_due on the covered end, past_due to suspended on the grace end), create the invoice due now through the ONE invoice creator
 * and queue the dunning intents when dunning is switched on. Idempotent by construction: unique indexes (invoices), the unchanged-state check
 * (transitions) and unique notices (dunning), so replaying a run, or two workers running it at once, changes nothing the second time.
 * `billing_control.jobs_frozen` (the post-restore switch, RUNBOOK 14) stops the whole run before it reads a store. It never touches `store.suspended_at`.
 */
export async function runBillingCycle(db: Db, opts: { now?: Date; batch?: number } = {}): Promise<CycleSummary> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? CYCLE_BATCH_SIZE;
  const controls = await billingControls(db);
  const summary: CycleSummary = { frozen: controls.jobsFrozen, stores: 0, transitions: 0, lapsed: 0, invoicesCreated: 0, notices: 0, errors: [] };
  if (controls.jobsFrozen) return summary;
  for (let after = 0; ; ) {
    const stores = await db.select({ id: store.id, name: store.name }).from(store).where(gt(store.id, after)).orderBy(asc(store.id)).limit(batch);
    if (stores.length === 0) break;
    for (const s of stores) {
      summary.stores++;
      try {
        await tickStore(db, s.id, s.name, now, controls.dunningEnabled, summary);
      } catch (err) {
        summary.errors.push({ storeId: s.id, error: err instanceof Error ? err.message.slice(0, 200) : "error" });
      }
    }
    after = stores[stores.length - 1]!.id;
  }
  return summary;
}

async function tickStore(db: Db, storeId: number, storeName: string, now: Date, dunning: boolean, summary: CycleSummary): Promise<void> {
  const state = await withStore(db, storeId, async (tx) => {
    const lapsed = await closeLapsedInvoices(tx, storeId, now);
    for (const i of lapsed) await recordEvent(tx, { storeId, kind: "invoice_lapsed", actor: BILLING_ACTOR, invoiceId: i.id, fromStatus: "pending", toStatus: "void", detail: { periodIndex: i.periodIndex } });
    summary.lapsed += lapsed.length;
    const synced = await syncSubscriptionState(tx, storeId, now);
    if (synced.changed && synced.from !== synced.to) summary.transitions++;
    const [sub] = await tx.select().from(storeSubscription).where(eq(storeSubscription.storeId, storeId));
    return { derived: synced.derived, trialEndsAt: sub!.trialEndsAt };
  });
  try {
    const r = await ensureSubscriptionInvoice(db, { storeId, source: "cron", actor: BILLING_ACTOR, now });
    if (r.kind === "invoice" && r.created) summary.invoicesCreated++;
  } catch (err) {
    // No effective PPN policy while PPN is on: never invoice untaxed. Everything else (a lapsed explicit period) cannot come from the cron's own target.
    if (!(err instanceof TaxRefusal) && !(err instanceof DomainError)) throw err;
    summary.errors.push({ storeId, error: err instanceof TaxRefusal ? `tax:${err.code}` : err.code });
  }
  if (!dunning) return;
  const { derived, trialEndsAt } = state;
  const base: DunningContext = { storeName, trialEndsAt, pastDueAt: derived.pastDueAt, graceEndsAt: derived.graceEndsAt };
  await withStore(db, storeId, async (tx) => {
    const queue = async (kind: Parameters<typeof queueNotice>[1]["kind"], ref: string, context: DunningContext) => {
      if ((await queueNotice(tx, { storeId, kind, ref, context })) !== null) summary.notices++;
    };
    if (derived.state === "trial" && now.getTime() >= trialEndsAt.getTime() - DUNNING_TRIAL_ENDING_LEAD_MS) await queue("trial_ending", trialEndsAt.toISOString().slice(0, 10), base);
    for (const inv of await openInvoices(tx, storeId, now)) await queue("invoice_ready", inv.number, { ...base, invoice: { number: inv.number, totalIdr: inv.totalIdr, periodStart: inv.periodStart, periodEnd: inv.periodEnd } });
    if (derived.state === "past_due" || derived.state === "suspended") {
      const ref = derived.pastDueAt!.toISOString().slice(0, 10);
      await queue("past_due", ref, base);
      if (derived.state === "past_due" && derived.graceEndsAt && now.getTime() >= derived.graceEndsAt.getTime() - DUNNING_GRACE_ENDING_LEAD_MS) await queue("grace_ending", ref, base);
      if (derived.state === "suspended") await queue("suspended", ref, base);
    }
  });
}
