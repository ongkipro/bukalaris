import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, pgTable, primaryKey, smallint, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { orderFinancials, product, store, user } from "../schema.ts";

// Platform-owned affiliate programme, phase 1 (T-52, ADR-0009, DATA-11). Three groups, three isolation classes
// (isolation-registry.ts): seller-owned opt-in settings keep the store policy (`tenant`); the affiliate's own records carry the
// own-affiliate policy on the transaction-local `app.affiliate_id` (`affiliate`); the discovery projection, the programme limits
// and the risk counters are `platform` / `shared-read` records. Every write to an affiliate-class table that checkout or the click
// entry point makes goes through a SECURITY DEFINER function of the T-52 migration section (the app role holds no INSERT there),
// and nothing in this file holds buyer contact or order identifiers on a column an affiliate may read.
//
// Out of scope here: wallet, ledger and payouts (T-53), the portal, storefronts and Owner console screens (T-54).

export const AFFILIATE_STATUSES = ["pending", "active", "rejected", "suspended", "closed"] as const;
export const OFFER_STATUSES = ["active", "paused", "withdrawn"] as const;
export const SELECTOR_STATUSES = ["active", "revoked"] as const;
export const ATTRIBUTION_METHODS = ["code", "link"] as const;
export const ATTRIBUTION_STATUSES = ["pending", "credited", "paid_out", "void"] as const;
/** The only product origin of phase 1 (T-56 external sources are deferred). It never describes how an attribution was won. */
export const AFFILIATE_SOURCE = "bukalaris" as const;
/** Phase-1 fraud counters (SEC-20, SA-18): written only by the definer functions that observe the event. */
export const COUNTER_KINDS = ["click_captured", "self_referral_suppressed", "click_refused_rate", "click_non_navigation", "code_failure"] as const;
export type CounterKind = (typeof COUNTER_KINDS)[number];

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const idr = (name: string) => bigint(name, { mode: "number" });
const ident = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const storeKey = () => bigint("store_id", { mode: "number" }).notNull();
const affiliateKey = () => bigint("affiliate_id", { mode: "number" }).notNull();

// ── affiliate class ──────────────────────────────────────────────────────────────────────────────────────────

