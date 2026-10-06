import { createEmptyCart, getCart, setCartLine } from "@bukalaris/db";
import { z } from "zod";
import { cartItemInput, cartJson, json, withChannel } from "../_lib";

const cartCreate = z.strictObject({ items: z.array(cartItemInput).max(50).default([]) });

/** createCart: a new cart bound to the channel's store, optionally with first items. */
export function POST(req: Request) {
  return withChannel(req, async ({ scope }) => {
    const { items } = cartCreate.parse(await req.json());
    let cartId = await createEmptyCart(scope);
    for (const i of items) cartId = await setCartLine(scope, cartId, { variantId: i.variant_id, quantity: i.quantity }, "add");
    return json({ cart: cartJson(await getCart(scope, cartId)) }, 201);
  });
}
