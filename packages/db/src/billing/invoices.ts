import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { Executor, Tx } from "../client.ts";
import { DomainError } from "../platform/scoped.ts";
import { withStore } from "../platform/tenant.ts";
import { jakartaDate, jakartaMidnight, periodBounds, targetPeriodIndex } from "./period.ts";
import { effectivePlan } from "./plan.ts";
import { storeSubscription, subscriptionInvoice } from "./schema-billing.ts";
import { INVOICE_LEAD_MS } from "./settings.ts";
import { vatSnapshot } from "./vat.ts";

export type Invoice = typeof subscriptionInvoice.$inferSelect;
export type InvoiceSource = "cron" | "seller" | "operator";

/** `SUB-<ts9><hex3>`: nine base-36 characters of the millisecond clock and three hex characters of entropy, so two stores in one millisecond differ. */
export function newReference(at: Date = new Date()): string {
  return `SUB-${at.getTime().toString(36).toUpperCase().padStart(9, "0")}${randomBytes(2).toString("hex").slice(0, 3).toUpperCase()}`;
}

export type EnsureInvoiceInput = {
  storeId: number;
  source: InvoiceSource;
  /** `system:billing` for the cron, the seller's user id or the operator's user id: stored on the invoice and its creation event. */
  actor: string;
  /** Explicit period (Owner console manual-create); default is the period due at `now` (cron, seller Pay). */
  periodIndex?: number;
  now?: Date;
};
export type EnsureInvoiceResult = { kind: "invoice"; invoice: Invoice; created: boolean } | { kind: "covered" } | { kind: "not_due" };

const MAX_REFERENCE_TRIES = 5;

/**
 * THE invoice creator. The cron, the seller Pay action and the Owner console manual-create all come through here for one
 * billing period, and concurrent calls (any mix of the three, any number) return the same invoice id and the same payment
 * reference: the insert is one `INSERT ... ON CONFLICT DO NOTHING` whose uniqueness is the partial unique indexes of
 * `subscription_invoice` (one non-void invoice per `(store, period_index)`, per `(store, period dates)`, one pending per period), so
 * there is no check-then-insert and no application lock to get wrong. A call that loses the race reads the winner's committed row.
 * A collision of the reference alone (12 bits of entropy per millisecond) leaves no row to read and retries with a new reference.
 *
 * The period, the plan snapshot (DPP) and the PPN snapshot are computed here and checked again by the `subscription_invoice_guard`
 * trigger. A period whose end has passed is never invoiced (OPEN-B1, D-20: no back-billing).
 * `exec` may be the app pool (seller Pay) or the platform pool (cron, Owner console); the store context is set here.
 */
