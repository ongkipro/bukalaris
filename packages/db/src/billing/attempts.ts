import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Executor, Tx } from "../client.ts";
import { enqueue } from "../ops/jobs/jobs.ts";
import { assertPaymentOwner, settlementEnabled, signedCallbackUrl } from "../payments/attempts.ts";
import { classifyAdvice, PaymentContractError, type PaymentCreateInput, type PaymentCustomer, type PaymentInstruction } from "../payments/contract.ts";
import type { PaymentAdapter, Providers } from "../payments/providers.ts";
import { store } from "../schema.ts";
import { DomainError, requireCap, type SellerScope } from "../platform/scoped.ts";
import { withStore } from "../platform/tenant.ts";
import { defaultProviders } from "../shipping/shipping.ts";
import { jakartaMidnight } from "./period.ts";
import { ensureSubscriptionInvoice, getInvoice, newReference, openInvoices, type Invoice } from "./invoices.ts";
import { subscriptionInvoice, subscriptionPaymentAttempt } from "./schema-billing.ts";
import { ATTEMPT_REPLACE_AFTER_EXPIRY_MS, SUBSCRIPTION_CHANNELS, SUBSCRIPTION_INSTRUCTION_LIFETIME_MS } from "./settings.ts";
import { applyCoverage, lockSubscription, recordEvent } from "./state.ts";

export type SubscriptionAttempt = typeof subscriptionPaymentAttempt.$inferSelect;
export const SUBSCRIPTION_INSTRUCTION = "subscription.instruction";
export const SUBSCRIPTION_VERIFY = "subscription.verify";
export const SUBSCRIPTION_SYSTEM_ACTOR = "system:subscription-inquiry";

/** Channels the provider offers right now, narrowed to the ones a subscription may use (real codes only). Availability comes only from the provider's list. */
export async function subscriptionChannels(adapter: PaymentAdapter) {
  let channels;
  try {
    channels = await adapter.listChannels();
  } catch (err) {
    const e = new DomainError("provider", "Metode pembayaran sedang tidak tersedia. Coba lagi sebentar.");
    e.cause = err;
    throw e;
  }
  return channels.filter((c) => SUBSCRIPTION_CHANNELS.includes(c.code));
}

/** 29 decimal digits from 96 random bits: the provider reff_id (documented limit 30 digits), never derived from guessable data. */
const newReffId = () => BigInt(`0x${randomBytes(12).toString("hex")}`).toString().padStart(29, "0");
const MAX_ATTEMPT_TRIES = 5;

export type PayResult = { invoice: Invoice; attempt: SubscriptionAttempt; invoiceCreated: boolean; attemptCreated: boolean };

/**
 * Create (or reuse) the one live payment attempt of an invoice. Committed together with the invoice and the `subscription.instruction` job
 * intent, BEFORE any provider call (the worker makes the single, fenced `/submit`). One live or uncertain attempt per invoice is the partial
 * unique index `subscription_payment_attempt_live_uq`: concurrent callers all get the same attempt (same reference, same instruction), a
 * timeout leaves the attempt `unknown` and live (never a second bill), and an accepted instruction that expired (plus the safety margin) is
 * replaced by a new controlled attempt on the SAME invoice through the definer `subscription_expire_attempt`.
 */
