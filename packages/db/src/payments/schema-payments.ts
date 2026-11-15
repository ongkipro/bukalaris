import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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
}, (t) => [
  unique("payment_attempt_order_uq").on(t.storeId, t.orderId), unique("payment_attempt_request_uq").on(t.storeId, t.requestKey), unique("payment_attempt_store_id_uq").on(t.storeId, t.id),
  foreignKey({ name: "payment_attempt_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
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
}, (t) => [foreignKey({ name: "payment_observation_attempt_fk", columns: [t.storeId, t.attemptId], foreignColumns: [paymentAttempt.storeId, paymentAttempt.id] }), check("payment_observation_class_chk", sql`${t.classification} in ('paid','pending','unknown')`)]);
/** Durable buyer refund obligation only; disbursement/approval lives in T-37, never a seller credit. */
export const latePaymentObligation = pgTable("late_payment_obligation", {
  attemptId: uuid("attempt_id").primaryKey(), storeId: bigint("store_id", { mode: "number" }).notNull(), orderId: bigint("order_id", { mode: "number" }).notNull(),
  amountIdr: bigint("amount_idr", { mode: "number" }).notNull(), status: text("status").notNull().default("open"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [foreignKey({ name: "late_payment_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }), foreignKey({ name: "late_payment_attempt_fk", columns: [t.storeId, t.attemptId], foreignColumns: [paymentAttempt.storeId, paymentAttempt.id] }), check("late_payment_obligation_chk", sql`${t.amountIdr} >= 0 and ${t.status} = 'open'`)]);
