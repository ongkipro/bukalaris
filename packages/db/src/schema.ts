import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { storeShippingAccount } from "./shipping/schema-accounts.ts";

// Numeric identities are Postgres identity columns (never MAX+1, never reused).
// lazy: mode "number" is exact up to 2^53; switch to mode "bigint"/string transport before any id or IDR amount nears that.
const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const idr = (name: string) => bigint(name, { mode: "number" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// External catalog identity (PR-12, DATA-5, docs/DECISIONS.md D-8): one platform-wide sequence shared by
// products and variants (so an item id never equals a group id), starting at 10000 so every id has at least
// five digits. Read as a STRING in TypeScript and at every API/feed/event/order-snapshot boundary; the DB
// keeps it bigint for the sequence and uniqueness. A trigger (migration 0003) makes it immutable after insert.
export const catalogIdSeq = pgSequence("catalog_id_seq", { startWith: 10000 });
const catalogIdColumn = customType<{ data: string; driverData: string }>({
  dataType: () => "bigint",
  fromDriver: (v) => String(v),
});
const catalogId = () => catalogIdColumn("catalog_id").notNull().default(sql`nextval('catalog_id_seq')`).unique();

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
  /** T-63: platform-wide suspension of this identity (set only through `console_set_user_suspension`); NULL = active. Every seller scope, session creation and the sessions themselves check it. */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
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
    // DATA-10 (T-50): the independent operator restriction. Set and cleared only with `status` (trigger `store_suspension_sync`, migration 0013),
    // never by billing, payment or a comp: the subscription state is another table.
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
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
  /** T-63 (SA-38): a deactivated operator has no scope at all (`operatorScope` returns null); the row stays so the identity remains staff (never an `accounts.*` target). */
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
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
    catalogId: catalogId(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    title: text("title").notNull(),
    // Optional readable slug. Canonical slug = slug ?? catalogId (DATA-5); all-digit
    // slugs are reserved for ids, so a path segment is never ambiguous. Old slugs live
    // on as aliases (product_slug_alias) that redirect to the canonical slug.
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
    check("product_catalog_id_chk", sql`${t.catalogId} >= 10000`),
  ],
);

export const variant = pgTable(
  "variant",
  {
    id: id(),
    catalogId: catalogId(),
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    title: text("title").notNull(),
    sku: text("sku"),
    price: idr("price").notNull(),
    stock: integer("stock").notNull().default(0),
    /** Parcel weight of one unit in grams (T-61); the seller sets it, there is no default. */
    weightGrams: integer("weight_grams").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("variant_store_id_uq").on(t.storeId, t.id),
    foreignKey({ name: "variant_product_fk", columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id] }),
    index("variant_product_idx").on(t.storeId, t.productId),
    check("variant_price_chk", sql`${t.price} >= 0`),
    check("variant_stock_chk", sql`${t.stock} >= 0`),
    check("variant_weight_chk", sql`${t.weightGrams} > 0`),
    check("variant_catalog_id_chk", sql`${t.catalogId} >= 10000`),
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
export const ORDER_STATUSES = ["awaiting_confirmation", "on_hold", "awaiting_payment", "placed", "processing", "shipped", "completed", "cancelled", "returned"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
/** Indonesian label per status; the one place both the admin UI and user-facing messages read from. */
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  awaiting_confirmation: "Menunggu konfirmasi",
  on_hold: "Ditahan",
  awaiting_payment: "Menunggu pembayaran",
  placed: "Baru",
  processing: "Diproses",
  shipped: "Dikirim",
  completed: "Selesai",
  cancelled: "Dibatalkan",
  returned: "Dikembalikan (RTS)",
};

export const order = pgTable(
  "order",
  {
    id: id(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    // One order per checked-out cart; the cart id is also the buyer's capability for the outcome page.
    cartId: uuid("cart_id").notNull().unique(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    // Lifecycle (docs/tracks/orders.md, T-35): COD starts in awaiting_confirmation → (hold → on_hold) → confirm → placed,
    // or reject → cancelled; transfer starts in awaiting_payment → pay → placed → processing → shipped → completed;
    // awaiting_payment/placed/processing → cancelled. Every cancellation restocks once. Transitions only via orders.ts.
    status: text("status", { enum: ORDER_STATUSES }).notNull(),
    paymentMethod: text("payment_method", { enum: ["cod", "manual_transfer"] }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** Seller confirmed the COD order (T-35); null for transfer orders and unconfirmed ones. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    trackingNumber: text("tracking_number"),
    buyerName: text("buyer_name").notNull(),
    buyerPhone: text("buyer_phone").notNull(),
    /** Optional, lower-cased; only used for order notifications (T-36, PR-21). */
    buyerEmail: text("buyer_email"),
    shippingAddress: text("shipping_address").notNull(),
    // Shipping snapshot (T-34, Q-12): provider courier key + label, route area ids, and the
    // fee split. `shipping_fee` is what the buyer pays = provider cost + platform margin.
    shippingAccountId: bigint("shipping_account_id", { mode: "number" }).notNull().default(0),
    shippingAccountKind: text("shipping_account_kind", { enum: ["partner_managed", "platform_master"] }).notNull().default("platform_master"),
    courierCode: text("courier_code").notNull(),
    courier: text("courier").notNull(),
    originAreaId: text("origin_area_id").notNull(),
    destinationAreaId: text("destination_area_id").notNull(),
    destinationAreaLabel: text("destination_area_label").notNull(),
    weightKg: integer("weight_kg").notNull(),
    shippingProviderCost: idr("shipping_provider_cost").notNull(),
    shippingMargin: idr("shipping_margin").notNull(),
    subtotal: idr("subtotal").notNull(),
    /** What the buyer pays for shipping AFTER a store-funded shipping discount (T-46): `shipping_fee + shipping_discount = provider cost + margin`. */
    shippingFee: idr("shipping_fee").notNull(),
    /** Store-funded goods discount (vouchers, flash-sale price overrides) and shipping discount, copied from the immutable financial snapshot (T-46, BILL-4). */
    goodsDiscount: idr("goods_discount").notNull().default(0),
    shippingDiscount: idr("shipping_discount").notNull().default(0),
    total: idr("total").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("order_store_id_uq").on(t.storeId, t.id),
    index("order_store_status_idx").on(t.storeId, t.status, t.id),
    unique("order_idempotency_uq").on(t.storeId, t.idempotencyKey),
    foreignKey({ name: "order_shipping_account_fk", columns: [t.storeId, t.shippingAccountId, t.shippingAccountKind], foreignColumns: [storeShippingAccount.storeId, storeShippingAccount.id, storeShippingAccount.kind] }),
    // The immutable financial snapshot (`order_financials`) re-checks these figures against the exact BILL-4 allocation identity.
    check("order_total_chk", sql`${t.total} = ${t.subtotal} - ${t.goodsDiscount} + ${t.shippingFee} and ${t.subtotal} >= 0 and ${t.shippingFee} >= 0 and ${t.goodsDiscount} >= 0 and ${t.goodsDiscount} <= ${t.subtotal}`),
    check(
      "order_shipping_fee_chk",
      sql`${t.shippingFee} + ${t.shippingDiscount} = ${t.shippingProviderCost} + ${t.shippingMargin} and ${t.shippingDiscount} >= 0 and ${t.shippingDiscount} <= ${t.shippingProviderCost} and ${t.shippingProviderCost} >= 0 and ${t.shippingMargin} >= 0 and ${t.weightKg} >= 1`,
    ),
    check("order_area_chk", sql`${t.originAreaId} ~ '^[a-f0-9]{24}$' and ${t.destinationAreaId} ~ '^[a-f0-9]{24}$'`),
    check(
      "order_status_chk",
      sql`${t.status} in ('awaiting_confirmation', 'on_hold', 'awaiting_payment', 'placed', 'processing', 'shipped', 'completed', 'cancelled', 'returned')`,
    ),
    // Confirmation states belong to COD only.
    check("order_cod_state_chk", sql`${t.paymentMethod} = 'cod' or ${t.status} not in ('awaiting_confirmation', 'on_hold')`),
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
    // Snapshot of the variant's external catalog id as a string (PR-12/PR-20 content id); never re-read from variant.
    variantCatalogId: text("variant_catalog_id").notNull(),
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
    actorCapability: text("actor_capability"),
    purposeCode: text("purpose_code"),
    caseId: text("case_id"),
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    accessLevel: text("access_level", { enum: ["masked", "full", "export", "write"] }),
    outcome: text("outcome", { enum: ["allowed", "denied"] }),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_store_idx").on(t.storeId, t.createdAt),
    index("audit_actor_idx").on(t.actorUserId, t.createdAt),
    index("audit_subject_idx").on(t.subjectKind, t.subjectId, t.createdAt),
    check("audit_access_level_chk", sql`${t.accessLevel} is null or ${t.accessLevel} in ('masked', 'full', 'export', 'write')`),
    check("audit_outcome_chk", sql`${t.outcome} is null or ${t.outcome} in ('allowed', 'denied')`),
  ],
);

// M2 track tables live in their own files so parallel branches merge cleanly.
export * from "./seller/commerce/schema-orders.ts";
export * from "./platform/schema-accounts.ts";
export * from "./ops/schema-ops.ts";
export * from "./storefront/schema-content.ts";
export * from "./storefront/schema-channels.ts";
export * from "./ops/jobs/schema-jobs.ts";
export * from "./shipping/schema-shipping.ts";
export * from "./seller/commerce/schema-catalog.ts";
export * from "./seller/commerce/schema-abuse.ts";
export * from "./ops/jobs/schema-notify.ts";
export * from "./storefront/schema-signals.ts";
export * from "./shipping/schema-fulfillment.ts";
export * from "./storefront/schema-feeds.ts";
export * from "./storefront/schema-landing.ts";
export * from "./seller/commerce/schema-privacy.ts";
export * from "./seller/commerce/schema-abandoned.ts";
export * from "./payments/schema-payments.ts";
export * from "./ops/schema-console.ts";
export * from "./ops/schema-governance.ts";
export * from "./tax/schema-tax.ts";
export * from "./ledger/schema-ledger.ts";
export * from "./billing/schema-billing.ts";
export * from "./buyer/schema-buyer.ts";
export * from "./promotions/schema-promotions.ts";
export * from "./shipping/schema-accounts.ts";
export * from "./affiliate/schema-affiliate.ts";
