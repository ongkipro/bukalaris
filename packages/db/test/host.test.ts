import { inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  dispatchHostPath,
  hostRootsFromEnv,
  isReservedHostLabel,
  redirectOriginForHost,
  resolveHostSurface,
  RESERVED_HOST_LABEL_LIST,
  slugFromHost,
  storeLinks,
  surfaceCookieNames,
  surfaceOriginsFromEnv,
} from "../src/platform/host.ts";
import { createStore } from "../src/platform/platform.ts";
import { store } from "../src/schema.ts";
import { storeCreateInput } from "../src/storefront/content.ts";
import { storeBaseUrl } from "../src/storefront/feeds.ts";
import { makeOperator, platform } from "./helpers.ts";

// T-70 (ADR-0008 §3, 08-DOMAIN-ROUTING DOM-5): exact-host dispatch golden table. Every row of the
// host × path matrix is asserted, with a negative case for each privileged or checkout 404 cell.
const ROOT = "bukalaris.com";
const H = {
  apex: ROOT,
  owner: `owner.${ROOT}`,
  seller: `app.${ROOT}`,
  checkout: `checkout.${ROOT}`,
  aff: `affiliate.${ROOT}`,
  buyer: `buyer.${ROOT}`,
  logs: `logs.${ROOT}`,
  affStore: `sari.affiliate.${ROOT}`,
  store: `toko-a.${ROOT}`,
} as const;
type Surface = keyof typeof H;

type Cell = "pass" | "404" | `→ ${string}` | `308 ${string}`;
const decide = (surface: Surface, path: string, method = "GET") => {
  const d = dispatchHostPath({ host: H[surface], rootDomain: ROOT, pathname: path, method, proto: "https", devOutbox: false });
  if (d.action === "pass") return "pass";
  if (d.action === "not_found") return "404";
  if (d.action === "rewrite") return `→ ${d.pathname}`;
  return `308 ${d.location}`;
};

const ORDER: Surface[] = ["apex", "owner", "seller", "checkout", "aff", "buyer", "logs", "affStore", "store"];

