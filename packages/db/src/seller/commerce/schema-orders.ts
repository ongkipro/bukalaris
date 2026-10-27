// M2 orders track tables (see AGENTS.md "Parallel tracks"). Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
