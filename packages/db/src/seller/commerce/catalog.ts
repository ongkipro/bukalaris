import { and, asc, count, desc, eq, min, sql, sum } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../../client.ts";
import { storeMoneyMode } from "../../ledger/boundary.ts";
import { catalogAudit, orderLine, product, PRODUCT_KINDS, productSlugAlias, user, variant, type CatalogAuditAction, type CatalogSnapshot, type ProductKind } from "../../schema.ts";
import { DomainError, requireCap, type SellerScope } from "../../platform/scoped.ts";
import { inStore } from "../../platform/tenant.ts";

export { PRODUCT_KINDS, type ProductKind } from "../../schema.ts";

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
const kind = z.enum(PRODUCT_KINDS);
const idr = z.coerce.number().int("Harga harus bilangan bulat rupiah.").min(0).max(1_000_000_000_000);
const stock = z.coerce.number().int().min(0).max(1_000_000);
const weightGrams = z.coerce.number({ error: "Berat wajib diisi (gram)." }).int("Berat harus bilangan bulat gram.").min(1, "Berat minimal 1 gram.").max(100_000_000);
const optionalWeight = z.preprocess((v) => (v === "" || v === null || v === undefined ? null : v), weightGrams.nullable());

export const variantInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  sku: z.string().trim().max(64).optional().transform((v) => v || null),
  price: idr,
  stock: z.preprocess((v) => (v === "" || v === undefined ? 0 : v), stock),
  /** T-111: false = unlimited stock (digital default); physical variants always keep true. */
  trackStock: z.boolean().optional(),
  weightGrams: optionalWeight.optional(),
});
export const productInput = z.strictObject({
  title: z.string().trim().min(1, "Judul wajib diisi.").max(200),
  description: z.string().trim().max(5000).default(""),
  /** Optional on update (defaults to current product.kind so callers omitting kind never convert digital products). */
  kind: kind.optional(),
  status: status.default("draft"),
  slug: z.union([slug, z.literal("").transform(() => null)]).nullish().transform((v) => v ?? null),
  /** Optional weight applied to existing variants when changing an unsold digital product to physical. */
  defaultWeightGrams: optionalWeight.optional(),
});
export const createProductInput = productInput.extend({ kind: kind.default("physical"), variant: variantInput }).superRefine((v, ctx) => {
  if (v.kind === "physical" && (v.variant.weightGrams == null || v.variant.weightGrams < 1)) {
    ctx.addIssue({ code: "custom", path: ["variant", "weightGrams"], message: "Berat wajib diisi (gram) untuk produk fisik." });
  }
});

export type ProductInput = z.input<typeof productInput>;
export type VariantInput = z.input<typeof variantInput>;

const physicalWeightCheck = z.object({ weightGrams });

/** Normalize variant fields against the parent product's kind (ADR-0016 decisions 1 and 2). */
function normalizeVariantForKind(productKind: ProductKind, raw: { weightGrams?: number | null | undefined; trackStock?: boolean | undefined; stock?: number | undefined }) {
  if (productKind === "digital") {
    const tracked = raw.trackStock ?? false;
    return { weightGrams: null, trackStock: tracked, stock: tracked ? (raw.stock ?? 0) : 0 };
  }
  return { weightGrams: physicalWeightCheck.parse({ weightGrams: raw.weightGrams }).weightGrams, trackStock: true, stock: raw.stock ?? 0 };
}

/** ADR-0016 decision 21: a digital product activates only when a prepaid method is ready; a physical product on a seller-owned store only when shipping is ready. */
async function assertCanActivate(tx: Executor, scope: SellerScope, productKind: ProductKind): Promise<void> {
  if (productKind === "digital") {
    const [{ paymentReadiness }, { bankTransferReady }] = await Promise.all([import("../../payments/provider-accounts.ts"), import("../../payments/bank-transfer.ts")]);
    const pay = await paymentReadiness({ exec: tx, storeId: scope.storeId });
    const bank = await bankTransferReady(tx, scope.storeId);
    if (!pay.ready && !bank) {
      throw new DomainError("prepaid_not_ready", "Produk digital hanya bisa diaktifkan setelah metode pembayaran prabayar (QRIS/VA atau transfer bank) siap.");
    }
    return;
  }
  if ((await storeMoneyMode(tx, scope.storeId)) === "seller_owned") {
    const { shippingReadiness } = await import("../../payments/provider-accounts.ts");
    const ship = await shippingReadiness({ exec: tx, storeId: scope.storeId });
    if (!ship.ready) {
      throw new DomainError("shipping_not_ready", "Produk fisik hanya bisa diaktifkan setelah pengiriman toko siap.");
    }
  }
}

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

const productSnapshot = (p: { title: string; slug: string | null; status: string; kind: string }): CatalogSnapshot => ({ title: p.title, slug: p.slug, status: p.status, kind: p.kind });
const variantSnapshot = (v: { title: string; sku: string | null; price: number; stock: number; trackStock: boolean; weightGrams: number | null }): CatalogSnapshot => ({ title: v.title, sku: v.sku, price: v.price, stock: v.stock, trackStock: v.trackStock, weightGrams: v.weightGrams });
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
        kind: product.kind,
        status: product.status,
        variants: count(variant.id),
        stock: sum(variant.stock).mapWith(Number),
        hasUnlimitedStock: sql<boolean>`coalesce(bool_or(not ${variant.trackStock}), false)`,
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
    const [sold] = await scope.exec
      .select({ n: count() })
      .from(orderLine)
      .innerJoin(variant, and(eq(variant.storeId, orderLine.storeId), eq(variant.id, orderLine.variantId)))
      .where(and(eq(orderLine.storeId, scope.storeId), eq(variant.productId, row.id)));
    return { ...row, variants, kindLocked: (sold?.n ?? 0) > 0 };
  });
}