// One row per DOM-5 path; cells in `ORDER`.
const MATRIX: [string, string, Cell[]][] = [
  ["/", "GET", ["pass", "→ /admin", "→ /seller", "404", "→ /affiliate", "→ /buyer", "→ /updates", "→ /a/sari", "→ /s/toko-a"]],
  ["/login", "GET", ["404", "pass", "pass", "404", "→ /affiliate/login", "→ /buyer/login", "404", "404", "404"]],
  ["/account/security", "GET", ["404", "pass", "pass", "404", "404", "404", "404", "404", "404"]],
  ["/invite/abc", "GET", ["404", "404", "pass", "404", "404", "404", "404", "404", "404"]],
  ["/o/1.2.abc", "GET", ["404", "404", `308 https://checkout.${ROOT}/o/1.2.abc`, "pass", "404", "404", "404", "404", "pass"]],
  ["/feeds/blfd_x/meta.csv", "GET", ["404", "404", "pass", "404", "404", "404", "404", "404", "404"]],
  ["/dev/outbox", "GET", ["404", "404", "404", "404", "404", "404", "404", "404", "404"]],
  ["/api/auth/sign-in/email", "POST", ["404", "pass", "pass", "404", "pass", "pass", "404", "404", "404"]],
  ["/api/health", "GET", ["pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass"]],
  ["/api/ready", "GET", ["pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass"]],
  ["/api/signals", "POST", ["404", "404", "404", "pass", "404", "404", "404", "404", "pass"]],
  ["/api/storefront/v1/products", "GET", ["404", "404", "pass", "404", "404", "404", "404", "404", "404"]],
  ["/api/payments/autolaris/callback", "POST", ["pass", "404", "404", "404", "404", "404", "404", "404", "404"]],
  ["/api/shipping/mengantar/webhook", "POST", ["pass", "404", "404", "404", "404", "404", "404", "404", "404"]],
  ["/api/public/reports", "POST", ["404", "404", "404", "404", "404", "404", "404", "404", "404"]],
  ["/api/internal/updates/revalidate", "POST", ["404", "404", "404", "404", "404", "404", "404", "404", "404"]],
  ["/checkout", "GET", ["404", "404", "404", "pass", "404", "404", "404", "404", "pass"]],
  ["/checkout", "POST", ["404", "404", "404", "pass", "404", "404", "404", "404", "pass"]],
  ["/checkout/confirmation", "GET", ["404", "404", "404", "pass", "404", "404", "404", "404", "pass"]],
  ["/checkout/r/v1.x", "GET", ["404", "404", "404", "pass", "404", "404", "404", "404", "pass"]],
  ["/checkout/h/abc", "GET", ["404", "404", "404", "pass", "404", "404", "404", "404", "404"]],
  ["/checkout/h/invalid", "GET", ["404", "404", "404", "pass", "404", "404", "404", "404", "pass"]],
  ["/r/token", "GET", ["pass", "404", "404", "404", "404", "404", "404", "404", "pass"]],
  ["/r/token", "POST", ["404", "404", "404", "404", "404", "404", "404", "404", "404"]],
  ["/report", "GET", ["404", "404", "404", "404", "404", "404", "404", "404", "404"]],
  ["/admin", "GET", ["404", "pass", "404", "404", "404", "404", "404", "404", "404"]],
  ["/admin/logs", "GET", ["404", "pass", "404", "404", "404", "404", "404", "404", "404"]],
  ["/seller/orders", "GET", ["404", "404", "pass", "404", "404", "404", "404", "404", "404"]],
  ["/affiliate/x", "GET", ["404", "404", "404", "404", "pass", "404", "404", "404", "404"]],
  ["/buyer/x", "GET", ["404", "404", "404", "404", "404", "pass", "404", "404", "404"]],
  ["/updates/x", "GET", ["404", "404", "404", "404", "404", "404", "pass", "404", "404"]],
  ["/a/sari/x", "GET", ["404", "404", "404", "404", "404", "404", "404", "pass", "404"]],
  ["/s/other/x", "GET", ["404", "404", "404", "404", "404", "404", "404", "404", "404"]],
  ["/s/toko-a/cart", "GET", ["404", "404", "404", "404", "404", "404", "404", "404", `308 https://toko-a.${ROOT}/cart`]],
  ["/cart", "GET", ["404", "surface 404", "surface 404", "404", "surface 404", "surface 404", "surface 404", "→ /a/sari/cart", "→ /s/toko-a/cart"].map((c) => (c === "surface 404" ? "404" : c)) as Cell[]],
];

