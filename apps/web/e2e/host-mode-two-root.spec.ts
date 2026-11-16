import { expect, request, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import postgres from "postgres";
import { chooseDestination, evidence, login, testPhone } from "./helpers";

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

// ── T-103 (ADR-0014 decisions 5 and 7, C-D1): checkout on the store host ──────────────────────────────────────────────
const STORE_A = `toko-a.${STORE}`;
const STORE_B = `toko-b.${STORE}`;
const databaseUrl = process.env.E2E_DATABASE_URL ?? "";
const sqlClient = () => {
  if (!/_e2e\b/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
  return postgres(databaseUrl, { max: 1, onnotice: () => {} });
};
/** The signed `/o/<orderId>.<expiry>.<hmac>` token of T-36, signed here with the server's own secret (ORDER_LINK_SECRET, else BETTER_AUTH_SECRET). */
const orderToken = (orderId: number) => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const secret = process.env.ORDER_LINK_SECRET ?? process.env.BETTER_AUTH_SECRET ?? "";
  return `${orderId}.${exp}.${createHmac("sha256", secret).update(`order-link:${orderId}.${exp}`).digest("base64url")}`;
};
const cartCookieOf = async (ctx: BrowserContext) => (await ctx.cookies()).find((c) => /^(?:__Host-)?bl_cart_\d+$/.test(c.name));

async function addKaosToCart(page: Page) {
  await page.goto("/products/kaos-katun-basic");
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(page.getByRole("heading", { name: "Keranjang", exact: true })).toBeVisible();
}

for (const width of [320, 1280]) {
  test(`T-103 a buyer completes cart, checkout, confirmation and the signed order-status page on the store host (${width}px)`, async ({ browser }, info) => {
    const sql = sqlClient();
    const buyer = await browser.newContext({ baseURL: origin(STORE_A), viewport: { width, height: 900 } });
    try {
      const page = await buyer.newPage();
      await addKaosToCart(page);
      await page.getByRole("link", { name: "Checkout", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Checkout · Toko Ayu" })).toBeVisible();
      expect(new URL(page.url()).host, "checkout stays on the store host").toBe(host(STORE_A));
      await chooseDestination(page);
      await page.getByLabel("Nama", { exact: true }).fill("Budi Dua Domain");
      await page.getByLabel("Nomor HP").fill(testPhone());
      await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 103, Menteng, Jakarta");
      await evidence(page, info, `t103-two-root-${width}-checkout`);
      await page.getByRole("button", { name: "Buat pesanan" }).click();
      await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible({ timeout: 30_000 });
      expect(new URL(page.url()).host, "confirmation on the store host").toBe(host(STORE_A));
      await expect(page.getByTestId("return-link")).toHaveAttribute("href", "/");
      await evidence(page, info, `t103-two-root-${width}-confirmation`);
      const orderId = Number((await page.getByTestId("order-id").textContent())!.replace("#", ""));
      const [row] = await sql`select s.slug from "order" o join store s on s.id = o.store_id where o.id = ${orderId}`;
      expect(row?.slug, "the order belongs to the host's store").toBe("toko-a");

      // The signed order-status page on the same host, as the e-mail link builds it (storeLinks).
      const token = orderToken(orderId);
      await page.goto(`/o/${token}`);
      await expect(page.getByTestId("order-id")).toHaveText(`#${orderId}`);
      await expect(page.getByTestId("order-status")).toBeVisible();
      await evidence(page, info, `t103-two-root-${width}-order-status`);

      // Every Bukalaris cookie this buyer holds is host-only on the store host: no cart or order cookie on another Bukalaris host.
      // (Seller pixels enabled by earlier specs set their own third-party cookies, e.g. on .facebook.com; those are not ours.)
      const cookies = await buyer.cookies();
      expect(cookies.some((c) => /bl_order_cart$/.test(c.name)), "post-checkout cart cookie set").toBe(true);
      const ours = cookies.filter((c) => c.domain.endsWith("localhost") || /^(?:__Host-)?bl_/.test(c.name));
      expect(ours.filter((c) => c.domain !== STORE_A).map((c) => `${c.name}@${c.domain}`), "no Bukalaris cookie on another host").toEqual([]);

      // Own store only: the same valid link on a sibling store host is the invalid-link 404; the confirmation is not shown there either.
      const other = await browser.newContext({ baseURL: origin(STORE_B) });
      try {
        const p2 = await other.newPage();
        expect((await p2.goto(`/o/${token}`))?.status(), "another store's order link on a store host").toBe(404);
        await expect(p2.getByText("Budi Dua Domain")).toHaveCount(0);
        const order = cookies.find((c) => /bl_order_cart$/.test(c.name))!;
        await other.addCookies([{ ...order, domain: STORE_B }]);
        expect((await p2.goto(`/checkout/confirmation?order=${orderId}`))?.status(), "another store's confirmation on a store host").toBe(404);
        // `?store=` naming another store is refused, never served.
        await p2.goto("/checkout?store=toko-a");
        await expect(p2.getByRole("alert").filter({ hasText: "Toko tidak tersedia" })).toBeVisible();
        await expect(p2.getByText("Toko Ayu")).toHaveCount(0);
      } finally {
        await other.close();
      }
    } finally {
      await buyer.close();
      await sql.end();
    }
  });
}

test("T-103 the store host still refuses the hand-off, feeds, seller, operator, auth and Storefront API paths; feed links name the store host", async () => {
  for (const [path, method] of [
    [`/checkout/h/${"a".repeat(43)}`, "GET"],
    ["/feeds/blfd_x/meta.csv", "GET"],
    ["/seller", "GET"],
    ["/admin", "GET"],
    ["/login", "GET"],
    ["/account/security", "GET"],
    ["/api/auth/sign-in/email", "POST"],
    ["/api/storefront/v1/products", "GET"],
    ["/r/anything", "POST"],
  ] as const) {
    expect((await at(STORE_A, path, method)).status, `${method} ${path}`).toBe(404);
  }
  // A feed is fetched on the Seller Admin host; its item links must name the store host, never the host it was fetched on.
  const sql = sqlClient();
  try {
    const token = `blfd_${randomBytes(6).toString("base64url")}_${randomBytes(32).toString("base64url")}`;
    const [s] = await sql`select id from store where slug = 'toko-a'`;
    // A media row is all a feed item needs (only its URL is published); removed again below.
    const [p] = await sql`select id from product where store_id = ${s!.id} and status = 'active' order by id limit 1`;
    const [m] = await sql`insert into media (store_id, product_id, position, alt, mime, width, height, bytes) values (${s!.id}, ${p!.id}, 99, '', 'image/jpeg', 800, 800, 1000) returning id`;
    await sql`update feed_token set status = 'revoked', revoked_at = now() where store_id = ${s!.id} and status = 'active'`;
    await sql`insert into feed_token (store_id, token_prefix, token_hash, created_by) values (${s!.id}, ${token.slice(5, 13)}, ${createHash("sha256").update(token).digest("hex")}, 't103-e2e')`;
    const ctx = await request.newContext({ baseURL: `http://127.0.0.1:${PORT}`, extraHTTPHeaders: { host: host(`app.${PLATFORM}`) } });
    try {
      const res = await ctx.get(`/feeds/${token}/google.xml`);
      expect(res.status()).toBe(200);
      const xml = await res.text();
      const links = [...xml.matchAll(/<g:link>([^<]+)<\/g:link>/g)].map((m) => m[1]!);
      expect(links.length, "the seed has products with a cover image").toBeGreaterThan(0);
      for (const link of links) expect(link.startsWith(`${origin(STORE_A)}/products/`), link).toBe(true);
      expect(xml).not.toContain(`app.${PLATFORM}`);
    } finally {
      await ctx.dispose();
      await sql`update feed_token set status = 'revoked', revoked_at = now() where token_hash = ${createHash("sha256").update(token).digest("hex")}`;
      await sql`delete from media where id = ${m!.id}`;
    }
  } finally {
    await sql.end();
  }
});

test("T-103 the checkout host serves the one-use hand-off of PR-16 and refuses a cart that was not handed off", async ({ browser }) => {
  const sql = sqlClient();
  const store = await browser.newContext({ baseURL: origin(STORE_A) });
  const checkout = await browser.newContext({ baseURL: origin(`checkout.${PLATFORM}`) });
  try {
    await addKaosToCart(await store.newPage());
    const cart = (await cartCookieOf(store))!;
    expect(Boolean(cart), "store-host cart exists").toBe(true);
    // A cart cookie copied onto the checkout host by hand is not a hand-off: the cart is not read there.
    await checkout.addCookies([{ ...cart, domain: `checkout.${PLATFORM}` }]);
    const c = await checkout.newPage();
    await c.goto("/checkout?store=toko-a");
    await expect(c.getByText("Keranjang kosong atau sudah di-checkout.")).toBeVisible();
    await expect(c.getByRole("button", { name: "Buat pesanan" })).toHaveCount(0);
    // A recovery link is redeemed on the store host only.
    expect((await at(`checkout.${PLATFORM}`, "/checkout/r/v1.x.1.y.2.z")).location).toBe("/checkout/h/invalid");

    // A real hand-off of that cart through a live channel (rows as the Storefront API writes them).
    const [s] = await sql`select id from store where slug = 'toko-a'`;
    const [ch] = await sql`insert into storefront_channel (store_id, name, origin, return_path, token_prefix, token_hash, created_by)
      values (${s!.id}, 'T-103 headless', 'https://headless.example', '/thanks', ${randomBytes(6).toString("base64url")}, ${randomBytes(32).toString("hex")}, 't103-e2e') returning id`;
    const code = randomBytes(32).toString("base64url");
    await sql`insert into checkout_handoff (store_id, cart_id, channel_id, code_hash, expires_at)
      values (${s!.id}, ${cart.value}::uuid, ${ch!.id}, ${createHash("sha256").update(code).digest("hex")}, now() + interval '5 minutes')`;
    expect((await at(STORE_A, `/checkout/h/${code}`)).status, "the hand-off is not served on the store host").toBe(404);
    await c.goto(`/checkout/h/${code}`);
    await expect(c).toHaveURL(`${origin(`checkout.${PLATFORM}`)}/checkout?store=toko-a`);
    await expect(c.getByRole("heading", { name: "Checkout · Toko Ayu" })).toBeVisible();
    await expect(c.getByTestId("subtotal")).toBeVisible();
    await sql`update storefront_channel set status = 'revoked', revoked_at = now() where id = ${ch!.id}`;
  } finally {
    await checkout.close();
    await store.close();
    await sql.end();
  }
});

test("T-103 C-D1 the store host serves the referral click route for its own store only", async ({ browser }) => {
  const sql = sqlClient();
  const buyer = await browser.newContext({ baseURL: origin(STORE_A) });
  try {
    const [sa] = await sql`select id from store where slug = 'toko-a'`;
    const [sb] = await sql`select id from store where slug = 'toko-b'`;
    const [prev] = await sql`select participation from affiliate_seller_policy where store_id = ${sa!.id}`;
    await sql`insert into affiliate_seller_policy (store_id, participation, default_rate_bps, updated_by) values (${sa!.id}, 'open', 1000, 't103-e2e') on conflict (store_id) do update set participation = 'open'`;
    const userId = `t103-${randomBytes(6).toString("hex")}`;
    await sql`insert into "user" (id, name, email, email_verified) values (${userId}, 'Afiliasi T103', ${`${userId}@example.com`}, true)`;
    const [a] = await sql`insert into affiliate (user_id, display_name, contact_phone) values (${userId}, 'Afiliasi T103', ${`62${testPhone().replace(/^\+?(62|0)/, "")}`}) returning id`;
    await sql`update affiliate set status = 'active' where id = ${a!.id}`;
    const tokenA = `tokt103a${randomBytes(9).toString("hex")}`;
    const tokenB = `tokt103b${randomBytes(9).toString("hex")}`;
    await sql`insert into affiliate_link (affiliate_id, token, store_id) values (${a!.id}, ${tokenA}, ${sa!.id}), (${a!.id}, ${tokenB}, ${sb!.id})`;
    const clicks = async (token: string) => Number((await sql`select count(*)::int as n from affiliate_click where link_id = (select id from affiliate_link where token = ${token})`)[0]!.n);
    try {
      const page = await buyer.newPage();
      // Another store's link on this store host: the unknown-link 404, no click, no cookie.
      expect((await page.goto(`/r/${tokenB}`))?.status()).toBe(404);
      expect(await clicks(tokenB)).toBe(0);
      expect((await buyer.cookies()).some((c) => /bl_click$/.test(c.name))).toBe(false);
      // This store's link: a captured click, the host-only continuity cookie here, and the storefront of this host.
      await page.goto(`/r/${tokenA}`);
      await expect(page).toHaveURL(`${origin(STORE_A)}/`);
      expect(await clicks(tokenA)).toBe(1);
      const click = (await buyer.cookies()).find((c) => /bl_click$/.test(c.name));
      expect(click?.domain).toBe(STORE_A);
    } finally {
      if (prev) await sql`update affiliate_seller_policy set participation = ${prev.participation} where store_id = ${sa!.id}`;
      else await sql`delete from affiliate_seller_policy where store_id = ${sa!.id}`;
    }
  } finally {
    await buyer.close();
    await sql.end();
  }
});

// ── T-103 independent review (2026-11-16): findings 1 to 3 ──────────────────────────────────────────────────────────────
type Fields = [string, string][];
/** Runs service code of packages/db against the e2e database as the platform role (the pattern of t37.spec), for states only the ledger may write. */
function runDb(body: string): void {
  const script = `
    import { createDb } from "./src/client.ts";
    import { withStore } from "./src/platform/tenant.ts";
    import { recordPaymentInquiry } from "./src/payments/attempts.ts";
    import { applyProviderTransition } from "./src/seller/commerce/orders.ts";
    const db = createDb(process.env.E2E_PLATFORM_DATABASE_URL);
    const admin = createDb(process.env.E2E_DATABASE_URL);
    await (async () => { ${body} })();
    await db.$client.end();
    await admin.$client.end();
  `;
  execFileSync("node", ["--input-type=module", "-e", script], { cwd: resolve(process.cwd(), "../../packages/db"), env: process.env, stdio: ["ignore", "inherit", "inherit"] });
}
const formFields = (page: Page, button: string) =>
  page.locator("form", { has: page.getByRole("button", { name: button, exact: true }) }).evaluate((el) => Array.from(new FormData(el as HTMLFormElement).entries()).map(([k, v]) => [k, String(v)] as [string, string]));
/** A form post with an explicit Host (and a matching Origin) against the two-root server; status, Location and Set-Cookie only. */
async function postAs(name: string, path: string, fields: Fields, cookie = ""): Promise<{ status: number; location: string; setCookie: string }> {
  const ctx = await request.newContext({ baseURL: `http://127.0.0.1:${PORT}` });
  try {
    const res = await ctx.post(path, { headers: { host: host(name), origin: origin(name), ...(cookie ? { cookie } : {}) }, multipart: Object.fromEntries(fields), maxRedirects: 0 });
    return { status: res.status(), location: res.headers().location ?? "", setCookie: res.headers()["set-cookie"] ?? "" };
  } finally {
    await ctx.dispose();
  }
}
async function getAs(name: string, path: string): Promise<{ status: number; location: string; setCookie: string }> {
  const ctx = await request.newContext({ baseURL: `http://127.0.0.1:${PORT}`, extraHTTPHeaders: { host: host(name) } });
  try {
    const res = await ctx.get(path, { maxRedirects: 0 });
    return { status: res.status(), location: res.headers().location ?? "", setCookie: res.headers()["set-cookie"] ?? "" };
  } finally {
    await ctx.dispose();
  }
}

test("T-103 review 1 and 2b: a suspended store keeps its order-status page and refund form on its own host; another store's host refuses the page and the refund post", async ({ browser }) => {
  test.setTimeout(120_000);
  const sql = sqlClient();
  const buyer = await browser.newContext({ baseURL: origin(STORE_A) });
  const [sa] = await sql`select id from store where slug = 'toko-a'`;
  try {
    // A transfer order on the store host; the worker creates its payment attempt; a pending refund as the ledger writes it for a cancelled order.
    const page = await buyer.newPage();
    await addKaosToCart(page);
    await page.goto("/checkout?store=toko-a");
    await chooseDestination(page);
    await page.getByLabel("Nama", { exact: true }).fill("Budi Refund");
    await page.getByLabel("Nomor HP").fill(testPhone());
    await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 37, Menteng, Jakarta");
    await page.locator('input[name="paymentMethod"][value="manual_transfer"]').check();
    await page.locator('input[name="paymentChannel"]').first().check();
    await page.getByRole("button", { name: "Buat pesanan" }).click();
    await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible({ timeout: 30_000 });
    const orderId = Number((await page.getByTestId("order-id").textContent())!.replace("#", ""));
    await expect.poll(async () => (await sql`select request_state from payment_attempt where order_id = ${orderId}`)[0]?.request_state, { timeout: 30_000 }).toBe("accepted");
    // Paid through the fake provider's status check, then cancelled by the provider: the ledger opens the refund (as in t37.spec).
    runDb(`
      const [a] = await admin.$client.unsafe("select id, store_id, total_idr from payment_attempt where order_id = ${orderId}");
      await recordPaymentInquiry({ exec: db, storeId: Number(a.store_id) }, a.id, { rc: "00", ket: "Sukses", data: { status: "PAID", amount: Number(a.total_idr) } }, { source: "reconcile", mode: "fake" });
      await withStore(db, Number(a.store_id), (tx) => applyProviderTransition(tx, Number(a.store_id), ${orderId}, "cancelled", { source: "provider", note: "t103-e2e" }));
    `);
    expect((await sql`select status from refund where order_id = ${orderId}`)[0]?.status, "the ledger opened a pending refund").toBe("pending");
    const destination = async () => (await sql`select destination_account from refund where order_id = ${orderId}`)[0]!.destination_account as string | null;
    const token = orderToken(orderId);

    await sql`update store set status = 'suspended' where id = ${sa!.id}`;
    // Own host of the suspended store: the page and its refund form are served.
    await page.goto(`/o/${token}`);
    await expect(page.getByTestId("order-id")).toHaveText(`#${orderId}`);
    const form = page.getByRole("form", { name: "Rekening tujuan refund" });
    await expect(form).toBeVisible();
    const fields: Fields = (await formFields(page, "Simpan rekening refund")).map(([k, v]) => [k, k === "account" ? "5555666677" : k === "holder" ? "Budi Asing" : v]);
    // Another store's host: the page is the invalid-link 404 and the bound refund action stores nothing.
    expect((await getAs(STORE_B, `/o/${token}`)).status, "order link on another store's host").toBe(404);
    const foreign = await postAs(STORE_B, `/o/${token}`, fields);
    console.info(JSON.stringify({ case: "refund post on another store host", status: foreign.status }));
    expect(await destination(), "refund post on another store's host stores nothing").toBeNull();
    // The buyer on the suspended store's own host saves the destination.
    await form.getByLabel("Nomor rekening").fill("9876543210");
    await form.getByLabel("Nama pemilik rekening").fill("Budi Refund");
    await form.getByRole("button", { name: "Simpan rekening refund" }).click();
    await expect(page.getByText("Rekening refund tersimpan")).toBeVisible();
    expect(await destination(), "own host of a suspended store stores the destination").toBe("9876543210");
  } finally {
    await sql`update store set status = 'active' where id = ${sa!.id}`;
    await buyer.close();
    await sql.end();
  }
});

test("T-103 review 2a: a valid recovery link of another store is refused on a store host and on the checkout host, with no cart cookie", async () => {
  const sql = sqlClient();
  try {
    // A live abandoned-checkout session of toko-b with one line, and its validly signed resume token (KEYRING_CHECKOUT_RESUME of the e2e config).
    const [sb] = await sql`select id from store where slug = 'toko-b'`;
    const [cart] = await sql`insert into cart (store_id) values (${sb!.id}) returning id`;
    await sql`insert into cart_line (cart_id, store_id, variant_id, quantity) select ${cart!.id}, ${sb!.id}, v.id, 1 from variant v where v.store_id = ${sb!.id} order by v.id limit 1`;
    const [session] = await sql`insert into checkout_session (store_id, cart_id) values (${sb!.id}, ${cart!.id}) returning public_id`;
    const [keyId, keyB64] = (process.env.KEYRING_CHECKOUT_RESUME ?? "").split(",")[0]!.split(":") as [string, string];
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const mac = createHmac("sha256", Buffer.from(keyB64, "base64")).update(`checkout.resume.v1\0${keyId}\0${sb!.id}\0${session!.public_id}\0${exp}`).digest("base64url");
    const path = `/checkout/r/v1.${keyId}.${sb!.id}.${session!.public_id}.${exp}.${mac}`;
    // Positive control: the token is valid on its own store's host.
    const own = await getAs(STORE_B, path);
    expect(own.location, "own store host redeems the link").toBe("/checkout?store=toko-b");
    expect(own.setCookie, "own store host binds the cart").toMatch(/bl_cart_\d+=/);
    for (const name of [STORE_A, `checkout.${PLATFORM}`]) {
      const res = await getAs(name, path);
      expect(res.status, name).toBe(303);
      expect(res.location, name).toBe("/checkout/h/invalid");
      expect(res.setCookie, `${name}: no cart cookie`).not.toMatch(/bl_cart_/);
    }
  } finally {
    await sql.end();
  }
});

test("T-103 review 3: another store's cart id in this store's cart cookie is never checked out through this host", async ({ browser }) => {
  const sql = sqlClient();
  // No JavaScript: the rendered checkout form is replayed as a plain form post.
  const ctx = await browser.newContext({ baseURL: origin(STORE_A), javaScriptEnabled: false });
  const [sa] = await sql`select id from store where slug = 'toko-a'`;
  const [sb] = await sql`select id from store where slug = 'toko-b'`;
  // toko-b gets a pickup area for this test only, so an order for its cart would be possible if the host let it through.
  const hadPickup = (await sql`select 1 from store_pickup_area where store_id = ${sb!.id}`).length > 0;
  try {
    if (!hadPickup) await sql`insert into store_pickup_area (store_id, area_id, area_label, address_text, updated_by) select ${sb!.id}, area_id, area_label, address_text, 't103-e2e' from store_pickup_area where store_id = ${sa!.id}`;
    const [foreignCart] = await sql`insert into cart (store_id) values (${sb!.id}) returning id`;
    await sql`insert into cart_line (cart_id, store_id, variant_id, quantity) select ${foreignCart!.id}, ${sb!.id}, v.id, 1 from variant v where v.store_id = ${sb!.id} order by v.id limit 1`;
    const p = await ctx.newPage();
    await p.goto("/products/kaos-katun-basic");
    await p.getByRole("button", { name: "Tambah ke keranjang" }).click();
    await expect(p.getByRole("heading", { name: "Keranjang", exact: true })).toBeVisible();
    const own = (await cartCookieOf(ctx))!;
    await p.goto("/checkout?store=toko-a");
    await chooseDestination(p);
    await p.getByLabel("Nama", { exact: true }).fill("Budi Lintas Toko");
    await p.getByLabel("Nomor HP").fill(testPhone());
    await p.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 3, Menteng, Jakarta");
    const fields = await formFields(p, "Buat pesanan");
    const path = new URL(p.url()).pathname + new URL(p.url()).search;
    // A current store-A cart token for the forged cookie, as any store-A page renders it for that cookie.
    await ctx.addCookies([{ ...own, value: String(foreignCart!.id) }]);
    await p.goto("/products/kaos-katun-basic");
    const token = await p.locator('input[name="_csrf"]').first().inputValue();
    const forged: Fields = fields.map(([k, v]) => [k, k === "_csrf" ? token : v]);
    const res = await postAs(STORE_A, path, forged, `${own.name}=${foreignCart!.id}`);
    console.info(JSON.stringify({ case: "foreign cart through this host", status: res.status }));
    expect(res.location.includes("/checkout/confirmation"), "no confirmation").toBe(false);
    expect((await sql`select count(*)::int as n from "order" where cart_id = ${foreignCart!.id}::uuid`)[0]!.n, "no order for the other store's cart").toBe(0);
  } finally {
    if (!hadPickup) await sql`delete from store_pickup_area where store_id = ${sb!.id}`;
    await ctx.close();
    await sql.end();
  }
});
