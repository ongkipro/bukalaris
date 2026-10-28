import { and, asc, count, desc, eq, ilike, inArray, max, or, sql } from "drizzle-orm";
import { z } from "zod";
import { accountStatusEvent, auditLog, collection, collectionProduct, media, membership, order, page, product, store, user, variant } from "../schema.ts";
import { DomainError, requireCap, type OperatorScope, type SellerScope, type StorefrontScope } from "../platform/scoped.ts";
import { isReservedHostLabel, RESERVED_ROUTE_ROOTS, validClaimableLabel } from "../platform/host.ts";
import { inStore } from "../platform/tenant.ts";
import { withPersonalDataAccess } from "../ops/console-access.ts";
import { maskEmail, maskName } from "../ops/accounts-governance.ts";
import { hasPlatformCap, requirePlatformCap } from "../ops/capabilities.ts";

// M2 content track: store settings/theme (SC-10/11), collections (SC-05/06, SF-02),
// CMS pages (SC-07/08, SF-05), product media (DATA-6) and storefront search (SF-03).
// Every store-owned query filters by scope.storeId; children also carry compound FKs.

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Slug wajib diisi.")
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug hanya huruf kecil, angka dan tanda hubung.");
const publish = z.enum(["draft", "published"]);
const notFound = (what: string) => new DomainError("not_found", `${what} tidak ditemukan.`);

function constraint(err: unknown): string | undefined {
  return (err as { cause?: { constraint_name?: string } })?.cause?.constraint_name;
}

// ---------------------------------------------------------------------------
// Store settings and theme (owner only).
// ---------------------------------------------------------------------------
export type Theme = "responsive" | "mobile";

/** Indonesian numbers only: "0812…", "+62812…", "62812…" → "62812…". */
const whatsapp = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s().-]/g, "").replace(/^\+/, "").replace(/^0/, "62"))
  .refine((s) => s === "" || /^62[0-9]{8,13}$/.test(s), "Nomor WhatsApp harus nomor Indonesia, contoh 0812xxxxxxx.")
  .transform((s) => s || null);

export const storeSettingsInput = z.strictObject({
  name: z.string().trim().min(1, "Nama toko wajib diisi.").max(200),
  description: z.string().trim().max(2000).default(""),
  whatsapp: whatsapp.prefault(""),
  theme: z.enum(["responsive", "mobile"]).default("responsive"),
});

export async function getStoreSettings(scope: SellerScope) {
  return inStore(scope, async (scope) => {
    const [row] = await scope.exec
      .select({ name: store.name, slug: store.slug, description: store.description, whatsapp: store.whatsapp, theme: store.theme })
      .from(store)
      .where(eq(store.id, scope.storeId));
    return row!;
  });
}

export async function updateStoreSettings(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "settings.manage"); // owner only; refused while the subscription is past due (T-50), like every Seller Admin write
  const input = storeSettingsInput.parse(raw);
  await inStore(scope, async ({ exec: tx }) => {
    await tx.update(store).set(input).where(eq(store.id, scope.storeId));
    await tx.insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: `store.settings:${input.theme}` });
  });
}

// ---------------------------------------------------------------------------
// Collections.
// ---------------------------------------------------------------------------
const productIds = z
  .array(z.coerce.number().int().positive())
  .max(500)
  .transform((ids) => [...new Set(ids)]);

export const collectionInput = z.strictObject({
  title: z.string().trim().min(1, "Judul wajib diisi.").max(200),
  slug,
  description: z.string().trim().max(2000).default(""),
  status: publish.default("draft"),
  productIds: productIds.default([]),
});
export type CollectionInput = z.input<typeof collectionInput>;

export async function listCollections(scope: SellerScope) {
  requireCap(scope, "catalog.read");
  return inStore(scope, async (scope) => {
    return scope.exec
      .select({
        id: collection.id,
        title: collection.title,
        slug: collection.slug,
        status: collection.status,
        products: count(collectionProduct.productId),
      })
      .from(collection)
      .leftJoin(collectionProduct, eq(collectionProduct.collectionId, collection.id))
      .where(eq(collection.storeId, scope.storeId))
      .groupBy(collection.id)
      .orderBy(desc(collection.id));
  });
}