describe("T-70 host × path × method golden table (DOM-5)", () => {
  for (const [path, method, cells] of MATRIX) {
    it(`${method} ${path}`, () => {
      expect(ORDER.map((s) => decide(s, path, method))).toEqual(cells);
    });
  }

  it("serves the Update Log on GET/HEAD only, with no cookies", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(decide("logs", "/updates/x", method)).toBe("404");
    expect(decide("logs", "/updates/x", "HEAD")).toBe("pass");
    const d = dispatchHostPath({ host: H.logs, rootDomain: ROOT, pathname: "/updates", method: "GET" });
    expect(d).toMatchObject({ noCookies: true });
    // probes are the only /api path the logs host answers, also without cookies
    expect(dispatchHostPath({ host: H.logs, rootDomain: ROOT, pathname: "/api/health" })).toMatchObject({ action: "pass", noCookies: true });
    expect(decide("logs", "/checkout", "GET")).toBe("404");
    expect(decide("logs", "/api/storefront/v1/products", "GET")).toBe("404");
  });

  it("affiliate storefront refuses unsafe methods; the redirect strips only this host's store prefix", () => {
    expect(decide("affStore", "/cart", "POST")).toBe("404");
    expect(decide("store", "/s/toko-a/cart", "POST")).toBe("404");
    expect(decide("store", "/s/toko-b/cart", "GET")).toBe("404");
  });

  it("opens the dev outbox only on the Owner host and only when DEV_OUTBOX is allowed", () => {
    const on = dispatchHostPath({ host: H.owner, rootDomain: ROOT, pathname: "/dev/outbox", devOutbox: true });
    expect(on.action).toBe("pass");
    const wrongHost = dispatchHostPath({ host: H.seller, rootDomain: ROOT, pathname: "/dev/outbox", devOutbox: true });
    expect(wrongHost.action).toBe("not_found");
  });

  it("unknown, reserved-unused and nested hosts fail closed; www redirects safe methods to the apex", () => {
    const hosts = ["bos.bukalaris.com", "berkah.bukalaris.com", "cname.bukalaris.com", "api.bukalaris.com", "a.b.bukalaris.com", "evil.com", "unknown.affiliate.bukalaris.com.evil.com", "a.b.affiliate.bukalaris.com"];
    for (const host of hosts) {
      expect(dispatchHostPath({ host, rootDomain: ROOT, pathname: "/" }).action, host).toBe("not_found");
    }
    expect(dispatchHostPath({ host: `www.${ROOT}`, rootDomain: ROOT, pathname: "/x", search: "?q=1", proto: "https" })).toMatchObject({
      action: "redirect",
      status: 308,
      location: `https://${ROOT}/x?q=1`,
    });
    expect(dispatchHostPath({ host: `www.${ROOT}`, rootDomain: ROOT, pathname: "/x", method: "POST" }).action).toBe("not_found");
    // probes still answer on an unknown host (no data)
    expect(dispatchHostPath({ host: "evil.com", rootDomain: ROOT, pathname: "/api/health" }).action).toBe("pass");
  });

  it("normalises case, port and trailing dot before matching", () => {
    expect(dispatchHostPath({ host: "OWNER.Bukalaris.COM.:443", rootDomain: ROOT, pathname: "/" })).toMatchObject({ action: "rewrite", pathname: "/admin" });
  });

  it("keeps local path mode on plain localhost and host mode on *.localhost", () => {
    expect(dispatchHostPath({ host: "localhost:3000", rootDomain: "localhost", pathname: "/seller" }).action).toBe("pass");
    expect(dispatchHostPath({ host: "localhost:3000", rootDomain: "localhost", pathname: "/s/toko-a" }).action).toBe("pass");
    expect(dispatchHostPath({ host: "toko-a.localhost:3000", rootDomain: "localhost", pathname: "/" })).toMatchObject({ action: "rewrite", pathname: "/s/toko-a", storeSlug: "toko-a" });
    expect(dispatchHostPath({ host: "app.localhost:3000", rootDomain: "localhost", pathname: "/" })).toMatchObject({ action: "rewrite", pathname: "/seller" });
    expect(dispatchHostPath({ host: "owner.localhost:3000", rootDomain: "localhost", pathname: "/admin" }).action).toBe("pass");
    expect(dispatchHostPath({ host: "toko-a.localhost:3000", rootDomain: "localhost", pathname: "/admin" }).action).toBe("not_found");
  });

  it("a custom domain resolves through the narrow resolver and fails closed on error or no match", () => {
    const hit = dispatchHostPath({ host: "tokoku.com", rootDomain: ROOT, pathname: "/", customDomainStore: (h) => (h === "tokoku.com" ? "toko-a" : null) });
    expect(hit).toMatchObject({ action: "rewrite", pathname: "/s/toko-a" });
    expect(dispatchHostPath({ host: "other.com", rootDomain: ROOT, pathname: "/", customDomainStore: () => null }).action).toBe("not_found");
    expect(
      dispatchHostPath({
        host: "tokoku.com",
        rootDomain: ROOT,
        pathname: "/",
        customDomainStore: () => {
          throw new Error("resolver down");
        },
      }).action,
    ).toBe("not_found");
    // Until T-15 there is no resolver: unknown host, never a default store.
    expect(dispatchHostPath({ host: "tokoku.com", rootDomain: ROOT, pathname: "/" }).action).toBe("not_found");
  });
});

// T-102 (ADR-0014 §1-3): two registrable domains. Platform surfaces on PLATFORM_ROOT_DOMAIN, storefronts on STORE_ROOT_DOMAIN.
const ROOTS = { platform: "bukalaris.com", store: "bukalaris.id" };
const two = (host: string, pathname = "/", method = "GET") => dispatchHostPath({ host, rootDomain: ROOTS, pathname, method, proto: "https", devOutbox: false });

