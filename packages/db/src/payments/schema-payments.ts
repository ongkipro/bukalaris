import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { order, store } from "../schema.ts";
import { PROVIDER_ENVIRONMENTS } from "../shipping/schema-accounts.ts";
import type { PaymentCustomer, PaymentInstruction } from "./contract.ts";

/**
 * T-104 (ADR-0013 decisions 2, 5, 8, 10 and 13): the store's own AutoLaris H2H connection, one per store. The key is sealed under the
 * `payment_credentials` keyring and opened only inside the server-side provider client; the application role never holds SELECT on the
 * sealed columns (it reads them only through `provider_key_envelope`, for its own store). No provider URL column exists: `environment`
 * maps to a fixed origin in server configuration. The readiness inputs of decision 13 sit next to the key.
 */
export const storePaymentAccount = pgTable("store_payment_account", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
  environment: text("environment", { enum: PROVIDER_ENVIRONMENTS }).notNull(),
  status: text("status", { enum: ["active", "needs_key"] }).notNull().default("needs_key"),
  sealedKey: text("sealed_key"),
  keyId: text("key_id"),
  sealedAt: timestamp("sealed_at", { withTimezone: true }),
  keyFingerprint: text("key_fingerprint"),
  keyHint: text("key_hint"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastResult: text("last_result"),
  /** Decision 13: the AutoLaris order fields the account needs, the sender address and the recorded payment-only profile confirmation. */
  originAreaId: text("origin_area_id"),
  destinationAreaId: text("destination_area_id"),
  shipperEmail: text("shipper_email"),
  senderAddress: text("sender_address"),
  paymentOnlyConfirmedAt: timestamp("payment_only_confirmed_at", { withTimezone: true }),
  paymentOnlyConfirmedBy: text("payment_only_confirmed_by"),
  stepUpRef: uuid("step_up_ref"),
  revision: integer("revision").notNull().default(0),
  /** T-106 (ADR-0013 section 4, decision 18): the seller's AutoLaris master switch, excluded channels and who bears the payment fee. */
  enabled: boolean("enabled").notNull().default(true),
  excludedChannels: text("excluded_channels").array().notNull().default(sql`'{}'::text[]`),
  feeBearer: text("fee_bearer", { enum: ["buyer", "seller"] }).notNull().default("buyer"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("payment_account_store_uq").on(t.storeId),
  unique("payment_account_store_id_uq").on(t.storeId, t.id),
  check("payment_account_env_chk", sql`${t.environment} in ('sandbox', 'production') and ${t.status} in ('active', 'needs_key')`),
  check("payment_account_sealed_chk", sql`(${t.status} = 'active') = (${t.sealedKey} is not null)
    and ((${t.sealedKey} is null and ${t.keyId} is null and ${t.sealedAt} is null and ${t.keyFingerprint} is null and ${t.keyHint} is null)
      or (${t.sealedKey} is not null and ${t.keyId} is not null and ${t.sealedAt} is not null and ${t.keyFingerprint} is not null and ${t.keyHint} is not null))`),
  check("payment_account_result_chk", sql`${t.lastResult} is null or ${t.lastResult} in ('ready', 'AUTH_FAILED', 'PROVIDER_UNAVAILABLE', 'INVALID_RESPONSE')`),
  check("payment_account_fields_chk", sql`(${t.originAreaId} is null or ${t.originAreaId} ~ '^[A-Za-z0-9_-]{1,64}$') and (${t.destinationAreaId} is null or ${t.destinationAreaId} ~ '^[A-Za-z0-9_-]{1,64}$')
    and (${t.shipperEmail} is null or length(${t.shipperEmail}) between 3 and 254) and (${t.senderAddress} is null or length(${t.senderAddress}) between 10 and 500)
    and ((${t.paymentOnlyConfirmedAt} is null) = (${t.paymentOnlyConfirmedBy} is null))`),
  check("payment_account_prefs_chk", sql`${t.feeBearer} in ('buyer', 'seller') and cardinality(${t.excludedChannels}) <= 40`),
]);

/** Buyer-order attempts only. Subscription attempts remain separate rows/tables (T-50). */
export const paymentAttempt = pgTable("payment_attempt", {
  id: uuid("id").primaryKey().defaultRandom(), storeId: bigint("store_id", { mode: "number" }).notNull(), orderId: bigint("order_id", { mode: "number" }).notNull(),
  ownerKind: text("owner_kind").notNull().default("order"), ownerId: text("owner_id").notNull(),
  requestKey: text("request_key").notNull(), reffId: text("reff_id").notNull().unique(), channelCode: text("channel_code").notNull(),
  customer: jsonb("customer").$type<PaymentCustomer>().notNull(),
  amountIdr: bigint("amount_idr", { mode: "number" }).notNull(), adminFeeIdr: bigint("admin_fee_idr", { mode: "number" }).notNull(), totalIdr: bigint("total_idr", { mode: "number" }).notNull(),
  providerFeeIdr: bigint("provider_fee_idr", { mode: "number" }), transactionId: text("transaction_id").unique(), instruction: jsonb("instruction").$type<PaymentInstruction>(),
  requestState: text("request_state", { enum: ["in_progress", "accepted", "failed", "unknown"] }).notNull().default("in_progress"),
  status: text("status", { enum: ["pending", "paid", "unknown"] }).notNull().default("pending"),
  revision: integer("revision").notNull().default(1), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  advicePolls: integer("advice_polls").notNull().default(0), nextAdviceAt: timestamp("next_advice_at", { withTimezone: true }).notNull(), finalAdviceAt: timestamp("final_advice_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * T-106 (ADR-0013 decisions 2, 11, 18 and 21): the attempt number of its order (a retry is a new attempt, the old one is kept), the store's
   * own AutoLaris account it was created under (null = the platform account of T-49), that account's environment (`sandbox` = a test order),
   * and the frozen fee decision: who bears the fee, the fee-rate version and the fee the provider is expected to charge.
   */
  attemptNo: integer("attempt_no").notNull().default(1),
  paymentAccountId: bigint("payment_account_id", { mode: "number" }),
  environment: text("environment", { enum: PROVIDER_ENVIRONMENTS }),
  feeBearer: text("fee_bearer", { enum: ["buyer", "seller"] }).notNull().default("buyer"),
  feeRateVersion: integer("fee_rate_version"),
  expectedFeeIdr: bigint("expected_fee_idr", { mode: "number" }),
}, (t) => [
  unique("payment_attempt_order_no_uq").on(t.storeId, t.orderId, t.attemptNo), unique("payment_attempt_request_uq").on(t.storeId, t.requestKey), unique("payment_attempt_store_id_uq").on(t.storeId, t.id),
  foreignKey({ name: "payment_attempt_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
  foreignKey({ name: "payment_attempt_account_fk", columns: [t.storeId, t.paymentAccountId], foreignColumns: [storePaymentAccount.storeId, storePaymentAccount.id] }),
  check("payment_attempt_account_chk", sql`${t.attemptNo} >= 1 and (${t.paymentAccountId} is null) = (${t.environment} is null) and (${t.paymentAccountId} is not null or ${t.attemptNo} = 1)
    and ${t.feeBearer} in ('buyer', 'seller') and (${t.expectedFeeIdr} is null or ${t.expectedFeeIdr} >= 0) and (${t.feeBearer} = 'buyer' or ${t.adminFeeIdr} = 0)`),
  index("payment_attempt_check_idx").on(t.paymentAccountId, t.nextAdviceAt),
  check("payment_attempt_owner_chk", sql`${t.ownerKind} = 'order' and ${t.ownerId} = ${t.orderId}::text`),
  check("payment_attempt_amount_chk", sql`${t.amountIdr} >= 0 and ${t.adminFeeIdr} >= 0 and ${t.totalIdr} = ${t.amountIdr} + ${t.adminFeeIdr} and ${t.totalIdr} <= 9007199254740991 and (${t.providerFeeIdr} is null or ${t.providerFeeIdr} >= 0)`),
  check("payment_attempt_state_chk", sql`${t.requestState} in ('in_progress','accepted','failed','unknown') and ${t.status} in ('pending','paid','unknown') and ${t.revision} > 0 and ${t.advicePolls} >= 0`),
  check("payment_attempt_accepted_chk", sql`(${t.requestState} <> 'accepted' or (${t.transactionId} is not null and ${t.instruction} is not null)) and (${t.status} <> 'paid' or ${t.paidAt} is not null)`),
  index("payment_attempt_poll_idx").on(t.nextAdviceAt),
]);
export const paymentAttemptEvent = pgTable("payment_attempt_event", {
  storeId: bigint("store_id", { mode: "number" }).notNull(), attemptId: uuid("attempt_id").notNull(), revision: integer("revision").notNull(), kind: text("kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.attemptId, t.revision] }), foreignKey({ name: "payment_event_attempt_fk", columns: [t.storeId, t.attemptId], foreignColumns: [paymentAttempt.storeId, paymentAttempt.id] })]);

/** Platform-only ingress evidence: sellers never receive callback bodies or signatures. Digest survives redaction. */
export const paymentCallback = pgTable("payment_callback", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(), storeId: bigint("store_id", { mode: "number" }).notNull(), attemptId: uuid("attempt_id").notNull(),
  bodySha256: text("body_sha256").notNull(), rawBody: text("raw_body"), bodyShape: jsonb("body_shape").notNull(), quarantined: text("quarantined"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), redactedAt: timestamp("redacted_at", { withTimezone: true }),
}, (t) => [unique("payment_callback_digest_uq").on(t.attemptId, t.bodySha256), foreignKey({ name: "payment_callback_attempt_fk", columns: [t.storeId, t.attemptId], foreignColumns: [paymentAttempt.storeId, paymentAttempt.id] }), check("payment_callback_digest_chk", sql`${t.bodySha256} ~ '^[a-f0-9]{64}$'`)]);
export const paymentObservation = pgTable("payment_observation", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(), storeId: bigint("store_id", { mode: "number" }).notNull(), attemptId: uuid("attempt_id").notNull(),
  source: text("source").notNull(), classification: text("classification").notNull(), responseSha256: text("response_sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** T-106 (decision 22): the provider's status word as received (bounded token), so an unknown word is recorded and reviewed, never settled. */
  statusWord: text("status_word"),
}, (t) => [foreignKey({ name: "payment_observation_attempt_fk", columns: [t.storeId, t.attemptId], foreignColumns: [paymentAttempt.storeId, paymentAttempt.id] }), check("payment_observation_class_chk", sql`${t.classification} in ('paid','pending','unknown')`),
  check("payment_observation_word_chk",
    sql`${t.statusWord} is null or ${t.statusWord} ~ '^[A-Za-z0-9 _.-]{1,64}$'`)]); // separate line: the T-65 tax-literal scan reads "observation" as "vat"
/** Durable buyer refund obligation only; disbursement/approval lives in T-37, never a seller credit. */
export const latePaymentObligation = pgTable("late_payment_obligation", {
  attemptId: uuid("attempt_id").primaryKey(), storeId: bigint("store_id", { mode: "number" }).notNull(), orderId: bigint("order_id", { mode: "number" }).notNull(),
  amountIdr: bigint("amount_idr", { mode: "number" }).notNull(), status: text("status").notNull().default("open"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [foreignKey({ name: "late_payment_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }), foreignKey({ name: "late_payment_attempt_fk", columns: [t.storeId, t.attemptId], foreignColumns: [paymentAttempt.storeId, paymentAttempt.id] }), check("late_payment_obligation_chk", sql`${t.amountIdr} >= 0 and ${t.status} = 'open'`)]);


// ── T-106 (ADR-0013 sections 4 to 6, decision 34, C-P10) ─────────────────────────────────────────────────────────────
/**
 * Decision 24: the seller's confirmation of a payment by hand, one append-only record per attempt (never edited or deleted; a trigger refuses
 * both). Four-eyes does not apply: it is the seller's own money. Retention class: kept with the order (financial record).
 */
export const paymentManualConfirmation = pgTable("payment_manual_confirmation", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(), storeId: bigint("store_id", { mode: "number" }).notNull(), attemptId: uuid("attempt_id").notNull(),
  orderId: bigint("order_id", { mode: "number" }).notNull(), confirmedBy: text("confirmed_by").notNull(), reason: text("reason").notNull(), evidence: text("evidence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("payment_manual_attempt_uq").on(t.attemptId),
  foreignKey({ name: "payment_manual_attempt_fk", columns: [t.storeId, t.attemptId], foreignColumns: [paymentAttempt.storeId, paymentAttempt.id] }),
  foreignKey({ name: "payment_manual_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
  check("payment_manual_text_chk", sql`length(${t.reason}) between 5 and 500 and length(${t.evidence}) between 3 and 500`),
]);
/** Decision 27 (T-91 direction change): a second settled attempt on one order, or a payment settled after the order closed, raised for the seller. */
export const paymentAnomaly = pgTable("payment_anomaly", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(), storeId: bigint("store_id", { mode: "number" }).notNull(), orderId: bigint("order_id", { mode: "number" }).notNull(),
  attemptId: uuid("attempt_id").notNull(), kind: text("kind", { enum: ["second_settled", "paid_after_close"] }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("payment_anomaly_uq").on(t.attemptId, t.kind),
  foreignKey({ name: "payment_anomaly_attempt_fk", columns: [t.storeId, t.attemptId], foreignColumns: [paymentAttempt.storeId, paymentAttempt.id] }),
  check("payment_anomaly_kind_chk", sql`${t.kind} in ('second_settled', 'paid_after_close')`),
]);
/** Decision 4 table "Payment channel locked": channels the platform never offers (a row = locked). Owner console writes, every store reads. */
export const paymentChannelLock = pgTable("payment_channel_lock", {
  channelCode: text("channel_code").primaryKey(), reason: text("reason").notNull(), lockedBy: text("locked_by").notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("payment_channel_lock_chk", sql`${t.channelCode} ~ '^[A-Z0-9_-]{1,40}$' and length(${t.reason}) between 3 and 500`)]);
/**
 * Decision 19: provider fee rates as versioned platform settings (append-only; the current schedule is the highest version). Version 1 is the
 * starting data seen in the reference system, UNVERIFIED with the provider.
 */
export const paymentFeeRate = pgTable("payment_fee_rate", {
  version: integer("version").notNull(), channelCode: text("channel_code").notNull(), base: text("base", { enum: ["goods_omset", "payable", "flat"] }).notNull(),
  rateBps: integer("rate_bps").notNull(), fixedIdr: bigint("fixed_idr", { mode: "number" }).notNull(), createdBy: text("created_by").notNull(), reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "payment_fee_rate_pk", columns: [t.version, t.channelCode] }),
  check("payment_fee_rate_chk", sql`${t.version} >= 1 and ${t.channelCode} ~ '^[A-Z0-9_-]{1,40}$' and ${t.base} in ('goods_omset', 'payable', 'flat') and ${t.rateBps} between 0 and 10000
    and ${t.fixedIdr} between 0 and 1000000 and (${t.base} <> 'flat' or ${t.rateBps} = 0) and length(${t.reason}) between 3 and 500`),
]);
/**
 * Decision 34 / C-P4: production calls on seller AutoLaris keys are off until the Owner console switches them on, which it can only after a
 * recorded sandbox pass. One row, seeded off.
 */
export const paymentProductionSwitch = pgTable("payment_production_switch", {
  provider: text("provider").primaryKey(), enabled: boolean("enabled").notNull().default(false),
  sandboxPassAt: timestamp("sandbox_pass_at", { withTimezone: true }), sandboxPassEvidence: text("sandbox_pass_evidence"),
  updatedBy: text("updated_by"), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), revision: integer("revision").notNull().default(0),
}, (t) => [check("payment_production_switch_chk", sql`${t.provider} = 'autolaris' and (not ${t.enabled} or ${t.sandboxPassAt} is not null)
  and ((${t.sandboxPassAt} is null) = (${t.sandboxPassEvidence} is null)) and (${t.sandboxPassEvidence} is null or length(${t.sandboxPassEvidence}) between 3 and 500)`)]);

// ── T-113 (ADR-0013 section 10, decisions 35 to 39, D-31, D-32, D-33): bank transfer to the seller's own bank account ──────────────
/** A destination account as the buyer sees it, frozen on the order at submit (a later change of the store's list never alters an order). */
export type BankAccountSnapshot = { bankCode: string; accountNumber: string; holderName: string };
/** One stored proof image: a random private key (never a request value), the sniffed type, its size and digest. */
export type ProofFile = { key: string; mime: "image/jpeg" | "image/png" | "image/webp"; bytes: number; sha256: string };

/**
 * Decision 36: the store's destination accounts, at most five listed at a time. Listing and removing need `integrations.manage` and a fresh
 * step-up consumed in the same transaction (the guard re-checks it), and are audited. A removal is a stamp, never a DELETE: the row stays as the
 * record of what buyers were shown, and the store's money mode never goes back (`store_money_mode` counts every row, D-36).
 */
export const storeBankAccount = pgTable("store_bank_account", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
  bankCode: text("bank_code").notNull(),
  accountNumber: text("account_number").notNull(),
  holderName: text("holder_name").notNull(),
  createdBy: text("created_by").notNull(),
  stepUpRef: uuid("step_up_ref").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  removedBy: text("removed_by"),
  removalStepUpRef: uuid("removal_step_up_ref"),
}, (t) => [
  unique("bank_account_store_id_uq").on(t.storeId, t.id),
  index("bank_account_store_idx").on(t.storeId, t.removedAt),
  // One step-up proof authorises one change: a single proof can never list or remove several accounts.
  unique("bank_account_step_up_uq").on(t.stepUpRef),
  uniqueIndex("bank_account_removal_step_up_uq").on(t.removalStepUpRef).where(sql`${t.removalStepUpRef} is not null`),
  check("bank_account_fields_chk", sql`${t.bankCode} ~ '^[A-Z0-9]{2,12}$' and ${t.accountNumber} ~ '^[0-9]{5,24}$' and length(btrim(${t.holderName})) between 2 and 120
    and ((${t.removedAt} is null) = (${t.removedBy} is null)) and ((${t.removedAt} is null) = (${t.removalStepUpRef} is null))`),
]);

/** Decision 39a and 37: the store switch for bank transfer and its payment window (hours an unpaid order keeps its stock). No row = on, 24 hours. */
export const storeBankTransfer = pgTable("store_bank_transfer", {
  storeId: bigint("store_id", { mode: "number" }).primaryKey().references(() => store.id),
  enabled: boolean("enabled").notNull().default(true),
  paymentWindowHours: integer("payment_window_hours").notNull().default(24),
  revision: integer("revision").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("bank_transfer_window_chk", sql`${t.paymentWindowHours} between 1 and 168 and ${t.revision} >= 0`)]);

/** Decision 37: what a bank-transfer order froze at submit: the destination accounts shown to the buyer and when the unpaid order expires. Immutable. */
export const orderBankTransfer = pgTable("order_bank_transfer", {
  storeId: bigint("store_id", { mode: "number" }).notNull(),
  orderId: bigint("order_id", { mode: "number" }).notNull(),
  accounts: jsonb("accounts").$type<BankAccountSnapshot[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "order_bank_transfer_pk", columns: [t.storeId, t.orderId] }),
  foreignKey({ name: "order_bank_transfer_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
  index("order_bank_transfer_expiry_idx").on(t.expiresAt),
  check("order_bank_transfer_chk", sql`jsonb_typeof(${t.accounts}) = 'array' and jsonb_array_length(${t.accounts}) between 1 and 5 and ${t.expiresAt} > ${t.createdAt}`),
]);

/**
 * Decisions 37 to 39 (D-32): one proof submission of the buyer, up to three private images. It never changes the order: the seller accepts it
 * (by confirming the payment) or rejects it with a reason, after which the buyer may send a new one. At most one submission waits at a time.
 * The cleanup job deletes the files 90 days after the order closes (retention class `payment_proof`, D-33) and keeps the row.
 */
export const paymentProof = pgTable("payment_proof", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: bigint("store_id", { mode: "number" }).notNull(),
  orderId: bigint("order_id", { mode: "number" }).notNull(),
  files: jsonb("files").$type<ProofFile[]>().notNull(),
  status: text("status", { enum: ["sent", "accepted", "rejected"] }).notNull().default("sent"),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  rejectReason: text("reject_reason"),
  filesPurgedAt: timestamp("files_purged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("payment_proof_store_id_uq").on(t.storeId, t.id),
  uniqueIndex("payment_proof_one_sent_uq").on(t.storeId, t.orderId).where(sql`${t.status} = 'sent'`),
  foreignKey({ name: "payment_proof_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
  check("payment_proof_chk", sql`${t.status} in ('sent', 'accepted', 'rejected') and jsonb_typeof(${t.files}) = 'array'
    and (jsonb_array_length(${t.files}) between 1 and 3 or (${t.filesPurgedAt} is not null and jsonb_array_length(${t.files}) = 0))
    and ((${t.status} = 'sent') = (${t.decidedAt} is null)) and ((${t.decidedAt} is null) = (${t.decidedBy} is null))
    and ((${t.status} = 'rejected') = (${t.rejectReason} is not null)) and (${t.rejectReason} is null or length(btrim(${t.rejectReason})) between 5 and 500)`),
]);

/**
 * Decision 38: the only way a bank-transfer order becomes paid. One append-only record per order: who confirmed, why, and the proof the seller
 * looked at (none when the money is visible in the seller's bank without one). The database refuses `awaiting_payment -> placed` for a
 * bank-transfer order without it, for every role.
 */
export const bankTransferConfirmation = pgTable("bank_transfer_confirmation", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  storeId: bigint("store_id", { mode: "number" }).notNull(),
  orderId: bigint("order_id", { mode: "number" }).notNull(),
  proofId: uuid("proof_id"),
  confirmedBy: text("confirmed_by").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("bank_transfer_confirmation_order_uq").on(t.storeId, t.orderId),
  foreignKey({ name: "bank_transfer_confirmation_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
  foreignKey({ name: "bank_transfer_confirmation_proof_fk", columns: [t.storeId, t.proofId], foreignColumns: [paymentProof.storeId, paymentProof.id] }),
  check("bank_transfer_confirmation_chk", sql`length(btrim(${t.reason})) between 5 and 500`),
]);
