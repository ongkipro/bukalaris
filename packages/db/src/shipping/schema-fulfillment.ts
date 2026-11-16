// M2 wave-4 fulfillment track (T-39): one provider shipment per order. Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { order, store } from "../schema.ts";

/**
 * Booking states (`queued` → `booking` → `booked` | `awaiting_balance` | `failed`) followed by the
 * tracking states the provider status category maps to. `delivered`, `returned`, `cancelled`
 * and `failed` are terminal for polling; `awaiting_balance` and `failed` accept a seller retry.
 */
export const SHIPMENT_STATUSES = ["queued", "booking", "unknown", "awaiting_account", "awaiting_balance", "booked", "in_transit", "delivered", "returned", "problem", "cancelled", "failed"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
/** T-105: how the parcel reaches the courier (ADR-0013 decision 28): a scheduled pickup at the registered address, or the seller drops it off. */
export const PICKUP_TYPES = ["scheduled_pickup", "drop_off"] as const;
export type PickupType = (typeof PICKUP_TYPES)[number];

export const SHIPMENT_STATUS_LABEL: Record<ShipmentStatus, string> = {
  queued: "Menunggu booking",
  booking: "Sedang booking",
  unknown: "Hasil booking tidak pasti",
  awaiting_account: "Menunggu pemulihan akun Bukalaris Kirim",
  awaiting_balance: "Menunggu saldo Bukalaris Kirim",
  booked: "Resi terbit, menunggu pickup",
  in_transit: "Dalam pengiriman",
  delivered: "Terkirim ke pembeli",
  returned: "Dikembalikan ke pengirim (RTS)",
  problem: "Perlu perhatian",
  cancelled: "Dibatalkan di Bukalaris Kirim",
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
    /** T-105: chosen by the seller on each booking request; a platform-account booking always uses the platform's scheduled pickup. */
    pickupType: text("pickup_type", { enum: PICKUP_TYPES }).notNull().default("scheduled_pickup"),
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
    /** T-115: the provider's `lastStatusChange` of the state last applied; a read reporting an older change is stale and changes nothing. */
    providerStatusAt: timestamp("provider_status_at", { withTimezone: true }),
    /** T-115 (ADR-0013 decision 45): Mengantar's own per-parcel figures, only the documented fields (`PROVIDER_FIGURE_FIELDS`), integer IDR, as read. */
    providerFigures: jsonb("provider_figures").$type<ProviderFigures>().notNull().default({}),
    providerFiguresAt: timestamp("provider_figures_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "shipment_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    unique("shipment_order_uq").on(t.storeId, t.orderId),
    // T-105 review M1: one provider order belongs to one shipment of a store (a store has one own courier account), so a link can never adopt a parcel twice.
    uniqueIndex("shipment_provider_order_uq").on(t.storeId, t.providerOrderId).where(sql`${t.providerOrderId} is not null`),
    index("shipment_store_status_idx").on(t.storeId, t.status),
    check("shipment_status_chk", sql`${t.status} in ('queued', 'booking', 'unknown', 'awaiting_account', 'awaiting_balance', 'booked', 'in_transit', 'delivered', 'returned', 'problem', 'cancelled', 'failed')`),
    check("shipment_amounts_chk", sql`${t.codAmount} >= 0 and ${t.weightKg} >= 1 and ${t.bookingAttempts} >= 0 and ${t.manualPolls} >= 0`),
    check("shipment_pickup_type_chk", sql`${t.pickupType} in ('scheduled_pickup', 'drop_off')`),
    // A shipment past booking carries its provider reference; a resi implies a paid order. `unknown` (T-105): the provider may or may not hold an order.
    check("shipment_booked_chk", sql`${t.status} in ('queued', 'booking', 'unknown', 'awaiting_account', 'failed') or ${t.providerOrderId} is not null`),
    check("shipment_resi_chk", sql`${t.trackingNumber} is null or ${t.paid}`),
    check("shipment_history_chk", sql`octet_length(${t.trackingHistory}::text) <= 16384`),
    check("shipment_figures_chk", sql`jsonb_typeof(${t.providerFigures}) = 'object' and octet_length(${t.providerFigures}::text) <= 1024 and (${t.providerFiguresAt} is not null or ${t.providerFigures} = '{}'::jsonb)`),
  ],
);

/**
 * T-115 (decision 45): the per-parcel money fields the official Mengantar documentation shows in its examples (create-order answer and
 * `GET /order`). Nothing else is mirrored: COD remittance, return charges and a final courier charge are not exposed per parcel.
 */
export const PROVIDER_FIGURE_FIELDS = ["estimatedPrice", "estimatedSpecialPrice", "discount", "COD_FEE", "COD_AMOUNT", "GOODS_AMOUNT"] as const;
export type ProviderFigures = Partial<Record<(typeof PROVIDER_FIGURE_FIELDS)[number], number>>;

const at = (name: string) => timestamp(name, { withTimezone: true });

/**
 * T-115 (decision 42): Mengantar's status categories as Bukalaris observed them, per parcel, append-only. The raw category is stored as
 * received; `parcel_state` is the mapped state or null for a category the one mapping table does not know. Written by the single writer
 * (a booking or a tracking read on the store's key), never by a webhook. Also the record of every provider order id Bukalaris created for
 * the store, so a parcel released and booked again is never mistaken for a foreign one.
 */
export const shipmentStatusEvent = pgTable(
  "shipment_status_event",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    shipmentId: bigint("shipment_id", { mode: "number" }).notNull().references(() => shipment.id),
    providerOrderId: text("provider_order_id").notNull(),
    category: text("category").notNull(),
    parcelState: text("parcel_state"),
    source: text("source", { enum: ["booking", "read"] }).notNull(),
    providerChangedAt: at("provider_changed_at"),
    observedAt: at("observed_at").notNull().defaultNow(),
  },
  (t) => [
    index("shipment_status_event_shipment_idx").on(t.storeId, t.shipmentId, t.id),
    index("shipment_status_event_order_idx").on(t.storeId, t.providerOrderId),
    check("shipment_status_event_chk", sql`length(${t.category}) between 1 and 60 and length(${t.providerOrderId}) between 1 and 64 and ${t.source} in ('booking', 'read')
      and (${t.parcelState} is null or ${t.parcelState} in ('created', 'waiting_pickup', 'pickup_failed', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'returning', 'returned', 'cancelled', 'error'))`),
  ],
);

