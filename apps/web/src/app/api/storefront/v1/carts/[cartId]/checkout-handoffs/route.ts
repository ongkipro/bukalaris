import { createHandoff } from "@bukalaris/db";
import { surfaceOriginsFromEnv } from "@bukalaris/db/host";
import { json, withChannel } from "../../../_lib";

/**
 * createCheckoutHandoff: a one-use, short-lived URL into Bukalaris hosted checkout.
 * No order or payment is created here. The URL carries only a random code.
 */
export function POST(req: Request, ctx: RouteContext<"/api/storefront/v1/carts/[cartId]/checkout-handoffs">) {
  return withChannel(req, async ({ scope, channel }) => {
    const { cartId } = await ctx.params;
    const h = await createHandoff(scope, channel.id, cartId);
    // Checkout origin is platform configuration (DOM-5, `CHECKOUT_ORIGIN`); never the request's own origin.
    const origin = surfaceOriginsFromEnv(process.env).checkoutOrigin;
    return json({ checkout_id: String(h.id), checkout_url: `${origin}/checkout/h/${h.code}`, expires_at: h.expiresAt.toISOString() }, 201);
  });
}