export async function getCollection(scope: SellerScope, collectionId: number) {
  requireCap(scope, "catalog.read");
  return inStore(scope, async (scope) => {
    const [row] = await scope.exec
      .select()
      .from(collection)
      .where(and(eq(collection.storeId, scope.storeId), eq(collection.id, collectionId)));
    if (!row) return null;
    const members = await scope.exec
      .select({ productId: collectionProduct.productId })
      .from(collectionProduct)
      .where(and(eq(collectionProduct.storeId, scope.storeId), eq(collectionProduct.collectionId, collectionId)))
      .orderBy(asc(collectionProduct.position));
    return { ...row, productIds: members.map((m) => m.productId) };
  });
}

/** Replace the ordered membership; every product must belong to this store (checked, and FK-enforced). */
async function setMembers(tx: SellerScope["exec"], scope: SellerScope, collectionId: number, ids: number[]) {
  if (ids.length > 0) {
    const owned = await tx
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.storeId, scope.storeId), inArray(product.id, ids)));
    if (owned.length !== ids.length) throw new DomainError("foreign_product", "Produk tidak ditemukan di toko ini.");
  }
  await tx.delete(collectionProduct).where(and(eq(collectionProduct.storeId, scope.storeId), eq(collectionProduct.collectionId, collectionId)));
  if (ids.length > 0) {
    await tx.insert(collectionProduct).values(ids.map((productId, position) => ({ collectionId, storeId: scope.storeId, productId, position })));
  }
}

function collectionError(err: unknown): never {
  if (constraint(err) === "collection_store_slug_uq") throw new DomainError("slug_taken", "Slug sudah dipakai koleksi lain di toko ini.");
  if (constraint(err) === "collection_product_product_fk") throw new DomainError("foreign_product", "Produk tidak ditemukan di toko ini.");
  throw err;
}

export async function createCollection(scope: SellerScope, raw: unknown): Promise<number> {
  requireCap(scope, "catalog.write");
  const { productIds: ids, ...input } = collectionInput.parse(raw);
  try {
    return await inStore(scope, async ({ exec: tx }) => {
      const [c] = await tx.insert(collection).values({ ...input, storeId: scope.storeId }).returning({ id: collection.id });
      await setMembers(tx, scope, c!.id, ids);
      return c!.id;
    });
  } catch (err) {
    collectionError(err);
  }
}

export async function updateCollection(scope: SellerScope, collectionId: number, raw: unknown): Promise<void> {
  requireCap(scope, "catalog.write");
  const { productIds: ids, ...input } = collectionInput.parse(raw);
  try {
    await inStore(scope, async ({ exec: tx }) => {
      const updated = await tx
        .update(collection)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(collection.storeId, scope.storeId), eq(collection.id, collectionId)))
        .returning({ id: collection.id });
      if (updated.length === 0) throw notFound("Koleksi");
      await setMembers(tx, scope, collectionId, ids);
    });
  } catch (err) {
    collectionError(err);
  }
}

// ---------------------------------------------------------------------------
// CMS pages.
// ---------------------------------------------------------------------------
/** Storefront and platform routes a page can never claim (DATA-6 "reserved routes"). */
export const RESERVED_PAGE_SLUGS = new Set(Object.keys(RESERVED_ROUTE_ROOTS));

export const pageInput = z.strictObject({
  title: z.string().trim().min(1, "Judul wajib diisi.").max(200),
  slug: slug.refine((s) => !RESERVED_PAGE_SLUGS.has(s), "Slug ini dicadangkan untuk rute toko."),
  body: z.string().max(50_000).default(""),
  status: publish.default("draft"),
});
export type PageInput = z.input<typeof pageInput>;

function pageError(err: unknown): never {
  if (constraint(err) === "page_store_slug_uq") throw new DomainError("slug_taken", "Slug sudah dipakai halaman lain di toko ini.");
  throw err;
}

export async function listPages(scope: SellerScope) {
  requireCap(scope, "catalog.read");
  return inStore(scope, async (scope) => {
    return scope.exec
      .select({ id: page.id, title: page.title, slug: page.slug, status: page.status, updatedAt: page.updatedAt })
      .from(page)
      .where(eq(page.storeId, scope.storeId))
      .orderBy(desc(page.id));
  });
}

export async function getPage(scope: SellerScope, pageId: number) {
  requireCap(scope, "catalog.read");
  return inStore(scope, async (scope) => {
    const [row] = await scope.exec.select().from(page).where(and(eq(page.storeId, scope.storeId), eq(page.id, pageId)));
    return row ?? null;
  });
}

