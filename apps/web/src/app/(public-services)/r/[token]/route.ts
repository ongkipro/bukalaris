import { addReferralClick, captureReferralClick, classifyClickRequest, db, storeBaseUrl, type ClickOutcome } from "@bukalaris/db";
import { surfaceCookieNames } from "@bukalaris/db/host";
import { clientIp, hostStoreScope } from "@/lib/storefront";
import { notFound } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";

/**
 * HTTP-27 referral link and click capture (SEC-20, ADR-0009 section 8). The destination is derived from the stored link record (the seller's storefront, or one product of
 * it), never from a query parameter: there is no `next`, no open redirect. A click is recorded only for a top-level navigation (Sec-Fetch-Mode navigate and Dest document,
 * no prefetch) and inside the RL-CLICK limits; an embedded, prefetch, subresource or over-limit request is redirected without a click, so an `<img>` or a hidden iframe cannot
 * stuff the visitor's cookie. Unknown, revoked, expired, blocked and suspended links give one identical not-found. The continuity cookie holds opaque click ids only, host-only,
 * HttpOnly, SameSite=Lax. No IP, user agent, referrer or full URL is stored. A selector is never authority: checkout re-validates every id against the database.
 */
const FOREIGN = new Error("referral link of another store");

export async function GET(req: NextRequest, ctx: RouteContext<"/r/[token]">) {
  const { token } = await ctx.params;
  const input = { token, decision: classifyClickRequest({ method: req.method, headers: req.headers }), clientIp: await clientIp() };
  const own = await hostStoreScope();
  // C-D1 (T-103): a store host serves only its own store's links. The capture runs in a transaction that is rolled back for another
  // store's link, so a foreign token leaves no click, no counter and no cookie, and answers the same not-found as an unknown one.
  const outcome =
    own === undefined
      ? await captureReferralClick(db(), input)
      : await db()
          .transaction(async (tx) => {
            const o = await captureReferralClick(tx, input);
            if (o && o.target.storeSlug !== own?.storeSlug) throw FOREIGN;
            return o;
          })
          .catch((err: unknown): ClickOutcome | null => {
            if (err === FOREIGN) return null;
            throw err;
          });
  if (!outcome) notFound();
  const { storeSlug, productPath } = outcome.target;
  const res = new NextResponse(null, {
    status: 302,
    headers: { Location: `${storeBaseUrl(storeSlug)}${productPath ? `/products/${encodeURIComponent(productPath)}` : ""}`, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" },
  });
  if (outcome.clickId && outcome.expiresAt) {
    const name = surfaceCookieNames().referralClick;
    res.cookies.set(name, addReferralClick(req.cookies.get(name)?.value, outcome.clickId), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: outcome.expiresAt,
    });
  }
  return res;
}

/** HEAD never captures (a link checker or prefetcher must not set a cookie): same redirect, no click. */
export async function HEAD(req: NextRequest, ctx: RouteContext<"/r/[token]">) {
  return GET(req, ctx);
}
