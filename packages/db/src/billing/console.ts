import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { consumeApproval, payloadHash, requestApproval } from "../ops/capabilities-approvals.ts";
import { requirePlatformCap } from "../ops/capabilities.ts";
import { consoleMutation } from "../ops/console.ts";
import type { FourEyesAction } from "../ops/schema-ops.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { store } from "../schema.ts";
import { withStore } from "../platform/tenant.ts";
import { resolveTaxPolicy, TaxRefusal } from "../tax/compute.ts";
import { failUnknownAttempt, type SubscriptionAttempt } from "./attempts.ts";
import { billingControls } from "./cycle.ts";
import { ensureSubscriptionInvoice, getInvoice, newReference, type Invoice } from "./invoices.ts";
import { jakartaDate, jakartaMidnight, periodBounds } from "./period.ts";
import { effectivePlan, type Plan } from "./plan.ts";
import { billingControl, storeSubscription, subscriptionEvent, subscriptionInvoice, subscriptionPaymentAttempt, subscriptionPlan } from "./schema-billing.ts";
import { PLAN_CODE, GRACE_DAYS_MAX, TRIAL_DAYS_MAX } from "./settings.ts";
import { applyCoverage, lockSubscription, recordEvent } from "./state.ts";
import { effectiveVatPolicies } from "./vat.ts";
import { billingAccess } from "./access.ts";

// Owner console billing services (SA-09, SA-10, UX-17, T-50). Every function takes the OperatorScope and checks its capability first
// (`billing.read` to read, `billing.manage` to change, `tax.manage` for the PPN switch, IAM-15). The sensitive actions are four-eyes (T-60):
// comp, mark-paid and a price change need an approved request for exactly that payload, consumed in the mutation's own transaction.

const note = z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500);

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function billingOverview(op: OperatorScope, opts: { after?: number | undefined; limit?: number | undefined } = {}) {
  await requirePlatformCap(op, "billing.read");
  const now = new Date();
  const limit = Math.min(opts.limit ?? 50, 200);
  const [subs, plans, controls] = await Promise.all([
    op.exec
      .select({ storeId: storeSubscription.storeId, name: store.name, slug: store.slug, storeStatus: store.status, suspendedAt: store.suspendedAt, status: storeSubscription.status, trialEndsAt: storeSubscription.trialEndsAt, currentPeriodEnd: storeSubscription.currentPeriodEnd, anchor: storeSubscription.billingAnchorDate })
      .from(storeSubscription)
      .innerJoin(store, eq(store.id, storeSubscription.storeId))
      .where(opts.after ? gt(storeSubscription.storeId, opts.after) : undefined)
      .orderBy(asc(storeSubscription.storeId))
      .limit(limit),
    op.exec.select().from(subscriptionPlan).orderBy(desc(subscriptionPlan.version)),
    billingControls(op.exec),
  ]);
  const access = await Promise.all(subs.map((s) => billingAccess({ exec: op.exec, storeId: s.storeId }, now)));
  const rows = subs.map((s, i) => ({ ...s, derivedState: access[i]!.state, writable: access[i]!.writable, coveredUntil: access[i]!.coveredUntil, graceEndsAt: access[i]!.graceEndsAt }));
  return { asOf: now, rows, nextAfter: subs.length === limit ? subs[subs.length - 1]!.storeId : null, plans, plan: plans[0]!, controls };
}

export type InvoiceDetail = { invoice: Invoice; store: { name: string; slug: string }; attempts: SubscriptionAttempt[]; events: (typeof subscriptionEvent.$inferSelect)[] };
export async function billingInvoiceDetail(op: OperatorScope, invoiceId: string): Promise<InvoiceDetail> {
  await requirePlatformCap(op, "billing.read");
  if (!z.uuid().safeParse(invoiceId).success) throw new DomainError("not_found", "Tagihan tidak ditemukan.");
  const [invoice] = await op.exec.select().from(subscriptionInvoice).where(eq(subscriptionInvoice.id, invoiceId));
  if (!invoice) throw new DomainError("not_found", "Tagihan tidak ditemukan.");
  const [shop] = await op.exec.select({ name: store.name, slug: store.slug }).from(store).where(eq(store.id, invoice.storeId));
  const attempts = await op.exec.select().from(subscriptionPaymentAttempt).where(eq(subscriptionPaymentAttempt.invoiceId, invoiceId)).orderBy(desc(subscriptionPaymentAttempt.createdAt));
  const events = await op.exec.select().from(subscriptionEvent).where(eq(subscriptionEvent.invoiceId, invoiceId)).orderBy(asc(subscriptionEvent.id));
  return { invoice, store: shop!, attempts, events };
}

