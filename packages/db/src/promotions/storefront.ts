import { and, asc, eq, min, sql } from "drizzle-orm";
import { collection, collectionProduct, media, product, variant } from "../schema.ts";
import { mediaKey, type Cover } from "../storefront/content.ts";
import type { StorefrontScope } from "../platform/scoped.ts";
import { withStore } from "../platform/tenant.ts";
import { discount, flashSale, flashSaleItem, promoHub, promoHubCollection } from "./schema-promotions.ts";

/** Navigation link only: whether the store has switched its promo hub on. */
export async function promoHubTitle(scope: StorefrontScope): Promise<string | null> {
  return withStore(scope.exec, scope.storeId, async (tx) => (await tx.select({ title: promoHub.title }).from(promoHub).where(and(eq(promoHub.storeId, scope.storeId), eq(promoHub.enabled, true))))[0]?.title ?? null);
}
/** Public projection: only currently usable store offers, never buyer counters or fingerprints. */
export async function storefrontPromotions(scope: StorefrontScope) {
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const [hub] = await tx.select().from(promoHub).where(and(eq(promoHub.storeId, scope.storeId), eq(promoHub.enabled, true)));
    if (!hub) return null;
    const vouchers = await tx.select({ code: discount.code, kind: discount.kind, value: discount.value, minPurchaseIdr: discount.minPurchaseIdr, maxDiscountIdr: discount.maxDiscountIdr, scope: discount.scope, endsAt: discount.endsAt }).from(discount).where(and(eq(discount.storeId, scope.storeId), eq(discount.public, true), eq(discount.status, "active"), sql`clock_timestamp() between ${discount.startsAt} and ${discount.endsAt}`, sql`(${discount.usageLimit} is null or ${discount.usedCount} < ${discount.usageLimit})`)).orderBy(asc(discount.createdAt), asc(discount.id)).limit(100);
    const flashes = await tx.select({ id: flashSaleItem.id, title: flashSale.title, endsAt: flashSale.endsAt, productId: product.id, productTitle: product.title, productSlug: product.slug, productCatalogId: product.catalogId, variantTitle: variant.title, variantId: variant.id, basePrice: variant.price, salePrice: flashSaleItem.salePriceIdr, stockCap: flashSaleItem.stockCap, soldCount: flashSaleItem.soldCount, stock: variant.stock }).from(flashSaleItem)
      .innerJoin(flashSale, and(eq(flashSale.storeId, flashSaleItem.storeId), eq(flashSale.id, flashSaleItem.flashSaleId)))
      .innerJoin(product, and(eq(product.storeId, flashSaleItem.storeId), eq(product.id, flashSaleItem.productId)))
      .innerJoin(variant, and(eq(variant.storeId, flashSaleItem.storeId), eq(variant.id, flashSaleItem.variantId)))
      .where(and(eq(flashSale.storeId, scope.storeId), eq(flashSale.status, "active"), eq(product.status, "active"), sql`clock_timestamp() between ${flashSale.startsAt} and ${flashSale.endsAt}`, sql`(${flashSaleItem.stockCap} is null or ${flashSaleItem.soldCount} < ${flashSaleItem.stockCap})`, sql`${variant.stock} > 0 and ${flashSaleItem.salePriceIdr} < ${variant.price}`)).orderBy(asc(flashSale.createdAt), asc(flashSale.id), asc(flashSaleItem.id)).limit(100);
    const featured = await tx.select({ id: collection.id, title: collection.title, slug: collection.slug }).from(promoHubCollection).innerJoin(collection, and(eq(collection.storeId, promoHubCollection.storeId), eq(collection.id, promoHubCollection.collectionId))).where(and(eq(promoHubCollection.storeId, scope.storeId), eq(collection.status, "published"))).orderBy(asc(promoHubCollection.position));
    // Discounted products include targets of live goods vouchers, not invented reference prices.
    const products = await tx.select({ id: product.id, catalogId: product.catalogId, slug: product.slug, title: product.title, minPrice: min(variant.price) }).from(product).innerJoin(variant, and(eq(variant.storeId, product.storeId), eq(variant.productId, product.id))).innerJoin(discount, eq(discount.storeId, product.storeId)).where(and(eq(product.storeId, scope.storeId), eq(product.status, "active"), eq(discount.public, true), eq(discount.status, "active"), sql`${discount.kind} <> 'free_shipping' and clock_timestamp() between ${discount.startsAt} and ${discount.endsAt}`, sql`(${discount.usageLimit} is null or ${discount.usedCount} < ${discount.usageLimit})`, sql`(${discount.scope} = 'all' or (${discount.scope} = 'product' and ${discount.productId} = ${product.id}) or (${discount.scope} = 'collection' and exists (select 1 from ${collectionProduct} cp where cp.store_id = ${scope.storeId} and cp.collection_id = ${discount.collectionId} and cp.product_id = ${product.id})))`)).groupBy(product.id, product.catalogId, product.slug, product.title).limit(100);
    const [bannerRow] = hub.bannerMediaId === null ? [] : await tx.select().from(media).where(and(eq(media.storeId, scope.storeId), eq(media.id, hub.bannerMediaId)));
    const banner: Cover | null = bannerRow ? { id: bannerRow.id, alt: bannerRow.alt, width: bannerRow.width, height: bannerRow.height, key: mediaKey(bannerRow) } : null;
    return { hub, banner, vouchers, flashes: flashes.filter((f, i) => flashes.findIndex((x) => x.variantId === f.variantId) === i), featured, products };
  });
}
