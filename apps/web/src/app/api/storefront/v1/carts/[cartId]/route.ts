import { getCart, ownsOpenCart } from "@bukalaris/db";
import { apiError, cartJson, json, withChannel } from "../../_lib";

/** getCart: channel token AND cart id; the cart must be an open cart of the channel's store. */
export function GET(req: Request, ctx: RouteContext<"/api/storefront/v1/carts/[cartId]">) {
  return withChannel(req, async ({ scope }) => {
    const { cartId } = await ctx.params;
    if (!(await ownsOpenCart(scope, cartId))) return apiError(req, 404, "cart_not_found", "Keranjang tidak ditemukan.");
    return json(cartJson(await getCart(scope, cartId)));
  });
}
