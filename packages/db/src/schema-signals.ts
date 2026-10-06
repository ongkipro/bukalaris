// M2 signals track (T-38, PR-20): per-store ad destinations, the signal event log the
// outbox handlers deliver, and the first-party click context stored with an order for
// delayed (prepaid) purchases. Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
import { order, store } from "./schema.ts";

export const SIGNAL_PROVIDERS = ["meta", "tiktok", "google"] as const;
export type SignalProvider = (typeof SIGNAL_PROVIDERS)[number];
export const SIGNAL_STATUSES = ["pending", "sent", "simulated", "failed"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

/**
 * One row per store × destination. `pixel_id` is the Meta pixel id, the TikTok pixel code
 * or the Google tag id (`AW-…`, with `conversion_label` for the Purchase action). The
 * server token is AES-256-GCM ciphertext (signals.ts `sealToken`, key `INTEGRATION_TOKEN_KEY`)
 * and never leaves the server: the UI only shows whether and when one was stored.
 */
export const signalDestination = pgTable(
  "signal_destination",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    provider: text("provider", { enum: SIGNAL_PROVIDERS }).notNull(),
    pixelId: text("pixel_id").notNull(),
    conversionLabel: text("conversion_label"),
    tokenCiphertext: text("token_ciphertext"),
    tokenSetAt: timestamp("token_set_at", { withTimezone: true }),
    testEventCode: text("test_event_code"),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("signal_destination_store_provider_uq").on(t.storeId, t.provider),
    check("signal_destination_provider_chk", sql`${t.provider} in ('meta', 'tiktok', 'google')`),
    check("signal_destination_token_chk", sql`(${t.tokenCiphertext} is null) = (${t.tokenSetAt} is null)`),
  ],
);

/**
 * Every browser/server funnel event and purchase the server leg knows about, one row per
 * destination. `(store_id, provider, event_id)` is the idempotency key shared with the
 * browser leg; the outbox job carries only this row's id. `payload` holds the provider-neutral
 * event (value, contents, url) and a `user` block (hashed phone/name, raw click ids, IP, UA)
 * that the cleanup command strips after 30 days (PRIV-3).
 */
export const signalEvent = pgTable(
  "signal_event",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    provider: text("provider", { enum: SIGNAL_PROVIDERS }).notNull(),
    eventId: text("event_id").notNull(),
    eventName: text("event_name").notNull(),
    orderId: bigint("order_id", { mode: "number" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: SIGNAL_STATUSES }).notNull().default("pending"),
    /** Sanitized message of the last delivery failure (never a token or a buyer field). */
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("signal_event_dedup_uq").on(t.storeId, t.provider, t.eventId),
    index("signal_event_store_created_idx").on(t.storeId, t.createdAt),
    check("signal_event_provider_chk", sql`${t.provider} in ('meta', 'tiktok', 'google')`),
    check("signal_event_status_chk", sql`${t.status} in ('pending', 'sent', 'simulated', 'failed')`),
    check("signal_event_payload_chk", sql`octet_length(${t.payload}::text) <= 16384`),
  ],
);

/**
 * First-party attribution context captured at checkout (click ids from the `bl_click`
 * cookie and the pixels' own cookies, client IP and user agent) so a prepaid Purchase
 * sent at settlement still matches. Deleted by the cleanup command after 30 days.
 */
export const orderSignalContext = pgTable(
  "order_signal_context",
  {
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    orderId: bigint("order_id", { mode: "number" }).notNull(),
    fbp: text("fbp"),
    fbc: text("fbc"),
    ttclid: text("ttclid"),
    ttp: text("ttp"),
    gclid: text("gclid"),
    gbraid: text("gbraid"),
    wbraid: text("wbraid"),
    utm: jsonb("utm").$type<Record<string, string>>(),
    clientIp: text("client_ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.storeId, t.orderId] }),
    foreignKey({ name: "order_signal_context_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }).onDelete("cascade"),
    index("order_signal_context_created_idx").on(t.createdAt),
  ],
);
