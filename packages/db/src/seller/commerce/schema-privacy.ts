// M2 privacy track (T-43, SEC-19, PRIV-4): the irreversible per-order record of a buyer-data
// redaction. Re-exported by schema.ts. RLS + grants live in the hand-written migration
// 0009_privacy_rls.sql (docs/tracks/privacy.md).
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { order } from "../../schema.ts";

export const REDACTION_SOURCES = ["seller", "retention"] as const;
export type RedactionSource = (typeof REDACTION_SOURCES)[number];

/**
 * One row per redacted order, written in the same transaction as the redaction itself.
 * Its presence is the idempotency marker (a redacted order is never rewritten) and the
 * per-order audit (who, when, override + reason). The batch summary with counts goes to
 * `audit_log` (`privacy.redact`).
 */
export const orderRedaction = pgTable(
  "order_redaction",
  {
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    orderId: bigint("order_id", { mode: "number" }).notNull(),
    /** Seller user id, or `system:retention` for the cleanup job. */
    actorUserId: text("actor_user_id").notNull(),
    source: text("source", { enum: REDACTION_SOURCES }).notNull(),
    /** True when the owner redacted an order that was not yet completed/cancelled. */
    override: boolean("override").notNull().default(false),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.storeId, t.orderId] }),
    foreignKey({ name: "order_redaction_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    check("order_redaction_source_chk", sql`${t.source} in ('seller', 'retention')`),
    check("order_redaction_override_chk", sql`not ${t.override} or ${t.reason} is not null`),
  ],
);