export async function ensureSubscriptionInvoice(exec: Executor, input: EnsureInvoiceInput): Promise<EnsureInvoiceResult> {
  const now = input.now ?? new Date();
  return withStore(exec, input.storeId, async (tx) => {
    const [sub] = await tx.select().from(storeSubscription).where(eq(storeSubscription.storeId, input.storeId));
    if (!sub) throw new DomainError("not_found", "Langganan toko tidak ditemukan.");
    const due = targetPeriodIndex(sub.billingAnchorDate, now, INVOICE_LEAD_MS);
    const index = input.periodIndex ?? due;
    if (index === null) return { kind: "not_due" as const };
    if (!Number.isInteger(index) || index < 0) throw new DomainError("invalid_period", "Periode tidak valid.");
    // Wave 3 review: an explicit period is bounded by what is due now (plus the invoice lead). Period 0 may be paid early. Without this
    // bound one operator-created invoice for period 24 paid at the normal monthly price moved coverage two years ahead (a comp without four-eyes).
    if (input.periodIndex !== undefined && index > 0 && (due === null || index > due)) throw new DomainError("period_not_due", "Periode ini belum waktunya ditagih.");
    const { start, end } = periodBounds(sub.billingAnchorDate, index);
    if (jakartaMidnight(end) <= now) throw new DomainError("period_lapsed", "Periode ini sudah lewat dan tidak ditagih mundur.");
    // Coverage already reaches the end of this period: nothing to bill (paid early, comp, or a later period was paid).
    if (sub.currentPeriodEnd && sub.currentPeriodEnd >= jakartaMidnight(end)) return { kind: "covered" as const };
    const [{ now: dbNowText }] = (await tx.execute(sql`select now()::text as now`)) as unknown as { now: string }[];
    const dbNow = new Date(dbNowText!);
    const plan = await effectivePlan(tx, dbNow);
    const vat = plan.ppnEnabled ? await vatSnapshot(tx, plan.monthlyDppIdr, dbNow) : null; // throws TaxRefusal without an effective policy: never an untaxed or guessed invoice
    for (let tries = 0; tries < MAX_REFERENCE_TRIES; tries++) {
      const [row] = await tx
        .insert(subscriptionInvoice)
        .values({
          storeId: input.storeId, number: newReference(now), periodIndex: index, periodStart: start, periodEnd: end, kind: "subscription", status: "pending", planId: plan.id,
          dppIdr: plan.monthlyDppIdr, ppnEnabled: vat !== null, ppnRateBps: vat?.rateBps ?? null, taxPolicyVersionId: vat?.taxPolicyVersionId ?? null,
          taxTypeCode: vat ? "vat_output" : null, taxCategoryCode: vat ? "subscription" : null, ppnIdr: vat?.ppnIdr ?? 0, totalIdr: plan.monthlyDppIdr + (vat?.ppnIdr ?? 0),
          dueAt: jakartaMidnight(start), source: input.source, createdBy: input.actor,
        })
        .onConflictDoNothing()
        .returning();
      if (row) return { kind: "invoice" as const, invoice: row, created: true };
      // Conflict: the period already has its invoice (committed by the winner). A conflict on `number` alone finds no row and loops with a new reference.
      const [existing] = await tx
        .select()
        .from(subscriptionInvoice)
        .where(and(eq(subscriptionInvoice.storeId, input.storeId), eq(subscriptionInvoice.periodIndex, index), eq(subscriptionInvoice.kind, "subscription"), ne(subscriptionInvoice.status, "void")));
      if (existing) return { kind: "invoice" as const, invoice: existing, created: false };
    }
    throw new Error("could not allocate an invoice reference");
  });
}

/** Pending, not-yet-lapsed subscription invoices of a store, oldest period first (periods are paid oldest first). */
export async function openInvoices(tx: Executor, storeId: number, now: Date): Promise<Invoice[]> {
  const rows = await tx
    .select()
    .from(subscriptionInvoice)
    .where(and(eq(subscriptionInvoice.storeId, storeId), eq(subscriptionInvoice.kind, "subscription"), eq(subscriptionInvoice.status, "pending")))
    .orderBy(asc(subscriptionInvoice.periodIndex));
  return rows.filter((i) => jakartaMidnight(i.periodEnd) > now);
}

/**
 * Close every unpaid invoice whose period already ended: `void`, reason `lapsed`. Nothing is back-billed; billing resumes at the first period
 * whose end is in the future and the anchor is kept (OPEN-B1, D-20).
 */
export async function closeLapsedInvoices(tx: Tx, storeId: number, now: Date): Promise<Invoice[]> {
  const rows = await tx
    .update(subscriptionInvoice)
    .set({ status: "void", voidedAt: now, voidReason: "lapsed" })
    .where(and(eq(subscriptionInvoice.storeId, storeId), eq(subscriptionInvoice.kind, "subscription"), eq(subscriptionInvoice.status, "pending"), sql`${subscriptionInvoice.periodEnd} <= ${jakartaDate(now)}::date`))
    .returning();
  return rows;
}

export async function listInvoices(exec: Executor, storeId: number, opts: { status?: Invoice["status"]; limit?: number } = {}): Promise<Invoice[]> {
  return withStore(exec, storeId, (tx) =>
    tx
      .select()
      .from(subscriptionInvoice)
      .where(and(eq(subscriptionInvoice.storeId, storeId), ...(opts.status ? [eq(subscriptionInvoice.status, opts.status)] : [])))
      .orderBy(desc(subscriptionInvoice.periodIndex), desc(subscriptionInvoice.createdAt))
      .limit(Math.min(opts.limit ?? 100, 200)),
  );
}

/** One invoice of this store, or null: another store's id is invisible under RLS and filtered again here. */
export async function getInvoice(exec: Executor, storeId: number, invoiceId: string): Promise<Invoice | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(invoiceId)) return null;
  return withStore(exec, storeId, async (tx) => (await tx.select().from(subscriptionInvoice).where(and(eq(subscriptionInvoice.storeId, storeId), eq(subscriptionInvoice.id, invoiceId))))[0] ?? null);
}