export async function createPage(scope: SellerScope, raw: unknown): Promise<number> {
  requireCap(scope, "catalog.write");
  return inStore(scope, async (scope) => {
    const input = pageInput.parse(raw);
    try {
      const [p] = await scope.exec.insert(page).values({ ...input, storeId: scope.storeId }).returning({ id: page.id });
      return p!.id;
    } catch (err) {
      pageError(err);
    }
  });
}

export async function updatePage(scope: SellerScope, pageId: number, raw: unknown): Promise<void> {
  requireCap(scope, "catalog.write");
  return inStore(scope, async (scope) => {
    const input = pageInput.parse(raw);
    try {
      const updated = await scope.exec
        .update(page)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(page.storeId, scope.storeId), eq(page.id, pageId)))
        .returning({ id: page.id });
      if (updated.length === 0) throw notFound("Halaman");
    } catch (err) {
      pageError(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Product media. Bytes are sniffed, never trusted from the file name or declared type
// (SEC-8). Dimensions are read from the header so <img> can reserve space without sharp.
// ---------------------------------------------------------------------------
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const MEDIA_MAX_PER_PRODUCT = 10;
export type ImageMime = "image/jpeg" | "image/png" | "image/webp";
export const mediaExt: Record<ImageMime, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** Content sniffing + header dimensions for jpg/png/webp; null for anything else. */
export function sniffImage(b: Uint8Array): { mime: ImageMime; width: number; height: number } | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && ascii(b, 12, 4) === "IHDR") {
    return { mime: "image/png", width: (be16(b, 16) << 16) | be16(b, 18), height: (be16(b, 20) << 16) | be16(b, 22) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length && b[i] === 0xff) {
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", width: be16(b, i + 7), height: be16(b, i + 5) };
      }
      i += 2 + be16(b, i + 2);
    }
    return null;
  }
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 ") return { mime: "image/webp", width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
    if (chunk === "VP8L") {
      const w = 1 + (((b[22]! & 0x3f) << 8) | b[21]!);
      const h = 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6));
      return { mime: "image/webp", width: w, height: h };
    }
    if (chunk === "VP8X") return { mime: "image/webp", width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
  }
  return null;
}

/** Throws a DomainError unless the bytes are a bounded jpg/png/webp image. */
export function validateImage(b: Uint8Array) {
  if (b.length === 0) throw new DomainError("empty_file", "Pilih berkas gambar.");
  if (b.length > MEDIA_MAX_BYTES) throw new DomainError("too_large", "Ukuran gambar maksimal 5 MB.");
  const img = sniffImage(b);
  if (!img) throw new DomainError("bad_type", "Berkas harus gambar JPG, PNG atau WebP.");
  if (img.width < 1 || img.height < 1 || img.width > 10_000 || img.height > 10_000) {
    throw new DomainError("bad_dims", "Dimensi gambar tidak valid (maksimal 10000 px).");
  }
  return { ...img, bytes: b.length };
}

export const mediaKey = (m: { storeId: number; id: number; mime: ImageMime }) => `${m.storeId}/${m.id}.${mediaExt[m.mime]}`;

const alt = z.string().trim().max(300);

export async function listProductMedia(scope: SellerScope, productId: number) {
  requireCap(scope, "catalog.read");
  return inStore(scope, async (scope) => {
    return scope.exec
      .select({ id: media.id, storeId: media.storeId, alt: media.alt, mime: media.mime, width: media.width, height: media.height, position: media.position })
      .from(media)
      .where(and(eq(media.storeId, scope.storeId), eq(media.productId, productId)))
      .orderBy(asc(media.position), asc(media.id));
  });
}

/**
 * Insert the metadata row for validated bytes. `persist(key)` stores the file inside the
 * transaction, so a failed write leaves no orphan row.
 */
