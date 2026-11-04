import { resolveHostSurface } from "@bukalaris/db/host";
import { WWW_REDIRECT_HEADER } from "@/lib/host-header";

const denied = () => new Response(null, { status: 404 });

/** Only the WWW proxy branch supplies this header; all inbound copies are removed. */
export function GET(request: Request) {
  const host = request.headers.get("host");
  const location = request.headers.get(WWW_REDIRECT_HEADER);
  if (!host || !location || resolveHostSurface(host, process.env.STORE_ROOT_DOMAIN ?? "localhost").kind !== "www") return denied();
  try {
    const target = new URL(location);
    const apex = new URL(`${target.protocol}//${host}`);
    apex.hostname = apex.hostname.replace(/^www\./i, "");
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || apex.username || apex.password || apex.pathname !== "/" || apex.search || apex.hash || target.origin !== apex.origin) return denied();
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
