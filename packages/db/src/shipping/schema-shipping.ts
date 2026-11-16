// M2 shipping track tables (see AGENTS.md "Parallel tracks"). Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { store } from "../schema.ts";
import { PROVINCE_CODES } from "./provinces.ts";

const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Platform shipping margin (Q-12): one row, edited by operators, audited in audit_log.
 * buyer fee = roundUp(provider cost + fixed_idr + ceil(provider cost × percent_bps / 10000), round_to).
 */
export const shippingMarginRule = pgTable(
  "shipping_margin_rule",
  {
    key: text("key").primaryKey().default("default"),
    fixedIdr: bigint("fixed_idr", { mode: "number" }).notNull().default(0),
    /** Basis points: 100 = 1 %. */
    percentBps: integer("percent_bps").notNull().default(0),
    /** Buyer fee rounds up to a multiple of this (IDR). */
    roundTo: integer("round_to").notNull().default(500),
    approvalRequestId: bigint("approval_request_id", { mode: "number" }),
    /** Bumped by every approved change; the four-eyes approval is bound to the revision it was requested against (a stale approval can never overwrite a later one). */
    revision: integer("revision").notNull().default(0),
    updatedBy: text("updated_by"),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("shipping_margin_rule_key_chk", sql`${t.key} = 'default'`),
    check(
      "shipping_margin_rule_values_chk",
      sql`${t.fixedIdr} >= 0 and ${t.percentBps} between 0 and 10000 and ${t.roundTo} in (1, 100, 500, 1000)`,
    ),
  ],
);

/** The store's pickup origin: a provider AREA id (not a provider pickup-address id) plus local address text. */
export const storePickupArea = pgTable("store_pickup_area", {
  storeId: bigint("store_id", { mode: "number" }).primaryKey().references(() => store.id),
  areaId: text("area_id").notNull(),
  areaLabel: text("area_label").notNull(),
  addressText: text("address_text").notNull().default(""),
  updatedBy: text("updated_by").notNull(),
  updatedAt: updatedAt(),
});

// ── T-105 (ADR-0013 sections 4 and 9): the seller's own courier filters, the store's COD settings, the provider-area province cache and the
// per-provider production switch. Every filter is read again at order submit (`shipping/rules.ts`).

const codeList = (codes: readonly string[]) => sql.raw(`array[${codes.map((c) => `'${c}'`).join(", ")}]::text[]`);

/** Seller, per courier service (the provider's estimate key, as snapshotted on the order). A courier WITHOUT a row is closed (decision table row 1). */
export const storeCourierRule = pgTable(
  "store_courier_rule",
  {
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    courierCode: text("courier_code").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    codEnabled: boolean("cod_enabled").notNull().default(false),
    /** Set when the provider refused COD for this seller on this courier; the courier's COD was switched off then. Only the seller turns it back on. */
    codRefusedAt: timestamp("cod_refused_at", { withTimezone: true }),
    updatedBy: text("updated_by").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "store_courier_rule_pk", columns: [t.storeId, t.courierCode] }),
    check("store_courier_rule_code_chk", sql`${t.courierCode} ~ '^[A-Za-z0-9_-]{1,40}$'`),
  ],
);

/** Seller, per store: COD on/off (on by default once shipping is ready), who bears the COD fee, and the COD-blocked provinces (empty until chosen). */
export const storeShippingSetting = pgTable(
  "store_shipping_setting",
  {
    storeId: bigint("store_id", { mode: "number" }).primaryKey().references(() => store.id),
    codEnabled: boolean("cod_enabled").notNull().default(true),
    codFeeBearer: text("cod_fee_bearer", { enum: ["buyer", "seller"] }).notNull().default("buyer"),
    codBlockedProvinces: text("cod_blocked_provinces").array().notNull().default(sql`'{}'::text[]`),
    revision: integer("revision").notNull().default(0),
    updatedBy: text("updated_by").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("store_shipping_setting_bearer_chk", sql`${t.codFeeBearer} in ('buyer', 'seller')`),
    check("store_shipping_setting_provinces_chk", sql`${t.codBlockedProvinces} <@ ${codeList(PROVINCE_CODES)}`),
  ],
);

/**
 * The province name a provider area search returned for an area id, per provider environment (sandbox and production are separate
 * deployments; one never overwrites the other). Written only from provider answers; an id never seen has no province (COD refused).
 */
export const shippingArea = pgTable(
  "shipping_area",
  {
    areaId: text("area_id").notNull(),
    environment: text("environment", { enum: ["sandbox", "production"] }).notNull(),
    provinceName: text("province_name"),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "shipping_area_pk", columns: [t.areaId, t.environment] }),
    check("shipping_area_id_chk", sql`${t.areaId} ~ '^[a-f0-9]{24}$' and ${t.environment} in ('sandbox', 'production') and (${t.provinceName} is null or length(${t.provinceName}) <= 80)`),
  ],
);

/**
 * ADR-0013 decision 34 (C-P4): calls on sellers' PRODUCTION keys are switched on per provider in the Owner console, off by default, and only
 * after a recorded sandbox pass. A missing row is "off, no pass".
 */
export const providerLiveSetting = pgTable(
  "provider_live_setting",
  {
    provider: text("provider", { enum: ["mengantar", "autolaris"] }).primaryKey(),
    sandboxPassedAt: timestamp("sandbox_passed_at", { withTimezone: true }),
    sandboxPassNote: text("sandbox_pass_note"),
    sandboxPassBy: text("sandbox_pass_by"),
    productionEnabled: boolean("production_enabled").notNull().default(false),
    revision: integer("revision").notNull().default(0),
    updatedBy: text("updated_by").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("provider_live_setting_provider_chk", sql`${t.provider} in ('mengantar', 'autolaris')`),
    check("provider_live_setting_pass_chk", sql`(${t.sandboxPassedAt} is null) = (${t.sandboxPassNote} is null) and (${t.sandboxPassedAt} is null) = (${t.sandboxPassBy} is null)`),
    check("provider_live_setting_switch_chk", sql`not ${t.productionEnabled} or ${t.sandboxPassedAt} is not null`),
  ],
);
