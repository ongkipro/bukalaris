import { and, asc, eq, min, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCartHasRoom, openCartStore } from "./checkout.ts";
import { isCatalogId } from "./catalog.ts";
import { cart, cartLine, product, productSlugAlias, variant } from "./schema.ts";
import { DomainError, type StorefrontScope } from "./scoped.ts";
import { inStore } from "./tenant.ts";

// Public storefront reads and the server cart (SF-01, SF-04, SF-06).
// Only active products of the host-resolved store are visible; every statement runs in the
// store-context transaction (`inStore`) that row-level security requires (T-27).

const published = (scope: StorefrontScope) => and(eq(product.storeId, scope.storeId), eq(product.status, "active"));

export async function listPublishedProducts(scope: StorefrontScope) {
  return inStore(scope, (scope) =>
    scope.exec
      .select({ id: product.id, catalogId: product.catalogId, title: product.title, slug: product.slug, minPrice: min(variant.price) })
      .from(product)
      .innerJoin(variant, and(eq(variant.storeId, product.storeId), eq(variant.productId, product.id)))
      .where(published(scope))
      .groupBy(product.id)
      .orderBy(asc(product.id)),
  );
}

const productCard = { id: product.id, catalogId: product.catalogId, title: product.title, slug: product.slug, description: product.description };

/**
 * Look up a published product by URL segment: an all-digit segment ≥ 10000 is the catalog id,
 * a smaller number a legacy database id (pre-D-8 URLs), anything else the readable slug or one
 * of its historical aliases. The caller compares `canonicalSlug()` with the segment and 308s
 * when they differ (legacy id, alias, or slug set later) — aliases point at the product, so
 * one redirect reaches the canonical URL.
 */
export async function getPublishedProduct(scope: StorefrontScope, segment: string) {
  const numeric = /^[0-9]{1,18}$/.test(segment);
  const where = numeric ? (isCatalogId(segment) ? eq(product.catalogId, segment) : eq(product.id, Number(segment))) : eq(product.slug, segment);
  return inStore(scope, async (scope) => {
    let [p] = await scope.exec.select(productCard).from(product).where(and(published(scope), where));
    if (!p && !numeric) {
      [p] = await scope.exec
        .select(productCard)
        .from(productSlugAlias)
        .innerJoin(product, and(eq(product.storeId, productSlugAlias.storeId), eq(product.id, productSlugAlias.productId)))
        .where(and(published(scope), eq(productSlugAlias.storeId, scope.storeId), eq(productSlugAlias.slug, segment)));
    }
    if (!p) return null;
    const variants = await scope.exec
      .select({ id: variant.id, catalogId: variant.catalogId, title: variant.title, price: variant.price, stock: variant.stock })
      .from(variant)
      .where(and(eq(variant.storeId, scope.storeId), eq(variant.productId, p.id)))
      .orderBy(asc(variant.id));
    return { ...p, variants };
  });
}

const lineInput = z.strictObject({
  variantId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().min(0).max(99),
});

/** Returns the cart id only if it belongs to this store and is not checked out yet (in context, RLS hides foreign carts as well). */
async function ownCart(scope: StorefrontScope, cartId: string | undefined): Promise<string | null> {
  return (await inStore(scope, (scope) => openCartStore(scope.exec, cartId))) === scope.storeId ? cartId! : null;
}

/**
 * Set a variant's quantity in the buyer's cart (0 removes it). A missing or
 * foreign-store cart id starts a new cart for this store. Returns the cart id.
 */
export async function setCartLine(scope: StorefrontScope, cartId: string | undefined, raw: unknown, mode: "add" | "set") {
  const { variantId, quantity } = lineInput.parse(raw);
  return inStore(scope, async (scope) => {
    const [sellable] = await scope.exec
      .select({ id: variant.id })
      .from(variant)
      .innerJoin(product, and(eq(product.storeId, variant.storeId), eq(product.id, variant.productId)))
      .where(and(published(scope), eq(variant.id, variantId)));
    if (!sellable) throw new DomainError("not_found", "Produk tidak tersedia.");

    let id = await ownCart(scope, cartId);
    if (!id) {
      if (quantity === 0) throw new DomainError("empty", "Keranjang kosong.");
      [{ id }] = (await scope.exec.insert(cart).values({ storeId: scope.storeId }).returning({ id: cart.id })) as [{ id: string }];
    }
    if (quantity === 0) {
      await scope.exec
        .delete(cartLine)
        .where(and(eq(cartLine.storeId, scope.storeId), eq(cartLine.cartId, id), eq(cartLine.variantId, variantId)));
    } else {
      await assertCartHasRoom(scope.exec, scope.storeId, id, variantId); // T-30 line cap
      await scope.exec
        .insert(cartLine)
        .values({ cartId: id, storeId: scope.storeId, variantId, quantity })
        .onConflictDoUpdate({
          target: [cartLine.cartId, cartLine.variantId],
          set: { quantity: mode === "add" ? sql`least(${cartLine.quantity} + ${quantity}, 99)` : quantity },
        });
    }
    return id;
  });
}

/** Cart lines priced from the current catalog (display only; checkout re-derives). */
export async function getCart(scope: StorefrontScope, cartId: string | undefined) {
  return inStore(scope, async (scope) => {
    const id = await ownCart(scope, cartId);
    if (!id) return { id: null, lines: [], subtotal: 0 };
    const lines = await scope.exec
      .select({
        variantId: variant.id,
        productTitle: product.title,
        productSlug: product.slug,
        productId: product.id,
        productCatalogId: product.catalogId,
        variantTitle: variant.title,
        price: variant.price,
        stock: variant.stock,
        quantity: cartLine.quantity,
      })
      .from(cartLine)
      .innerJoin(variant, and(eq(variant.storeId, cartLine.storeId), eq(variant.id, cartLine.variantId)))
      .innerJoin(product, and(eq(product.storeId, variant.storeId), eq(product.id, variant.productId)))
      .where(and(eq(cartLine.storeId, scope.storeId), eq(cartLine.cartId, id)))
      .orderBy(asc(variant.id));
    return { id, lines, subtotal: lines.reduce((s, l) => s + l.price * l.quantity, 0) };
  });
}
