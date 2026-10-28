// T-46 / DATA-8. Store-owned promotion configuration, guarded counters and immutable checkout redemption evidence.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
import { order, product, store, variant } from "../schema.ts";
import { collection, media } from "../storefront/schema-content.ts";

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const sid = () => bigint("store_id", { mode: "number" }).notNull();
const money = (name: string) => bigint(name, { mode: "number" }).notNull();
const time = (name: string) => timestamp(name, { withTimezone: true }).notNull();
export const PROMOTION_KINDS = ["percent", "fixed", "free_shipping"] as const;
export const PROMOTION_SCOPES = ["all", "collection", "product"] as const;

export const discount = pgTable("discount", {
  id: id(), storeId: sid().references(() => store.id),
  code: text("code").notNull(), codeSha256: text("code_sha256").notNull(),
  kind: text("kind", { enum: PROMOTION_KINDS }).notNull(), scope: text("scope", { enum: PROMOTION_SCOPES }).notNull(),
  productId: bigint("product_id", { mode: "number" }), collectionId: bigint("collection_id", { mode: "number" }),
  value: money("value"), minPurchaseIdr: money("min_purchase_idr").default(0), maxDiscountIdr: bigint("max_discount_idr", { mode: "number" }),
  usageLimit: integer("usage_limit"), buyerUsageLimit: integer("buyer_usage_limit"), usedCount: integer("used_count").notNull().default(0),
  startsAt: time("starts_at"), endsAt: time("ends_at"), status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  public: boolean("public").notNull().default(true), createdAt: time("created_at").defaultNow(),
}, (t) => [
  unique("discount_store_id_uq").on(t.storeId, t.id), unique("discount_code_uq").on(t.storeId, t.codeSha256),
  foreignKey({ name: "discount_product_fk", columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id] }),
  foreignKey({ name: "discount_collection_fk", columns: [t.storeId, t.collectionId], foreignColumns: [collection.storeId, collection.id] }),
  check("discount_scope_chk", sql`(${t.scope} = 'all' and ${t.productId} is null and ${t.collectionId} is null) or (${t.scope} = 'product' and ${t.productId} is not null and ${t.collectionId} is null) or (${t.scope} = 'collection' and ${t.productId} is null and ${t.collectionId} is not null)`),
  check("discount_value_chk", sql`(${t.kind} = 'percent' and ${t.value} between 1 and 10000) or (${t.kind} = 'fixed' and ${t.value} > 0) or (${t.kind} = 'free_shipping' and ${t.value} = 0)`),
  check("discount_limits_chk", sql`${t.minPurchaseIdr} >= 0 and (${t.maxDiscountIdr} is null or ${t.maxDiscountIdr} >= 0) and (${t.usageLimit} is null or ${t.usageLimit} >= 1) and (${t.buyerUsageLimit} is null or ${t.buyerUsageLimit} >= 1) and ${t.usedCount} >= 0 and (${t.usageLimit} is null or ${t.usedCount} <= ${t.usageLimit})`),
  check("discount_window_chk", sql`${t.endsAt} > ${t.startsAt} and ${t.status} in ('active', 'disabled')`),
  check("discount_code_chk", sql`${t.code} ~ '^[A-F0-9]{24}$' and ${t.codeSha256} ~ '^[a-f0-9]{64}$'`),
]);

export const discountBuyerUsage = pgTable("discount_buyer_usage", {
  storeId: sid(), discountId: bigint("discount_id", { mode: "number" }).notNull(), phoneFingerprint: text("phone_fingerprint").notNull(), usedCount: integer("used_count").notNull().default(1),
}, (t) => [primaryKey({ columns: [t.storeId, t.discountId, t.phoneFingerprint] }), foreignKey({ name: "discount_buyer_usage_fk", columns: [t.storeId, t.discountId], foreignColumns: [discount.storeId, discount.id] }), check("discount_buyer_count_chk", sql`${t.usedCount} >= 1`)]);

