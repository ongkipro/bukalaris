import { slugFromHost } from "@bukalaris/db/host";
import { NextResponse, type NextRequest } from "next/server";
import { HOST_STORE_HEADER } from "./lib/host-header";

/**
 * Storefront host resolution (TEN-2, DOM-1 subset): `<slug>.<STORE_ROOT_DOMAIN>`
 * is rewritten to `/s/<slug>/...`. Hosted checkout and auth stay at their own
 * paths. The internal header is always overwritten so a client cannot forge it.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete(HOST_STORE_HEADER);
  const slug = slugFromHost(request.headers.get("host"), process.env.STORE_ROOT_DOMAIN ?? "localhost");
  const { pathname } = request.nextUrl;
  if (!slug || pathname.startsWith("/checkout") || pathname.startsWith("/api/")) {
    return NextResponse.next({ request: { headers } });
  }
  // Path-style links (/s/<slug>/...) on the store's own host: drop the prefix, keep the host.
  if (pathname === `/s/${slug}` || pathname.startsWith(`/s/${slug}/`)) {
    const path = pathname.slice(`/s/${slug}`.length) || "/";
    const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
    return NextResponse.redirect(new URL(`${path}${request.nextUrl.search}`, `${proto}://${request.headers.get("host")}`));
  }
  const url = request.nextUrl.clone();
  headers.set(HOST_STORE_HEADER, slug);
  url.pathname = `/s/${slug}${pathname === "/" ? "" : pathname}`;
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