// ── Four-eyes requests (the requester holds `billing.manage`, the approver is another operator) ────────────────────────────────────────────

export type CompInput = { storeId: number; periodIndex: number; requestKey: string };
export type MarkPaidInput = { invoiceId: string; storeId: number; evidence: string };
export type PlanPriceInput = { monthlyDppIdr: number };
const compPayload = (i: CompInput) => ({ storeId: i.storeId, periodIndex: i.periodIndex, requestKey: i.requestKey });
const markPaidPayload = (i: MarkPaidInput) => ({ invoiceId: i.invoiceId, storeId: i.storeId, evidence: i.evidence });
const pricePayload = (i: PlanPriceInput) => ({ monthlyDppIdr: i.monthlyDppIdr });

const compInput = z.strictObject({ storeId: z.number().int().positive(), periodIndex: z.number().int().min(0).max(1200), requestKey: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_.:-]+$/), reason: note });
const markPaidInput = z.strictObject({ invoiceId: z.uuid(), storeId: z.number().int().positive(), evidence: z.string().trim().min(5).max(200), reason: note });
const priceInput = z.strictObject({ monthlyDppIdr: z.number().int().min(1).max(100_000_000), reason: note });

async function request(op: OperatorScope, actionKey: FourEyesAction, targetKind: string, targetId: string, payload: unknown, reason: string) {
  await requirePlatformCap(op, "billing.manage");
  return requestApproval(op, { actionKey, targetKind, targetId, payload, reason });
}
export async function requestCompApproval(op: OperatorScope, raw: unknown) {
  const i = compInput.parse(raw);
  return request(op, "billing.comp", "store", String(i.storeId), compPayload(i), i.reason);
}
export async function requestMarkPaidApproval(op: OperatorScope, raw: unknown) {
  const i = markPaidInput.parse(raw);
  return request(op, "billing.mark_paid", "invoice", i.invoiceId, markPaidPayload(i), i.reason);
}
export async function requestPlanPriceApproval(op: OperatorScope, raw: unknown) {
  const i = priceInput.parse(raw);
  return request(op, "billing.plan_price", "plan", PLAN_CODE, pricePayload(i), i.reason);
}

// ── Manual create (one invoice creator, the Owner console entry point) ──────────────────────────────────────────────────────────────────────

/** Invoice for a period through the same creator the cron and seller Pay use: an existing invoice is returned, never duplicated. `periodIndex` defaults to the period due now. */
export async function createInvoiceAsOperator(op: OperatorScope, raw: unknown) {
  const i = z.strictObject({ storeId: z.number().int().positive(), periodIndex: z.number().int().min(0).max(1200).optional(), reason: note }).parse(raw);
  return consoleMutation(op, { capability: "billing.manage", action: "billing.invoice.create", targetKind: "store", targetId: String(i.storeId), reason: i.reason, reasonCode: "manual_invoice" }, (tx) =>
    ensureSubscriptionInvoice(tx, { storeId: i.storeId, source: "operator", actor: op.userId, ...(i.periodIndex === undefined ? {} : { periodIndex: i.periodIndex }) }),
  );
}

/**
 * Comp grant (four-eyes `billing.comp`): an audited Rp0 `kind=comp` invoice with explicit covered period. It voids a conflicting UNPAID invoice of
 * the period first and refuses a period that is already paid (paid history is not rewritten); it creates no revenue, no provider instruction and no
 * seller ledger entry. Replaying the same `requestKey` returns the same invoice without consuming another approval.
 */
