import { slugFromHost } from "@bukalaris/db/host";
import { NextResponse, type NextRequest } from "next/server";
import { HOST_STORE_HEADER } from "./lib/host-header";
import { REQUEST_ID_COOKIE, REQUEST_ID_HEADER, validRequestId } from "./lib/request-id";
import { CSP_HEADER, contentSecurityPolicy, HSTS_HEADER, HSTS_VALUE, newNonce, NONCE_HEADER } from "./lib/security-headers";

/**
 * Storefront host resolution (TEN-2, DOM-1 subset): `<slug>.<STORE_ROOT_DOMAIN>`
 * is rewritten to `/s/<slug>/...`. Hosted checkout and auth stay at their own
 * paths. The internal header is always overwritten so a client cannot forge it.
 * Also stamps the per-request security headers (SEC-14): nonce CSP on HTML routes and
 * HSTS when `ENABLE_HSTS=1` and the request arrived over HTTPS (runtime env, so it cannot
 * live in next.config.ts, which is evaluated at build time).
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete(HOST_STORE_HEADER);
  // Correlation id (OBS): minted here. An inbound x-request-id is honoured only with
  // TRUST_PROXY_REQUEST_ID=1, i.e. when the reverse proxy in front is known to set or overwrite
  // it; otherwise a client could pick the id its log lines carry. Never identity or authorization.
  const inbound = process.env.TRUST_PROXY_REQUEST_ID === "1" ? request.headers.get(REQUEST_ID_HEADER) : null;
  const requestId = validRequestId(inbound) ? inbound : crypto.randomUUID();
  headers.set(REQUEST_ID_HEADER, requestId);
  const { pathname } = request.nextUrl;
  const https = (request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "")) === "https";
  const hsts = https && process.env.ENABLE_HSTS === "1";
  // JSON API routes carry no HTML and image routes (`.../media/<id>`, storefront, host mode and
  // seller) set their own sandboxing CSP in lib/media.ts, which a proxy header would overwrite.
  // Everything else gets a fresh nonce that Next reads from the request header and applies to
  // its inline scripts.
  let csp: string | null = null;
  if (!pathname.startsWith("/api/") && !/\/media\/[0-9]+$/.test(pathname)) {
    const nonce = newNonce();
    csp = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === "development", https });
    headers.set(NONCE_HEADER, nonce);
    headers.set(CSP_HEADER, csp);
  }
  const finish = (res: NextResponse) => {
    res.headers.set(REQUEST_ID_HEADER, requestId);
    res.cookies.set(REQUEST_ID_COOKIE, requestId, { path: "/", sameSite: "lax", maxAge: 300 });
    if (csp) res.headers.set(CSP_HEADER, csp);
    if (hsts) res.headers.set(HSTS_HEADER, HSTS_VALUE);
    return res;
  };
  const slug = slugFromHost(request.headers.get("host"), process.env.STORE_ROOT_DOMAIN ?? "localhost");
  if (!slug || pathname.startsWith("/checkout") || pathname.startsWith("/api/")) {
    return finish(NextResponse.next({ request: { headers } }));
  }
  // Path-style links (/s/<slug>/...) on the store's own host: drop the prefix, keep the host.
  if (pathname === `/s/${slug}` || pathname.startsWith(`/s/${slug}/`)) {
    const path = pathname.slice(`/s/${slug}`.length) || "/";
    const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
    return finish(NextResponse.redirect(new URL(`${path}${request.nextUrl.search}`, `${proto}://${request.headers.get("host")}`)));
  }
  const url = request.nextUrl.clone();
  headers.set(HOST_STORE_HEADER, slug);
  url.pathname = `/s/${slug}${pathname === "/" ? "" : pathname}`;
  return finish(NextResponse.rewrite(url, { request: { headers } }));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
