import { cartCookie, cookieOpts } from "@/lib/storefront";
import { db, exchangeHandoff } from "@bukalaris/db";
import { NextResponse } from "next/server";

/**
 * Handoff exchange (ARCH-7, API-8): consume the one-use code, bind the cart to the
 * buyer with the existing per-store HttpOnly cart cookie and land on the clean
 * /checkout?store=<slug> route. Anything invalid (unknown, expired, replayed,
 * revoked channel, checked-out cart) gets a safe page and no cookie.
 */
export async function GET(_req: Request, ctx: RouteContext<"/checkout/h/[code]">) {
  const { code } = await ctx.params;
  const ok = await exchangeHandoff(db(), code);
  const to = ok ? `/checkout?store=${encodeURIComponent(ok.storeSlug)}` : "/checkout/h/invalid";
  // Relative Location: the server may see its own bind address (0.0.0.0) as the request host.
  const res = new NextResponse(null, { status: 303, headers: { Location: to, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" } });
  if (ok) res.cookies.set(cartCookie(ok.storeId), ok.cartId, cookieOpts);
  return res;
}