describe("T-102 two root domains", () => {
  it("serves every platform surface on the platform root and storefronts on the store root", () => {
    expect(two("bukalaris.com")).toMatchObject({ action: "pass", surface: "apex" });
    expect(two("owner.bukalaris.com")).toMatchObject({ action: "rewrite", pathname: "/admin", surface: "owner" });
    expect(two("app.bukalaris.com")).toMatchObject({ action: "rewrite", pathname: "/seller", surface: "seller" });
    expect(two("checkout.bukalaris.com", "/checkout")).toMatchObject({ action: "pass", surface: "checkout" });
    expect(two("affiliate.bukalaris.com")).toMatchObject({ action: "rewrite", pathname: "/affiliate" });
    expect(two("buyer.bukalaris.com")).toMatchObject({ action: "rewrite", pathname: "/buyer" });
    expect(two("logs.bukalaris.com")).toMatchObject({ action: "rewrite", pathname: "/updates", noCookies: true });
    expect(two("sari.affiliate.bukalaris.com")).toMatchObject({ action: "rewrite", pathname: "/a/sari" });
    expect(two("toko-a.bukalaris.id")).toMatchObject({ action: "rewrite", pathname: "/s/toko-a", storeSlug: "toko-a" });
    expect(two("TOKO-A.Bukalaris.ID.:443", "/cart")).toMatchObject({ action: "rewrite", pathname: "/s/toko-a/cart" });
    // The seller host still sends order-status links to the checkout host of the platform root.
    expect(two("app.bukalaris.com", "/o/1.2.abc")).toMatchObject({ action: "redirect", location: "https://checkout.bukalaris.com/o/1.2.abc" });
  });

  it("a platform or reserved label on the store root fails closed", () => {
    for (const label of RESERVED_HOST_LABEL_LIST.filter((l) => l !== "www")) {
      expect(resolveHostSurface(`${label}.bukalaris.id`, ROOTS), label).toEqual({ kind: "reserved_unused", label });
      expect(two(`${label}.bukalaris.id`).action, label).toBe("not_found");
      expect(two(`${label}.bukalaris.id`, "/api/auth/sign-in/email", "POST").action, label).toBe("not_found");
    }
    expect(two("owner.bukalaris.id", "/admin").action).toBe("not_found");
    expect(two("app.bukalaris.id", "/seller").action).toBe("not_found");
    expect(two("checkout.bukalaris.id", "/checkout").action).toBe("not_found");
  });

  it("cname on the store root is never a store", () => {
    expect(resolveHostSurface("cname.bukalaris.id", ROOTS)).toEqual({ kind: "reserved_unused", label: "cname" });
    for (const path of ["/", "/cart", "/products/kaos", "/s/cname"]) expect(two("cname.bukalaris.id", path).action, path).toBe("not_found");
    expect(two("cname.bukalaris.id", "/api/signals", "POST").action).toBe("not_found");
  });

  it("a store slug on the platform root fails closed", () => {
    for (const host of ["toko-a.bukalaris.com", "TOKO-A.bukalaris.com:443"]) {
      expect(resolveHostSurface(host, ROOTS), host).toEqual({ kind: "unknown" });
      for (const path of ["/", "/cart", "/s/toko-a"]) expect(two(host, path).action, `${host}${path}`).toBe("not_found");
    }
    expect(two("toko-a.bukalaris.com", "/api/signals", "POST").action).toBe("not_found");
    // Reserved, nested and foreign hosts stay closed too; the probes still answer without data.
    for (const host of ["cname.bukalaris.com", "api.bukalaris.com", "a.b.bukalaris.com", "a.b.bukalaris.id", "sari.affiliate.bukalaris.id", "bukalaris.id.evil.com", "evilbukalaris.id"]) {
      expect(two(host).action, host).toBe("not_found");
    }
    expect(two("toko-a.bukalaris.com", "/api/health").action).toBe("pass");
  });

  it("the store-root apex and www redirect safe methods to the platform apex; other methods get 404", () => {
    for (const host of ["bukalaris.id", "www.bukalaris.id"]) {
      expect(resolveHostSurface(host, ROOTS), host).toEqual({ kind: "store_apex" });
      for (const method of ["GET", "HEAD"]) {
        expect(dispatchHostPath({ host, rootDomain: ROOTS, pathname: "/x", search: "?q=1", method, proto: "https" }), `${method} ${host}`).toEqual({
          action: "redirect",
          status: 308,
          location: "https://bukalaris.com/x?q=1",
          surface: "store_apex",
        });
      }
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) expect(two(host, "/api/auth/sign-in/email", method).action, `${method} ${host}`).toBe("not_found");
    }
    // The platform www keeps redirecting to the platform apex; the local port is kept.
    expect(two("www.bukalaris.com", "/x")).toMatchObject({ action: "redirect", location: "https://bukalaris.com/x", surface: "www" });
    expect(dispatchHostPath({ host: "store.localhost:3104", rootDomain: { platform: "platform.localhost", store: "store.localhost" }, pathname: "/x", proto: "http" })).toMatchObject({
      action: "redirect",
      location: "http://platform.localhost:3104/x",
    });
  });

  it("Object prototype member names are never a surface label on either root, one root or two", () => {
    // Host names are lower-cased first, so only lower-case member names can reach the lookup (`tostring` is an ordinary slug).
    for (const label of ["constructor", "__proto__"]) {
      for (const [host, roots] of [[`${label}.bukalaris.com`, ROOTS], [`${label}.bukalaris.id`, ROOTS], [`${label}.bukalaris.com`, "bukalaris.com"], [`${label}.localhost:3000`, "localhost"]] as const) {
        const d = dispatchHostPath({ host, rootDomain: roots, pathname: "/" });
        expect(d, `${host} ${JSON.stringify(roots)}`).toBeDefined();
        expect(d.action, `${host} ${JSON.stringify(roots)}`).toBe("not_found");
      }
    }
  });

  it("redirectOriginForHost names an origin only for redirect-only hosts", () => {
    expect(redirectOriginForHost("www.bukalaris.com", ROOTS, "https")).toBe("https://bukalaris.com");
    expect(redirectOriginForHost("bukalaris.id", ROOTS, "https")).toBe("https://bukalaris.com");
    expect(redirectOriginForHost("www.localhost:3103", "localhost", "http")).toBe("http://localhost:3103");
    for (const host of ["bukalaris.com", "toko-a.bukalaris.id", "owner.bukalaris.com", "cname.bukalaris.id", "www.bukalaris.id.evil.com", "www.localhost:3103/x", null]) {
      expect(redirectOriginForHost(host, ROOTS, "https"), String(host)).toBeNull();
    }
  });

  it("one root stays valid: an unset platform root falls back to the store root, the store root to localhost", () => {
    expect(hostRootsFromEnv({} as NodeJS.ProcessEnv)).toEqual({ platform: "localhost", store: "localhost" });
    expect(hostRootsFromEnv({ STORE_ROOT_DOMAIN: "bukalaris.com" } as NodeJS.ProcessEnv)).toEqual({ platform: "bukalaris.com", store: "bukalaris.com" });
    // The store root never borrows the platform root: storeBaseUrl (feeds, referral redirects) reads STORE_ROOT_DOMAIN as well.
    expect(hostRootsFromEnv({ PLATFORM_ROOT_DOMAIN: "bukalaris.com" } as NodeJS.ProcessEnv)).toEqual({ platform: "bukalaris.com", store: "localhost" });
    expect(hostRootsFromEnv({ PLATFORM_ROOT_DOMAIN: "Bukalaris.com.", STORE_ROOT_DOMAIN: "BUKALARIS.id" } as NodeJS.ProcessEnv)).toEqual(ROOTS);
    // The same roots as one string behave exactly like the T-70 one-root table.
    const one = { platform: "bukalaris.com", store: "bukalaris.com" };
    for (const host of ["bukalaris.com", "owner.bukalaris.com", "toko-a.bukalaris.com", "www.bukalaris.com", "cname.bukalaris.com", "a.b.bukalaris.com", "evil.com"]) {
      expect(resolveHostSurface(host, one), host).toEqual(resolveHostSurface(host, "bukalaris.com"));
    }
    expect(two("localhost:3000", "/seller").action).toBe("not_found");
    expect(dispatchHostPath({ host: "localhost:3000", rootDomain: { platform: "localhost", store: "localhost" }, pathname: "/seller" }).action).toBe("pass");
  });
});