/** Create a product with its first variant in one transaction; returns the numeric (database) id. */
export async function createProduct(scope: SellerScope, raw: unknown): Promise<number> {
  requireCap(scope, "catalog.write");
  const input = createProductInput.parse(raw);
  const vNorm = normalizeVariantForKind(input.kind, input.variant);
  try {
    return await inStore(scope, async ({ exec: tx }) => {
      if (input.status === "active") await assertCanActivate(tx, scope, input.kind);
      if (input.slug) await assertSlugFree(tx, scope, input.slug, null);
      const [p] = await tx
        .insert(product)
        .values({ storeId: scope.storeId, title: input.title, description: input.description, kind: input.kind, status: input.status, slug: input.slug })
        .returning({ id: product.id, title: product.title, slug: product.slug, status: product.status, kind: product.kind });
      const [v] = await tx.insert(variant).values({ title: input.variant.title, sku: input.variant.sku, price: input.variant.price, ...vNorm, storeId: scope.storeId, productId: p!.id }).returning();
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
  const { defaultWeightGrams, ...fields } = input;
  try {
    await inStore(scope, async ({ exec: tx }) => {
      const [before] = await tx
        .select({ title: product.title, slug: product.slug, status: product.status, kind: product.kind })
        .from(product)
        .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)))
        .for("update");
      if (!before) throw new DomainError("not_found", "Produk tidak ditemukan.");
      const nextKind = fields.kind ?? before.kind;
      const nextFields = { ...fields, kind: nextKind };
      let lockedVariants: (typeof variant.$inferSelect)[] = [];
      if (nextKind !== before.kind) {
        // Lock every variant row in id order before checking order_line so a concurrent checkout cannot slip an order_line past the check.
        lockedVariants = await tx
          .select()
          .from(variant)
          .where(and(eq(variant.storeId, scope.storeId), eq(variant.productId, productId)))
          .orderBy(asc(variant.id))
          .for("update");
        const [{ n }] = (await tx
          .select({ n: count() })
          .from(orderLine)
          .innerJoin(variant, and(eq(variant.storeId, orderLine.storeId), eq(variant.id, orderLine.variantId)))
          .where(and(eq(orderLine.storeId, scope.storeId), eq(variant.productId, productId)))) as [{ n: number }];
        if (n > 0) throw new DomainError("product_kind_locked", "Jenis produk tidak dapat diubah setelah produk pernah dipesan.");
        if (nextKind === "physical" && (defaultWeightGrams == null || defaultWeightGrams < 1)) {
          throw new DomainError("weight_required", "Isi berat bawaan varian (gram) saat mengubah produk digital menjadi produk fisik.");
        }
      }
      if (nextFields.status === "active") {
        const [{ n }] = (await tx
          .select({ n: count() })
          .from(variant)
          .where(and(eq(variant.storeId, scope.storeId), eq(variant.productId, productId)))) as [{ n: number }];
        if (n === 0) throw new DomainError("no_variant", "Produk aktif wajib punya minimal satu varian.");
        if (before.status !== "active" || nextKind !== before.kind) await assertCanActivate(tx, scope, nextKind);
      }
      if (nextFields.slug !== before.slug) {
        if (nextFields.slug) await assertSlugFree(tx, scope, nextFields.slug, productId);
        // The previous readable slug keeps resolving (308 → canonical) and is never given to another product.
        if (before.slug) await tx.insert(productSlugAlias).values({ storeId: scope.storeId, slug: before.slug, productId });
      }
      const [after] = await tx
        .update(product)
        .set({ ...nextFields, updatedAt: new Date() })
        .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)))
        .returning({ title: product.title, slug: product.slug, status: product.status, kind: product.kind });
      if (nextKind !== before.kind) {
        const patch = nextKind === "digital" ? { weightGrams: null, trackStock: false, stock: 0 } : { weightGrams: defaultWeightGrams!, trackStock: true };
        const updated = await tx.update(variant).set(patch).where(and(eq(variant.storeId, scope.storeId), eq(variant.productId, productId))).returning();
        const beforeById = new Map(lockedVariants.map((v) => [v.id, v]));
        for (const vAfter of updated) {
          const vBefore = beforeById.get(vAfter.id);
          if (vBefore) {
            const vb = variantSnapshot(vBefore);
            const va = variantSnapshot(vAfter);
            if (changed(vb, va)) await audit(tx, scope, { productId, variantId: vAfter.id, action: "variant.update", before: vb, after: va });
          }
        }
      }
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
      .select({ id: product.id, kind: product.kind })
      .from(product)
      .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)))
      .for("share");
    if (!owned) throw new DomainError("not_found", "Produk tidak ditemukan.");
    const vNorm = normalizeVariantForKind(owned.kind, input);
    // The compound (store_id, product_id) FK also rejects a foreign product at the database.
    const [v] = await tx.insert(variant).values({ title: input.title, sku: input.sku, price: input.price, ...vNorm, storeId: scope.storeId, productId }).returning();
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
    const [p] = await tx.select({ kind: product.kind }).from(product).where(and(eq(product.storeId, scope.storeId), eq(product.id, before.productId))).for("share");
    const vNorm = normalizeVariantForKind(p!.kind, { weightGrams: input.weightGrams, trackStock: input.trackStock ?? before.trackStock, stock: before.stock });
    const [after] = await tx
      .update(variant)
      .set({
        title: input.title,
        sku: input.sku,
        price: input.price,
        weightGrams: vNorm.weightGrams,
        trackStock: vNorm.trackStock,
        ...(vNorm.trackStock ? {} : { stock: 0 }),
      })
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
