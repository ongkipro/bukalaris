import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { store } from "../schema.ts";
import type { PaymentCustomer, PaymentInstruction } from "../payments/contract.ts";
import { taxPolicyVersion } from "../tax/schema-tax.ts";

// DATA-10 (T-50): platform-owned subscription, plan/config and invoice records, distinct from buyer `order`, buyer `payment_attempt`,
// seller `ledger_entry` and seller proceeds. Migration 0013 (hand-written section T-50) adds row-level security, grants, guards,
// the resolver and the seeds; the invariants below are CHECKs, partial unique indexes and composite foreign keys, not service code.

const instant = (name: string) => timestamp(name, { withTimezone: true });
const idr = (name: string) => bigint(name, { mode: "number" });

/**
 * The versioned billing configuration (`subscription_plan` / config version, DATA-10). Append-only: a price, trial/grace or PPN
 * change is a new row whose `effective_from` is its creation instant (prospective). The one all-feature plan is the named plan
 * code `all_feature`. There is no PPN rate here: the rate is the effective `vat_output` `tax_policy_version` of T-65.
 */
export const subscriptionPlan = pgTable("subscription_plan", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  planCode: text("plan_code").notNull(), version: integer("version").notNull(), effectiveFrom: instant("effective_from").notNull(),
  monthlyDppIdr: idr("monthly_dpp_idr").notNull(), trialDays: integer("trial_days").notNull(), graceDays: integer("grace_days").notNull(),
  ppnEnabled: boolean("ppn_enabled").notNull().default(false), entitlements: jsonb("entitlements").$type<{ allFeatures: true }>().notNull().default(sql`'{"allFeatures": true}'::jsonb`),
  reason: text("reason").notNull(), createdBy: text("created_by").notNull(), createdAt: instant("created_at").notNull().defaultNow(),
}, (t) => [
  unique("subscription_plan_version_uq").on(t.planCode, t.version), unique("subscription_plan_effective_uq").on(t.planCode, t.effectiveFrom),
  check("subscription_plan_values_chk", sql`${t.monthlyDppIdr} > 0 and ${t.monthlyDppIdr} <= 9007199254740991 and ${t.trialDays} between 0 and 60 and ${t.graceDays} between 0 and 60 and ${t.version} > 0 and ${t.planCode} ~ '^[a-z][a-z0-9_]{1,31}$'`),
]);

/** One per store (primary key). `billing_anchor_date` is the Jakarta date of `trial_ends_at` and never changes. Platform writes; the store reads. */
export const storeSubscription = pgTable("store_subscription", {
  storeId: bigint("store_id", { mode: "number" }).primaryKey().references(() => store.id),
  planId: bigint("plan_id", { mode: "number" }).notNull().references(() => subscriptionPlan.id),
  status: text("status", { enum: ["trial", "active", "past_due", "suspended"] }).notNull().default("trial"),
  trialEndsAt: instant("trial_ends_at").notNull(), billingAnchorDate: date("billing_anchor_date").notNull(),
  currentPeriodStart: instant("current_period_start"), currentPeriodEnd: instant("current_period_end"),
  pastDueAt: instant("past_due_at"), graceEndsAt: instant("grace_ends_at"),
  createdAt: instant("created_at").notNull().defaultNow(), updatedAt: instant("updated_at").notNull().defaultNow(),
}, (t) => [
  check("store_subscription_status_chk", sql`${t.status} in ('trial','active','past_due','suspended')`),
  check("store_subscription_period_chk", sql`(${t.currentPeriodStart} is null) = (${t.currentPeriodEnd} is null) and (${t.currentPeriodStart} is null or ${t.currentPeriodStart} < ${t.currentPeriodEnd})`),
  check("store_subscription_anchor_chk", sql`${t.billingAnchorDate} = (${t.trialEndsAt} at time zone 'Asia/Jakarta')::date`),
  check("store_subscription_grace_chk", sql`(${t.status} in ('past_due','suspended')) = (${t.pastDueAt} is not null) and (${t.pastDueAt} is null) = (${t.graceEndsAt} is null) and (${t.graceEndsAt} is null or ${t.graceEndsAt} >= ${t.pastDueAt})`),
  check("store_subscription_active_chk", sql`${t.status} <> 'active' or ${t.currentPeriodEnd} is not null`),
]);

