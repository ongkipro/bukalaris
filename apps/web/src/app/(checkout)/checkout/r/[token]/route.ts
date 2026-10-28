import { cartCookie, clientIp, cookieOpts } from "@/lib/storefront";
import { db, resumeCheckout } from "@bukalaris/db";
import { NextResponse } from "next/server";

/**
 * Resume link of the seller's WhatsApp recovery message (T-45, HTTP-32): a signed, store-bound, 7-day token. A valid link binds the saved cart to the
 * buyer through the existing per-store HttpOnly cart cookie and lands on /checkout?store=<slug>; it shows and carries no buyer data. Anything else
 * (tampered, expired, another store's pair, a session already completed, a purged or emptied cart, too many tries) gets the same safe page and no cookie.
 */
export async function GET(_req: Request, ctx: RouteContext<"/checkout/r/[token]">) {
  const { token } = await ctx.params;
  const r = await resumeCheckout(db(), token, { clientIp: await clientIp() });
  // Relative Location: the server may see its own bind address (0.0.0.0) as the request host.
  const to = r.ok ? `/checkout?store=${encodeURIComponent(r.storeSlug)}` : "/checkout/h/invalid";
  const res = new NextResponse(null, { status: 303, headers: { Location: to, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" } });
  if (r.ok) res.cookies.set(cartCookie(r.storeId), r.cartId, cookieOpts);
  return res;
}