export const discountRedemption = pgTable("discount_redemption", {
  storeId: sid(), orderId: bigint("order_id", { mode: "number" }).primaryKey(), discountId: bigint("discount_id", { mode: "number" }).notNull(),
  goodsDiscountIdr: money("goods_discount_idr"), shippingDiscountIdr: money("shipping_discount_idr"), createdAt: time("created_at").defaultNow(),
}, (t) => [foreignKey({ name: "discount_redemption_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }), foreignKey({ name: "discount_redemption_discount_fk", columns: [t.storeId, t.discountId], foreignColumns: [discount.storeId, discount.id] }), check("discount_redemption_amount_chk", sql`${t.goodsDiscountIdr} >= 0 and ${t.shippingDiscountIdr} >= 0`)]);

export const flashSale = pgTable("flash_sale", {
  id: id(), storeId: sid().references(() => store.id), title: text("title").notNull(), startsAt: time("starts_at"), endsAt: time("ends_at"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"), createdAt: time("created_at").defaultNow(),
}, (t) => [unique("flash_sale_store_id_uq").on(t.storeId, t.id), check("flash_sale_window_chk", sql`${t.endsAt} > ${t.startsAt} and ${t.status} in ('active', 'disabled')`)]);
export const flashSaleItem = pgTable("flash_sale_item", {
  id: id(), storeId: sid(), flashSaleId: bigint("flash_sale_id", { mode: "number" }).notNull(), productId: bigint("product_id", { mode: "number" }).notNull(), variantId: bigint("variant_id", { mode: "number" }).notNull(),
  salePriceIdr: money("sale_price_idr"), stockCap: integer("stock_cap"), soldCount: integer("sold_count").notNull().default(0),
}, (t) => [
  unique("flash_sale_item_store_id_uq").on(t.storeId, t.id), unique("flash_sale_variant_uq").on(t.flashSaleId, t.variantId), index("flash_sale_variant_idx").on(t.storeId, t.variantId),
  foreignKey({ name: "flash_sale_item_sale_fk", columns: [t.storeId, t.flashSaleId], foreignColumns: [flashSale.storeId, flashSale.id] }),
  foreignKey({ name: "flash_sale_item_product_fk", columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id] }),
  foreignKey({ name: "flash_sale_item_variant_fk", columns: [t.storeId, t.variantId], foreignColumns: [variant.storeId, variant.id] }),
  check("flash_sale_item_stock_chk", sql`${t.salePriceIdr} >= 0 and ${t.soldCount} >= 0 and (${t.stockCap} is null or (${t.stockCap} >= 1 and ${t.soldCount} <= ${t.stockCap}))`),
]);
export const flashSaleRedemption = pgTable("flash_sale_redemption", {
  storeId: sid(), orderId: bigint("order_id", { mode: "number" }).notNull(), itemId: bigint("item_id", { mode: "number" }).notNull(), quantity: integer("quantity").notNull(), goodsDiscountIdr: money("goods_discount_idr"),
}, (t) => [primaryKey({ columns: [t.orderId, t.itemId] }), foreignKey({ name: "flash_redemption_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }), foreignKey({ name: "flash_redemption_item_fk", columns: [t.storeId, t.itemId], foreignColumns: [flashSaleItem.storeId, flashSaleItem.id] }), check("flash_redemption_amount_chk", sql`${t.quantity} >= 1 and ${t.goodsDiscountIdr} >= 0`)]);

export const promoHub = pgTable("promo_hub", {
  storeId: sid().primaryKey().references(() => store.id), enabled: boolean("enabled").notNull().default(false), title: text("title").notNull().default("Promo toko"), subtitle: text("subtitle").notNull().default(""),
  bannerMediaId: bigint("banner_media_id", { mode: "number" }), bannerCtaLabel: text("banner_cta_label").notNull().default(""), bannerCtaHref: text("banner_cta_href").notNull().default(""),
  freeShipEnabled: boolean("free_ship_enabled").notNull().default(false), freeShipThresholdIdr: money("free_ship_threshold_idr").default(0),
  percentRounding: text("percent_rounding", { enum: ["floor", "half_up", "ceil"] }).notNull().default("floor"),
}, (t) => [foreignKey({ name: "promo_hub_banner_fk", columns: [t.storeId, t.bannerMediaId], foreignColumns: [media.storeId, media.id] }), check("promo_hub_settings_chk", sql`${t.freeShipThresholdIdr} >= 0 and ${t.percentRounding} in ('floor', 'half_up', 'ceil')`)]);
export const promoHubCollection = pgTable("promo_hub_collection", {
  storeId: sid().references(() => promoHub.storeId), collectionId: bigint("collection_id", { mode: "number" }).notNull(), position: integer("position").notNull(),
}, (t) => [primaryKey({ columns: [t.storeId, t.collectionId] }), foreignKey({ name: "promo_hub_collection_fk", columns: [t.storeId, t.collectionId], foreignColumns: [collection.storeId, collection.id] })]);
