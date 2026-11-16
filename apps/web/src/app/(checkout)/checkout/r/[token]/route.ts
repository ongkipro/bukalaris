import { cartCookie, clientIp, cookieOpts, hostStoreScope } from "@/lib/storefront";
import { db, resumeCheckout } from "@bukalaris/db";
import { hostRootsFromEnv, resolveHostSurface } from "@bukalaris/db/host";
import { NextResponse } from "next/server";

/**
 * Resume link of the seller's WhatsApp recovery message (T-45, HTTP-32): a signed, store-bound, 7-day token. A valid link binds the saved cart to the
 * buyer through the existing per-store HttpOnly cart cookie and lands on /checkout?store=<slug>; it shows and carries no buyer data. Anything else
 * (tampered, expired, another store's pair, a session already completed, a purged or emptied cart, too many tries) gets the same safe page and no cookie.
 */
export async function GET(req: Request, ctx: RouteContext<"/checkout/r/[token]">) {
  const { token } = await ctx.params;
  // T-103: the link is built on the store's own host. A store host redeems only its own store's link; the hosted checkout host
  // (PR-16 hand-off only) redeems none. Both refusals get the same safe page and no cookie.
  const own = await hostStoreScope();
  const checkoutHost = own === undefined && resolveHostSurface(req.headers.get("host"), hostRootsFromEnv()).kind === "checkout";
  const r = checkoutHost ? null : await resumeCheckout(db(), token, { clientIp: await clientIp() });
  const ok = r?.ok && (own === undefined || own?.storeId === r.storeId) ? r : null;
  // Relative Location: the server may see its own bind address (0.0.0.0) as the request host.
  const to = ok ? `/checkout?store=${encodeURIComponent(ok.storeSlug)}` : "/checkout/h/invalid";
  const res = new NextResponse(null, { status: 303, headers: { Location: to, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" } });
  if (ok) res.cookies.set(cartCookie(ok.storeId), ok.cartId, cookieOpts);
  return res;
}