export async function addProductMedia(
  scope: SellerScope,
  productId: number,
  bytes: Uint8Array,
  rawAlt: unknown,
  persist: (key: string) => Promise<void> = async () => {},
) {
  requireCap(scope, "catalog.write");
  const img = validateImage(bytes);
  const altText = alt.parse(rawAlt ?? "");
  return inStore(scope, async ({ exec: tx }) => {
    const [owned] = await tx.select({ id: product.id }).from(product).where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)));
    if (!owned) throw notFound("Produk");
    const [{ n, last }] = (await tx
      .select({ n: count(), last: max(media.position) })
      .from(media)
      .where(and(eq(media.storeId, scope.storeId), eq(media.productId, productId)))) as [{ n: number; last: number | null }];
    if (n >= MEDIA_MAX_PER_PRODUCT) throw new DomainError("too_many", `Maksimal ${MEDIA_MAX_PER_PRODUCT} gambar per produk.`);
    const [m] = await tx
      .insert(media)
      .values({ storeId: scope.storeId, productId, position: (last ?? -1) + 1, alt: altText, ...img })
      .returning({ id: media.id });
    const key = mediaKey({ storeId: scope.storeId, id: m!.id, mime: img.mime });
    await persist(key);
    return { id: m!.id, key };
  });
}

export async function updateMediaAlt(scope: SellerScope, mediaId: number, rawAlt: unknown): Promise<void> {
  requireCap(scope, "catalog.write");
  return inStore(scope, async (scope) => {
    const updated = await scope.exec
      .update(media)
      .set({ alt: alt.parse(rawAlt ?? "") })
      .where(and(eq(media.storeId, scope.storeId), eq(media.id, mediaId)))
      .returning({ id: media.id });
    if (updated.length === 0) throw notFound("Gambar");
  });
}

/** Swap positions with the previous image (make it the cover sooner). */
export async function moveMediaUp(scope: SellerScope, mediaId: number): Promise<void> {
  requireCap(scope, "catalog.write");
  await inStore(scope, async ({ exec: tx }) => {
    const [m] = await tx.select().from(media).where(and(eq(media.storeId, scope.storeId), eq(media.id, mediaId)));
    if (!m) throw notFound("Gambar");
    const siblings = await tx
      .select({ id: media.id, position: media.position })
      .from(media)
      .where(and(eq(media.storeId, scope.storeId), eq(media.productId, m.productId)))
      .orderBy(asc(media.position), asc(media.id));
    const i = siblings.findIndex((s) => s.id === mediaId);
    if (i <= 0) return;
    // Renumber densely so swaps stay well-defined even after deletions.
    [siblings[i - 1], siblings[i]] = [siblings[i]!, siblings[i - 1]!];
    for (const [position, s] of siblings.entries()) {
      await tx.update(media).set({ position }).where(and(eq(media.storeId, scope.storeId), eq(media.id, s.id)));
    }
  });
}

/** Delete the row; returns the storage key so the caller can unlink the file. */
export async function removeProductMedia(scope: SellerScope, mediaId: number): Promise<string> {
  requireCap(scope, "catalog.write");
  return inStore(scope, async (scope) => {
    const [m] = await scope.exec
      .delete(media)
      .where(and(eq(media.storeId, scope.storeId), eq(media.id, mediaId)))
      .returning({ id: media.id, storeId: media.storeId, mime: media.mime });
    if (!m) throw notFound("Gambar");
    return mediaKey(m);
  });
}

// ---------------------------------------------------------------------------
// Storefront reads: only this store's published content.
// ---------------------------------------------------------------------------
export type Cover = { id: number; alt: string; width: number; height: number; key: string };
const coverOf = (m: { id: number; storeId: number; alt: string; mime: ImageMime; width: number; height: number }): Cover => ({
  id: m.id, alt: m.alt, width: m.width, height: m.height, key: mediaKey(m),
});

/** Store profile for the storefront shell (theme, description, WhatsApp). */
export async function getStorefrontStore(scope: StorefrontScope) {
  return inStore(scope, async (scope) => {
    const [row] = await scope.exec
      .select({ description: store.description, whatsapp: store.whatsapp, theme: store.theme })
      .from(store)
      .where(eq(store.id, scope.storeId));
    return row!;
  });
}

/** Published metadata for the media route handler; null when the file is not this store's. */
export async function getPublicMedia(scope: StorefrontScope, mediaId: number) {
  return inStore(scope, async (scope) => {
    const [m] = await scope.exec
      .select({ id: media.id, storeId: media.storeId, mime: media.mime, bytes: media.bytes, productStatus: product.status })
      .from(media)
      .innerJoin(product, and(eq(product.storeId, media.storeId), eq(product.id, media.productId)))
      .where(and(eq(media.storeId, scope.storeId), eq(media.id, mediaId)));
    return m ? { ...m, key: mediaKey(m) } : null;
  });
}

