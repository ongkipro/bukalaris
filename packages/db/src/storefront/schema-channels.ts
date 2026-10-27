import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { cart, store } from "../schema.ts";

// Headless channels (PR-16, ARCH-7, IAM-11). A channel is a developer-operated
// storefront backend holding one private token; the token resolves exactly one
// store. Only a hash of the token is stored; the prefix is for display/lookup.

export const storefrontChannel = pgTable(
  "storefront_channel",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    name: text("name").notNull(),
    // Registered return destination: origin (scheme://host[:port]) + a local path. The
    // only place a buyer is sent after checkout (allowlist, never a client-supplied URL).
    origin: text("origin").notNull(),
    returnPath: text("return_path").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("storefront_channel_store_id_uq").on(t.storeId, t.id),
    index("storefront_channel_prefix_idx").on(t.tokenPrefix),
    check("storefront_channel_status_chk", sql`${t.status} in ('active', 'revoked')`),
  ],
);

/**
 * One-use checkout handoff: exchanges a random code (hash stored) for the buyer's
 * per-store cart cookie on the checkout origin. Bound to store, cart and channel;
 * consumed atomically exactly once (DATA-MODEL "Checkout Handoff").
 */
export const checkoutHandoff = pgTable(
  "checkout_handoff",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    cartId: uuid("cart_id").notNull(),
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    codeHash: text("code_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "checkout_handoff_cart_fk", columns: [t.storeId, t.cartId], foreignColumns: [cart.storeId, cart.id] }).onDelete("cascade"),
    foreignKey({
      name: "checkout_handoff_channel_fk",
      columns: [t.storeId, t.channelId],
      foreignColumns: [storefrontChannel.storeId, storefrontChannel.id],
    }).onDelete("cascade"),
    index("checkout_handoff_cart_idx").on(t.storeId, t.cartId),
  ],
);
