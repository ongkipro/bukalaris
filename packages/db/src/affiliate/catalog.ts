import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { media, product, store, variant } from "../schema.ts";
import { AFFILIATE_CATALOG_PAGE } from "./settings.ts";
import { affiliateCatalog, affiliateOffer, affiliatePolicy, affiliateSellerPolicy, AFFILIATE_SOURCE } from "./schema-affiliate.ts";

// The affiliate discovery read model (T-52 slice 1, JOB-20, DATA-11 `affiliate_catalog`). The `affiliate.catalog.project` job fills and withdraws it from the live seller rows;
// it is a platform-pool process that names each store explicitly and reads nothing the projection does not publish. The projection is NOT authority: checkout rechecks
// the live offer, policy, product, account and block (`affiliate_line_rate`, `affiliate_resolve`), so a stale row can neither sell nor attribute.

export type OfferRateFacts = {
  offerStatus: string;
  participation: string | null;
  productStatus: string;
  storeStatus: string;
  offerRateBps: number | null;
  defaultRateBps: number | null;
  minRateBps: number;
  maxRateBps: number;
};

/**
 * The commission rate an offer earns right now, in basis points; 0 when anything makes it ineligible. The single rule, also written in SQL as `affiliate_line_rate`
 * (checkout and the attribution guard): override else store default, only while the store policy is open, the offer active, the product published, the store active
 * and the rate inside the programme's bounds. A parity test runs one corpus through both.
 */
export function effectiveOfferRate(f: OfferRateFacts): number {
  if (f.offerStatus !== "active" || f.participation !== "open" || f.productStatus !== "active" || f.storeStatus !== "active") return 0;
  const rate = f.offerRateBps ?? f.defaultRateBps;
  if (rate === null || rate < f.minRateBps || rate > f.maxRateBps) return 0;
  return rate;
}

/**
 * Project the given offers of one store (all of its offers when `offerIds` is omitted) from the live rows. Idempotent and order-independent: a row is written only when its
 * (offer revision, store policy revision) pair is newer than the stored one (the database guard refuses anything else), so a replayed or reordered job can never undo a newer withdrawal. Returns the
 * number of rows written and the number left alone as stale.
 */