/** A platform invoice for one store and period (`kind = 'subscription'`) or an audited Rp0 comp grant (`kind = 'comp'`). Amount snapshots survive config edits. */
export const subscriptionInvoice = pgTable("subscription_invoice", {
  id: uuid("id").primaryKey().defaultRandom(), storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
  /** The unique local payment reference of the invoice (`SUB-<ts9><hex3>`), stable for every entry point and every attempt. */
  number: text("number").notNull().unique(),
  periodIndex: integer("period_index").notNull(), periodStart: date("period_start").notNull(), periodEnd: date("period_end").notNull(),
  kind: text("kind", { enum: ["subscription", "comp"] }).notNull().default("subscription"),
  status: text("status", { enum: ["pending", "paid", "void"] }).notNull().default("pending"),
  planId: bigint("plan_id", { mode: "number" }).notNull().references(() => subscriptionPlan.id),
  dppIdr: idr("dpp_idr").notNull(), ppnEnabled: boolean("ppn_enabled").notNull().default(false), ppnRateBps: integer("ppn_rate_bps"),
  taxPolicyVersionId: bigint("tax_policy_version_id", { mode: "number" }), taxTypeCode: text("tax_type_code"), taxCategoryCode: text("tax_category_code"),
  ppnIdr: idr("ppn_idr").notNull().default(0), totalIdr: idr("total_idr").notNull(),
  dueAt: instant("due_at").notNull(), createdAt: instant("created_at").notNull().defaultNow(), paidAt: instant("paid_at"), voidedAt: instant("voided_at"), voidReason: text("void_reason"),
  /** `cron`, `seller`, `operator` or `comp`, and the actor that asked (`system:billing`, a seller user id or an operator user id). */
  source: text("source", { enum: ["cron", "seller", "operator", "comp"] }).notNull(), createdBy: text("created_by").notNull(), reason: text("reason"),
  /** `provider` (verified settlement), `comp` (explicit grant) or `bookkeeping` (manual mark-paid: no entitlement). */
  settlementSource: text("settlement_source", { enum: ["provider", "comp", "bookkeeping"] }), settlementRef: text("settlement_ref"), settledBy: text("settled_by"),
  /** Set once, with the coverage extension and the `coverage_applied` event: the exactly-once entitlement marker. */
  coverageAppliedAt: instant("coverage_applied_at"),
  compRequestKey: text("comp_request_key"),
}, (t) => [
  unique("subscription_invoice_store_id_uq").on(t.storeId, t.id),
  uniqueIndex("subscription_invoice_period_index_uq").on(t.storeId, t.periodIndex).where(sql`${t.kind} = 'subscription' and ${t.status} <> 'void'`),
  uniqueIndex("subscription_invoice_period_dates_uq").on(t.storeId, t.periodStart, t.periodEnd).where(sql`${t.kind} = 'subscription' and ${t.status} <> 'void'`),
  uniqueIndex("subscription_invoice_pending_uq").on(t.storeId, t.periodStart, t.periodEnd).where(sql`${t.status} = 'pending'`),
  uniqueIndex("subscription_invoice_comp_period_uq").on(t.storeId, t.periodIndex).where(sql`${t.kind} = 'comp' and ${t.status} <> 'void'`),
  uniqueIndex("subscription_invoice_comp_key_uq").on(t.compRequestKey).where(sql`${t.kind} = 'comp'`),
  index("subscription_invoice_store_idx").on(t.storeId, t.periodIndex),
  foreignKey({ name: "subscription_invoice_policy_fk", columns: [t.taxPolicyVersionId, t.taxTypeCode, t.taxCategoryCode], foreignColumns: [taxPolicyVersion.id, taxPolicyVersion.taxTypeCode, taxPolicyVersion.categoryCode] }),
  check("subscription_invoice_number_chk", sql`${t.number} ~ '^SUB-[0-9A-Z]{9}[0-9A-F]{3}$'`),
  check("subscription_invoice_period_chk", sql`${t.periodIndex} >= 0 and ${t.periodEnd} > ${t.periodStart}`),
  check("subscription_invoice_amount_chk", sql`${t.dppIdr} >= 0 and ${t.ppnIdr} >= 0 and ${t.totalIdr} = ${t.dppIdr} + ${t.ppnIdr} and ${t.totalIdr} <= 9007199254740991`),
  check("subscription_invoice_comp_chk", sql`(${t.kind} = 'comp') = (${t.compRequestKey} is not null) and (${t.kind} <> 'comp' or (${t.dppIdr} = 0 and ${t.ppnIdr} = 0 and ${t.totalIdr} = 0 and ${t.source} = 'comp' and ${t.status} = 'paid' and ${t.settlementSource} = 'comp'))`),
  check("subscription_invoice_subscription_chk", sql`${t.kind} <> 'subscription' or (${t.dppIdr} > 0 and ${t.source} in ('cron','seller','operator') and ${t.settlementSource} is distinct from 'comp')`),
  check("subscription_invoice_ppn_chk", sql`(${t.ppnEnabled} = (${t.taxPolicyVersionId} is not null)) and (${t.ppnEnabled} = (${t.ppnRateBps} is not null)) and (${t.taxPolicyVersionId} is null) = (${t.taxTypeCode} is null) and (${t.taxTypeCode} is null) = (${t.taxCategoryCode} is null) and (${t.taxTypeCode} is null or (${t.taxTypeCode} = 'vat_output' and ${t.taxCategoryCode} = 'subscription')) and (${t.ppnEnabled} or ${t.ppnIdr} = 0) and (${t.ppnRateBps} is null or ${t.ppnRateBps} between 0 and 10000)`),
  check("subscription_invoice_state_chk", sql`${t.status} in ('pending','paid','void') and (${t.status} = 'paid') = (${t.paidAt} is not null) and (${t.status} = 'void') = (${t.voidedAt} is not null) and (${t.status} <> 'void' or nullif(btrim(${t.voidReason}), '') is not null) and (${t.status} <> 'paid' or ${t.settlementSource} is not null) and (${t.status} = 'paid' or ${t.settlementSource} is null)`),
  check("subscription_invoice_coverage_chk", sql`${t.coverageAppliedAt} is null or (${t.status} = 'paid' and ${t.settlementSource} in ('provider','comp','bookkeeping'))`),
]);

