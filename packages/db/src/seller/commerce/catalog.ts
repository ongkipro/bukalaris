import { and, asc, count, desc, eq, min, sql, sum } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../../client.ts";
import { catalogAudit, product, productSlugAlias, user, variant, type CatalogAuditAction, type CatalogSnapshot } from "../../schema.ts";
import { DomainError, requireCap, type SellerScope } from "../../platform/scoped.ts";
import { inStore } from "../../platform/tenant.ts";

// Seller catalog operations (SC-02, SC-03, SC-17). All queries are filtered by scope.storeId
// and run inside `inStore(scope, …)`, the store-context transaction row-level security needs (T-27).
// Every write records a catalog_audit row in the same transaction (T-31, SEC-17).

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug hanya huruf kecil, angka dan tanda hubung.")
  .refine((s) => !/^[0-9]+$/.test(s), "Slug angka saja dicadangkan untuk ID produk.")
  .max(80);
const status = z.enum(["draft", "active", "archived"]);
const idr = z.coerce.number().int("Harga harus bilangan bulat rupiah.").min(0).max(1_000_000_000_000);
const stock = z.coerce.number().int().min(0).max(1_000_000);
const weightGrams = z.coerce.number({ error: "Berat wajib diisi (gram)." }).int("Berat harus bilangan bulat gram.").min(1, "Berat minimal 1 gram.").max(100_000_000);

export const variantInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  sku: z.string().trim().max(64).optional().transform((v) => v || null),
  price: idr,
  stock,
  weightGrams,
});
export const productInput = z.strictObject({
  title: z.string().trim().min(1, "Judul wajib diisi.").max(200),
  description: z.string().trim().max(5000).default(""),
  status: status.default("draft"),
  slug: z.union([slug, z.literal("").transform(() => null)]).nullish().transform((v) => v ?? null),
});
export const createProductInput = productInput.extend({ variant: variantInput });

export type ProductInput = z.input<typeof productInput>;
export type VariantInput = z.input<typeof variantInput>;

/** Canonical URL segment: the readable SEO-friendly slug, else the external numeric catalog id (string, ≥ 5 digits). Never the DB id. */
export const canonicalSlug = (p: { catalogId: string; slug: string | null }) => p.slug ?? p.catalogId;
/** Catalog ids start at 10000, so an all-digit URL segment with ≥ 5 digits is a catalog id and a shorter one a legacy DB id (redirected). */
export const isCatalogId = (segment: string) => /^[1-9][0-9]{4,17}$/.test(segment);
/** Convert a product title into a clean, SEO-friendly ASCII slug (or null when no ASCII words exist). */
export function slugifyTitle(title: string): string | null {
  const s = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return s && !/^[0-9]+$/.test(s) ? s : null;
}
const slugTaken = () => new DomainError("slug_taken", "Slug sudah dipakai produk lain di toko ini.");
function isSlugTaken(err: unknown): boolean {
  return (err as { cause?: { constraint_name?: string } })?.cause?.constraint_name === "product_store_slug_uq";
}

const productSnapshot = (p: { title: string; slug: string | null; status: string }): CatalogSnapshot => ({ title: p.title, slug: p.slug, status: p.status });
const variantSnapshot = (v: { title: string; sku: string | null; price: number; stock: number; weightGrams: number }): CatalogSnapshot => ({ title: v.title, sku: v.sku, price: v.price, stock: v.stock, weightGrams: v.weightGrams });
const changed = (a: CatalogSnapshot, b: CatalogSnapshot) => Object.keys(a).some((k) => a[k] !== b[k]);

function audit(
  tx: Executor,
  scope: SellerScope,
  row: { productId: number; variantId?: number; action: CatalogAuditAction; before?: CatalogSnapshot; after?: CatalogSnapshot },
) {
  return tx.insert(catalogAudit).values({ storeId: scope.storeId, actorUserId: scope.userId, ...row });
}