async function ensureLiveAttempt(tx: Tx, a: { storeId: number; invoice: Invoice; channel: string; actor: string; now: Date }): Promise<{ attempt: SubscriptionAttempt; created: boolean }> {
  const live = () => tx.select().from(subscriptionPaymentAttempt).where(and(eq(subscriptionPaymentAttempt.storeId, a.storeId), eq(subscriptionPaymentAttempt.invoiceId, a.invoice.id), sql`${subscriptionPaymentAttempt.status} in ('pending','unknown') and ${subscriptionPaymentAttempt.requestState} <> 'failed'`));
  const [current] = await live();
  if (current) {
    const stale = current.requestState === "accepted" && current.expiresAt.getTime() + ATTEMPT_REPLACE_AFTER_EXPIRY_MS <= a.now.getTime();
    if (!stale) return { attempt: current, created: false };
    await tx.execute(sql`select subscription_expire_attempt(${current.id}::uuid, ${ATTEMPT_REPLACE_AFTER_EXPIRY_MS}::integer)`);
  }
  const [shop] = await tx.select({ name: store.name, whatsapp: store.whatsapp }).from(store).where(eq(store.id, a.storeId));
  const customer: PaymentCustomer = { id: String(a.storeId), name: shop?.name ?? `Toko ${a.storeId}`, phone: shop?.whatsapp ?? "0800000000", email: null };
  for (let tries = 0; tries < MAX_ATTEMPT_TRIES; tries++) {
    const [row] = await tx
      .insert(subscriptionPaymentAttempt)
      .values({
        storeId: a.storeId, invoiceId: a.invoice.id, ownerId: a.invoice.id, localReference: newReference(a.now), reffId: newReffId(), channelCode: a.channel, customer,
        amountIdr: a.invoice.totalIdr, adminFeeIdr: 0, totalIdr: a.invoice.totalIdr, expiresAt: new Date(a.now.getTime() + SUBSCRIPTION_INSTRUCTION_LIFETIME_MS), createdBy: a.actor,
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      await enqueue(tx, { kind: SUBSCRIPTION_INSTRUCTION, storeId: a.storeId, key: `attempt:${row.id}`, payload: { attemptId: row.id } });
      return { attempt: row, created: true };
    }
    const [winner] = await live();
    if (winner) return { attempt: winner, created: false };
  }
  throw new Error("could not allocate a payment attempt");
}

/**
 * Seller Pay. The store comes from the seller scope, never from the browser; the invoice is the oldest unpaid, not-lapsed one (periods are
 * paid oldest first) or the period due now, created through the one creator `ensureSubscriptionInvoice`. Needs `billing.pay` (owner), which stays
 * usable while Seller Admin is read-only. Paying never touches `store.suspended_at`.
 */
export async function paySubscription(scope: SellerScope, input: { channel: string; invoiceId?: string; now?: Date }, providers: Providers = defaultProviders()): Promise<PayResult> {
  requireCap(scope, "billing.pay");
  const now = input.now ?? new Date();
  const channel = (await subscriptionChannels(providers.payment)).find((c) => c.code === input.channel);
  if (!channel) throw new DomainError("payment_channel", "Metode pembayaran tidak tersedia. Pilih metode lain.");
  return withStore(scope.exec, scope.storeId, async (tx) => {
    let invoice: Invoice | null = null;
    let invoiceCreated = false;
    if (input.invoiceId) {
      invoice = await getInvoice(tx, scope.storeId, input.invoiceId);
      if (!invoice) throw new DomainError("not_found", "Tagihan tidak ditemukan.");
    } else {
      invoice = (await openInvoices(tx, scope.storeId, now))[0] ?? null;
      if (!invoice) {
        let r = await ensureSubscriptionInvoice(tx, { storeId: scope.storeId, source: "seller", actor: scope.userId, now });
        // Period 0 may be invoiced and paid before the trial ends (BILL-7): a seller who pays early is not told "not due".
        if (r.kind === "not_due") r = await ensureSubscriptionInvoice(tx, { storeId: scope.storeId, source: "seller", actor: scope.userId, now, periodIndex: 0 });
        if (r.kind === "covered") throw new DomainError("already_covered", "Periode berjalan sudah lunas.");
        if (r.kind === "not_due") throw new DomainError("not_due", "Belum ada tagihan yang perlu dibayar.");
        invoice = r.invoice;
        invoiceCreated = r.created;
      }
    }
    if (invoice.kind !== "subscription") throw new DomainError("not_payable", "Tagihan ini tidak perlu dibayar.");
    if (invoice.status === "paid") throw new DomainError("already_paid", "Tagihan ini sudah dibayar.");
    if (invoice.status === "void") throw new DomainError("invoice_void", "Tagihan ini sudah dibatalkan.");
    // Wave 3 review: the same "not lapsed" rule openInvoices applies; a period whose end has passed is never paid by id either (no back-billing, OPEN-B1).
    if (jakartaMidnight(invoice.periodEnd) <= now) throw new DomainError("period_lapsed", "Periode ini sudah lewat dan tidak ditagih mundur.");
    const { attempt, created } = await ensureLiveAttempt(tx, { storeId: scope.storeId, invoice, channel: channel.code, actor: scope.userId, now });
    return { invoice, attempt, invoiceCreated, attemptCreated: created };
  });
}

/** What a member may see of an attempt: never the provider transaction id, the provider fee or callback data. */
export type SubscriptionPaymentView = {
  id: string;
  channelCode: string;
  requestState: SubscriptionAttempt["requestState"];
  status: SubscriptionAttempt["status"];
  totalIdr: number;
  expiresAt: Date;
  instruction: { virtualAccount: string | null; qr: string | null; paymentCode: string | null; url: string | null; expiresAt: string } | null;
};
export const paymentView = (a: SubscriptionAttempt): SubscriptionPaymentView => ({
  id: a.id, channelCode: a.channelCode, requestState: a.requestState, status: a.status, totalIdr: a.totalIdr, expiresAt: a.expiresAt,
  instruction: a.instruction ? { virtualAccount: a.instruction.virtualAccount, qr: a.instruction.qr, paymentCode: a.instruction.paymentCode, url: a.instruction.url, expiresAt: a.instruction.expiresAt } : null,
});

/** The attempts of one invoice (store-checked), newest first. */
export async function invoiceAttempts(exec: Executor, storeId: number, invoiceId: string): Promise<SubscriptionAttempt[]> {
  return withStore(exec, storeId, (tx) =>
    tx.select().from(subscriptionPaymentAttempt).where(and(eq(subscriptionPaymentAttempt.storeId, storeId), eq(subscriptionPaymentAttempt.invoiceId, invoiceId))).orderBy(desc(subscriptionPaymentAttempt.createdAt)),
  );
}

// ── Worker side ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SubscriptionScope = { exec: Executor; storeId: number };

/** Provider create input of a persisted attempt, owner kind `subscription_invoice`; the signed callback URL comes from configuration only (fails closed without a secret). */
export function subscriptionCreateInput(a: SubscriptionAttempt, options: { callbackSecret?: string; callbackOrigin?: string } = {}): PaymentCreateInput {
  return {
    reffId: a.reffId, channelCode: a.channelCode, owner: { kind: "subscription_invoice", id: a.ownerId }, customer: a.customer,
    amountIdr: a.amountIdr, adminFeeIdr: a.adminFeeIdr, totalIdr: a.totalIdr, expiresAt: a.expiresAt, callbackUrl: signedCallbackUrl(a.reffId, options),
  };
}

export const getAttempt = (scope: SubscriptionScope, attemptId: string): Promise<SubscriptionAttempt | null> =>
  withStore(scope.exec, scope.storeId, async (tx) => (await tx.select().from(subscriptionPaymentAttempt).where(and(eq(subscriptionPaymentAttempt.storeId, scope.storeId), eq(subscriptionPaymentAttempt.id, attemptId))))[0] ?? null);

/** One transaction: provider transaction id and structured instruction together, once. */
export async function storeSubscriptionInstruction(scope: SubscriptionScope, a: SubscriptionAttempt, instruction: PaymentInstruction): Promise<void> {
  if (instruction.reference !== a.reffId || instruction.totalIdr !== a.totalIdr) throw new PaymentContractError("binding", "stored instruction mismatch");
  await withStore(scope.exec, scope.storeId, async (tx) => {
    const [row] = await tx
      .update(subscriptionPaymentAttempt)
      .set({ requestState: "accepted", transactionId: instruction.transactionId, instruction, providerFeeIdr: instruction.providerFeeIdr, revision: sql`${subscriptionPaymentAttempt.revision} + 1` })
      .where(and(eq(subscriptionPaymentAttempt.storeId, scope.storeId), eq(subscriptionPaymentAttempt.id, a.id), ne(subscriptionPaymentAttempt.requestState, "accepted")))
      .returning();
    if (row) await recordEvent(tx, { storeId: scope.storeId, kind: "attempt_accepted", actor: SUBSCRIPTION_SYSTEM_ACTOR, invoiceId: row.invoiceId, attemptId: row.id });
  });
}

/** `failed` for a definite provider rejection, `unknown` when the outcome cannot be told (never a second bill: `unknown` stays in the live set). */
export async function markSubscriptionCreationOutcome(scope: SubscriptionScope, a: SubscriptionAttempt, outcome: "failed" | "unknown"): Promise<void> {
  await withStore(scope.exec, scope.storeId, async (tx) => {
    const [row] = await tx
      .update(subscriptionPaymentAttempt)
      .set({ requestState: outcome, revision: sql`${subscriptionPaymentAttempt.revision} + 1` })
      .where(and(eq(subscriptionPaymentAttempt.storeId, scope.storeId), eq(subscriptionPaymentAttempt.id, a.id), ne(subscriptionPaymentAttempt.requestState, "accepted"), ne(subscriptionPaymentAttempt.requestState, "failed")))
      .returning();
    if (row) await recordEvent(tx, { storeId: scope.storeId, kind: `attempt_${outcome}`, actor: SUBSCRIPTION_SYSTEM_ACTOR, invoiceId: row.invoiceId, attemptId: row.id });
  });
}

export type SubscriptionInquiryResult = { classification: "paid" | "pending" | "unknown"; applied: boolean; coverageApplied: boolean; duplicate: boolean };

/**
 * Record one provider inquiry for a subscription attempt: THE settlement path (a callback body never reaches it, D-21 K). Only a pulled `rc 00`
 * + `PAID` + the attempt's own `total_idr` is `paid`. Lock order: subscription row, invoice, attempt. `paid` is monotonic and `attempt_paid` is
 * a unique event per attempt, `coverage_applied` a unique event per invoice: a replay or a second verification settles and extends once. A
 * payment for a void invoice, or for an invoice already covered by another payment, extends nothing and leaves a `payment_*` event for a refund
 * decision (T-37). The owner kind and id of the attempt are asserted (`assertPaymentOwner`): an order attempt can never settle an invoice.
 */
export async function recordSubscriptionInquiry(scope: SubscriptionScope, attemptId: string, raw: unknown, options: { source: "callback" | "reconcile" | "poll"; mode: "fake" | "live"; now?: Date }): Promise<SubscriptionInquiryResult> {
  const now = options.now ?? new Date();
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const [a0] = await tx.select({ invoiceId: subscriptionPaymentAttempt.invoiceId }).from(subscriptionPaymentAttempt).where(and(eq(subscriptionPaymentAttempt.storeId, scope.storeId), eq(subscriptionPaymentAttempt.id, attemptId)));
    if (!a0) throw new PaymentContractError("not_found", "subscription attempt not found");
    await lockSubscription(tx, scope.storeId);
    const [inv] = await tx.select().from(subscriptionInvoice).where(and(eq(subscriptionInvoice.storeId, scope.storeId), eq(subscriptionInvoice.id, a0.invoiceId))).for("update");
    const [a] = await tx.select().from(subscriptionPaymentAttempt).where(and(eq(subscriptionPaymentAttempt.storeId, scope.storeId), eq(subscriptionPaymentAttempt.id, attemptId))).for("update");
    if (!inv || !a) throw new PaymentContractError("not_found", "subscription attempt not found");
    assertPaymentOwner(a, { kind: "subscription_invoice", id: inv.id });
    const classification = classifyAdvice(raw, a.totalIdr);
    await recordEvent(tx, { storeId: scope.storeId, kind: "inquiry", actor: SUBSCRIPTION_SYSTEM_ACTOR, invoiceId: inv.id, attemptId, detail: { source: options.source, classification, responseSha256: createHash("sha256").update(JSON.stringify(raw) ?? "null").digest("hex") } });
    const none = { classification, applied: false, coverageApplied: false, duplicate: false };
    if (options.source === "poll" || !settlementEnabled(options.mode) || a.status === "paid" || a.transactionId === null) return none;
    // An expired attempt stays expired unless the provider says it was paid (a late payment is still money received).
    if (a.status === "expired" && classification !== "paid") return none;
    const [changed] = await tx
      .update(subscriptionPaymentAttempt)
      .set({ status: classification, ...(classification === "paid" ? { paidAt: now } : {}), revision: sql`${subscriptionPaymentAttempt.revision} + 1` })
      .where(and(eq(subscriptionPaymentAttempt.storeId, scope.storeId), eq(subscriptionPaymentAttempt.id, attemptId), ne(subscriptionPaymentAttempt.status, "paid")))
      .returning();
    if (!changed) return none;
    if (classification !== "paid") return { classification, applied: true, coverageApplied: false, duplicate: false };
    await recordEvent(tx, { storeId: scope.storeId, kind: "attempt_paid", actor: SUBSCRIPTION_SYSTEM_ACTOR, invoiceId: inv.id, attemptId, detail: { totalIdr: a.totalIdr } });
    if (inv.status === "void") {
      await recordEvent(tx, { storeId: scope.storeId, kind: "payment_on_void_invoice", actor: SUBSCRIPTION_SYSTEM_ACTOR, invoiceId: inv.id, attemptId, detail: { totalIdr: a.totalIdr, voidReason: inv.voidReason } });
      return { classification, applied: true, coverageApplied: false, duplicate: false };
    }
    const { applied } = await applyCoverage(tx, { storeId: scope.storeId, invoice: inv, source: "provider", ref: a.id, actor: SUBSCRIPTION_SYSTEM_ACTOR, now });
    if (!applied) await recordEvent(tx, { storeId: scope.storeId, kind: "payment_on_covered_invoice", actor: SUBSCRIPTION_SYSTEM_ACTOR, invoiceId: inv.id, attemptId, detail: { totalIdr: a.totalIdr } });
    return { classification, applied: true, coverageApplied: applied, duplicate: !applied };
  });
}

/**
 * Owner console (T-50): an attempt whose creation outcome stayed `unknown` after the provider could not be asked leaves the live set only by an
 * operator's decision after checking the provider's own records. The caller (`billing.manage`, audited in the console service) supplies the transaction.
 */
export async function failUnknownAttempt(tx: Tx, storeId: number, attemptId: string, actor: string): Promise<SubscriptionAttempt> {
  const [row] = await tx
    .update(subscriptionPaymentAttempt)
    .set({ requestState: "failed", revision: sql`${subscriptionPaymentAttempt.revision} + 1` })
    .where(and(eq(subscriptionPaymentAttempt.storeId, storeId), eq(subscriptionPaymentAttempt.id, attemptId), eq(subscriptionPaymentAttempt.requestState, "unknown"), ne(subscriptionPaymentAttempt.status, "paid")))
    .returning();
  if (!row) throw new DomainError("not_found", "Percobaan pembayaran dengan hasil tidak diketahui tidak ditemukan.");
  await recordEvent(tx, { storeId, kind: "attempt_failed", actor, invoiceId: row.invoiceId, attemptId: row.id, detail: { by: "operator" } });
  return row;
}
