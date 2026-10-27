import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { mediaKey, RESERVED_PAGE_SLUGS, type Cover } from "./content.ts";
import { auditLog, landingPage, landingPageRevision, media, product, variant } from "../schema.ts";
import { DomainError, requireCap, type SellerScope, type StorefrontScope } from "../platform/scoped.ts";
import { inStore } from "../platform/tenant.ts";

// M2 landing track (T-42, PR-9, ARCH-4, UI-6). A landing page is store-owned content with its
// own presentation: a versioned JSON document of typed blocks plus design settings, saved as
// immutable revisions. The page row points at the latest draft and at the published revision;
// the public route reads only the published pointer. Commerce stays in the commerce core: the
// order block names one product, the storefront cart and hosted checkout do the rest.

export { LANDING_STATUSES, type LandingStatus } from "../schema.ts";

// ── Document (schema version 1) ────────────────────────────────────────────────────────────
export const LANDING_SCHEMA_VERSION = 1;
/** Small accent palette; the renderer maps a token to CSS variables (no inline styles under the nonce CSP). */
export const LP_ACCENTS = ["ink", "teal", "emerald", "amber", "rose", "indigo"] as const;
export type LpAccent = (typeof LP_ACCENTS)[number];
export const LP_FONT_SCALES = ["compact", "regular", "large"] as const;
export type LpFontScale = (typeof LP_FONT_SCALES)[number];
export const LP_MAX_BLOCKS = 30;

const blockId = z.string().regex(/^[a-z0-9]{4,40}$/);
const short = (max: number) => z.string().trim().max(max);
const required = (max: number, msg: string) => z.string().trim().min(1, msg).max(max);
const mediaRef = z.coerce.number().int().positive().nullable();
const items = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(item).min(1, "Minimal satu item.").max(max);

export const blockSchemas = {
  hero: z.strictObject({
    id: blockId,
    type: z.literal("hero"),
    headline: required(160, "Judul utama wajib diisi."),
    subheadline: short(400).default(""),
    mediaId: mediaRef.default(null),
    /** Label of the scroll-to-order button; empty hides it. */
    ctaLabel: short(60).default("Pesan sekarang"),
  }),
  text: z.strictObject({ id: blockId, type: z.literal("text"), body: z.string().max(20_000).default("") }),
  image: z.strictObject({ id: blockId, type: z.literal("image"), mediaId: mediaRef.default(null), caption: short(300).default("") }),
  benefits: z.strictObject({
    id: blockId,
    type: z.literal("benefits"),
    title: short(120).default(""),
    items: items(z.strictObject({ title: required(120, "Judul manfaat wajib diisi."), body: short(400).default("") }), 8),
  }),
  testimonials: z.strictObject({
    id: blockId,
    type: z.literal("testimonials"),
    title: short(120).default(""),
    items: items(z.strictObject({ quote: required(600, "Isi testimoni wajib diisi."), name: short(80).default(""), note: short(80).default("") }), 8),
  }),
  faq: z.strictObject({
    id: blockId,
    type: z.literal("faq"),
    title: short(120).default(""),
    items: items(z.strictObject({ q: required(200, "Pertanyaan wajib diisi."), a: z.string().trim().max(2000).default("") }), 12),
  }),
  cta: z.strictObject({ id: blockId, type: z.literal("cta"), label: required(60, "Label tombol wajib diisi."), note: short(200).default("") }),
  /** Platform order component: one product, its variants and a quantity; price and stock are always read from the catalog. */
  order: z.strictObject({
    id: blockId,
    type: z.literal("order"),
    productId: z.coerce.number().int().positive(),
    title: short(120).default("Pesan di sini"),
    note: short(300).default(""),
  }),
} as const;
export type BlockType = keyof typeof blockSchemas;
export const BLOCK_TYPES = Object.keys(blockSchemas) as BlockType[];

export const blockSchema = z.discriminatedUnion("type", [
  blockSchemas.hero,
  blockSchemas.text,
  blockSchemas.image,
  blockSchemas.benefits,
  blockSchemas.testimonials,
  blockSchemas.faq,
  blockSchemas.cta,
  blockSchemas.order,
]);
export type LandingBlock = z.infer<typeof blockSchema>;