/** Cover image (position 0) per product for listings. */
export async function coverImages(scope: StorefrontScope | SellerScope, ids: number[]): Promise<Map<number, Cover>> {
  return inStore(scope, async (scope) => {
    const out = new Map<number, Cover>();
    if (ids.length === 0) return out;
    const rows = await scope.exec
      .select({ id: media.id, storeId: media.storeId, productId: media.productId, alt: media.alt, mime: media.mime, width: media.width, height: media.height })
      .from(media)
      .where(and(eq(media.storeId, scope.storeId), inArray(media.productId, ids)))
      .orderBy(asc(media.position), asc(media.id));
    for (const r of rows) if (!out.has(r.productId)) out.set(r.productId, coverOf(r));
    return out;
  });
}

/** All images of one published product, in order. */
export async function publishedProductImages(scope: StorefrontScope, productId: number): Promise<Cover[]> {
  return inStore(scope, async (scope) => {
    const rows = await scope.exec
      .select({ id: media.id, storeId: media.storeId, alt: media.alt, mime: media.mime, width: media.width, height: media.height })
      .from(media)
      .innerJoin(product, and(eq(product.storeId, media.storeId), eq(product.id, media.productId)))
      .where(and(eq(media.storeId, scope.storeId), eq(media.productId, productId), eq(product.status, "active")))
      .orderBy(asc(media.position), asc(media.id));
    return rows.map(coverOf);
  });
}

export async function listPublishedCollections(scope: StorefrontScope) {
  return inStore(scope, async (scope) => {
    return scope.exec
      .select({ id: collection.id, title: collection.title, slug: collection.slug, description: collection.description })
      .from(collection)
      .where(and(eq(collection.storeId, scope.storeId), eq(collection.status, "published")))
      .orderBy(asc(collection.id));
  });
}

const sellable = (scope: StorefrontScope) => and(eq(product.storeId, scope.storeId), eq(product.status, "active"));
const card = { id: product.id, catalogId: product.catalogId, title: product.title, slug: product.slug, minPrice: sql<number | null>`min(${variant.price})`.mapWith(Number) };

/** Published collection with its active products in collection order. */
export async function getPublishedCollection(scope: StorefrontScope, slugValue: string) {
  return inStore(scope, async (scope) => {
    const [c] = await scope.exec
      .select({ id: collection.id, title: collection.title, slug: collection.slug, description: collection.description })
      .from(collection)
      .where(and(eq(collection.storeId, scope.storeId), eq(collection.status, "published"), eq(collection.slug, slugValue)));
    if (!c) return null;
    const products = await scope.exec
      .select({ ...card, position: collectionProduct.position })
      .from(collectionProduct)
      .innerJoin(product, and(eq(product.storeId, collectionProduct.storeId), eq(product.id, collectionProduct.productId)))
      .innerJoin(variant, and(eq(variant.storeId, product.storeId), eq(variant.productId, product.id)))
      .where(and(sellable(scope), eq(collectionProduct.collectionId, c.id)))
      .groupBy(product.id, collectionProduct.position)
      .orderBy(asc(collectionProduct.position));
    return { ...c, products };
  });
}

export async function listPublishedPages(scope: StorefrontScope) {
  return inStore(scope, async (scope) => {
    return scope.exec
      .select({ id: page.id, title: page.title, slug: page.slug })
      .from(page)
      .where(and(eq(page.storeId, scope.storeId), eq(page.status, "published")))
      .orderBy(asc(page.id));
  });
}

export async function getPublishedPage(scope: StorefrontScope, slugValue: string) {
  return inStore(scope, async (scope) => {
    const [p] = await scope.exec
      .select({ id: page.id, title: page.title, slug: page.slug, body: page.body, updatedAt: page.updatedAt })
      .from(page)
      .where(and(eq(page.storeId, scope.storeId), eq(page.status, "published"), eq(page.slug, slugValue)));
    return p ?? null;
  });
}

export const SEARCH_LIMIT = 24;
const searchQuery = z.string().trim().max(100);