/**
 * T-115 (decision 43): a verified Mengantar webhook delivery, stored before anything else happens and never applied: it only enqueues a
 * tracking read on the store's key. The signature is unique per store, so a replayed delivery is a duplicate that stores and enqueues nothing.
 */
export const shippingWebhookEvent = pgTable(
  "shipping_webhook_event",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    signature: text("signature").notNull(),
    /** The provider's `x-timestamp` (signed). */
    sentAt: at("sent_at").notNull(),
    receivedAt: at("received_at").notNull().defaultNow(),
    providerOrderId: text("provider_order_id"),
    trackingNumber: text("tracking_number"),
    courier: text("courier"),
    statusCategory: text("status_category"),
    outcome: text("outcome", { enum: ["read_enqueued", "no_parcel", "parcel_final"] }).notNull(),
  },
  (t) => [
    unique("shipping_webhook_event_signature_uq").on(t.storeId, t.signature),
    index("shipping_webhook_event_store_idx").on(t.storeId, t.receivedAt),
    check("shipping_webhook_event_chk", sql`${t.signature} ~ '^[a-f0-9]{64}$' and ${t.outcome} in ('read_enqueued', 'no_parcel', 'parcel_final')
      and coalesce(length(${t.providerOrderId}), 0) <= 64 and coalesce(length(${t.trackingNumber}), 0) <= 64 and coalesce(length(${t.courier}), 0) <= 40 and coalesce(length(${t.statusCategory}), 0) <= 60`),
  ],
);

/**
 * T-115 (decision 41): a parcel found in the store's own Mengantar account that Bukalaris did not create. Listed to the seller, never
 * imported (no order, no shipment); while one is unresolved the store's sync is not exact.
 */