export async function listProducts(scope: SellerScope) {
  requireCap(scope, "catalog.read");
  return inStore(scope, (scope) =>
    scope.exec
      .select({
        id: product.id,
        catalogId: product.catalogId,
        title: product.title,
        slug: product.slug,
        status: product.status,
        variants: count(variant.id),
        stock: sum(variant.stock).mapWith(Number),
        minPrice: min(variant.price),
      })
      .from(product)
      .leftJoin(variant, and(eq(variant.storeId, product.storeId), eq(variant.productId, product.id)))
      .where(eq(product.storeId, scope.storeId))
      .groupBy(product.id)
      .orderBy(desc(product.id)),
  );
}

export async function getProduct(scope: SellerScope, productId: number) {
  requireCap(scope, "catalog.read");
  const byCatalogId = isCatalogId(String(productId));
  return inStore(scope, async (scope) => {
    const [row] = await scope.exec
      .select()
      .from(product)
      .where(and(eq(product.storeId, scope.storeId), byCatalogId ? eq(product.catalogId, String(productId)) : eq(product.id, productId)));
    if (!row) return null;
    const variants = await scope.exec
      .select()
      .from(variant)
      .where(and(eq(variant.storeId, scope.storeId), eq(variant.productId, row.id)))
      .orderBy(asc(variant.id));
    return { ...row, variants };
  });
}

/** Create a product with its first variant in one transaction; returns the numeric (database) id. */
export async function createProduct(scope: SellerScope, raw: unknown): Promise<number> {
  requireCap(scope, "catalog.write");
  const input = createProductInput.parse(raw);
  try {
    return await inStore(scope, async ({ exec: tx }) => {
      if (input.slug) await assertSlugFree(tx, scope, input.slug, null);
      const [p] = await tx
        .insert(product)
        .values({ storeId: scope.storeId, title: input.title, description: input.description, status: input.status, slug: input.slug })
        .returning({ id: product.id, title: product.title, slug: product.slug, status: product.status });
      const [v] = await tx.insert(variant).values({ ...input.variant, storeId: scope.storeId, productId: p!.id }).returning();
      await audit(tx, scope, { productId: p!.id, action: "product.create", after: productSnapshot(p!) });
      await audit(tx, scope, { productId: p!.id, variantId: v!.id, action: "variant.create", after: variantSnapshot(v!) });
      return p!.id;
    });
  } catch (err) {
    if (isSlugTaken(err)) throw slugTaken();
    throw err;
  }
}

/**
 * A slug is free for `productId` when no other product of the store currently uses it (unique index)
 * and no other product ever used it (alias table). Slug changes of one store are serialised by an
 * advisory lock so the two checks cannot race each other.
 */
async function assertSlugFree(tx: Executor, scope: SellerScope, slugValue: string, productId: number | null) {
  await tx.execute(sql`select pg_advisory_xact_lock(${scope.storeId})`);
  const [alias] = await tx
    .select({ productId: productSlugAlias.productId })
    .from(productSlugAlias)
    .where(and(eq(productSlugAlias.storeId, scope.storeId), eq(productSlugAlias.slug, slugValue)));
  if (!alias) return;
  if (alias.productId !== productId) throw slugTaken();
  // The product takes one of its own old slugs back: it becomes current again (no self-redirect).
  await tx.delete(productSlugAlias).where(and(eq(productSlugAlias.storeId, scope.storeId), eq(productSlugAlias.slug, slugValue)));
}