describe("T-70 reserved labels", () => {
  it("every reserved label is refused as a host-derived store slug and as a store slug at creation", async () => {
    for (const label of RESERVED_HOST_LABEL_LIST) {
      expect(isReservedHostLabel(label), label).toBe(true);
      expect(slugFromHost(`${label}.${ROOT}`, ROOT), label).toBeNull();
      expect(storeCreateInput.safeParse({ slug: label, name: "X", ownerEmail: "a@b.co" }).success, label).toBe(false);
    }
    expect(RESERVED_HOST_LABEL_LIST).toEqual(expect.arrayContaining(["owner", "app", "checkout", "affiliate", "buyer", "logs", "cname", "berkah", "bos"]));
    expect(slugFromHost(`toko-a.${ROOT}`, ROOT)).toBe("toko-a");
  });
  it("the platform refuses a reserved store slug in createStore", async () => {
    const op = await makeOperator();
    await expect(createStore(op, { slug: "owner", name: "X", ownerUserId: op.userId })).rejects.toMatchObject({ code: "slug_reserved" });
    await expect(createStore(op, { slug: "Bos", name: "X", ownerUserId: op.userId })).rejects.toMatchObject({ code: "slug_reserved" });
    expect(await platform.select().from(store).where(inArray(store.slug, ["owner", "bos"]))).toEqual([]);
  });

});

