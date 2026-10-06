import { and, asc, count, desc, eq, min, sum } from "drizzle-orm";
import { z } from "zod";
import { product, variant } from "./schema.ts";
import { DomainError, requireCap, type SellerScope } from "./scoped.ts";

// Seller catalog operations (SC-02, SC-03, SC-17). All queries are filtered by scope.storeId.

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

export const variantInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  sku: z.string().trim().max(64).optional().transform((v) => v || null),
  price: idr,
  stock,
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

export const canonicalSlug = (p: { id: number; slug: string | null }) => p.slug ?? String(p.id);

function slugTaken(err: unknown): boolean {
  return (err as { cause?: { constraint_name?: string } })?.cause?.constraint_name === "product_store_slug_uq";
}

export async function listProducts(scope: SellerScope) {
  requireCap(scope, "catalog.read");
  return scope.exec
    .select({
      id: product.id,
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
    .orderBy(desc(product.id));
}

export async function getProduct(scope: SellerScope, productId: number) {
  requireCap(scope, "catalog.read");
  const [row] = await scope.exec
    .select()
    .from(product)
    .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)));
  if (!row) return null;
  const variants = await scope.exec
    .select()
    .from(variant)
    .where(and(eq(variant.storeId, scope.storeId), eq(variant.productId, productId)))
    .orderBy(asc(variant.id));
  return { ...row, variants };
}

/** Create a product with its first variant in one transaction; returns the numeric id. */
export async function createProduct(scope: SellerScope, raw: unknown): Promise<number> {
  requireCap(scope, "catalog.write");
  const input = createProductInput.parse(raw);
  try {
    return await scope.exec.transaction(async (tx) => {
      const [p] = await tx
        .insert(product)
        .values({ storeId: scope.storeId, title: input.title, description: input.description, status: input.status, slug: input.slug })
        .returning({ id: product.id });
      await tx.insert(variant).values({ ...input.variant, storeId: scope.storeId, productId: p!.id });
      return p!.id;
    });
  } catch (err) {
    if (slugTaken(err)) throw new DomainError("slug_taken", "Slug sudah dipakai produk lain di toko ini.");
    throw err;
  }
}

export async function updateProduct(scope: SellerScope, productId: number, raw: unknown): Promise<void> {
  requireCap(scope, "catalog.write");
  const input = productInput.parse(raw);
  try {
    await scope.exec.transaction(async (tx) => {
      if (input.status === "active") {
        const [{ n }] = (await tx
          .select({ n: count() })
          .from(variant)
          .where(and(eq(variant.storeId, scope.storeId), eq(variant.productId, productId)))) as [{ n: number }];
        if (n === 0) throw new DomainError("no_variant", "Produk aktif wajib punya minimal satu varian.");
      }
      const updated = await tx
        .update(product)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)))
        .returning({ id: product.id });
      if (updated.length === 0) throw new DomainError("not_found", "Produk tidak ditemukan.");
    });
  } catch (err) {
    if (slugTaken(err)) throw new DomainError("slug_taken", "Slug sudah dipakai produk lain di toko ini.");
    throw err;
  }
}

export async function addVariant(scope: SellerScope, productId: number, raw: unknown): Promise<number> {
  requireCap(scope, "catalog.write");
  const input = variantInput.parse(raw);
  const [owned] = await scope.exec
    .select({ id: product.id })
    .from(product)
    .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)));
  if (!owned) throw new DomainError("not_found", "Produk tidak ditemukan.");
  // The compound (store_id, product_id) FK also rejects a foreign product at the database.
  const [v] = await scope.exec
    .insert(variant)
    .values({ ...input, storeId: scope.storeId, productId })
    .returning({ id: variant.id });
  return v!.id;
}

export async function updateVariant(scope: SellerScope, variantId: number, raw: unknown): Promise<void> {
  requireCap(scope, "catalog.write");
  const input = variantInput.parse(raw);
  const updated = await scope.exec
    .update(variant)
    .set(input)
    .where(and(eq(variant.storeId, scope.storeId), eq(variant.id, variantId)))
    .returning({ id: variant.id });
  if (updated.length === 0) throw new DomainError("not_found", "Varian tidak ditemukan.");
}
