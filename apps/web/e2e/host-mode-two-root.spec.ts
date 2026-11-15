import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { login } from "./helpers";

// T-102 (ADR-0014 §1-3, DOM-5): two root domains on one production build. Platform surfaces live on PLATFORM_ROOT_DOMAIN,
// native storefronts on STORE_ROOT_DOMAIN. Locally both are siblings under `localhost` (Chrome resolves *.localhost to
// loopback and treats it as a secure context, so the `__Host-` cookies of the production build work over http).
// This spec starts its own server: PORT + 1 and + 2 belong to ops.spec and security-headers.spec, + 3 to the one-root
// host-mode server of playwright.config.ts.
test.use({ trace: "off" });
const PORT = Number(process.env.E2E_PORT ?? 3100) + 4;
const PLATFORM = "platform.localhost";
const STORE = "store.localhost";
const host = (name: string) => `${name}:${PORT}`;
const origin = (name: string) => `http://${host(name)}`;

let server: ChildProcess | undefined;

test.beforeAll(async () => {
  server = spawn("node", [".next/standalone/apps/web/server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOSTNAME: "localhost",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --dns-result-order=ipv4first`.trim(),
      NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: process.env.E2E_APP_DATABASE_URL,
      PLATFORM_DATABASE_URL: process.env.E2E_PLATFORM_DATABASE_URL,
      MEDIA_DIR: resolve("var/e2e-media"),
      PLATFORM_ROOT_DOMAIN: PLATFORM,
      STORE_ROOT_DOMAIN: STORE,
      BETTER_AUTH_URL: origin(PLATFORM),
      PLATFORM_ORIGIN: origin(PLATFORM),
      OWNER_ORIGIN: origin(`owner.${PLATFORM}`),
      APP_ORIGIN: origin(`app.${PLATFORM}`),
      CHECKOUT_ORIGIN: origin(`checkout.${PLATFORM}`),
      AFFILIATE_ORIGIN: origin(`affiliate.${PLATFORM}`),
      BUYER_ORIGIN: origin(`buyer.${PLATFORM}`),
      LOGS_ORIGIN: origin(`logs.${PLATFORM}`),
    },
    stdio: "ignore",
  });
  const probe = await request.newContext();
  try {
    await expect.poll(async () => (await probe.get(`http://127.0.0.1:${PORT}/api/health`).catch(() => null))?.status(), { timeout: 60_000 }).toBe(200);
  } finally {
    await probe.dispose();
  }
});

test.afterAll(() => {
  server?.kill();
});

/** One request with an explicit Host header against the two-root server; status and Location only. */
async function at(name: string, path: string, method = "GET"): Promise<{ status: number; location?: string }> {
  const ctx: APIRequestContext = await request.newContext({ baseURL: `http://127.0.0.1:${PORT}`, extraHTTPHeaders: { host: host(name) } });
  try {
    const res = await ctx.fetch(path, { method, maxRedirects: 0, ...(method === "GET" || method === "HEAD" ? {} : { headers: { origin: origin(name) }, data: {} }) });
    return { status: res.status(), location: res.headers().location };
  } finally {
    await ctx.dispose();
  }
}