export const landingDocument = z.strictObject({
  version: z.literal(LANDING_SCHEMA_VERSION),
  design: z.strictObject({
    accent: z.enum(LP_ACCENTS).default("ink"),
    fontScale: z.enum(LP_FONT_SCALES).default("regular"),
  }),
  blocks: z
    .array(blockSchema)
    .max(LP_MAX_BLOCKS, `Maksimal ${LP_MAX_BLOCKS} blok.`)
    .refine((b) => new Set(b.map((x) => x.id)).size === b.length, "Id blok ganda.")
    .refine((b) => b.filter((x) => x.type === "order").length <= 1, "Hanya satu bagian pemesanan per landing page."),
});
export type LandingDocument = z.infer<typeof landingDocument>;

export const newBlockId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

/** A block of `type` with sensible defaults, ready to be edited. */
export function newBlock(type: BlockType, id = newBlockId()): LandingBlock {
  const base = { id };
  switch (type) {
    case "hero": return { ...base, type, headline: "Judul utama", subheadline: "", mediaId: null, ctaLabel: "Pesan sekarang" };
    case "text": return { ...base, type, body: "" };
    case "image": return { ...base, type, mediaId: null, caption: "" };
    case "benefits": return { ...base, type, title: "Kenapa produk ini", items: [{ title: "Manfaat pertama", body: "" }] };
    case "testimonials": return { ...base, type, title: "Kata pembeli", items: [{ quote: "Produknya bagus.", name: "", note: "" }] };
    case "faq": return { ...base, type, title: "Pertanyaan umum", items: [{ q: "Berapa lama pengiriman?", a: "" }] };
    case "cta": return { ...base, type, label: "Pesan sekarang", note: "" };
    case "order": return { ...base, type, productId: 0, title: "Pesan di sini", note: "" };
  }
}

export const defaultDocument = (title: string): LandingDocument => ({
  version: LANDING_SCHEMA_VERSION,
  design: { accent: "ink", fontScale: "regular" },
  blocks: [{ ...(newBlock("hero") as Extract<LandingBlock, { type: "hero" }>), headline: title }],
});