export async function grantComp(op: OperatorScope, raw: unknown): Promise<Invoice> {
  const { approvalId, ...rest } = z.looseObject({ approvalId: z.number().int().positive() }).parse(raw);
  const i = compInput.parse(rest);
  const now = new Date();
  return consoleMutation(op, { capability: "billing.manage", action: "billing.comp.grant", targetKind: "store", targetId: String(i.storeId), reason: i.reason, reasonCode: "comp_grant" }, (tx) =>
    withStore(tx, i.storeId, async (stx) => {
      const sub = await lockSubscription(stx, i.storeId);
      const [again] = await stx.select().from(subscriptionInvoice).where(and(eq(subscriptionInvoice.storeId, i.storeId), eq(subscriptionInvoice.compRequestKey, i.requestKey)));
      if (again) return again;
      await consumeApproval(tx, op, { approvalId, actionKey: "billing.comp", targetKind: "store", targetId: String(i.storeId), payloadSha256: payloadHash(compPayload(i)) });
      const { start, end } = periodBounds(sub.billingAnchorDate, i.periodIndex);
      if (jakartaMidnight(end) <= now) throw new DomainError("period_lapsed", "Periode ini sudah lewat dan tidak ditagih mundur.");
      const existing = await stx.select().from(subscriptionInvoice).where(and(eq(subscriptionInvoice.storeId, i.storeId), eq(subscriptionInvoice.periodIndex, i.periodIndex), sql`${subscriptionInvoice.status} <> 'void'`));
      if (existing.some((e) => e.status === "paid")) throw new DomainError("already_paid", "Periode ini sudah dibayar atau sudah diberi comp; riwayat pembayaran tidak diubah.");
      for (const e of existing) {
        await stx.update(subscriptionInvoice).set({ status: "void", voidedAt: now, voidReason: "comp_replaced" }).where(eq(subscriptionInvoice.id, e.id));
        await recordEvent(stx, { storeId: i.storeId, kind: "invoice_voided", actor: op.userId, invoiceId: e.id, fromStatus: "pending", toStatus: "void", detail: { reason: "comp_replaced" } });
      }
      const plan = await effectivePlan(stx, now);
      const [comp] = await stx
        .insert(subscriptionInvoice)
        .values({
          storeId: i.storeId, number: newReference(now), periodIndex: i.periodIndex, periodStart: start, periodEnd: end, kind: "comp", status: "paid", planId: plan.id, dppIdr: 0, ppnEnabled: false, ppnIdr: 0, totalIdr: 0,
          dueAt: jakartaMidnight(start), paidAt: now, source: "comp", createdBy: op.userId, reason: i.reason, settlementSource: "comp", settlementRef: i.requestKey, settledBy: op.userId, compRequestKey: i.requestKey,
        })
        .returning();
      await applyCoverage(stx, { storeId: i.storeId, invoice: comp!, source: "comp", ref: i.requestKey, actor: op.userId, now });
      return (await getInvoice(stx, i.storeId, comp!.id))!;
    }),
  );
}

/**
 * Manual mark-paid (four-eyes `billing.mark_paid`): BOOKKEEPING ONLY. It records who, why and the evidence, sets the invoice `paid` with settlement
 * source `bookkeeping`, and grants no entitlement: no coverage, no subscription change, no provider evidence, no money movement. Only a verified provider
 * settlement or a comp extends coverage.
 */
export async function markInvoicePaidBookkeeping(op: OperatorScope, raw: unknown): Promise<Invoice> {
  const { approvalId, ...rest } = z.looseObject({ approvalId: z.number().int().positive() }).parse(raw);
  const i = markPaidInput.parse(rest);
  const now = new Date();
  return consoleMutation(op, { capability: "billing.manage", action: "billing.invoice.mark_paid", targetKind: "invoice", targetId: i.invoiceId, reason: i.reason, reasonCode: "bookkeeping_paid" }, (tx) =>
    withStore(tx, i.storeId, async (stx) => {
      await lockSubscription(stx, i.storeId);
      await consumeApproval(tx, op, { approvalId, actionKey: "billing.mark_paid", targetKind: "invoice", targetId: i.invoiceId, payloadSha256: payloadHash(markPaidPayload(i)) });
      const [row] = await stx
        .update(subscriptionInvoice)
        .set({ status: "paid", paidAt: now, settlementSource: "bookkeeping", settlementRef: i.evidence, settledBy: op.userId })
        .where(and(eq(subscriptionInvoice.storeId, i.storeId), eq(subscriptionInvoice.id, i.invoiceId), eq(subscriptionInvoice.kind, "subscription"), eq(subscriptionInvoice.status, "pending")))
        .returning();
      if (!row) throw new DomainError("not_found", "Tagihan yang menunggu pembayaran tidak ditemukan.");
      await recordEvent(stx, { storeId: i.storeId, kind: "invoice_marked_paid", actor: op.userId, invoiceId: row.id, fromStatus: "pending", toStatus: "paid", detail: { source: "bookkeeping", entitlement: false } });
      return row;
    }),
  );
}

/**
 * Void a PENDING invoice (a wrong amount can then be re-issued for the same period, DATA-10). Refused while its payment instruction is still live
 * (an accepted, unexpired attempt): taking money for a void invoice is the failure this prevents.
 */
