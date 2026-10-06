// M2 content track tables (collections, CMS pages, media). Re-exported by schema.ts.
// Every row carries store_id; children use compound (store_id, parent_id) foreign keys
// so a membership or image can never reference another store's product (DATA-6).
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
import { product, store } from "./schema.ts";

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const storeId = () => bigint("store_id", { mode: "number" }).notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const collection = pgTable(
  "collection",
  {
    id: id(),
    storeId: storeId().references(() => store.id),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("collection_store_id_uq").on(t.storeId, t.id),
    unique("collection_store_slug_uq").on(t.storeId, t.slug),
    check("collection_status_chk", sql`${t.status} in ('draft', 'published')`),
    check("collection_slug_chk", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

export const collectionProduct = pgTable(
  "collection_product",
  {
    collectionId: bigint("collection_id", { mode: "number" }).notNull(),
    storeId: storeId(),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.productId] }),
    foreignKey({ name: "collection_product_collection_fk", columns: [t.storeId, t.collectionId], foreignColumns: [collection.storeId, collection.id] }).onDelete("cascade"),
    foreignKey({ name: "collection_product_product_fk", columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id] }).onDelete("cascade"),
    index("collection_product_order_idx").on(t.collectionId, t.position),
  ],
);

export const page = pgTable(
  "page",
  {
    id: id(),
    storeId: storeId().references(() => store.id),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    // Markdown-lite (paragraphs, headings, lists, bold, links); rendered to elements, never as HTML.
    body: text("body").notNull().default(""),
    status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("page_store_slug_uq").on(t.storeId, t.slug),
    check("page_status_chk", sql`${t.status} in ('draft', 'published')`),
    check("page_slug_chk", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

/** Product images stored on local disk under MEDIA_DIR as `<store_id>/<id>.<ext>` (DATA-6 Media). */
export const media = pgTable(
  "media",
  {
    id: id(),
    storeId: storeId(),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    position: integer("position").notNull(),
    alt: text("alt").notNull().default(""),
    mime: text("mime", { enum: ["image/jpeg", "image/png", "image/webp"] }).notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("media_store_id_uq").on(t.storeId, t.id),
    foreignKey({ name: "media_product_fk", columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id] }).onDelete("cascade"),
    index("media_product_idx").on(t.storeId, t.productId, t.position),
    check("media_mime_chk", sql`${t.mime} in ('image/jpeg', 'image/png', 'image/webp')`),
    check("media_dims_chk", sql`${t.width} between 1 and 10000 and ${t.height} between 1 and 10000 and ${t.bytes} between 1 and 5242880`),
  ],
);