/** Case-insensitive substring search over title/description of this store's active products; bounded. */
export async function searchPublishedProducts(scope: StorefrontScope, rawQ: unknown) {
  return inStore(scope, async (scope) => {
    const q = searchQuery.parse(typeof rawQ === "string" ? rawQ : "");
    if (q.length === 0) return { q, products: [] };
    // lazy: ILIKE is enough for catalogs of hundreds of products; upgrade to tsvector + GIN when sellers exceed that.
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const products = await scope.exec
      .select(card)
      .from(product)
      .innerJoin(variant, and(eq(variant.storeId, product.storeId), eq(variant.productId, product.id)))
      .where(and(sellable(scope), or(ilike(product.title, pattern), ilike(product.description, pattern))))
      .groupBy(product.id)
      .orderBy(asc(product.title))
      .limit(SEARCH_LIMIT);
    return { q, products };
  });
}

// ---------------------------------------------------------------------------
// Super Admin store detail and creation (SA-03). Cross-store reads need an OperatorScope.
// ---------------------------------------------------------------------------
export const storeCreateInput = z.strictObject({
  slug: slug
    .max(63)
    .refine((s) => !isReservedHostLabel(s) && validClaimableLabel(s), "Slug toko ini dicadangkan oleh platform."),
  name: z.string().trim().min(1, "Nama toko wajib diisi.").max(200),
  ownerEmail: z.email("Email pemilik tidak valid.").trim().toLowerCase(),
});

/** Create a store whose first owner is an existing user chosen by email (invitations are another track). */
export async function createStoreForOwnerEmail(op: OperatorScope, raw: unknown): Promise<number> {
  await requirePlatformCap(op, "tenants.manage");
  const input = storeCreateInput.parse(raw);
  const [owner] = await op.exec.select({ id: user.id }).from(user).where(eq(user.email, input.ownerEmail));
  if (!owner) throw new DomainError("owner_not_found", "Tidak ada pengguna dengan email itu.");
  try {
    return await op.exec.transaction(async (tx) => {
      const [s] = await tx.insert(store).values({ slug: input.slug, name: input.name }).returning({ id: store.id });
      await tx.insert(membership).values({ storeId: s!.id, userId: owner.id, role: "owner" });
      await tx.insert(auditLog).values({ actorUserId: op.userId, storeId: s!.id, action: "store.create", reason: `owner ${maskEmail(input.ownerEmail)}` }); // PRIV-9: an audit reason never carries a raw contact
      await tx.insert(accountStatusEvent).values({ subjectKind: "store", subjectId: String(s!.id), fromStatus: null, toStatus: "active", reasonCode: "store_created", actorUserId: op.userId });
      return s!.id;
    });
  } catch (err) {
    if (constraint(err) === "store_slug_unique") throw new DomainError("slug_taken", "Slug toko sudah dipakai.");
    throw err;
  }
}

/** Needs `tenants.read`; the audit rows are included only for an operator who also holds `audit.read` (otherwise `audit` is null). */
export async function getStoreDetail(op: OperatorScope, storeId: number) {
  await requirePlatformCap(op, "tenants.read");
  const [s] = await op.exec.select().from(store).where(eq(store.id, storeId));
  if (!s) return null;
  const n = async (table: typeof product | typeof order | typeof membership | typeof collection | typeof page | typeof media) => {
    const [{ c }] = (await op.exec.select({ c: count() }).from(table).where(eq(table.storeId, storeId))) as [{ c: number }];
    return c;
  };
  const [products, orders, members, collections, pages, images] = await Promise.all([n(product), n(order), n(membership), n(collection), n(page), n(media)]);
  // PRIV-9: the team summary carries masked contact only (masked in the data layer), and the read is recorded as a masked access event.
  const owners = await withPersonalDataAccess(op, { capability: "tenants.read", targetKind: "store", targetId: String(storeId), fieldClass: "email", purposeCode: "support_case", reason: "ringkasan tim di detail toko", accessLevel: "masked" }, async (tx) => {
    const rows = await tx
      .select({ userId: user.id, email: user.email, name: user.name, role: membership.role })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .where(eq(membership.storeId, storeId))
      .orderBy(asc(membership.role), asc(user.email));
    return rows.map((r) => ({ userId: r.userId, email: maskEmail(r.email), name: maskName(r.name), role: r.role }));
  });
  const audit = (await hasPlatformCap(op, "audit.read")) ? await op.exec.select().from(auditLog).where(eq(auditLog.storeId, storeId)).orderBy(desc(auditLog.id)).limit(20) : null;
  return { ...s, counts: { products, orders, members, collections, pages, images }, members: owners, audit };
}