export const shippingForeignParcel = pgTable(
  "shipping_foreign_parcel",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    providerOrderId: text("provider_order_id").notNull(),
    trackingNumber: text("tracking_number"),
    providerStatus: text("provider_status"),
    providerCreatedAt: at("provider_created_at"),
    firstSeenAt: at("first_seen_at").notNull().defaultNow(),
    resolvedAt: at("resolved_at"),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    unique("shipping_foreign_parcel_uq").on(t.storeId, t.providerOrderId),
    check("shipping_foreign_parcel_chk", sql`length(${t.providerOrderId}) between 1 and 64 and coalesce(length(${t.trackingNumber}), 0) <= 64 and coalesce(length(${t.providerStatus}), 0) <= 60
      and (${t.resolvedAt} is null) = (${t.resolvedBy} is null) and (${t.resolvedAt} is null) = (${t.resolutionNote} is null) and coalesce(length(${t.resolutionNote}), 0) <= 300`),
  ],
);

/** One mirrored Mengantar invoice (decision 45): documented fields only, as read. */
export type MirroredInvoice = { invNumber: string; type: string; status: string; amount: number | null; total: number | null; createdAt: string | null };

/**
 * T-115: the store's link with its own Mengantar account. The dedicated-account confirmation (decision 41) and the sealed Webhook Secret
 * (decision 43) each belong to ONE account: each carries the fingerprint and environment of the key it was given for and counts only while
 * they equal the connected key's, so another key or environment needs it again (a key regenerated in Mengantar replaces the secret too).
 * `hook_id` is the opaque part of the store's webhook address. The balance and invoice mirror is Mengantar's data with its read time
 * (decision 45), never a ledger.
 */
export const storeShippingSync = pgTable(
  "store_shipping_sync",
  {
    storeId: bigint("store_id", { mode: "number" }).primaryKey().references(() => store.id),
    hookId: text("hook_id").notNull(),
    dedicatedConfirmedAt: at("dedicated_confirmed_at"),
    dedicatedConfirmedBy: text("dedicated_confirmed_by"),
    dedicatedFingerprint: text("dedicated_fingerprint"),
    dedicatedEnvironment: text("dedicated_environment", { enum: ["sandbox", "production"] }),
    sealedWebhookSecret: text("sealed_webhook_secret"),
    webhookKeyId: text("webhook_key_id"),
    webhookSealedAt: at("webhook_sealed_at"),
    webhookFingerprint: text("webhook_fingerprint"),
    webhookEnvironment: text("webhook_environment", { enum: ["sandbox", "production"] }),
    stepUpRef: uuid("step_up_ref"),
    lastWebhookAt: at("last_webhook_at"),
    accountReadAt: at("account_read_at"),
    balanceIdr: bigint("balance_idr", { mode: "number" }),
    invoices: jsonb("invoices").$type<MirroredInvoice[]>().notNull().default([]),
    lastScanAt: at("last_scan_at"),
    scanError: text("scan_error"),
    revision: integer("revision").notNull().default(0),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("store_shipping_sync_hook_uq").on(t.hookId),
    check("store_shipping_sync_hook_chk", sql`${t.hookId} ~ '^[a-f0-9]{32}$'`),
    check("store_shipping_sync_dedicated_chk", sql`(${t.dedicatedConfirmedAt} is null) = (${t.dedicatedConfirmedBy} is null) and (${t.dedicatedConfirmedAt} is null) = (${t.dedicatedFingerprint} is null)
      and (${t.dedicatedConfirmedAt} is null) = (${t.dedicatedEnvironment} is null) and (${t.dedicatedEnvironment} is null or ${t.dedicatedEnvironment} in ('sandbox', 'production'))`),
    check("store_shipping_sync_secret_chk", sql`(${t.sealedWebhookSecret} is null) = (${t.webhookKeyId} is null) and (${t.sealedWebhookSecret} is null) = (${t.webhookSealedAt} is null)
      and (${t.sealedWebhookSecret} is null) = (${t.webhookFingerprint} is null) and (${t.sealedWebhookSecret} is null) = (${t.webhookEnvironment} is null) and (${t.webhookEnvironment} is null or ${t.webhookEnvironment} in ('sandbox', 'production'))`),
    check("store_shipping_sync_mirror_chk", sql`jsonb_typeof(${t.invoices}) = 'array' and octet_length(${t.invoices}::text) <= 16384 and (${t.balanceIdr} is null or ${t.accountReadAt} is not null) and coalesce(length(${t.scanError}), 0) <= 300`),
  ],
);
