// M2 orders track tables (see AGENTS.md "Parallel tracks"). Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { order, variant } from "../../schema.ts";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** One row per order status transition, written in the same transaction as the transition (IAM-5). */
export const orderStatusHistory = pgTable(
  "order_status_history",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    orderId: bigint("order_id", { mode: "number" }).notNull(),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    /** Tracking number, cancellation reason or payment note; free text shown to the seller. */
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "order_status_history_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    index("order_status_history_order_idx").on(t.storeId, t.orderId),
  ],
);

/** Every manual stock movement (seller adjustment or cancellation restock), with actor and reason. */
export const stockAdjustment = pgTable(
  "stock_adjustment",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    variantId: bigint("variant_id", { mode: "number" }).notNull(),
    delta: integer("delta").notNull(),
    reason: text("reason").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    /** Set when the movement is a cancellation restock. */
    orderId: bigint("order_id", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "stock_adjustment_variant_fk", columns: [t.storeId, t.variantId], foreignColumns: [variant.storeId, variant.id] }),
    foreignKey({ name: "stock_adjustment_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    index("stock_adjustment_variant_idx").on(t.storeId, t.variantId),
    check("stock_adjustment_delta_chk", sql`${t.delta} <> 0`),
  ],
);

/** T-107: how the seller paid a refund back (labels in Seller Admin). */
export const SELLER_REFUND_METHODS = ["bank_transfer", "autolaris", "cash", "other"] as const;
export type SellerRefundMethod = (typeof SELLER_REFUND_METHODS)[number];

/**
 * T-107 (ADR-0013 decision 26, C-P9): a refund the SELLER made outside Bukalaris, recorded on an order of a store on its own accounts. A record
 * only: Bukalaris moves no money and calls no refund endpoint. Append-only; the database refuses a record for a platform-held order, for an order
 * that was never paid and above the buyer's bill (`order_seller_refund_guard`, migration 0021).
 */
export const orderSellerRefund = pgTable(
  "order_seller_refund",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    orderId: bigint("order_id", { mode: "number" }).notNull(),
    amountIdr: bigint("amount_idr", { mode: "number" }).notNull(),
    /** The day the seller paid the refund (WIB calendar day, typed by the seller). */
    refundedOn: date("refunded_on").notNull(),
    method: text("method", { enum: SELLER_REFUND_METHODS }).notNull(),
    /** The seller's own transfer reference, optional. */
    reference: text("reference"),
    reason: text("reason").notNull(),
    recordedByUserId: text("recorded_by_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "order_seller_refund_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    index("order_seller_refund_order_idx").on(t.storeId, t.orderId),
    check(
      "order_seller_refund_chk",
      sql`${t.amountIdr} > 0 and ${t.method} in ('bank_transfer', 'autolaris', 'cash', 'other') and length(${t.reason}) between 5 and 500 and (${t.reference} is null or length(${t.reference}) between 1 and 120)`,
    ),
  ],
);