/** Separate from buyer attempts. Settlement compares the provider amount with `total_idr` (invoice total plus any gateway fee added to this attempt). */
export const subscriptionPaymentAttempt = pgTable("subscription_payment_attempt", {
  id: uuid("id").primaryKey().defaultRandom(), storeId: bigint("store_id", { mode: "number" }).notNull(), invoiceId: uuid("invoice_id").notNull(),
  ownerKind: text("owner_kind").notNull().default("subscription_invoice"), ownerId: text("owner_id").notNull(),
  /** Unique local reference of this attempt (`SUB-<ts9><hex3>`); the provider `reff_id` is the 29-digit one of the T-49 contract. */
  localReference: text("local_reference").notNull().unique(), reffId: text("reff_id").notNull().unique(), channelCode: text("channel_code").notNull(),
  customer: jsonb("customer").$type<PaymentCustomer>().notNull(),
  amountIdr: idr("amount_idr").notNull(), adminFeeIdr: idr("admin_fee_idr").notNull(), totalIdr: idr("total_idr").notNull(), providerFeeIdr: idr("provider_fee_idr"),
  transactionId: text("transaction_id").unique(), instruction: jsonb("instruction").$type<PaymentInstruction>(),
  requestState: text("request_state", { enum: ["in_progress", "accepted", "failed", "unknown"] }).notNull().default("in_progress"),
  status: text("status", { enum: ["pending", "paid", "unknown", "expired"] }).notNull().default("pending"),
  revision: integer("revision").notNull().default(1), expiresAt: instant("expires_at").notNull(), paidAt: instant("paid_at"), createdAt: instant("created_at").notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
}, (t) => [
  unique("subscription_payment_attempt_store_id_uq").on(t.storeId, t.id),
  foreignKey({ name: "subscription_payment_attempt_invoice_fk", columns: [t.storeId, t.invoiceId], foreignColumns: [subscriptionInvoice.storeId, subscriptionInvoice.id] }),
  // At most ONE live or uncertain instruction per invoice, in the database. `expired` and `failed` and `paid` leave the set; an
  // `unknown` creation or inquiry stays in it, so a timeout never yields a second bill. Expired attempts are replaced under this index.
  uniqueIndex("subscription_payment_attempt_live_uq").on(t.invoiceId).where(sql`${t.status} in ('pending','unknown') and ${t.requestState} <> 'failed'`),
  index("subscription_payment_attempt_invoice_idx").on(t.invoiceId, t.createdAt),
  check("subscription_payment_attempt_owner_chk", sql`${t.ownerKind} = 'subscription_invoice' and ${t.ownerId} = ${t.invoiceId}::text`),
  check("subscription_payment_attempt_channel_chk", sql`${t.channelCode} in ('VABCA','VABNI','VABRI','VAMANDIRI','VAPERMATA','QRIS')`),
  check("subscription_payment_attempt_amount_chk", sql`${t.amountIdr} > 0 and ${t.adminFeeIdr} >= 0 and ${t.totalIdr} = ${t.amountIdr} + ${t.adminFeeIdr} and ${t.totalIdr} <= 9007199254740991 and (${t.providerFeeIdr} is null or ${t.providerFeeIdr} >= 0)`),
  check("subscription_payment_attempt_state_chk", sql`${t.requestState} in ('in_progress','accepted','failed','unknown') and ${t.status} in ('pending','paid','unknown','expired') and ${t.revision} > 0`),
  check("subscription_payment_attempt_accepted_chk", sql`(${t.requestState} <> 'accepted' or (${t.transactionId} is not null and ${t.instruction} is not null)) and (${t.status} <> 'paid') = (${t.paidAt} is null)`),
  check("subscription_payment_attempt_reference_chk", sql`${t.localReference} ~ '^SUB-[0-9A-Z]{9}[0-9A-F]{3}$' and ${t.reffId} ~ '^[0-9]{1,30}$'`),
]);