export async function projectOffers(exec: Executor, storeId: number, offerIds?: readonly number[]): Promise<{ written: number; stale: number }> {
  const offers = await exec
    .select()
    .from(affiliateOffer)
    .where(and(eq(affiliateOffer.storeId, storeId), eq(affiliateOffer.source, AFFILIATE_SOURCE), ...(offerIds ? [inArray(affiliateOffer.id, [...offerIds])] : [])))
    .orderBy(asc(affiliateOffer.id));
  if (offers.length === 0) return { written: 0, stale: 0 };
  const [st] = await exec.select({ slug: store.slug, name: store.name, status: store.status }).from(store).where(eq(store.id, storeId));
  if (!st) return { written: 0, stale: offers.length };
  const [sp] = await exec.select({ participation: affiliateSellerPolicy.participation, defaultRateBps: affiliateSellerPolicy.defaultRateBps, revision: affiliateSellerPolicy.revision }).from(affiliateSellerPolicy).where(eq(affiliateSellerPolicy.storeId, storeId));
  const [g] = await exec.select({ minRateBps: affiliatePolicy.minRateBps, maxRateBps: affiliatePolicy.maxRateBps }).from(affiliatePolicy);
  const productIds = offers.map((o) => o.productId);
  const products = await exec.select({ id: product.id, title: product.title, slug: product.slug, catalogId: product.catalogId, status: product.status }).from(product).where(and(eq(product.storeId, storeId), inArray(product.id, productIds)));
  const prices = await exec
    .select({ productId: variant.productId, priceFrom: sql<number>`min(${variant.price})`.mapWith(Number), inStock: sql<boolean>`bool_or(${variant.stock} > 0)` })
    .from(variant)
    .where(and(eq(variant.storeId, storeId), inArray(variant.productId, productIds)))
    .groupBy(variant.productId);
  const images = await exec
    .selectDistinctOn([media.productId], { productId: media.productId, id: media.id })
    .from(media)
    .where(and(eq(media.storeId, storeId), inArray(media.productId, productIds)))
    .orderBy(media.productId, asc(media.position), asc(media.id));
  let written = 0;
  for (const o of offers) {
    const p = products.find((x) => x.id === o.productId);
    if (!p) continue;
    const price = prices.find((x) => x.productId === o.productId);
    const rate = effectiveOfferRate({ offerStatus: o.status, participation: sp?.participation ?? null, productStatus: p.status, storeStatus: st.status, offerRateBps: o.rateBps, defaultRateBps: sp?.defaultRateBps ?? null, ...g! });
    const active = rate > 0 && price !== undefined;
    const row = {
      source: AFFILIATE_SOURCE,
      offerId: o.id,
      storeId,
      productId: o.productId,
      storeSlug: st.slug,
      storeName: st.name,
      productTitle: p.title,
      productPath: p.slug ?? p.catalogId,
      priceFromIdr: price?.priceFrom ?? null,
      inStock: price?.inStock ?? false,
      imageMediaId: images.find((x) => x.productId === o.productId)?.id ?? null,
      rateBps: active ? rate : null,
      active,
      sourceRevision: o.revision,
      sellerPolicyRevision: sp?.revision ?? 0,
    };
    const res = await exec
      .insert(affiliateCatalog)
      .values(row)
      .onConflictDoUpdate({
        target: [affiliateCatalog.source, affiliateCatalog.offerId],
        set: { storeSlug: row.storeSlug, storeName: row.storeName, productTitle: row.productTitle, productPath: row.productPath, priceFromIdr: row.priceFromIdr, inStock: row.inStock, imageMediaId: row.imageMediaId, rateBps: row.rateBps, active: row.active, sourceRevision: row.sourceRevision, sellerPolicyRevision: row.sellerPolicyRevision, projectedAt: sql`now()` },
        setWhere: sql`(${affiliateCatalog.sourceRevision}, ${affiliateCatalog.sellerPolicyRevision}) < (excluded.source_revision, excluded.seller_policy_revision)`,
      })
      .returning({ offerId: affiliateCatalog.offerId });
    if (res.length > 0) written++;
  }
  return { written, stale: offers.length - written };
}

/** The full rebuild registered with T-74's `rebuildProjection` (JOB-22): a pure replace of every row from the live seller tables, so a repeat leaves the same state. */
export async function rebuildAffiliateCatalog(tx: Executor): Promise<number> {
  await tx.delete(affiliateCatalog);
  const stores = await tx.selectDistinct({ storeId: affiliateOffer.storeId }).from(affiliateOffer).orderBy(asc(affiliateOffer.storeId));
  let rows = 0;
  for (const s of stores) rows += (await projectOffers(tx, s.storeId)).written;
  return rows;
}

export type CatalogItem = {
  offerId: number;
  storeId: number;
  storeSlug: string;
  storeName: string;
  productTitle: string;
  productPath: string;
  priceFromIdr: number;
  inStock: boolean;
  imageMediaId: number | null;
  rateBps: number;
};

/**
 * Cross-store discovery for approved affiliates: active offers only, public seller and product fields only, newest offers after `afterOfferId`. Intentionally readable across stores
 * (IAM-3: the effective rate and status of an approved public offer is public by design); it carries no buyer, order, account or private seller field.
 */
export async function listAffiliateCatalog(exec: Executor, opts: { afterOfferId?: number; limit?: number } = {}): Promise<CatalogItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? AFFILIATE_CATALOG_PAGE, 1), 100);
  const rows = await exec
    .select()
    .from(affiliateCatalog)
    .where(and(eq(affiliateCatalog.active, true), ...(opts.afterOfferId ? [gt(affiliateCatalog.offerId, opts.afterOfferId)] : [])))
    .orderBy(asc(affiliateCatalog.offerId))
    .limit(limit);
  return rows.map((r) => ({ offerId: r.offerId, storeId: r.storeId, storeSlug: r.storeSlug, storeName: r.storeName, productTitle: r.productTitle, productPath: r.productPath, priceFromIdr: r.priceFromIdr!, inStock: r.inStock, imageMediaId: r.imageMediaId, rateBps: r.rateBps! }));
}
