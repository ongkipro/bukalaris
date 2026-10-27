// M2 wave-4 fulfillment track (T-39): one provider shipment per order. Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { order, store } from "../schema.ts";

/**
 * Booking states (`queued` → `booking` → `booked` | `awaiting_balance` | `failed`) followed by the
 * tracking states the provider status category maps to. `delivered`, `returned`, `cancelled`
 * and `failed` are terminal for polling; `awaiting_balance` and `failed` accept a seller retry.
 */
export const SHIPMENT_STATUSES = ["queued", "booking", "awaiting_balance", "booked", "in_transit", "delivered", "returned", "problem", "cancelled", "failed"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_STATUS_LABEL: Record<ShipmentStatus, string> = {
  queued: "Menunggu booking",
  booking: "Sedang booking",
  awaiting_balance: "Menunggu saldo Mengantar",
  booked: "Resi terbit, menunggu pickup",
  in_transit: "Dalam pengiriman",
  delivered: "Terkirim ke pembeli",
  returned: "Dikembalikan ke pengirim (RTS)",
  problem: "Perlu perhatian",
  cancelled: "Dibatalkan di Mengantar",
  failed: "Booking gagal",
};

/** One provider tracking line as stored (provider `history[].date` is `DD-MM-YYYY HH:mm` WIB; kept verbatim). */
export type TrackingEvent = { at: string; desc: string };

/**
 * Store-scoped shipment record linked to the order's shipping snapshot (TEN-1, DATA-2). Exactly
 * one per order (`shipment_order_uq`): the booking job is idempotent on this row, never on the
 * provider. Buyer data is not copied here; the handler re-reads the order.
 */
export const shipment = pgTable(
  "shipment",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    orderId: bigint("order_id", { mode: "number" }).notNull(),
    /** Seller who requested the booking; actor of the system transitions (shipped, completed). */
    requestedBy: text("requested_by").notNull(),
    status: text("status", { enum: SHIPMENT_STATUSES }).notNull().default("queued"),
    // Snapshot copied from the order at request time (what was booked, even if the order changes later).
    courierCode: text("courier_code").notNull(),
    originAreaId: text("origin_area_id").notNull(),
    destinationAreaId: text("destination_area_id").notNull(),
    weightKg: integer("weight_kg").notNull(),
    /** Integer IDR the courier collects; 0 for prepaid shipments. */
    codAmount: bigint("cod_amount", { mode: "number" }).notNull().default(0),
    // Provider references.
    providerOrderId: text("provider_order_id"),
    providerBatchId: text("provider_batch_id"),
    /** Resi / cnote; null while unpaid or not yet issued. */
    trackingNumber: text("tracking_number"),
    /** Raw provider status category (e.g. `ON DELIVERY`); labels come from `PROVIDER_STATUS_LABEL`. */
    providerStatus: text("provider_status"),
    paid: boolean("paid").notNull().default(false),
    trackingHistory: jsonb("tracking_history").$type<TrackingEvent[]>().notNull().default([]),
    /** Booking attempts requested by the seller (first request = 0); part of the job idempotency key. */
    bookingAttempts: integer("booking_attempts").notNull().default(0),
    /** Seller-triggered tracking refreshes; bounded so a seller cannot drive unbounded provider reads. */
    manualPolls: integer("manual_polls").notNull().default(0),
    /** Sanitized message of the last booking/tracking failure or the unpaid reason. */
    lastError: text("last_error"),
    bookedAt: timestamp("booked_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastTrackedAt: timestamp("last_tracked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "shipment_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    unique("shipment_order_uq").on(t.storeId, t.orderId),
    index("shipment_store_status_idx").on(t.storeId, t.status),
    check("shipment_status_chk", sql`${t.status} in ('queued', 'booking', 'awaiting_balance', 'booked', 'in_transit', 'delivered', 'returned', 'problem', 'cancelled', 'failed')`),
    check("shipment_amounts_chk", sql`${t.codAmount} >= 0 and ${t.weightKg} >= 1 and ${t.bookingAttempts} >= 0 and ${t.manualPolls} >= 0`),
    // A shipment past booking carries its provider reference; a resi implies a paid order.
    check("shipment_booked_chk", sql`${t.status} in ('queued', 'booking', 'failed') or ${t.providerOrderId} is not null`),
    check("shipment_resi_chk", sql`${t.trackingNumber} is null or ${t.paid}`),
    check("shipment_history_chk", sql`octet_length(${t.trackingHistory}::text) <= 16384`),
  ],
);