/** Callback evidence only: the digest and the shape of each distinct body, never the body (verification is by pull, D-21 K). */
export const subscriptionPaymentCallback = pgTable("subscription_payment_callback", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(), storeId: bigint("store_id", { mode: "number" }).notNull(), attemptId: uuid("attempt_id").notNull(),
  bodySha256: text("body_sha256").notNull(), bodyShape: jsonb("body_shape").notNull(), createdAt: instant("created_at").notNull().defaultNow(),
}, (t) => [
  unique("subscription_payment_callback_digest_uq").on(t.attemptId, t.bodySha256),
  foreignKey({ name: "subscription_payment_callback_attempt_fk", columns: [t.storeId, t.attemptId], foreignColumns: [subscriptionPaymentAttempt.storeId, subscriptionPaymentAttempt.id] }),
  check("subscription_payment_callback_digest_chk", sql`${t.bodySha256} ~ '^[a-f0-9]{64}$'`),
]);

/**
 * Append-only history of subscriptions, invoices and attempts. Rows for invoice and attempt creation are written by triggers; the
 * rest by the platform services. The partial unique indexes make the entitlement and the paid settlement exactly-once.
 */
export const subscriptionEvent = pgTable("subscription_event", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(), storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
  kind: text("kind").notNull(), invoiceId: uuid("invoice_id"), attemptId: uuid("attempt_id"), fromStatus: text("from_status"), toStatus: text("to_status"),
  actor: text("actor").notNull(), detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`), createdAt: instant("created_at").notNull().defaultNow(),
}, (t) => [
  index("subscription_event_store_idx").on(t.storeId, t.id),
  uniqueIndex("subscription_event_coverage_uq").on(t.invoiceId).where(sql`${t.kind} = 'coverage_applied'`),
  uniqueIndex("subscription_event_paid_uq").on(t.attemptId).where(sql`${t.kind} = 'attempt_paid'`),
  check("subscription_event_kind_chk", sql`${t.kind} ~ '^[a-z][a-z_]{2,40}$'`),
]);

/** One dunning message intent per store, kind and reference: the unique key is what makes a replayed cycle send nothing twice. */
export const subscriptionNotice = pgTable("subscription_notice", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(), storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
  kind: text("kind", { enum: ["trial_ending", "invoice_ready", "past_due", "grace_ending", "suspended"] }).notNull(), ref: text("ref").notNull(),
  recipients: integer("recipients").notNull(), createdAt: instant("created_at").notNull().defaultNow(),
}, (t) => [unique("subscription_notice_uq").on(t.storeId, t.kind, t.ref), check("subscription_notice_recipients_chk", sql`${t.recipients} >= 0`)]);

/** Singleton platform controls: the billing-job freeze used after a restore (RUNBOOK) and the dunning switch (off until real mail delivery has evidence). */
export const billingControl = pgTable("billing_control", {
  id: integer("id").primaryKey().default(1), jobsFrozen: boolean("jobs_frozen").notNull().default(false), dunningEnabled: boolean("dunning_enabled").notNull().default(false),
  reason: text("reason"), changedBy: text("changed_by"), changedAt: instant("changed_at").notNull().defaultNow(),
}, (t) => [check("billing_control_singleton_chk", sql`${t.id} = 1`)]);