describe("T-70 per-surface origins and cookies", () => {
  it("each link type uses its own surface origin, never one shared auth URL", () => {
    const env = {
      PLATFORM_ORIGIN: "https://bukalaris.com",
      OWNER_ORIGIN: "https://owner.bukalaris.com",
      APP_ORIGIN: "https://app.bukalaris.com",
      CHECKOUT_ORIGIN: "https://checkout.bukalaris.com/",
      BETTER_AUTH_URL: "https://legacy.example",
      STORE_ROOT_DOMAIN: "bukalaris.com",
    } as NodeJS.ProcessEnv;
    const o = surfaceOriginsFromEnv(env);
    expect(o).toMatchObject({ platformOrigin: "https://bukalaris.com", ownerOrigin: "https://owner.bukalaris.com", appOrigin: "https://app.bukalaris.com", checkoutOrigin: "https://checkout.bukalaris.com" });
    expect(storeBaseUrl("toko-a", env)).toBe("https://toko-a.bukalaris.com");
  });

  it("uses __Host- cookie names in production and plain names in development", () => {
    expect(surfaceCookieNames(true)).toMatchObject({
      ownerSession: "__Host-bl_owner",
      sellerSession: "__Host-bl_seller",
      sellerStore: "__Host-bl_store",
      affiliateSession: "__Host-bl_aff",
      buyerSession: "__Host-bl_buyer",
      orderCart: "__Host-bl_order_cart",
      referralClick: "__Host-bl_click",
    });
    expect(surfaceCookieNames(true).storeCart(7)).toBe("__Host-bl_cart_7");
    expect(surfaceCookieNames(false).ownerSession).toBe("bl_owner");
  });
});

// T-103 (ADR-0014 decisions 5 and 7, C-D1): the buyer paths on the store host, and the one link-origin function.
describe("T-103 checkout on the store host", () => {
  const roots = { platform: "bukalaris.com", store: "bukalaris.id" };
  const at = (host: string, pathname: string, method = "GET") => dispatchHostPath({ host, rootDomain: roots, pathname, method, proto: "https" });

  it("the store host serves checkout, confirmation, recovery, order status and its referral route, naming its own store for the gate", () => {
    for (const [path, method] of [["/checkout", "GET"], ["/checkout", "POST"], ["/checkout/confirmation", "GET"], ["/checkout/r/v1.x", "GET"], ["/checkout/h/invalid", "GET"], ["/o/1.2.abc", "GET"], ["/o/1.2.abc", "POST"], ["/r/tok", "GET"]] as const) {
      expect(at("toko-a.bukalaris.id", path, method), `${method} ${path}`).toEqual({ action: "pass", surface: "store", storeSlug: "toko-a" });
    }
  });

  it("the store host refuses the PR-16 hand-off, feeds, unsafe referral methods and every seller, operator, auth and Storefront API path", () => {
    for (const [path, method] of [
      ["/checkout/h/abc", "GET"],
      ["/checkout/h", "GET"],
      ["/feeds/blfd_x/meta.csv", "GET"],
      ["/r/tok", "POST"],
      ["/r/tok", "HEAD"],
      ["/seller", "GET"],
      ["/admin", "GET"],
      ["/login", "GET"],
      ["/account/security", "GET"],
      ["/invite/abc", "GET"],
      ["/api/auth/sign-in/email", "POST"],
      ["/api/storefront/v1/products", "GET"],
      ["/dev/outbox", "GET"],
    ] as const) {
      expect(at("toko-a.bukalaris.id", path, method).action, `${method} ${path}`).toBe("not_found");
    }
  });

  it("the checkout host keeps the hand-off and its own paths; a store slug on the platform root still serves nothing", () => {
    for (const path of ["/checkout", "/checkout/h/abc", "/checkout/confirmation", "/o/1.2.abc"]) expect(at("checkout.bukalaris.com", path).action, path).toBe("pass");
    for (const path of ["/checkout", "/o/1.2.abc", "/r/tok"]) expect(at("toko-a.bukalaris.com", path).action, path).toBe("not_found");
  });

  it("a request already naming a store path is never re-targeted to another store by the store host", () => {
    expect(at("toko-a.bukalaris.id", "/s/toko-b/checkout").action).toBe("not_found");
  });
});

