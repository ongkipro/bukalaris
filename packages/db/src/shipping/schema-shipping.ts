// M2 shipping track tables (see AGENTS.md "Parallel tracks"). Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { store } from "../schema.ts";

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
