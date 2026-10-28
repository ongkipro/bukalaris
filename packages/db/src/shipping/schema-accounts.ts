// T-48: one Bukalaris-managed account binding per store and kind. Credentials never belong to a seller DTO.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { store } from "../schema.ts";

export const SHIPPING_ACCOUNT_KINDS = ["partner_managed", "platform_master"] as const;
export type ShippingAccountKind = (typeof SHIPPING_ACCOUNT_KINDS)[number];
const at = (name: string) => timestamp(name, { withTimezone: true });
export const storeShippingAccount = pgTable("store_shipping_account", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
  kind: text("kind", { enum: SHIPPING_ACCOUNT_KINDS }).notNull(),
  status: text("status", { enum: ["pending", "active", "needs_key", "disabled"] }).notNull().default("pending"),
  externalUserId: text("external_user_id").notNull(),
  mengantarSellerId: text("mengantar_seller_id"),
  registeredEmail: text("registered_email"),
  sealedKey: text("sealed_key"),
  keyId: text("key_id"),
  sealedAt: at("sealed_at"),
  lastCheckedAt: at("last_checked_at"),
  lastResult: text("last_result"),
  provisioningUntil: at("provisioning_until"),
  nextRetryAt: at("next_retry_at"),
  /** Failed provisioning rounds since the last success or owner recovery: drives the exponential back-off and the per-store cap on repeated 409s. */
  registrationAttempts: integer("registration_attempts").notNull().default(0),
  revision: integer("revision").notNull().default(0),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("shipping_account_store_id_uq").on(t.storeId, t.id),
  unique("shipping_account_store_kind_uq").on(t.storeId, t.kind),
  unique("shipping_account_identity_uq").on(t.storeId, t.id, t.kind),
  check("shipping_account_kind_chk", sql`${t.kind} in ('partner_managed', 'platform_master')`),
  check("shipping_account_status_chk", sql`${t.status} in ('pending', 'active', 'needs_key', 'disabled')`),
  check("shipping_account_external_chk", sql`${t.externalUserId} = 'store:' || ${t.storeId}::text`),
  check("shipping_account_sealed_chk", sql`(${t.sealedKey} is null and ${t.keyId} is null and ${t.sealedAt} is null) or (${t.sealedKey} is not null and ${t.keyId} is not null and ${t.sealedAt} is not null and ${t.kind} = 'partner_managed')`),
  check("shipping_account_active_chk", sql`${t.status} <> 'active' or ${t.kind} = 'platform_master' or (${t.sealedKey} is not null and ${t.mengantarSellerId} is not null)`),
  check("shipping_account_attempts_chk", sql`${t.registrationAttempts} >= 0`),
]);

/** Named conservative settings; an empty/off cashback policy cannot invent provider income (D-22, OPEN-F9). */
export const shippingControl = pgTable("shipping_control", {
  key: text("key").primaryKey().default("default"),
  /** OPEN-F9: partner settlement is unverified, so new orders use the master account until the owner switches this on (four-eyes). */
  preferPartner: boolean("prefer_partner").notNull().default(false),
  discountIdr: bigint("discount_idr", { mode: "number" }).notNull().default(0),
  discountBps: integer("discount_bps").notNull().default(0),
  cashbackEnabled: boolean("cashback_enabled").notNull().default(false),
  revision: integer("revision").notNull().default(0),
  approvalRequestId: bigint("approval_request_id", { mode: "number" }),
  updatedBy: text("updated_by"),
  updatedAt: at("updated_at").notNull().defaultNow(),
}, (t) => [check("shipping_control_key_chk", sql`${t.key} = 'default'`), check("shipping_discount_chk", sql`${t.discountIdr} >= 0 and ${t.discountBps} between 0 and 10000`), check("shipping_cashback_dormant_chk", sql`not ${t.cashbackEnabled}`)]);

export const cashbackRule = pgTable("cashback_rule", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  courierCode: text("courier_code").notNull().default(""),
  serviceCode: text("service_code").notNull().default(""),
  sellerShareBps: integer("seller_share_bps").notNull().default(0),
  fixedSellerBonusIdr: bigint("fixed_seller_bonus_idr", { mode: "number" }).notNull().default(0),
  status: text("status", { enum: ["disabled", "active"] }).notNull().default("disabled"),
  revision: integer("revision").notNull().default(0),
  updatedBy: text("updated_by"),
  updatedAt: at("updated_at").notNull().defaultNow(),
}, (t) => [unique("cashback_rule_service_uq").on(t.courierCode, t.serviceCode), check("cashback_rule_values_chk", sql`${t.sellerShareBps} between 0 and 10000 and ${t.fixedSellerBonusIdr} >= 0`), check("cashback_rule_status_chk", sql`${t.status} in ('disabled', 'active')`)]);

/** Shared partner-wide request/registration budget, including Retry-After; no per-process counters. */
export const shippingPartnerBudget = pgTable("shipping_partner_budget", {
  key: text("key").primaryKey(),
  tokens: integer("tokens").notNull(),
  refilledAt: at("refilled_at").notNull(),
  dayStart: at("day_start").notNull(),
  registrations: integer("registrations").notNull().default(0),
  blockedUntil: at("blocked_until"),
}, (t) => [check("shipping_partner_budget_chk", sql`${t.key} = 'partner:mengantar' and ${t.tokens} between 0 and 60 and ${t.registrations} between 0 and 1000`)]);

export const shippingDispatchLease = pgTable("shipping_dispatch_lease", {
  key: text("key").primaryKey(),
  token: text("token").notNull(),
  expiresAt: at("expires_at").notNull(),
});
