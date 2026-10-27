// M2 catalog track tables (T-14 slug aliases, T-31 catalog audit). Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { product, variant } from "../../schema.ts";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Historical product slugs (DATA-5 route claims). One (store_id, slug) namespace: an alias
 * points directly at its product, so resolution is one 308 with no chains, and a slug that
 * was ever published is never handed to another product of the same store.
 */
export const productSlugAlias = pgTable(
  "product_slug_alias",
  {
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    slug: text("slug").notNull(),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.storeId, t.slug] }),
    foreignKey({ name: "product_slug_alias_product_fk", columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id] }),
    index("product_slug_alias_product_idx").on(t.storeId, t.productId),
    check("product_slug_alias_slug_chk", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and ${t.slug} !~ '^[0-9]+$'`),
  ],
);

export const CATALOG_AUDIT_ACTIONS = ["product.create", "product.update", "variant.create", "variant.update"] as const;
export type CatalogAuditAction = (typeof CATALOG_AUDIT_ACTIONS)[number];
/** Tracked fields: product → title, slug, status; variant → title, sku, price, stock. */
export type CatalogSnapshot = Record<string, string | number | null>;

/** Every catalog write, in the same transaction (SEC-17, IAM-5): actor, store, object, before/after snapshot. */
export const catalogAudit = pgTable(
  "catalog_audit",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    actorUserId: text("actor_user_id").notNull(),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    variantId: bigint("variant_id", { mode: "number" }),
    action: text("action", { enum: CATALOG_AUDIT_ACTIONS }).notNull(),
    before: jsonb("before").$type<CatalogSnapshot>(),
    after: jsonb("after").$type<CatalogSnapshot>(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "catalog_audit_product_fk", columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id] }),
    foreignKey({ name: "catalog_audit_variant_fk", columns: [t.storeId, t.variantId], foreignColumns: [variant.storeId, variant.id] }),
    index("catalog_audit_product_idx").on(t.storeId, t.productId, t.id),
    check("catalog_audit_action_chk", sql`${t.action} in ('product.create', 'product.update', 'variant.create', 'variant.update')`),
  ],
);
