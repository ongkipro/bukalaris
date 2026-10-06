import { getCart, ownsOpenCart, setCartLine } from "@bukalaris/db";
import { apiError, cartItemInput, cartJson, json, withChannel } from "../../../_lib";

/** addCartItem: adds quantity to a variant line (capped at 99 per line). */
export function POST(req: Request, ctx: RouteContext<"/api/storefront/v1/carts/[cartId]/items">) {
  return withChannel(req, async ({ scope }) => {
    const { cartId } = await ctx.params;
    if (!(await ownsOpenCart(scope, cartId))) return apiError(req, 404, "cart_not_found", "Keranjang tidak ditemukan.");
    const item = cartItemInput.parse(await req.json());
    await setCartLine(scope, cartId, { variantId: item.variant_id, quantity: item.quantity }, "add");
    return json(cartJson(await getCart(scope, cartId)));
  });
}