export async function updateProduct(scope: SellerScope, productId: number, raw: unknown): Promise<void> {
  requireCap(scope, "catalog.write");
  const input = productInput.parse(raw);
  try {
    await inStore(scope, async ({ exec: tx }) => {
      const [before] = await tx
        .select({ title: product.title, slug: product.slug, status: product.status })
        .from(product)
        .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)))
        .for("update");
      if (!before) throw new DomainError("not_found", "Produk tidak ditemukan.");
      if (input.status === "active") {
        const [{ n }] = (await tx
          .select({ n: count() })
          .from(variant)
          .where(and(eq(variant.storeId, scope.storeId), eq(variant.productId, productId)))) as [{ n: number }];
        if (n === 0) throw new DomainError("no_variant", "Produk aktif wajib punya minimal satu varian.");
      }
      if (input.slug !== before.slug) {
        if (input.slug) await assertSlugFree(tx, scope, input.slug, productId);
        // The previous readable slug keeps resolving (308 → canonical) and is never given to another product.
        if (before.slug) await tx.insert(productSlugAlias).values({ storeId: scope.storeId, slug: before.slug, productId });
      }
      const [after] = await tx
        .update(product)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)))
        .returning({ title: product.title, slug: product.slug, status: product.status });
      const b = productSnapshot(before);
      const a = productSnapshot(after!);
      if (changed(b, a)) await audit(tx, scope, { productId, action: "product.update", before: b, after: a });
    });
  } catch (err) {
    if (isSlugTaken(err)) throw slugTaken();
    throw err;
  }
}

export async function addVariant(scope: SellerScope, productId: number, raw: unknown): Promise<number> {
  requireCap(scope, "catalog.write");
  const input = variantInput.parse(raw);
  return inStore(scope, async ({ exec: tx }) => {
    const [owned] = await tx
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)));
    if (!owned) throw new DomainError("not_found", "Produk tidak ditemukan.");
    // The compound (store_id, product_id) FK also rejects a foreign product at the database.
    const [v] = await tx.insert(variant).values({ ...input, storeId: scope.storeId, productId }).returning();
    await audit(tx, scope, { productId, variantId: v!.id, action: "variant.create", after: variantSnapshot(v!) });
    return v!.id;
  });
}

export async function updateVariant(scope: SellerScope, variantId: number, raw: unknown): Promise<void> {
  requireCap(scope, "catalog.write");
  // Legacy forms may include stock: validate it, but manual stock changes go through adjustStock.
  const input = variantInput.partial({ stock: true }).parse(raw);
  await inStore(scope, async ({ exec: tx }) => {
    const [before] = await tx
      .select()
      .from(variant)
      .where(and(eq(variant.storeId, scope.storeId), eq(variant.id, variantId)))
      .for("update");
    if (!before) throw new DomainError("not_found", "Varian tidak ditemukan.");
    const [after] = await tx
      .update(variant)
      .set({ title: input.title, sku: input.sku, price: input.price, weightGrams: input.weightGrams })
      .where(and(eq(variant.storeId, scope.storeId), eq(variant.id, variantId)))
      .returning();
    const b = variantSnapshot(before);
    const a = variantSnapshot(after!);
    if (changed(b, a)) await audit(tx, scope, { productId: before.productId, variantId, action: "variant.update", before: b, after: a });
  });
}

/** Store-scoped change history of one product and its variants, newest first (T-31). */
export async function listCatalogHistory(scope: SellerScope, productId: number, limit = 50) {
  requireCap(scope, "catalog.read");
  return inStore(scope, (scope) =>
    scope.exec
      .select({
        id: catalogAudit.id,
        action: catalogAudit.action,
        variantId: catalogAudit.variantId,
        variantTitle: variant.title,
        actorName: user.name,
        before: catalogAudit.before,
        after: catalogAudit.after,
        createdAt: catalogAudit.createdAt,
      })
      .from(catalogAudit)
      .leftJoin(user, eq(user.id, catalogAudit.actorUserId))
      .leftJoin(variant, and(eq(variant.storeId, catalogAudit.storeId), eq(variant.id, catalogAudit.variantId)))
      .where(and(eq(catalogAudit.storeId, scope.storeId), eq(catalogAudit.productId, productId)))
      .orderBy(desc(catalogAudit.id))
      .limit(limit),
  );
}