export async function voidInvoiceAsOperator(op: OperatorScope, raw: unknown) {
  const i = z.strictObject({ invoiceId: z.uuid(), storeId: z.number().int().positive(), reason: note }).parse(raw);
  const now = new Date();
  return consoleMutation(op, { capability: "billing.manage", action: "billing.invoice.void", targetKind: "invoice", targetId: i.invoiceId, reason: i.reason, reasonCode: "invoice_void" }, (tx) =>
    withStore(tx, i.storeId, async (stx) => {
      await lockSubscription(stx, i.storeId);
      const [live] = await stx
        .select({ id: subscriptionPaymentAttempt.id })
        .from(subscriptionPaymentAttempt)
        .where(and(eq(subscriptionPaymentAttempt.invoiceId, i.invoiceId), sql`${subscriptionPaymentAttempt.status} in ('pending','unknown') and ${subscriptionPaymentAttempt.requestState} <> 'failed' and (${subscriptionPaymentAttempt.requestState} <> 'accepted' or ${subscriptionPaymentAttempt.expiresAt} > now())`));
      if (live) throw new DomainError("attempt_live", "Instruksi pembayaran masih berlaku. Tunggu kedaluwarsa atau selesaikan percobaannya dulu.");
      const [row] = await stx
        .update(subscriptionInvoice)
        .set({ status: "void", voidedAt: now, voidReason: i.reason })
        .where(and(eq(subscriptionInvoice.storeId, i.storeId), eq(subscriptionInvoice.id, i.invoiceId), eq(subscriptionInvoice.kind, "subscription"), eq(subscriptionInvoice.status, "pending")))
        .returning();
      if (!row) throw new DomainError("not_found", "Tagihan yang menunggu pembayaran tidak ditemukan.");
      await recordEvent(stx, { storeId: i.storeId, kind: "invoice_voided", actor: op.userId, invoiceId: row.id, fromStatus: "pending", toStatus: "void", detail: { reason: i.reason } });
      return row;
    }),
  );
}

/** An attempt stuck `unknown` (the provider could not be asked) leaves the live set only by an operator's decision (`billing.manage`, audited). */
export async function failUnknownAttemptAsOperator(op: OperatorScope, raw: unknown) {
  const i = z.strictObject({ attemptId: z.uuid(), storeId: z.number().int().positive(), reason: note }).parse(raw);
  return consoleMutation(op, { capability: "billing.manage", action: "billing.attempt.fail_unknown", targetKind: "attempt", targetId: i.attemptId, reason: i.reason, reasonCode: "attempt_unknown_resolved" }, (tx) =>
    withStore(tx, i.storeId, async (stx) => {
      await lockSubscription(stx, i.storeId);
      return failUnknownAttempt(stx, i.storeId, i.attemptId, op.userId);
    }),
  );
}

// ── Plan / configuration versions ────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function appendPlan(tx: Parameters<Parameters<OperatorScope["exec"]["transaction"]>[0]>[0], op: OperatorScope, change: Partial<Pick<Plan, "monthlyDppIdr" | "trialDays" | "graceDays" | "ppnEnabled">>, reason: string): Promise<Plan> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bukalaris.billing.plan'))`);
  const [latest] = await tx.select().from(subscriptionPlan).where(eq(subscriptionPlan.planCode, PLAN_CODE)).orderBy(desc(subscriptionPlan.version)).limit(1);
  if (!latest) throw new Error("no subscription plan exists");
  const [row] = await tx
    .insert(subscriptionPlan)
    .values({ planCode: PLAN_CODE, version: latest.version + 1, effectiveFrom: sql`now()` as unknown as Date, monthlyDppIdr: change.monthlyDppIdr ?? latest.monthlyDppIdr, trialDays: change.trialDays ?? latest.trialDays, graceDays: change.graceDays ?? latest.graceDays, ppnEnabled: change.ppnEnabled ?? latest.ppnEnabled, reason, createdBy: op.userId })
    .returning();
  return row!;
}

