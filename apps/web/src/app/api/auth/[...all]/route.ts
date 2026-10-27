import { authForHost } from "@/lib/auth";

/**
 * Better Auth HTTP handler. The auth instance, cookie names and session audience come from the request HOST
 * only (T-70 slice 3, DOM-5 `/api/auth/*`); a host that serves no sign-in surface is a plain 404.
 *
 * CSRF does not rely on the cookie alone (DOM-6): on top of Better Auth's trusted-origin check, every
 * non-safe request must carry the surface's exact `Origin`, a `Sec-Fetch-Site: cross-site` request is refused,
 * and a request with cookies but no `Origin` is refused. A cookie tossed from a sibling host satisfies none of it.
 */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

async function handle(request: Request) {
  const surface = authForHost(request.headers.get("host"));
  if (!surface) return new Response("Not Found", { status: 404 });
  if (!SAFE.has(request.method)) {
    const origin = request.headers.get("origin");
    const bad =
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin !== null ? origin !== surface.origin : request.headers.has("cookie"));
    if (bad) return Response.json({ code: "INVALID_ORIGIN", message: "Invalid origin" }, { status: 403 });
  }
  return surface.auth.handler(request);
}

export const GET = handle;
export const POST = handle;
