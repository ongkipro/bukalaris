/**
 * Platform host resolution, reserved labels, per-surface origins, per-surface cookies,
 * and DOM-5 host × path × method dispatch (T-70, ADR-0008 §3, 08-DOMAIN-ROUTING DOM-4..DOM-6).
 */

export const RESERVED_HOST_LABEL_LIST = [
  "owner",
  "app",
  "checkout",
  "affiliate",
  "buyer",
  "logs",
  "www",
  "api",
  "mail",
  "status",
  "docs",
  "assets",
  "cdn",
  "cname",
  "berkah",
  "bos",
] as const;

export type ReservedHostLabel = (typeof RESERVED_HOST_LABEL_LIST)[number];

export const RESERVED_HOST_LABELS: Record<string, true> = {
  owner: true,
  app: true,
  checkout: true,
  affiliate: true,
  buyer: true,
  logs: true,
  www: true,
  api: true,
  mail: true,
  status: true,
  docs: true,
  assets: true,
  cdn: true,
  cname: true,
  berkah: true,
  bos: true,
};

export const RESERVED_ROUTE_ROOTS: Record<string, true> = {
  report: true,
  updates: true,
  affiliate: true,
  buyer: true,
  a: true,
  r: true,
  admin: true,
  seller: true,
  checkout: true,
  api: true,
  login: true,
  account: true,
  invite: true,
  s: true,
  lp: true,
  o: true,
  feeds: true,
  dev: true,
  products: true,
  collections: true,
  pages: true,
  search: true,
  cart: true,
  media: true,
  sitemap: true,
  robots: true,
};

const DNS_LABEL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isReservedHostLabel(label: string): boolean {
  return Boolean(RESERVED_HOST_LABELS[label.trim().toLowerCase()]);
}

export function validDnsLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized.length >= 1 && normalized.length <= 63 && DNS_LABEL_RE.test(normalized);
}

export function validClaimableLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return validDnsLabel(normalized) && !isReservedHostLabel(normalized);
}

