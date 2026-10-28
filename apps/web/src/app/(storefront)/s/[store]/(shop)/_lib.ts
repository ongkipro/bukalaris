import "server-only";
import { storeOr404 } from "@/lib/storefront";
import { getStorefrontStore, listPublishedCollections, listPublishedPages, promoHubTitle } from "@bukalaris/db";
import { cache } from "react";

/** Store shell data for /s/[store]: scope, link base, profile (theme) and published navigation. */
export const storeShell = cache(async (slug: string) => {
  const { scope, base } = await storeOr404(slug);
  const [profile, collections, pages, promo] = await Promise.all([
    getStorefrontStore(scope),
    listPublishedCollections(scope),
    listPublishedPages(scope),
    promoHubTitle(scope),
  ]);
  return { scope, base, profile, collections, pages, promo };
});

/** wa.me deep link for a normalized Indonesian number (62…). */
export const waLink = (number: string, storeName: string) =>
  `https://wa.me/${number}?text=${encodeURIComponent(`Halo ${storeName}, saya mau tanya produk.`)}`;