describe("T-103 link-origin unit table (storeLinks)", () => {
  const custom = (slug: string) => (slug === "toko-a" ? "Shop.Example.COM." : null);
  const rows: { name: string; env: NodeJS.ProcessEnv; primaryDomain?: (slug: string) => string | null; origin: string; storefront: string }[] = [
    { name: "two roots, no custom domain", env: { PLATFORM_ROOT_DOMAIN: "bukalaris.com", STORE_ROOT_DOMAIN: "bukalaris.id", PLATFORM_ORIGIN: "https://bukalaris.com" }, origin: "https://toko-a.bukalaris.id", storefront: "https://toko-a.bukalaris.id" },
    { name: "two roots, verified primary custom domain", env: { PLATFORM_ROOT_DOMAIN: "bukalaris.com", STORE_ROOT_DOMAIN: "bukalaris.id" }, primaryDomain: custom, origin: "https://shop.example.com", storefront: "https://shop.example.com" },
    { name: "resolver knows no domain for this store", env: { STORE_ROOT_DOMAIN: "bukalaris.id" }, primaryDomain: () => null, origin: "https://toko-a.bukalaris.id", storefront: "https://toko-a.bukalaris.id" },
    { name: "one root (pre-T-102 layout)", env: { STORE_ROOT_DOMAIN: "bukalaris.com", BETTER_AUTH_URL: "https://app.bukalaris.com" }, origin: "https://toko-a.bukalaris.com", storefront: "https://toko-a.bukalaris.com" },
    { name: "local two roots keep the platform origin's scheme and port", env: { PLATFORM_ROOT_DOMAIN: "platform.localhost", STORE_ROOT_DOMAIN: "store.localhost", PLATFORM_ORIGIN: "http://platform.localhost:3404" }, origin: "http://toko-a.store.localhost:3404", storefront: "http://toko-a.store.localhost:3404" },
    { name: "one-host path mode on localhost", env: { STORE_ROOT_DOMAIN: "localhost", BETTER_AUTH_URL: "http://localhost:3280/" }, origin: "http://localhost:3280", storefront: "http://localhost:3280/s/toko-a" },
    { name: "nothing configured", env: {}, origin: "http://localhost:3000", storefront: "http://localhost:3000/s/toko-a" },
  ];
  for (const r of rows) {
    it(r.name, () => {
      expect(storeLinks("toko-a", { env: r.env, primaryDomain: r.primaryDomain })).toEqual({ origin: r.origin, storefront: r.storefront });
      // Feeds and referral redirects use the same function (storefront base).
      if (!r.primaryDomain) expect(storeBaseUrl("toko-a", r.env)).toBe(r.storefront);
    });
  }

  it("never reads a request host: the same configuration gives the same links whatever host the caller was reached on", () => {
    const env = { PLATFORM_ROOT_DOMAIN: "bukalaris.com", STORE_ROOT_DOMAIN: "bukalaris.id", APP_ORIGIN: "https://app.bukalaris.com", CHECKOUT_ORIGIN: "https://checkout.bukalaris.com" };
    const links = storeLinks("toko-a", { env });
    expect(links.origin).not.toContain("app.");
    expect(links.origin).not.toContain("checkout.");
    expect(storeLinks.length).toBe(1); // (slug, opts): no request or host parameter
  });
});
