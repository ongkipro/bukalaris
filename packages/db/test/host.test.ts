import { inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  dispatchHostPath,
  isReservedHostLabel,
  RESERVED_HOST_LABEL_LIST,
  slugFromHost,
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
  ["/o/1.2.abc", "GET", ["404", "404", `308 https://checkout.${ROOT}/o/1.2.abc`, "pass", "404", "404", "404", "404", "404"]],
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
  ["/checkout", "GET", ["404", "404", "404", "pass", "404", "404", "404", "404", "404"]],
  ["/checkout/confirmation", "GET", ["404", "404", "404", "pass", "404", "404", "404", "404", "404"]],
  ["/checkout/h/abc", "GET", ["404", "404", "404", "pass", "404", "404", "404", "404", "404"]],
  ["/r/token", "GET", ["pass", "404", "404", "404", "404", "404", "404", "404", "404"]],
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
