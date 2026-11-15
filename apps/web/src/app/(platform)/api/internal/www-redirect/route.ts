import { hostRootsFromEnv, redirectOriginForHost } from "@bukalaris/db/host";
import { WWW_REDIRECT_HEADER } from "@/lib/host-header";

const denied = () => new Response(null, { status: 404 });

/**
 * Only the proxy's redirect branch (platform `www`, store-root apex and `www`, ADR-0014) supplies this header; all inbound
 * copies are removed. The target origin is recomputed from Host and configuration, never taken from the header.
 */
export function GET(request: Request) {
  const host = request.headers.get("host");
  const location = request.headers.get(WWW_REDIRECT_HEADER);
  if (!host || !location) return denied();
  try {
    const target = new URL(location);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) return denied();
    const expected = redirectOriginForHost(host, hostRootsFromEnv(process.env), target.protocol.slice(0, -1));
    if (!expected || target.origin !== new URL(expected).origin) return denied();
    // Path-dependent proxy transport must never share a cached response.
    return new Response(null, { status: 308, headers: { location: target.href, "cache-control": "no-store" } });
  } catch {
    return denied();
  }
}

export const HEAD = GET;
export const POST = denied;
export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;
export const OPTIONS = denied;
