import { getCart, ownsOpenCart, setCartLine } from "@bukalaris/db";
import { z } from "zod";
import { apiError, cartJson, json, withChannel } from "../../../../_lib";

const edit = z.strictObject({ quantity: z.number().int().min(0).max(99) });

/** updateCartItem: set a line's quantity; 0 removes it. The item id is the variant id. */
export function PATCH(req: Request, ctx: RouteContext<"/api/storefront/v1/carts/[cartId]/items/[variantId]">) {
  return withChannel(req, async ({ scope }) => {
    const { cartId, variantId } = await ctx.params;
    if (!(await ownsOpenCart(scope, cartId))) return apiError(req, 404, "cart_not_found", "Keranjang tidak ditemukan.");
    if (!/^[1-9][0-9]*$/.test(variantId)) return apiError(req, 404, "not_found", "Produk tidak tersedia.");
    const { quantity } = edit.parse(await req.json());
    await setCartLine(scope, cartId, { variantId, quantity }, "set");
    return json(cartJson(await getCart(scope, cartId)));
  });
}
