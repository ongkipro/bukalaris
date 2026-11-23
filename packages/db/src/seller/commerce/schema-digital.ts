import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
import { order, orderLine, product, variant } from "../../schema.ts";

// T-112 (PR-2, ADR-0016 section 4, section 7 and decisions 18, 20, 23, 24; C-G1..C-G3):
// Delivery content for digital products (`product_access_item`, `product_access_note`) and per-line buyer grants
// (`digital_grant`). All three tables live separate from `product` under FORCE RLS so access links and notes can
// NEVER leak into storefront HTML, Storefront API, feeds, e-mails or logs. The platform stores no files and never
// makes outbound requests to seller-hosted access links.

/** Only `link` is accepted in the first release; `video_embed` and `live_session` are reserved for a later stage (ADR-0016 item 25). */
export const ACCESS_ITEM_TYPES = ["link"] as const;
export type AccessItemType = (typeof ACCESS_ITEM_TYPES)[number];
export const RESERVED_ACCESS_ITEM_TYPES = ["video_embed", "live_session"] as const;

export const DIGITAL_GRANT_STATES = ["active", "revoked"] as const;
export type DigitalGrantState = (typeof DIGITAL_GRANT_STATES)[number];

/** One seller-hosted access link on a digital product (cap 10 per product, 2,000 chars per URL, https only, no credentials). */
export const productAccessItem = pgTable(
  "product_access_item",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    itemType: text("item_type", { enum: ACCESS_ITEM_TYPES }).notNull().default("link"),
    label: text("label").notNull(),
    url: text("url").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "product_access_item_product_fk", columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id] }),
    index("product_access_item_product_idx").on(t.storeId, t.productId, t.position, t.id),
    check("product_access_item_type_chk", sql`${t.itemType} = 'link'`),
    check(
      "product_access_item_fields_chk",
      sql`length(btrim(${t.label})) between 1 and 120 and length(${t.url}) between 10 and 2000 and ${t.url} ~ '^https://[^/\\s@]+(:[0-9]+)?(/[^\\s]*)?$' and ${t.position} >= 0`,
    ),
  ],
);

/** Plain-text access note shown only after payment through an active grant (never rendered as HTML, never on public pages). */
export const productAccessNote = pgTable(
  "product_access_note",
  {
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    note: text("note").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "product_access_note_pk", columns: [t.storeId, t.productId] }),
    foreignKey({ name: "product_access_note_product_fk", columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id] }),
    check("product_access_note_len_chk", sql`length(${t.note}) <= 5000`),
  ],
);

/**
 * One grant per digital order line, created strictly inside the transaction that settles the order (status check or manual confirmation).
 * Bound to the store, order line and product; buyer identity is reached through the order (C-G2).
 */
export const digitalGrant = pgTable(
  "digital_grant",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    orderId: bigint("order_id", { mode: "number" }).notNull(),
    variantId: bigint("variant_id", { mode: "number" }).notNull(),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    state: text("state", { enum: DIGITAL_GRANT_STATES }).notNull().default("active"),
    /** Optional expiry; null = no expiry by default (D-31 OPEN-G4). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** ADR-0016 decision 24: sandbox test orders grant access marked as a test. */
    isTest: boolean("is_test").notNull().default(false),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    revokedReason: text("revoked_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("digital_grant_order_line_uq").on(t.storeId, t.orderId, t.variantId),
    index("digital_grant_store_order_idx").on(t.storeId, t.orderId),
    foreignKey({ name: "digital_grant_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    foreignKey({ name: "digital_grant_variant_fk", columns: [t.storeId, t.variantId], foreignColumns: [variant.storeId, variant.id] }),
    foreignKey({ name: "digital_grant_product_fk", columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id] }),
    foreignKey({ name: "digital_grant_line_fk", columns: [t.orderId, t.variantId], foreignColumns: [orderLine.orderId, orderLine.variantId] }),
    check(
      "digital_grant_state_chk",
      sql`(${t.state} = 'active' and ${t.revokedAt} is null and ${t.revokedBy} is null and ${t.revokedReason} is null)
        or (${t.state} = 'revoked' and ${t.revokedAt} is not null and length(btrim(coalesce(${t.revokedBy}, ''))) >= 1 and length(btrim(coalesce(${t.revokedReason}, ''))) >= 3)`,
    ),
  ],
);