/** Platform affiliate account: a separate account type with its own login (IAM-13), never a seller membership and never owned by a store. */
export const affiliate = pgTable(
  "affiliate",
  {
    id: ident(),
    /** The authenticated account of the affiliate surface (`user`); one account, one affiliate. */
    userId: text("user_id").notNull().unique().references(() => user.id),
    displayName: text("display_name").notNull(),
    /** Canonical Indonesian mobile (`628…`, the T-57 normalisation): the self-referral comparison value. Protected: no public projection carries it. */
    contactPhone: text("contact_phone").notNull(),
    status: text("status", { enum: AFFILIATE_STATUSES }).notNull().default("pending"),
    statusReason: text("status_reason"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamptz("reviewed_at"),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("affiliate_status_chk", sql`${t.status} in (${quoted(AFFILIATE_STATUSES)})`),
    check("affiliate_phone_chk", sql`${t.contactPhone} ~ '^628[0-9]{7,12}$'`),
    check("affiliate_name_chk", sql`char_length(btrim(${t.displayName})) between 2 and 80`),
    check("affiliate_reason_chk", sql`${t.status} not in ('rejected', 'suspended', 'closed') or char_length(btrim(coalesce(${t.statusReason}, ''))) between 1 and 500`),
  ],
);

/** A public promotion link (HTTP-27 `GET /r/<token>`): a selector for a destination, never authentication. Suspension is derived from the affiliate row, so reactivation restores the links. */
export const affiliateLink = pgTable(
  "affiliate_link",
  {
    id: ident(),
    affiliateId: affiliateKey().references(() => affiliate.id),
    token: text("token").notNull().unique(),
    storeId: storeKey().references(() => store.id),
    /** Optional product destination (an offer of the same store, compound FK); NULL sends the buyer to the store front page. */
    offerId: bigint("offer_id", { mode: "number" }),
    source: text("source").notNull().default(AFFILIATE_SOURCE),
    status: text("status", { enum: SELECTOR_STATUSES }).notNull().default("active"),
    /** Capture window of the link itself; a click already captured stays valid for its own window. */
    expiresAt: timestamptz("expires_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    unique("affiliate_link_owner_uq").on(t.affiliateId, t.id),
    unique("affiliate_link_target_uq").on(t.id, t.affiliateId, t.storeId),
    foreignKey({ name: "affiliate_link_offer_fk", columns: [t.storeId, t.offerId], foreignColumns: [affiliateOffer.storeId, affiliateOffer.id] }),
    index("affiliate_link_affiliate_idx").on(t.affiliateId, t.id),
    check("affiliate_link_token_chk", sql`${t.token} ~ '^[A-Za-z0-9_-]{16,64}$'`),
    check("affiliate_link_source_chk", sql`${t.source} = 'bukalaris'`),
    check("affiliate_link_status_chk", sql`${t.status} in (${quoted(SELECTOR_STATUSES)}) and (${t.status} = 'revoked') = (${t.revokedAt} is not null)`),
  ],
);

/** A typed affiliate code: globally unique in its normalised form (upper-case letters and digits, 4 to 24). */
export const affiliateCode = pgTable(
  "affiliate_code",
  {
    id: ident(),
    affiliateId: affiliateKey().references(() => affiliate.id),
    code: text("code").notNull().unique(),
    status: text("status", { enum: SELECTOR_STATUSES }).notNull().default("active"),
    expiresAt: timestamptz("expires_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    unique("affiliate_code_owner_uq").on(t.affiliateId, t.id),
    check("affiliate_code_form_chk", sql`${t.code} ~ '^[A-Z0-9]{4,24}$'`),
    check("affiliate_code_status_chk", sql`${t.status} in (${quoted(SELECTOR_STATUSES)}) and (${t.status} = 'revoked') = (${t.revokedAt} is not null)`),
  ],
);

/**
 * A server-captured click: opaque id, the link's affiliate and store (matching-affiliate and matching-store foreign keys), server capture
 * and expiry times. No buyer identity, address, user agent, referrer, URL or fingerprint (PRIV-7). Immutable; deleted only by the
 * retention function `retention_purge_affiliate_click`, which first detaches the attribution evidence that points at it.
 */
export const affiliateClick = pgTable(
  "affiliate_click",
  {
    id: text("id").primaryKey(),
    linkId: bigint("link_id", { mode: "number" }).notNull(),
    affiliateId: affiliateKey(),
    storeId: storeKey(),
    offerId: bigint("offer_id", { mode: "number" }),
    capturedAt: timestamptz("captured_at").notNull().defaultNow(),
    /** `captured_at` + the attribution window of that moment: later policy changes never extend or shorten a click that exists. */
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (t) => [
    unique("affiliate_click_target_uq").on(t.id, t.affiliateId, t.storeId),
    foreignKey({ name: "affiliate_click_link_fk", columns: [t.linkId, t.affiliateId, t.storeId], foreignColumns: [affiliateLink.id, affiliateLink.affiliateId, affiliateLink.storeId] }),
    index("affiliate_click_affiliate_idx").on(t.affiliateId, t.capturedAt),
    index("affiliate_click_captured_idx").on(t.capturedAt),
    check("affiliate_click_id_chk", sql`${t.id} ~ '^c[0-9a-f]{32}$'`),
    check("affiliate_click_window_chk", sql`${t.expiresAt} > ${t.capturedAt}`),
  ],
);

/**
 * One commission obligation per order (`UNIQUE(order_id)`), frozen with the order. The amounts are derived inside the database from the
 * immutable `order_financials` / `order_line_financials` snapshot, never typed in. `click_id` is detached (NULL + `click_detached_at`)
 * when the raw click is retired; nothing else on the row ever changes except the T-53 state columns.
 */
export const affiliateAttribution = pgTable(
  "affiliate_attribution",
  {
    id: ident(),
    orderId: bigint("order_id", { mode: "number" }).notNull().unique("affiliate_attribution_order_uq"),
    storeId: storeKey(),
    affiliateId: affiliateKey().references(() => affiliate.id),
    source: text("source").notNull().default(AFFILIATE_SOURCE),
    method: text("method", { enum: ATTRIBUTION_METHODS }).notNull(),
    codeId: bigint("code_id", { mode: "number" }),
    clickId: text("click_id"),
    clickDetachedAt: timestamptz("click_detached_at"),
    /** Policy snapshots (ADR-0009 section 2): what applied when the order was placed. */
    windowDays: integer("window_days").notNull(),
    holdDays: integer("hold_days").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    sellerPolicyRevision: integer("seller_policy_revision").notNull(),
    commissionBaseIdr: idr("commission_base_idr").notNull(),
    commissionIdr: idr("commission_idr").notNull(),
    status: text("status", { enum: ATTRIBUTION_STATUSES }).notNull().default("pending"),
    /** Set once by T-53 when the order is delivered and its sale released, plus the snapshotted hold. */
    eligibleAt: timestamptz("eligible_at"),
    creditRef: text("credit_ref"),
    voidReason: text("void_reason"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "affiliate_attribution_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [orderFinancials.storeId, orderFinancials.orderId] }),
    foreignKey({ name: "affiliate_attribution_code_fk", columns: [t.affiliateId, t.codeId], foreignColumns: [affiliateCode.affiliateId, affiliateCode.id] }),
    foreignKey({ name: "affiliate_attribution_click_fk", columns: [t.clickId, t.affiliateId, t.storeId], foreignColumns: [affiliateClick.id, affiliateClick.affiliateId, affiliateClick.storeId] }),
    index("affiliate_attribution_affiliate_idx").on(t.affiliateId, t.id),
    check("affiliate_attribution_source_chk", sql`${t.source} = 'bukalaris'`),
    check("affiliate_attribution_method_chk", sql`${t.method} in (${quoted(ATTRIBUTION_METHODS)}) and ((${t.method} = 'code') = (${t.codeId} is not null))`),
    check("affiliate_attribution_click_chk", sql`${t.clickId} is null or ${t.clickDetachedAt} is null`),
    check("affiliate_attribution_amounts_chk", sql`${t.commissionIdr} > 0 and ${t.commissionBaseIdr} >= ${t.commissionIdr} and ${t.windowDays} >= 1 and ${t.holdDays} >= 0 and ${t.policyRevision} >= 1 and ${t.sellerPolicyRevision} >= 1`),
    check("affiliate_attribution_status_chk", sql`${t.status} in (${quoted(ATTRIBUTION_STATUSES)}) and (${t.status} <> 'void' or ${t.voidReason} is not null) and (${t.status} in ('pending', 'void') or ${t.eligibleAt} is not null)`),
  ],
);

// ── tenant class: the seller's own opt-in settings ───────────────────────────────────────────────────────────

/** One per store: closed by default (no row = closed). The default rate is NULL until the seller chooses one: there is no invented initial rate. */
export const affiliateSellerPolicy = pgTable(
  "affiliate_seller_policy",
  {
    storeId: storeKey().primaryKey().references(() => store.id),
    participation: text("participation", { enum: ["closed", "open"] }).notNull().default("closed"),
    defaultRateBps: integer("default_rate_bps"),
    revision: integer("revision").notNull().default(1),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("affiliate_seller_policy_state_chk", sql`${t.participation} in ('closed', 'open')`),
    check("affiliate_seller_policy_rate_chk", sql`${t.defaultRateBps} is null or ${t.defaultRateBps} between 0 and 10000`),
  ],
);

/** A product the seller opted in; `(store_id, source, product_id)` is unique and the product is the store's own (compound FK). */
export const affiliateOffer = pgTable(
  "affiliate_offer",
  {
    id: ident(),
    storeId: storeKey().references(() => store.id),
    source: text("source").notNull().default(AFFILIATE_SOURCE),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    status: text("status", { enum: OFFER_STATUSES }).notNull().default("active"),
    /** Per-product override in basis points; NULL means the store default. */
    rateBps: integer("rate_bps"),
    /** Source revision of the projection: bumped by every write (including the product, price, stock and image triggers). */
    revision: integer("revision").notNull().default(1),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("affiliate_offer_store_id_uq").on(t.storeId, t.id),
    unique("affiliate_offer_product_uq").on(t.storeId, t.source, t.productId),
    foreignKey({ name: "affiliate_offer_product_fk", columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id] }),
    index("affiliate_offer_product_idx").on(t.storeId, t.productId),
    check("affiliate_offer_source_chk", sql`${t.source} = 'bukalaris'`),
    check("affiliate_offer_status_chk", sql`${t.status} in (${quoted(OFFER_STATUSES)})`),
    check("affiliate_offer_rate_chk", sql`${t.rateBps} is null or ${t.rateBps} between 0 and 10000`),
  ],
);

/** A seller's block of one platform affiliate, for its own store only: a block stops new attribution there and rewrites nothing that was earned. */
export const affiliateBlock = pgTable(
  "affiliate_block",
  {
    storeId: storeKey().references(() => store.id),
    affiliateId: affiliateKey().references(() => affiliate.id),
    reason: text("reason").notNull(),
    blockedBy: text("blocked_by").notNull(),
    blockedAt: timestamptz("blocked_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "affiliate_block_pk", columns: [t.storeId, t.affiliateId] }),
    check("affiliate_block_reason_chk", sql`char_length(btrim(${t.reason})) between 1 and 300`),
  ],
);

// ── platform / shared-read class ─────────────────────────────────────────────────────────────────────────────

/**
 * The discovery read model (DATA-11): public seller and product fields of active opted-in offers, filled and withdrawn by the
 * `affiliate.catalog.project` job. `(source_revision, seller_policy_revision)` only ever grows (trigger), so a stale or replayed event cannot undo a newer
 * withdrawal. Nothing here is authoritative: checkout rechecks the live seller tables.
 */
export const affiliateCatalog = pgTable(
  "affiliate_catalog",
  {
    source: text("source").notNull().default(AFFILIATE_SOURCE),
    offerId: bigint("offer_id", { mode: "number" }).notNull(),
    storeId: storeKey(),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    storeSlug: text("store_slug").notNull(),
    storeName: text("store_name").notNull(),
    productTitle: text("product_title").notNull(),
    /** URL segment of the product on the storefront (the slug, else the catalog id: DATA-5). */
    productPath: text("product_path").notNull(),
    priceFromIdr: idr("price_from_idr"),
    inStock: boolean("in_stock").notNull().default(false),
    imageMediaId: bigint("image_media_id", { mode: "number" }),
    /** Effective commission rate at projection time (public by design, IAM-3); NULL when the offer is not active. */
    rateBps: integer("rate_bps"),
    active: boolean("active").notNull().default(false),
    sourceRevision: integer("source_revision").notNull(),
    /** Revision of the store's affiliate policy at projection (0 = the store has none): a policy change reprojects every offer without touching the offer rows. */
    sellerPolicyRevision: integer("seller_policy_revision").notNull().default(0),
    projectedAt: timestamptz("projected_at").notNull().defaultNow(),
  },
  (t) => [
    unique("affiliate_catalog_offer_pk").on(t.source, t.offerId),
    unique("affiliate_catalog_product_uq").on(t.source, t.storeId, t.productId),
    foreignKey({ name: "affiliate_catalog_offer_fk", columns: [t.storeId, t.offerId], foreignColumns: [affiliateOffer.storeId, affiliateOffer.id] }),
    index("affiliate_catalog_active_idx").on(t.active, t.storeId, t.productId),
    check("affiliate_catalog_source_chk", sql`${t.source} = 'bukalaris'`),
    check("affiliate_catalog_active_chk", sql`not ${t.active} or (${t.rateBps} is not null and ${t.priceFromIdr} is not null)`),
  ],
);

/** The programme limits (one row). The defaults are NAMED settings (settings.ts) that no owner has decided; the writer is T-54's console. */
export const affiliatePolicy = pgTable(
  "affiliate_policy",
  {
    id: smallint("id").primaryKey().default(1),
    minRateBps: integer("min_rate_bps").notNull(),
    maxRateBps: integer("max_rate_bps").notNull(),
    attributionWindowDays: integer("attribution_window_days").notNull(),
    holdDays: integer("hold_days").notNull(),
    revision: integer("revision").notNull().default(1),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("affiliate_policy_singleton_chk", sql`${t.id} = 1`),
    check("affiliate_policy_rate_chk", sql`${t.minRateBps} >= 0 and ${t.minRateBps} <= ${t.maxRateBps} and ${t.maxRateBps} <= 10000`),
    check("affiliate_policy_window_chk", sql`${t.attributionWindowDays} between 1 and 365 and ${t.holdDays} between 0 and 90`),
  ],
);

/** Daily per-affiliate fraud counters (SEC-20 phase 1); `affiliate_id` NULL = platform-wide (a failed code has no affiliate). Written by the definer functions that see the event. */
export const affiliateCounter = pgTable(
  "affiliate_counter",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: COUNTER_KINDS }).notNull(),
    affiliateId: bigint("affiliate_id", { mode: "number" }).references(() => affiliate.id),
    n: idr("n").notNull().default(0),
  },
  (t) => [
    uniqueIndex("affiliate_counter_uq").on(t.day, t.kind, sql`coalesce(${t.affiliateId}, 0)`),
    check("affiliate_counter_kind_chk", sql`${t.kind} in (${quoted(COUNTER_KINDS)}) and ${t.n} >= 0`),
  ],
);