// Pure edits used by the builder's add / move up / move down / remove / edit actions.
export function moveBlock(doc: LandingDocument, id: string, dir: "up" | "down"): LandingDocument {
  const i = doc.blocks.findIndex((b) => b.id === id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= doc.blocks.length) return doc;
  const blocks = [...doc.blocks];
  [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
  return { ...doc, blocks };
}
export const removeBlock = (doc: LandingDocument, id: string): LandingDocument => ({ ...doc, blocks: doc.blocks.filter((b) => b.id !== id) });
export const appendBlock = (doc: LandingDocument, block: LandingBlock): LandingDocument => ({ ...doc, blocks: [...doc.blocks, block] });
export const replaceBlock = (doc: LandingDocument, block: LandingBlock): LandingDocument => ({ ...doc, blocks: doc.blocks.map((b) => (b.id === block.id ? block : b)) });

// ── Page metadata ──────────────────────────────────────────────────────────────────────────
/** LP slugs share the store's reserved route names; the `/lp/` prefix itself is reserved for them. */
export const RESERVED_LANDING_SLUGS = RESERVED_PAGE_SLUGS;
export const landingPageInput = z.strictObject({
  title: z.string().trim().min(1, "Judul wajib diisi.").max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Slug wajib diisi.")
    .max(80)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug hanya huruf kecil, angka dan tanda hubung.")
    .refine((s) => !RESERVED_LANDING_SLUGS.has(s), "Slug ini dicadangkan untuk rute toko."),
});
export type LandingPageInput = z.input<typeof landingPageInput>;

const notFound = () => new DomainError("not_found", "Landing page tidak ditemukan.");
const stale = () => new DomainError("stale_revision", "Landing page sudah diubah di tempat lain. Muat ulang halaman ini, lalu ulangi perubahan Anda.");
const constraint = (err: unknown) => (err as { cause?: { constraint_name?: string } })?.cause?.constraint_name;
function pageError(err: unknown): never {
  if (constraint(err) === "landing_page_store_slug_uq") throw new DomainError("slug_taken", "Slug sudah dipakai landing page lain di toko ini.");
  throw err;
}
const revisionId = z.coerce.number().int().positive();

const pageColumns = {
  id: landingPage.id,
  slug: landingPage.slug,
  title: landingPage.title,
  status: landingPage.status,
  draftRevisionId: landingPage.draftRevisionId,
  publishedRevisionId: landingPage.publishedRevisionId,
  updatedAt: landingPage.updatedAt,
};

export async function listLandingPages(scope: SellerScope) {
  requireCap(scope, "catalog.read");
  return inStore(scope, (scope) => scope.exec.select(pageColumns).from(landingPage).where(eq(landingPage.storeId, scope.storeId)).orderBy(desc(landingPage.id)));
}

type Tx = SellerScope["exec"];

async function readRevision(tx: Tx, storeId: number, id: number | null) {
  if (id === null) return null;
  const [r] = await tx
    .select({ id: landingPageRevision.id, revisionNumber: landingPageRevision.revisionNumber, document: landingPageRevision.document, createdAt: landingPageRevision.createdAt })
    .from(landingPageRevision)
    .where(and(eq(landingPageRevision.storeId, storeId), eq(landingPageRevision.id, id)));
  return r ? { ...r, document: landingDocument.parse(r.document) } : null;
}

/** Page with its draft and published revisions (documents parsed; a stored document always validates). */
export async function getLandingPage(scope: SellerScope, pageId: number) {
  requireCap(scope, "catalog.read");
  return inStore(scope, async ({ exec: tx }) => {
    const [p] = await tx.select(pageColumns).from(landingPage).where(and(eq(landingPage.storeId, scope.storeId), eq(landingPage.id, pageId)));
    if (!p) return null;
    const [draft, published] = await Promise.all([readRevision(tx, scope.storeId, p.draftRevisionId), readRevision(tx, scope.storeId, p.publishedRevisionId)]);
    return { ...p, draft: draft!, published };
  });
}

async function insertRevision(tx: Tx, scope: SellerScope, pageId: number, number: number, document: LandingDocument) {
  const [r] = await tx
    .insert(landingPageRevision)
    .values({ storeId: scope.storeId, pageId, revisionNumber: number, schemaVersion: document.version, document, createdBy: scope.userId })
    .returning({ id: landingPageRevision.id });
  return r!.id;
}

/** Create a page with revision 1 (a hero carrying the title) as its draft. Returns the page id. */
export async function createLandingPage(scope: SellerScope, raw: unknown): Promise<number> {
  requireCap(scope, "catalog.write");
  const input = landingPageInput.parse(raw);
  try {
    return await inStore(scope, async ({ exec: tx }) => {
      const [p] = await tx.insert(landingPage).values({ ...input, storeId: scope.storeId }).returning({ id: landingPage.id });
      const rev = await insertRevision(tx, scope, p!.id, 1, defaultDocument(input.title));
      await tx.update(landingPage).set({ draftRevisionId: rev }).where(and(eq(landingPage.storeId, scope.storeId), eq(landingPage.id, p!.id)));
      return p!.id;
    });
  } catch (err) {
    pageError(err);
  }
}

export async function updateLandingPageMeta(scope: SellerScope, pageId: number, raw: unknown): Promise<void> {
  requireCap(scope, "catalog.write");
  const input = landingPageInput.parse(raw);
  try {
    await inStore(scope, async ({ exec: tx }) => {
      const updated = await tx
        .update(landingPage)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(landingPage.storeId, scope.storeId), eq(landingPage.id, pageId)))
        .returning({ id: landingPage.id });
      if (updated.length === 0) throw notFound();
    });
  } catch (err) {
    pageError(err);
  }
}

/**
 * Every media id and the order product must belong to this store (checked inside the store
 * context, so RLS and the predicate agree). `requireActive` is the publish rule: a live page
 * must not point at a product the storefront cannot sell.
 */
async function assertReferences(tx: Tx, storeId: number, doc: LandingDocument, requireActive: boolean) {
  const mediaIds = [...new Set(doc.blocks.flatMap((b) => ("mediaId" in b && b.mediaId ? [b.mediaId] : [])))];
  if (mediaIds.length > 0) {
    const owned = await tx.select({ id: media.id }).from(media).where(and(eq(media.storeId, storeId), inArray(media.id, mediaIds)));
    if (owned.length !== mediaIds.length) throw new DomainError("foreign_media", "Gambar tidak ditemukan di toko ini.");
  }
  const order = doc.blocks.find((b) => b.type === "order");
  if (order) {
    const [p] = await tx.select({ status: product.status }).from(product).where(and(eq(product.storeId, storeId), eq(product.id, order.productId)));
    if (!p) throw new DomainError("foreign_product", "Produk untuk bagian pemesanan tidak ditemukan di toko ini.");
    if (requireActive && p.status !== "active") throw new DomainError("product_inactive", "Produk pada bagian pemesanan belum aktif; aktifkan produk dulu sebelum publikasi.");
  }
}

/**
 * Append a revision with `rawDocument` and move the draft pointer — only if the pointer still
 * equals `expectedRevisionId`. A stale tab (another save happened since it loaded) is rejected
 * instead of overwriting newer work (UX-7 "stale edits"). Returns the new revision id.
 */
