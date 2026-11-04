import { authForHost } from "@/lib/auth";
import { portalCsrfContext } from "@/lib/auth-csrf";
import { createCsrfToken, validCsrfToken } from "@/lib/auth-csrf-token.mts";

/**
 * Better Auth HTTP handler. The auth instance, cookie names and session audience come from the request HOST
 * only (T-70 slice 3, DOM-5 `/api/auth/*`); a host that serves no sign-in surface is a plain 404.
 *
 * CSRF does not rely on the cookie alone (DOM-6): on top of Better Auth's trusted-origin check, every
 * non-safe request must carry the surface's exact `Origin`, a `Sec-Fetch-Site: cross-site` request is refused,
 * and a request with cookies but no `Origin` is refused. A cookie tossed from a sibling host satisfies none of it.
 */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const ANONYMOUS = new Set(["/sign-in/email", "/request-password-reset", "/reset-password"]);
const PENDING_MFA = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code", "/two-factor/verify-otp"]);
// Keep the global Referrer-Policy; CSRF transport never places a token in a URL.
const PRIVATE = { "cache-control": "private, no-store", vary: "Cookie" };
const invalidCsrf = () => Response.json({ code: "INVALID_CSRF", message: "Reload the page and try again" }, { status: 403, headers: PRIVATE });

async function handle(request: Request) {
  const surface = authForHost(request.headers.get("host"));
  if (!surface) return new Response("Not Found", { status: 404 });
  const path = new URL(request.url).pathname.slice("/api/auth".length);
  if (request.method === "GET" && path === "/csrf-token") {
    const origin = request.headers.get("origin");
    if (request.headers.get("sec-fetch-site") === "cross-site" || (origin !== null && origin !== surface.origin)) return invalidCsrf();
    const context = await portalCsrfContext(request.headers);
    if (!context || context.ambiguous) return invalidCsrf();
    return Response.json({ token: context.binding ? createCsrfToken(context.binding, context.secret) : null }, { headers: PRIVATE });
  }
  if (!SAFE.has(request.method)) {
    const origin = request.headers.get("origin");
    const bad =
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin !== null ? origin !== surface.origin : request.headers.has("cookie"));
    if (bad) return Response.json({ code: "INVALID_ORIGIN", message: "Invalid origin" }, { status: 403 });
    const context = await portalCsrfContext(request.headers);
    if (!context || context.ambiguous) return invalidCsrf();
    if (context.binding) {
      if (context.binding.kind === "pending-mfa" && !PENDING_MFA.has(path) && !ANONYMOUS.has(path)) return invalidCsrf();
      if (!validCsrfToken(request.headers.get("x-bl-csrf"), context.binding, context.secret)) return invalidCsrf();
    } else if (!ANONYMOUS.has(path)) return invalidCsrf();
  }
  return surface.auth.handler(request);
}

export const GET = handle;
export const POST = handle;
