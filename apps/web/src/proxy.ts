import { dispatchHostPath, resolveHostSurface, surfaceOriginsFromEnv } from "@bukalaris/db/host";
import { NextResponse, type NextRequest } from "next/server";
import { HOST_STORE_HEADER, WWW_REDIRECT_HEADER } from "./lib/host-header";
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
  // T-82 #31: after a successful hydrated Server Action redirect, Next renders the target with an internal
  // fetch to its listener origin, so the app sees Host=localhost (one-host path mode, no session) while the
  // browser's real host survives only in x-forwarded-host. Rendering that request would show the wrong surface
  // (login, wrong CSRF binding). Refuse it instead: Next then sends the redirect without Flight data and the
  // browser navigates itself with its real Host. x-forwarded-host is only ever used to REFUSE, never to choose
  // a surface or grant authority, so a forged value can only deny the forger's own request.
  if (misdirectedInternalRender(request)) {
    // Traceable without echoing the forwarded value (review 089b6b7e).
    return new NextResponse(null, { status: 421, headers: { "cache-control": "no-store", [REQUEST_ID_HEADER]: crypto.randomUUID() } });
  }
  const headers = new Headers(request.headers);
  headers.delete(HOST_STORE_HEADER);
  headers.delete(WWW_REDIRECT_HEADER);
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
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const decision = dispatchHostPath({
    host: request.headers.get("host"),
    rootDomain: process.env.STORE_ROOT_DOMAIN ?? "localhost",
    pathname,
    search: request.nextUrl.search,
    method: request.method,
    proto,
    devOutbox: process.env.DEV_OUTBOX === "1" && process.env.NODE_ENV !== "production",
    checkoutOrigin: surfaceOriginsFromEnv(process.env).checkoutOrigin,
  });
  const finish = (res: NextResponse) => {
    res.headers.set(REQUEST_ID_HEADER, requestId);
    if (!decision.noCookies) {
      res.cookies.set(REQUEST_ID_COOKIE, requestId, { path: "/", sameSite: "lax", maxAge: 300 });
    }
    if (csp) res.headers.set(CSP_HEADER, csp);
    if (hsts) res.headers.set(HSTS_HEADER, HSTS_VALUE);
    return res;
  };
  if (decision.action === "not_found") {
    const url = request.nextUrl.clone();
    url.pathname = "/_not-found";
    return finish(NextResponse.rewrite(url, { status: 404, request: { headers } }));
  }
  if (decision.action === "redirect") {
    if (decision.surface === "www") {
      // Emit WWW Location from a route response, outside Next's middleware redirect relativization.
      headers.set(WWW_REDIRECT_HEADER, decision.location);
      const url = request.nextUrl.clone();
      url.pathname = "/api/internal/www-redirect";
      return finish(NextResponse.rewrite(url, { request: { headers } }));
    }
    return finish(NextResponse.redirect(new URL(decision.location), decision.status));
  }
  if (decision.storeSlug) {
    headers.set(HOST_STORE_HEADER, decision.storeSlug);
  }
  if (decision.action === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = decision.pathname;
    return finish(NextResponse.rewrite(url, { request: { headers } }));
  }
  return finish(NextResponse.next({ request: { headers } }));
}

/**
 * True when the first x-forwarded-host names a different surface than Host. Locally the internal render arrives as
 * localhost (local_path); with a real root domain the same listener host resolves to `unknown`, so the comparison is
 * by resolved surface rather than by "is localhost". Ordinary requests (Next sets x-forwarded-host = Host, and a
 * Host-preserving reverse proxy does the same) never differ.
 */
function misdirectedInternalRender(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  if (!forwarded) return false;
  const root = process.env.STORE_ROOT_DOMAIN ?? "localhost";
  const key = (host: string | null) => JSON.stringify(resolveHostSurface(host, root));
  return key(request.headers.get("host")) !== key(forwarded);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