test("each surface answers only on its own root; a platform label on the store root and a store slug on the platform root fail closed", async () => {
  expect((await at(PLATFORM, "/")).status, "platform apex").toBe(200);
  expect((await at(`app.${PLATFORM}`, "/login")).status, "seller login on the platform root").toBe(200);
  expect((await at(`owner.${PLATFORM}`, "/admin")).location, "owner console on the platform root").toMatch(/\/login\?next=\/admin$/);
  expect((await at(`checkout.${PLATFORM}`, "/checkout")).status, "hosted checkout on the platform root").toBe(200);
  expect((await at(`toko-a.${STORE}`, "/")).status, "storefront on the store root").toBe(200);
  expect((await at(`toko-a.${STORE}`, "/s/toko-a/cart")).location, "path-mode prefix on the store host").toBe(`${origin(`toko-a.${STORE}`)}/cart`);

  for (const [name, path] of [
    [`owner.${STORE}`, "/admin"],
    [`app.${STORE}`, "/seller"],
    [`app.${STORE}`, "/login"],
    [`checkout.${STORE}`, "/checkout"],
    [`buyer.${STORE}`, "/"],
    [`cname.${STORE}`, "/"],
    [`cname.${STORE}`, "/cart"],
    [`toko-a.${PLATFORM}`, "/"],
    [`toko-a.${PLATFORM}`, "/cart"],
    [`toko-a.${PLATFORM}`, "/s/toko-a"],
    [`a.b.${STORE}`, "/"],
  ] as const) {
    const res = await at(name, path);
    expect(res.status, `${name}${path}`).toBe(404);
    expect(res.location, `${name}${path}`).toBeUndefined();
  }
  // The auth API is not routed on a store-root host that carries a platform label.
  for (const name of [`app.${STORE}`, `owner.${STORE}`]) expect((await at(name, "/api/auth/sign-in/email", "POST")).status, name).toBe(404);
});

test("the store-root apex and www redirect GET and HEAD to the platform apex and refuse every other method", async () => {
  for (const name of [STORE, `www.${STORE}`]) {
    for (const method of ["GET", "HEAD"]) {
      const res = await at(name, "/x?q=1", method);
      expect(res.status, `${method} ${name}`).toBe(308);
      expect(res.location, `${method} ${name}`).toBe(`${origin(PLATFORM)}/x?q=1`);
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await at(name, "/api/auth/sign-in/email", method);
      expect(res.status, `${method} ${name}`).toBe(404);
      expect(res.location, `${method} ${name}`).toBeUndefined();
    }
  }
  // The platform www still lands on the platform apex.
  expect((await at(`www.${PLATFORM}`, "/x")).location).toBe(`${origin(PLATFORM)}/x`);
  // A forged internal redirect header is overwritten by the proxy and cannot choose the target.
  const forged = await request.newContext({ baseURL: `http://127.0.0.1:${PORT}`, extraHTTPHeaders: { host: host(STORE), "x-bl-www-redirect": "https://attacker.invalid/x" } });
  try {
    for (const path of ["/x", "/api/internal/www-redirect"]) {
      const res = await forged.get(path, { maxRedirects: 0 });
      expect(res.headers().location ?? "", path).not.toContain("attacker.invalid");
    }
  } finally {
    await forged.dispose();
  }
});

for (const width of [320, 1280]) {
  test(`seller signs in on the platform root and a buyer adds to cart on the store root (${width}px)`, async ({ browser }) => {
    const seller = await browser.newContext({ baseURL: origin(`app.${PLATFORM}`), viewport: { width, height: 900 } });
    try {
      const page = await seller.newPage();
      // Seller sign-in (per-surface session cookie and CSRF origin of the platform root).
      await login(page, "owner-a@bukalaris.local");
      await expect(page.getByRole("heading", { name: "Produk", level: 1 })).toBeVisible();
      expect(new URL(page.url()).host).toBe(host(`app.${PLATFORM}`));
    } finally {
      await seller.close();
    }

    const buyer = await browser.newContext({ baseURL: origin(`toko-a.${STORE}`), viewport: { width, height: 900 } });
    try {
      const page = await buyer.newPage();
      // Hydrated add to cart on the store root: fails when the cart CSRF audience is built on the platform root (mutation 1 in the track report).
      await page.goto("/products/kaos-katun-basic");
      await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
      await expect(page.getByRole("heading", { name: "Keranjang", exact: true })).toBeVisible();
      await expect(page.getByRole("spinbutton", { name: /Jumlah/ })).toHaveValue("1");
      expect(new URL(page.url()).host).toBe(host(`toko-a.${STORE}`));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, "cart page reflows without horizontal scroll").toBeLessThanOrEqual(0);

      // A browser on the store-root apex ends on the platform apex.
      const response = await page.goto(`${origin(STORE)}/`);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(`${origin(PLATFORM)}/`);
    } finally {
      await buyer.close();
    }
  });
}