export function normalizeHostname(host: string | null | undefined): string {
  if (!host) return "";
  return host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

/**
 * Map a request Host to a store slug: `<slug>.<rootDomain>[:port]` → slug.
 * Reserved platform/infrastructure labels (`owner`, `app`, `checkout`, `affiliate`,
 * `buyer`, `logs`, `cname`, `berkah`, `bos`, etc.), apex, nested subdomains, and other
 * domains return `null`.
 */
export function slugFromHost(host: string | null, rootDomain: string): string | null {
  const hostname = normalizeHostname(host);
  const root = normalizeHostname(rootDomain);
  if (!hostname || !root) return null;
  const suffix = `.${root}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return validClaimableLabel(label) ? label : null;
}

export type HostSurface =
  | { kind: "local_path" }
  | { kind: "apex" }
  | { kind: "owner" }
  | { kind: "seller" }
  | { kind: "checkout" }
  | { kind: "affiliate" }
  | { kind: "buyer" }
  | { kind: "logs" }
  | { kind: "www" }
  | { kind: "reserved_unused"; label: string }
  | { kind: "affiliate_store"; handle: string }
  | { kind: "store"; slug: string }
  | { kind: "unknown" };

const LOCAL_HOSTS: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
};

export function resolveHostSurface(
  host: string | null,
  rootDomain: string,
  customDomainStore?: (hostname: string) => string | null,
): HostSurface {
  const hostname = normalizeHostname(host);
  const root = normalizeHostname(rootDomain) || "localhost";
  if (!hostname) return { kind: "unknown" };

  // Local path mode when running directly on localhost / 127.0.0.1 with rootDomain="localhost"
  if (LOCAL_HOSTS[root] && LOCAL_HOSTS[hostname]) {
    return { kind: "local_path" };
  }
  if (hostname === root) {
    return { kind: "apex" };
  }
  const suffix = `.${root}`;
  if (hostname.endsWith(suffix)) {
    const sub = hostname.slice(0, -suffix.length);
    if (!sub.includes(".")) {
      if (sub === "owner") return { kind: "owner" };
      if (sub === "app") return { kind: "seller" };
      if (sub === "checkout") return { kind: "checkout" };
      if (sub === "affiliate") return { kind: "affiliate" };
      if (sub === "buyer") return { kind: "buyer" };
      if (sub === "logs") return { kind: "logs" };
      if (sub === "www") return { kind: "www" };
      if (isReservedHostLabel(sub)) return { kind: "reserved_unused", label: sub };
      if (validClaimableLabel(sub)) return { kind: "store", slug: sub };
      return { kind: "unknown" };
    }
    if (sub.endsWith(".affiliate")) {
      const handle = sub.slice(0, -".affiliate".length);
      if (!handle.includes(".") && validClaimableLabel(handle)) {
        return { kind: "affiliate_store", handle };
      }
      // Never fall back to store lookup for *.affiliate.<root>
      return { kind: "unknown" };
    }
    return { kind: "unknown" };
  }
  if (customDomainStore) {
    try {
      const resolved = customDomainStore(hostname);
      if (resolved && validClaimableLabel(resolved)) return { kind: "store", slug: resolved };
    } catch {
      // Fail closed on resolver error (ADR-0008 §3 step 5)
      return { kind: "unknown" };
    }
  }
  return { kind: "unknown" };
}

export type SurfaceOrigins = {
  platformOrigin: string;
  ownerOrigin: string;
  appOrigin: string;
  checkoutOrigin: string;
  affiliateOrigin: string;
  buyerOrigin: string;
  logsOrigin: string;
};

const trimSlash = (u: string) => u.replace(/\/+$/, "");

export function surfaceOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): SurfaceOrigins {
  const fallback = trimSlash(env.PLATFORM_ORIGIN ?? env.BETTER_AUTH_URL ?? "http://localhost:3000");
  return {
    platformOrigin: trimSlash(env.PLATFORM_ORIGIN ?? fallback),
    ownerOrigin: trimSlash(env.OWNER_ORIGIN ?? fallback),
    appOrigin: trimSlash(env.APP_ORIGIN ?? fallback),
    checkoutOrigin: trimSlash(env.CHECKOUT_ORIGIN ?? fallback),
    affiliateOrigin: trimSlash(env.AFFILIATE_ORIGIN ?? fallback),
    buyerOrigin: trimSlash(env.BUYER_ORIGIN ?? fallback),
    logsOrigin: trimSlash(env.LOGS_ORIGIN ?? fallback),
  };
}

export function surfaceCookieNames(prod = process.env.NODE_ENV === "production") {
  const prefix = prod ? "__Host-" : "";
  return {
    ownerSession: `${prefix}bl_owner`,
    sellerSession: `${prefix}bl_seller`,
    sellerStore: `${prefix}bl_store`,
    affiliateSession: `${prefix}bl_aff`,
    buyerSession: `${prefix}bl_buyer`,
    orderCart: `${prefix}bl_order_cart`,
    referralClick: `${prefix}bl_click`,
    storeCart: (storeId: number | string) => `${prefix}bl_cart_${storeId}`,
  };
}

export type DispatchDecision =
  | { action: "pass"; surface: HostSurface["kind"]; storeSlug?: string; affiliateHandle?: string; noCookies?: boolean }
  | { action: "rewrite"; pathname: string; surface: HostSurface["kind"]; storeSlug?: string; affiliateHandle?: string; noCookies?: boolean }
  | { action: "redirect"; status: 308; location: string; surface: HostSurface["kind"]; noCookies?: boolean }
  | { action: "not_found"; status: 404; surface: HostSurface["kind"]; noCookies?: boolean };

const isProbe = (p: string) => p === "/api/health" || p === "/api/ready";
const isSafeMethod = (m: string) => m === "GET" || m === "HEAD";
const matchesPrefix = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

const EXPLICIT_SURFACE_PREFIXES = ["/admin", "/seller", "/affiliate", "/buyer", "/updates", "/a", "/s"];
const isAnyExplicitSurfacePrefix = (pathname: string) => EXPLICIT_SURFACE_PREFIXES.some((p) => matchesPrefix(pathname, p));

/**
 * Pure DOM-5 host × path × method decision engine (ADR-0008 §3, 08-DOMAIN-ROUTING DOM-5).
 */
export function dispatchHostPath(input: {
  host: string | null;
  rootDomain: string;
  pathname: string;
  search?: string;
  method?: string;
  proto?: string;
  devOutbox?: boolean;
  checkoutOrigin?: string;
  customDomainStore?: (hostname: string) => string | null;
}): DispatchDecision {
  const pathname = input.pathname || "/";
  const search = input.search ?? "";
  const method = (input.method ?? "GET").toUpperCase();
  const proto = input.proto ?? "https";
  const surface = resolveHostSurface(input.host, input.rootDomain, input.customDomainStore);

  // Infrastructure probes pass on EVERY host (DOM-5 row `/api/health`, `/api/ready`).
  if (isProbe(pathname)) {
    return { action: "pass", surface: surface.kind, noCookies: surface.kind === "logs" };
  }

  // `/api/internal/*` is never routable on any public host (DOM-5).
  if (matchesPrefix(pathname, "/api/internal")) {
    return { action: "not_found", status: 404, surface: surface.kind };
  }

  switch (surface.kind) {
    case "local_path":
      return { action: "pass", surface: "local_path" };

    case "www": {
      if (!isSafeMethod(method)) return { action: "not_found", status: 404, surface: "www" };
      // Same host without the `www.` label (the port, if any, is kept: local mode).
      const apex = (input.host ?? "").trim().replace(/^www\./i, "");
      return { action: "redirect", status: 308, location: `${proto}://${apex}${pathname}${search}`, surface: "www" };
    }

    case "reserved_unused":
    case "unknown":
      return { action: "not_found", status: 404, surface: surface.kind };

    case "apex": {
      if (pathname === "/") return { action: "pass", surface: "apex" };
      if (matchesPrefix(pathname, "/r")) {
        return method === "GET" ? { action: "pass", surface: "apex" } : { action: "not_found", status: 404, surface: "apex" };
      }
      if (pathname === "/api/payments/autolaris/callback" || pathname === "/api/shipping/mengantar/webhook") {
        return method === "POST" ? { action: "pass", surface: "apex" } : { action: "not_found", status: 404, surface: "apex" };
      }
      // `/report` and `/api/public/reports` stay 404 until Compliance center is activated (DOM-5).
      return { action: "not_found", status: 404, surface: "apex" };
    }

    case "owner": {
      if (pathname === "/") return { action: "rewrite", pathname: "/admin", surface: "owner" };
      if (matchesPrefix(pathname, "/admin")) return { action: "pass", surface: "owner" };
      if (pathname === "/login" || matchesPrefix(pathname, "/account") || matchesPrefix(pathname, "/api/auth")) {
        return { action: "pass", surface: "owner" };
      }
      if (matchesPrefix(pathname, "/dev/outbox") && input.devOutbox) {
        return { action: "pass", surface: "owner" };
      }
      return { action: "not_found", status: 404, surface: "owner" };
    }

    case "seller": {
      if (pathname === "/") return { action: "rewrite", pathname: "/seller", surface: "seller" };
      if (matchesPrefix(pathname, "/seller")) return { action: "pass", surface: "seller" };
      if (
        pathname === "/login" ||
        matchesPrefix(pathname, "/account") ||
        matchesPrefix(pathname, "/invite") ||
        matchesPrefix(pathname, "/feeds") ||
        matchesPrefix(pathname, "/api/auth") ||
        matchesPrefix(pathname, "/api/storefront/v1")
      ) {
        return { action: "pass", surface: "seller" };
      }
      if (matchesPrefix(pathname, "/o") && isSafeMethod(method)) {
        const co = trimSlash(input.checkoutOrigin ?? `${proto}://checkout.${normalizeHostname(input.rootDomain)}`);
        return { action: "redirect", status: 308, location: `${co}${pathname}${search}`, surface: "seller" };
      }
      return { action: "not_found", status: 404, surface: "seller" };
    }

    case "checkout": {
      if (matchesPrefix(pathname, "/checkout") || matchesPrefix(pathname, "/o") || pathname === "/api/signals") {
        return { action: "pass", surface: "checkout" };
      }
      return { action: "not_found", status: 404, surface: "checkout" };
    }

    case "affiliate": {
      if (pathname === "/") return { action: "rewrite", pathname: "/affiliate", surface: "affiliate" };
      if (pathname === "/login") return { action: "rewrite", pathname: "/affiliate/login", surface: "affiliate" };
      if (matchesPrefix(pathname, "/affiliate") || matchesPrefix(pathname, "/api/auth")) {
        return { action: "pass", surface: "affiliate" };
      }
      return { action: "not_found", status: 404, surface: "affiliate" };
    }

    case "buyer": {
      if (pathname === "/") return { action: "rewrite", pathname: "/buyer", surface: "buyer" };
      if (pathname === "/login") return { action: "rewrite", pathname: "/buyer/login", surface: "buyer" };
      if (matchesPrefix(pathname, "/buyer") || matchesPrefix(pathname, "/api/auth")) {
        return { action: "pass", surface: "buyer" };
      }
      return { action: "not_found", status: 404, surface: "buyer" };
    }

    case "logs": {
      if (!isSafeMethod(method)) return { action: "not_found", status: 404, surface: "logs", noCookies: true };
      if (pathname === "/") return { action: "rewrite", pathname: "/updates", surface: "logs", noCookies: true };
      if (matchesPrefix(pathname, "/updates")) return { action: "pass", surface: "logs", noCookies: true };
      return { action: "not_found", status: 404, surface: "logs", noCookies: true };
    }

    case "affiliate_store": {
      if (!isSafeMethod(method)) return { action: "not_found", status: 404, surface: "affiliate_store" };
      if (matchesPrefix(pathname, `/a/${surface.handle}`)) {
        return { action: "pass", surface: "affiliate_store", affiliateHandle: surface.handle };
      }
      if (
        isAnyExplicitSurfacePrefix(pathname) ||
        matchesPrefix(pathname, "/checkout") ||
        matchesPrefix(pathname, "/api") ||
        pathname === "/login" ||
        matchesPrefix(pathname, "/account") ||
        matchesPrefix(pathname, "/invite") ||
        matchesPrefix(pathname, "/o") ||
        matchesPrefix(pathname, "/feeds") ||
        matchesPrefix(pathname, "/dev") ||
        matchesPrefix(pathname, "/r") ||
        pathname === "/report"
      ) {
        return { action: "not_found", status: 404, surface: "affiliate_store" };
      }
      return {
        action: "rewrite",
        pathname: `/a/${surface.handle}${pathname === "/" ? "" : pathname}`,
        surface: "affiliate_store",
        affiliateHandle: surface.handle,
      };
    }

    case "store": {
      if (pathname === "/api/signals") {
        return { action: "pass", surface: "store", storeSlug: surface.slug };
      }
      if (pathname === `/s/${surface.slug}` || pathname.startsWith(`/s/${surface.slug}/`)) {
        if (!isSafeMethod(method)) return { action: "not_found", status: 404, surface: "store" };
        const stripped = pathname.slice(`/s/${surface.slug}`.length) || "/";
        return {
          action: "redirect",
          status: 308,
          location: `${proto}://${input.host}${stripped}${search}`,
          surface: "store",
        };
      }
      if (
        isAnyExplicitSurfacePrefix(pathname) ||
        matchesPrefix(pathname, "/checkout") ||
        matchesPrefix(pathname, "/api") ||
        pathname === "/login" ||
        matchesPrefix(pathname, "/account") ||
        matchesPrefix(pathname, "/invite") ||
        matchesPrefix(pathname, "/o") ||
        matchesPrefix(pathname, "/feeds") ||
        matchesPrefix(pathname, "/dev") ||
        matchesPrefix(pathname, "/r") ||
        pathname === "/report"
      ) {
        return { action: "not_found", status: 404, surface: "store" };
      }
      return {
        action: "rewrite",
        pathname: `/s/${surface.slug}${pathname === "/" ? "" : pathname}`,
        surface: "store",
        storeSlug: surface.slug,
      };
    }
  }
}
