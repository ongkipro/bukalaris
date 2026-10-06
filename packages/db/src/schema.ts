import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Numeric identities are Postgres identity columns (never MAX+1, never reused).
// lazy: mode "number" is exact up to 2^53; switch to mode "bigint"/string transport before any id or IDR amount nears that.
const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const idr = (name: string) => bigint(name, { mode: "number" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Better Auth core tables (fields verified against better-auth 1.7.7 getAuthTables()).
// ---------------------------------------------------------------------------
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // two-factor plugin: set to true only after a TOTP code has been verified.
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

/** two-factor plugin table (fields from better-auth/plugins/two-factor schema.mjs); secret and codes are encrypted by the plugin. */
export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [index("two_factor_user_idx").on(t.userId), index("two_factor_secret_idx").on(t.secret)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Tenancy. M1: the store is the tenant root (see docs/DECISIONS.md D-3).
// ---------------------------------------------------------------------------
export const store = pgTable(
  "store",
  {
    id: id(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
    // Store profile and presentation (SC-10/SC-11, PR-8). The theme changes presentation only.
    description: text("description").notNull().default(""),
    whatsapp: text("whatsapp"),
    theme: text("theme", { enum: ["responsive", "mobile"] }).notNull().default("responsive"),
    createdAt: createdAt(),
  },
  (t) => [
    check("store_status_chk", sql`${t.status} in ('active', 'suspended')`),
    check("store_slug_chk", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("store_theme_chk", sql`${t.theme} in ('responsive', 'mobile')`),
    check("store_whatsapp_chk", sql`${t.whatsapp} is null or ${t.whatsapp} ~ '^62[0-9]{8,13}$'`),
  ],
);

/** Platform operators (Super Admin). Never granted through seller membership. */
export const platformOperator = pgTable("platform_operator", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

export const membership = pgTable(
  "membership",
  {
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "staff"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.storeId, t.userId] }),
    index("membership_user_idx").on(t.userId),
    check("membership_role_chk", sql`${t.role} in ('owner', 'staff')`),
  ],
);

// ---------------------------------------------------------------------------
// Catalog. Every store-owned row carries store_id; child rows use compound
// (store_id, parent_id) foreign keys so a relation can never cross stores.
// ---------------------------------------------------------------------------
export const product = pgTable(
  "product",
  {
    id: id(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    title: text("title").notNull(),
    // Optional readable slug. Canonical slug = slug ?? String(id) (DATA-5); all-digit
    // slugs are reserved for ids, so a path segment is never ambiguous.
    slug: text("slug"),
    description: text("description").notNull().default(""),
    status: text("status", { enum: ["draft", "active", "archived"] }).notNull().default("draft"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("product_store_id_uq").on(t.storeId, t.id),
    unique("product_store_slug_uq").on(t.storeId, t.slug),
    check("product_status_chk", sql`${t.status} in ('draft', 'active', 'archived')`),
    check("product_slug_chk", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and ${t.slug} !~ '^[0-9]+$'`),
  ],
);

export const variant = pgTable(
  "variant",
  {
    id: id(),
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    title: text("title").notNull(),
    sku: text("sku"),
    price: idr("price").notNull(),
    stock: integer("stock").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique("variant_store_id_uq").on(t.storeId, t.id),
    foreignKey({ name: "variant_product_fk", columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id] }),
    index("variant_product_idx").on(t.storeId, t.productId),
    check("variant_price_chk", sql`${t.price} >= 0`),
    check("variant_stock_chk", sql`${t.stock} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Cart (store-bound, server-side; the random uuid is the buyer's capability).
// ---------------------------------------------------------------------------
export const cart = pgTable(
  "cart",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    createdAt: createdAt(),
  },
  (t) => [unique("cart_store_id_uq").on(t.storeId, t.id)],
);

export const cartLine = pgTable(
  "cart_line",
  {
    cartId: uuid("cart_id").notNull(),
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    variantId: bigint("variant_id", { mode: "number" }).notNull(),
    quantity: integer("quantity").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cartId, t.variantId] }),
    foreignKey({ name: "cart_line_cart_fk", columns: [t.storeId, t.cartId], foreignColumns: [cart.storeId, cart.id] }).onDelete("cascade"),
    foreignKey({ name: "cart_line_variant_fk", columns: [t.storeId, t.variantId], foreignColumns: [variant.storeId, variant.id] }).onDelete("cascade"),
    check("cart_line_qty_chk", sql`${t.quantity} between 1 and 99`),
  ],
);

// ---------------------------------------------------------------------------
// Orders: immutable commercial snapshot (DATA-2).
// ---------------------------------------------------------------------------
export const ORDER_STATUSES = ["awaiting_payment", "placed", "processing", "shipped", "completed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const order = pgTable(
  "order",
  {
    id: id(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    // One order per checked-out cart; the cart id is also the buyer's capability for the outcome page.
    cartId: uuid("cart_id").notNull().unique(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    // Lifecycle (M2 orders track, docs/tracks/orders.md): awaiting_payment → placed → processing → shipped → completed;
    // placed/awaiting_payment/processing → cancelled (restocks once). Transitions only via orders.ts.
    status: text("status", { enum: ORDER_STATUSES }).notNull(),
    paymentMethod: text("payment_method", { enum: ["cod", "manual_transfer"] }).notNull(),
    paymentReference: text("payment_reference"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    trackingNumber: text("tracking_number"),
    buyerName: text("buyer_name").notNull(),
    buyerPhone: text("buyer_phone").notNull(),
    shippingAddress: text("shipping_address").notNull(),
    courier: text("courier").notNull(),
    subtotal: idr("subtotal").notNull(),
    shippingFee: idr("shipping_fee").notNull(),
    total: idr("total").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("order_store_id_uq").on(t.storeId, t.id),
    index("order_store_status_idx").on(t.storeId, t.status, t.id),
    unique("order_idempotency_uq").on(t.storeId, t.idempotencyKey),
    check("order_total_chk", sql`${t.total} = ${t.subtotal} + ${t.shippingFee} and ${t.subtotal} >= 0 and ${t.shippingFee} >= 0`),
    check("order_status_chk", sql`${t.status} in ('awaiting_payment', 'placed', 'processing', 'shipped', 'completed', 'cancelled')`),
    check("order_shipped_chk", sql`${t.status} not in ('shipped', 'completed') or ${t.trackingNumber} is not null`),
    check("order_payment_chk", sql`${t.paymentMethod} in ('cod', 'manual_transfer')`),
  ],
);

export const orderLine = pgTable(
  "order_line",
  {
    orderId: bigint("order_id", { mode: "number" }).notNull(),
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    variantId: bigint("variant_id", { mode: "number" }).notNull(),
    productTitle: text("product_title").notNull(),
    variantTitle: text("variant_title").notNull(),
    unitPrice: idr("unit_price").notNull(),
    quantity: integer("quantity").notNull(),
    lineTotal: idr("line_total").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.variantId] }),
    foreignKey({ name: "order_line_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    foreignKey({ name: "order_line_variant_fk", columns: [t.storeId, t.variantId], foreignColumns: [variant.storeId, variant.id] }),
    check("order_line_chk", sql`${t.quantity} > 0 and ${t.lineTotal} = ${t.unitPrice} * ${t.quantity}`),
  ],
);

// ---------------------------------------------------------------------------
// Audit (append-only by convention in M1; IAM-5).
// ---------------------------------------------------------------------------
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    actorUserId: text("actor_user_id").notNull(),
    storeId: bigint("store_id", { mode: "number" }),
    action: text("action").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_store_idx").on(t.storeId, t.createdAt)],
);

// M2 track tables live in their own files so parallel branches merge cleanly.
export * from "./schema-orders.ts";
export * from "./schema-accounts.ts";
export * from "./schema-ops.ts";
export * from "./schema-content.ts";
export * from "./schema-channels.ts";
export * from "./schema-jobs.ts";
export * from "./schema-shipping.ts";