/** New DPP price: four-eyes `billing.plan_price`. Prospective: only invoices created after the new version's instant carry it; issued invoices keep their snapshot. */
export async function changePlanPrice(op: OperatorScope, raw: unknown): Promise<Plan> {
  const { approvalId, ...rest } = z.looseObject({ approvalId: z.number().int().positive() }).parse(raw);
  const i = priceInput.parse(rest);
  return consoleMutation(op, { capability: "billing.manage", action: "billing.plan.price", targetKind: "plan", targetId: PLAN_CODE, reason: i.reason, reasonCode: "plan_price" }, async (tx) => {
    await consumeApproval(tx, op, { approvalId, actionKey: "billing.plan_price", targetKind: "plan", targetId: PLAN_CODE, payloadSha256: payloadHash(pricePayload(i)) });
    return appendPlan(tx, op, { monthlyDppIdr: i.monthlyDppIdr }, i.reason);
  });
}

/** Trial and grace days (`billing.manage`, audited; not a price). Trial days apply to stores created afterwards; grace days to coverage that ends afterwards. */
export async function changePlanDays(op: OperatorScope, raw: unknown): Promise<Plan> {
  const i = z.strictObject({ trialDays: z.number().int().min(0).max(TRIAL_DAYS_MAX), graceDays: z.number().int().min(0).max(GRACE_DAYS_MAX), reason: note }).parse(raw);
  return consoleMutation(op, { capability: "billing.manage", action: "billing.plan.days", targetKind: "plan", targetId: PLAN_CODE, reason: i.reason, reasonCode: "plan_days" }, (tx) => appendPlan(tx, op, { trialDays: i.trialDays, graceDays: i.graceDays }, i.reason));
}

/**
 * The global PPN switch (D-17): `tax.manage`, a confirmation and a required reason, audited, NOT four-eyes and no PKP gate. It is prospective (a new plan
 * version effective now: issued invoices keep their snapshot). Switching ON needs an effective confirmed `vat_output` policy for the subscription line
 * (T-65); with none the switch REFUSES, and the rate is always that policy's value, never a constant.
 */
export async function setPpnSwitch(op: OperatorScope, raw: unknown): Promise<Plan> {
  const i = z.strictObject({ enabled: z.boolean(), confirmed: z.literal(true, { error: "Konfirmasi wajib dicentang." }), reason: note }).parse(raw);
  return consoleMutation(op, { capability: "tax.manage", action: i.enabled ? "billing.ppn.enable" : "billing.ppn.disable", targetKind: "plan", targetId: PLAN_CODE, reason: i.reason, reasonCode: "ppn_switch" }, async (tx) => {
    const current = await effectivePlan(tx, new Date());
    if (current.ppnEnabled === i.enabled) throw new DomainError("unchanged", `PPN sudah ${i.enabled ? "menyala" : "mati"}.`);
    if (i.enabled) {
      const asOf = jakartaDate(new Date());
      try {
        const policy = resolveTaxPolicy(await effectiveVatPolicies(tx, asOf), "vat_output", "subscription", asOf);
        if (policy.rateMethod !== "per_payment" || policy.brackets.length !== 1 || policy.brackets[0]!.up_to_idr !== null) throw new TaxRefusal("policy_invalid");
      } catch (err) {
        if (err instanceof TaxRefusal) throw new DomainError("ppn_no_policy", err.code === "no_effective_policy" ? "PPN tidak bisa dinyalakan: belum ada kebijakan PPN keluaran (vat_output) yang berlaku dan terkonfirmasi. Masukkan tarif sebagai kebijakan pajak berlaku-tanggal lebih dulu." : "PPN tidak bisa dinyalakan: kebijakan PPN keluaran yang berlaku tidak berbentuk satu tarif tetap.");
        throw err;
      }
    }
    return appendPlan(tx, op, { ppnEnabled: i.enabled }, i.reason);
  });
}

/** Billing controls: the post-restore job freeze and the dunning switch (`billing.manage`, audited). Dunning stays off until real mail delivery has evidence. */
export async function setBillingControls(op: OperatorScope, raw: unknown) {
  const i = z.strictObject({ jobsFrozen: z.boolean().optional(), dunningEnabled: z.boolean().optional(), reason: note }).parse(raw);
  return consoleMutation(op, { capability: "billing.manage", action: "billing.controls", targetKind: "billing", targetId: "controls", reason: i.reason, reasonCode: "billing_controls" }, async (tx) => {
    const [row] = await tx
      .update(billingControl)
      .set({ ...(i.jobsFrozen === undefined ? {} : { jobsFrozen: i.jobsFrozen }), ...(i.dunningEnabled === undefined ? {} : { dunningEnabled: i.dunningEnabled }), reason: i.reason, changedBy: op.userId, changedAt: new Date() })
      .where(eq(billingControl.id, 1))
      .returning();
    return row!;
  });
}
