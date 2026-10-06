import { listPublishedProducts } from "@bukalaris/db";
import { canonicalPath, json, money, withChannel } from "../_lib";

/** listStorefrontProducts: published products of the channel's store. */
export function GET(req: Request) {
  return withChannel(req, async ({ scope }) => {
    const items = (await listPublishedProducts(scope)).map((p) => ({
      id: String(p.id),
      catalog_id: p.catalogId,
      slug: p.slug ?? p.catalogId,
      canonical_path: canonicalPath(scope.storeSlug, p),
      title: p.title,
      min_price: money(p.minPrice ?? 0),
    }));
    return json({ items });
  });
}
