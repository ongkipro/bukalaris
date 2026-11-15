// T-48: one Bukalaris-managed account binding per store and kind. Credentials never belong to a seller DTO.
// T-104 (ADR-0013 sections 1 and 2): `seller_owned` is the store's own Mengantar account. Its key is entered by the store owner with a fresh
// step-up, sealed under `shipping_credentials`, and the row carries a fixed `environment` instead of any provider URL.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { store } from "../schema.ts";

export const SHIPPING_ACCOUNT_KINDS = ["partner_managed", "platform_master", "seller_owned"] as const;
/** The kinds an order runs on today (T-48). A `seller_owned` account (T-104) carries orders only once T-105 routes them to it. */
export type ShippingAccountKind = "partner_managed" | "platform_master";
/** The only way a seller account names a provider origin: the platform maps it to a fixed origin from server configuration (ADR-0013 decision 10). */
export const PROVIDER_ENVIRONMENTS = ["sandbox", "production"] as const;
export type ProviderEnvironment = (typeof PROVIDER_ENVIRONMENTS)[number];
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
  /** `seller_owned` only (T-104). */
  environment: text("environment", { enum: PROVIDER_ENVIRONMENTS }),
  keyFingerprint: text("key_fingerprint"),
  keyHint: text("key_hint"),
  /** Set when the pickup address was registered with this account (T-105); cleared when the key changes to another account. */
  pickupRegisteredAt: at("pickup_registered_at"),
  /** The step-up proof consumed by the last key or environment change (provider_account_guard). */
  stepUpRef: uuid("step_up_ref"),
  revision: integer("revision").notNull().default(0),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("shipping_account_store_id_uq").on(t.storeId, t.id),
  unique("shipping_account_store_kind_uq").on(t.storeId, t.kind),
  unique("shipping_account_identity_uq").on(t.storeId, t.id, t.kind),
  check("shipping_account_kind_chk", sql`${t.kind} in ('partner_managed', 'platform_master', 'seller_owned')`),
  check("shipping_account_status_chk", sql`${t.status} in ('pending', 'active', 'needs_key', 'disabled')`),
  check("shipping_account_external_chk", sql`${t.externalUserId} = 'store:' || ${t.storeId}::text`),
  check("shipping_account_sealed_chk", sql`(${t.sealedKey} is null and ${t.keyId} is null and ${t.sealedAt} is null) or (${t.sealedKey} is not null and ${t.keyId} is not null and ${t.sealedAt} is not null and ${t.kind} in ('partner_managed', 'seller_owned'))`),
  check("shipping_account_active_chk", sql`${t.status} <> 'active' or ${t.kind} = 'platform_master' or (${t.sealedKey} is not null and (${t.mengantarSellerId} is not null or ${t.kind} = 'seller_owned'))`),
  // A seller-owned row: an environment always, `active` exactly while a key is sealed, and fingerprint and hint exactly with the key.
  check("shipping_account_seller_chk", sql`(${t.kind} = 'seller_owned') = (${t.environment} is not null) and (${t.environment} is null or ${t.environment} in ('sandbox', 'production'))
    and (${t.kind} <> 'seller_owned' or (${t.status} in ('active', 'needs_key') and (${t.status} = 'active') = (${t.sealedKey} is not null)))
    and (${t.sealedKey} is null or ${t.kind} <> 'seller_owned' or (${t.keyFingerprint} is not null and ${t.keyHint} is not null))
    and (${t.sealedKey} is not null or (${t.keyFingerprint} is null and ${t.keyHint} is null and ${t.pickupRegisteredAt} is null))`),
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
