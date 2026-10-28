// T-45 / PR-25 / DATA-8: abandoned checkout capture. Re-exported by schema.ts. RLS, grants and the transition guard live in the
// hand-written `-- ===== T-45` section of migration 0016 (docs/tracks/t45.md).
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { cart, store } from "../../schema.ts";

export const CHECKOUT_SESSION_STATUSES = ["active", "abandoned", "recovered"] as const;
export type CheckoutSessionStatus = (typeof CHECKOUT_SESSION_STATUSES)[number];

/**
 * What a hosted checkout buyer typed so far (contact fields) and the cart value, one row per cart. Store-scoped under FORCE RLS.
 * `abandoned_at` and `recovered_at` are separate, monotonic stamps: a recovery never erases the abandonment it rescued.
 * Personal columns follow the T-43 export and redaction mechanism (BUYER_DATA_INVENTORY) and the 30-day purge of `cleanup.ts`.
 */
export const checkoutSession = pgTable(
  "checkout_session",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    cartId: uuid("cart_id").notNull(),
    /** Opaque handle of the resume link: random, never the primary key (a link never exposes `id`). */
    publicId: uuid("public_id").notNull().defaultRandom(),
    status: text("status", { enum: CHECKOUT_SESSION_STATUSES }).notNull().default("active"),
    buyerName: text("buyer_name"),
    buyerPhone: text("buyer_phone"),
    buyerEmail: text("buyer_email"),
    shippingAddress: text("shipping_address"),
    /** Goods subtotal of the cart at the last capture, integer IDR, computed by the server (never from the client). */
    subtotalIdr: bigint("subtotal_idr", { mode: "number" }).notNull().default(0),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),
    /** The seller opened the WhatsApp recovery link ("WA dibuka"); never a delivery claim. */
    waOpenedAt: timestamp("wa_opened_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last buyer activity: the idle clock of the 60-minute sweep. Only a capture moves it. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("checkout_session_cart_uq").on(t.storeId, t.cartId),
    unique("checkout_session_public_uq").on(t.publicId),
    foreignKey({ name: "checkout_session_cart_fk", columns: [t.storeId, t.cartId], foreignColumns: [cart.storeId, cart.id] }),
    index("checkout_session_status_idx").on(t.storeId, t.status, t.updatedAt),
    index("checkout_session_created_idx").on(t.createdAt),
    check("checkout_session_status_chk", sql`${t.status} in ('active', 'abandoned', 'recovered')`),
    check("checkout_session_stamps_chk", sql`(${t.status} <> 'abandoned' or ${t.abandonedAt} is not null) and ((${t.status} = 'recovered') = (${t.recoveredAt} is not null))`),
    check("checkout_session_amount_chk", sql`${t.subtotalIdr} >= 0`),
    check("checkout_session_text_chk", sql`char_length(${t.buyerName}) <= 120 and char_length(${t.buyerPhone}) <= 32 and char_length(${t.buyerEmail}) <= 254 and char_length(${t.shippingAddress}) <= 500`),
  ],
);