export async function saveDraft(scope: SellerScope, pageId: number, expectedRevisionRaw: unknown, rawDocument: unknown): Promise<number> {
  requireCap(scope, "catalog.write");
  const expected = revisionId.parse(expectedRevisionRaw);
  const doc = landingDocument.parse(rawDocument);
  return inStore(scope, async ({ exec: tx }) => {
    const [p] = await tx
      .select({ draftRevisionId: landingPage.draftRevisionId, number: landingPageRevision.revisionNumber })
      .from(landingPage)
      .innerJoin(landingPageRevision, eq(landingPageRevision.id, landingPage.draftRevisionId))
      .where(and(eq(landingPage.storeId, scope.storeId), eq(landingPage.id, pageId)));
    if (!p) throw notFound();
    if (p.draftRevisionId !== expected) throw stale();
    await assertReferences(tx, scope.storeId, doc, false);
    const rev = await insertRevision(tx, scope, pageId, p.number + 1, doc);
    // The compare-and-set makes two concurrent saves serialise: the loser sees 0 rows.
    const moved = await tx
      .update(landingPage)
      .set({ draftRevisionId: rev, updatedAt: new Date() })
      .where(and(eq(landingPage.storeId, scope.storeId), eq(landingPage.id, pageId), eq(landingPage.draftRevisionId, expected)))
      .returning({ id: landingPage.id });
    if (moved.length === 0) throw stale();
    return rev;
  });
}

/** Point the public route at the current draft (which must still be `expectedRevisionId`). */
export async function publishLandingPage(scope: SellerScope, pageId: number, expectedRevisionRaw: unknown): Promise<void> {
  requireCap(scope, "catalog.write");
  const expected = revisionId.parse(expectedRevisionRaw);
  await inStore(scope, async ({ exec: tx }) => {
    const [p] = await tx.select({ draftRevisionId: landingPage.draftRevisionId }).from(landingPage).where(and(eq(landingPage.storeId, scope.storeId), eq(landingPage.id, pageId)));
    if (!p) throw notFound();
    if (p.draftRevisionId !== expected) throw stale();
    const draft = (await readRevision(tx, scope.storeId, expected))!;
    await assertReferences(tx, scope.storeId, draft.document, true);
    const moved = await tx
      .update(landingPage)
      .set({ publishedRevisionId: expected, status: "published", updatedAt: new Date() })
      .where(and(eq(landingPage.storeId, scope.storeId), eq(landingPage.id, pageId), eq(landingPage.draftRevisionId, expected)))
      .returning({ id: landingPage.id });
    if (moved.length === 0) throw stale();
    await tx.insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: `landing.publish:${pageId}:${expected}` });
  });
}

/** Take the page offline; the draft and all revisions stay. */
export async function unpublishLandingPage(scope: SellerScope, pageId: number): Promise<void> {
  requireCap(scope, "catalog.write");
  await inStore(scope, async ({ exec: tx }) => {
    const moved = await tx
      .update(landingPage)
      .set({ publishedRevisionId: null, status: "draft", updatedAt: new Date() })
      .where(and(eq(landingPage.storeId, scope.storeId), eq(landingPage.id, pageId)))
      .returning({ id: landingPage.id });
    if (moved.length === 0) throw notFound();
    await tx.insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: `landing.unpublish:${pageId}` });
  });
}

// ── Builder pickers ────────────────────────────────────────────────────────────────────────
export type StoreMedia = Cover & { productId: number; productTitle: string };
const mediaRow = { id: media.id, storeId: media.storeId, productId: media.productId, productTitle: product.title, alt: media.alt, mime: media.mime, width: media.width, height: media.height };
const toStoreMedia = (m: { id: number; storeId: number; productId: number; productTitle: string; alt: string; mime: "image/jpeg" | "image/png" | "image/webp"; width: number; height: number }): StoreMedia => ({
  id: m.id, alt: m.alt, width: m.width, height: m.height, key: mediaKey(m), productId: m.productId, productTitle: m.productTitle,
});

/** Every image of this store (store media = product images), for the hero/image pickers. */
export async function listStoreMedia(scope: SellerScope): Promise<StoreMedia[]> {
  requireCap(scope, "catalog.read");
  return inStore(scope, async (scope) => {
    const rows = await scope.exec
      .select(mediaRow)
      .from(media)
      .innerJoin(product, and(eq(product.storeId, media.storeId), eq(product.id, media.productId)))
      .where(eq(media.storeId, scope.storeId))
      .orderBy(asc(media.productId), asc(media.position), asc(media.id));
    return rows.map(toStoreMedia);
  });
}

