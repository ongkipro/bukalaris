import { getPublishedProduct } from "@bukalaris/db";
import { apiError, canonicalPath, json, money, withChannel } from "../../_lib";

/** getStorefrontProduct: by canonical slug or numeric id, published only. */
export function GET(req: Request, ctx: RouteContext<"/api/storefront/v1/products/[slug]">) {
  return withChannel(req, async ({ scope }) => {
    const { slug } = await ctx.params;
    const p = await getPublishedProduct(scope, slug);
    if (!p) return apiError(req, 404, "not_found", "Produk tidak ditemukan.");
    return json({
      id: String(p.id),
      slug: p.slug ?? String(p.id),
      canonical_path: canonicalPath(scope.storeSlug, p),
      title: p.title,
      description: p.description,
      variants: p.variants.map((v) => ({ id: String(v.id), title: v.title, price: money(v.price), available: v.stock > 0 })),
    });
  });
}