/** Products the order block can bind to (drafts included so a page can be prepared first; publish requires active). */
export async function listOrderableProducts(scope: SellerScope) {
  requireCap(scope, "catalog.read");
  return inStore(scope, (scope) =>
    scope.exec
      .select({ id: product.id, title: product.title, status: product.status })
      .from(product)
      .where(and(eq(product.storeId, scope.storeId), inArray(product.status, ["draft", "active"])))
      .orderBy(asc(product.title)),
  );
}

// ── Rendering ──────────────────────────────────────────────────────────────────────────────
export type LandingProduct = {
  id: number;
  catalogId: string;
  title: string;
  slug: string | null;
  status: "draft" | "active" | "archived";
  variants: { id: number; catalogId: string; title: string; price: number; stock: number }[];
};
export type ResolvedLanding = {
  id: number;
  title: string;
  slug: string;
  revisionId: number;
  document: LandingDocument;
  /** Images referenced by the document that exist (and, for the public route, belong to an active product). */
  media: Map<number, StoreMedia>;
  /** The order block's product, or null when the block is absent or the product is gone. */
  product: LandingProduct | null;
};

async function resolveDocument(tx: Tx, storeId: number, page: { id: number; title: string; slug: string }, revisionId: number, doc: LandingDocument, publicOnly: boolean): Promise<ResolvedLanding> {
  const mediaIds = [...new Set(doc.blocks.flatMap((b) => ("mediaId" in b && b.mediaId ? [b.mediaId] : [])))];
  const images = new Map<number, StoreMedia>();
  if (mediaIds.length > 0) {
    const rows = await tx
      .select(mediaRow)
      .from(media)
      .innerJoin(product, and(eq(product.storeId, media.storeId), eq(product.id, media.productId)))
      .where(and(eq(media.storeId, storeId), inArray(media.id, mediaIds), ...(publicOnly ? [eq(product.status, "active")] : [])));
    for (const r of rows) images.set(r.id, toStoreMedia(r));
  }
  const order = doc.blocks.find((b) => b.type === "order");
  let orderProduct: LandingProduct | null = null;
  if (order) {
    const [p] = await tx
      .select({ id: product.id, catalogId: product.catalogId, title: product.title, slug: product.slug, status: product.status })
      .from(product)
      .where(and(eq(product.storeId, storeId), eq(product.id, order.productId)));
    if (p) {
      const variants = await tx
        .select({ id: variant.id, catalogId: variant.catalogId, title: variant.title, price: variant.price, stock: variant.stock })
        .from(variant)
        .where(and(eq(variant.storeId, storeId), eq(variant.productId, p.id)))
        .orderBy(asc(variant.id));
      orderProduct = { ...p, variants };
    }
  }
  return { id: page.id, title: page.title, slug: page.slug, revisionId, document: doc, media: images, product: orderProduct };
}

/** Public render: only a published page of the host/path-resolved store, only its published revision. */
export async function getPublishedLandingPage(scope: StorefrontScope, slug: string): Promise<ResolvedLanding | null> {
  return inStore(scope, async ({ exec: tx }) => {
    const [p] = await tx
      .select({ id: landingPage.id, title: landingPage.title, slug: landingPage.slug, revisionId: landingPage.publishedRevisionId })
      .from(landingPage)
      .where(and(eq(landingPage.storeId, scope.storeId), eq(landingPage.slug, slug), eq(landingPage.status, "published")));
    if (!p || p.revisionId === null) return null;
    const rev = await readRevision(tx, scope.storeId, p.revisionId);
    if (!rev) return null;
    return resolveDocument(tx, scope.storeId, p, rev.id, rev.document, true);
  });
}

/** Seller preview of the current draft (SC-16): authorized through the seller scope, never public. */
export async function getDraftLandingPage(scope: SellerScope, pageId: number): Promise<ResolvedLanding | null> {
  requireCap(scope, "catalog.read");
  return inStore(scope, async ({ exec: tx }) => {
    const [p] = await tx
      .select({ id: landingPage.id, title: landingPage.title, slug: landingPage.slug, revisionId: landingPage.draftRevisionId })
      .from(landingPage)
      .where(and(eq(landingPage.storeId, scope.storeId), eq(landingPage.id, pageId)));
    if (!p || p.revisionId === null) return null;
    const rev = await readRevision(tx, scope.storeId, p.revisionId);
    if (!rev) return null;
    return resolveDocument(tx, scope.storeId, p, rev.id, rev.document, false);
  });
}
