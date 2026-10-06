import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { THIRD_PARTY } from "../src/lib/security-headers";
import { login } from "./helpers";

// T-29 / SEC-14: every HTML surface carries the same security headers; the CSP is nonce based
// (fresh 128-bit nonce per response) and the pages still run without a single CSP violation.
const NONCE = "'nonce-[A-Za-z0-9+/]{22}=='";
// Pixel destinations (T-38) are the only third-party hosts; the lists are the single source in lib/security-headers.ts.
const hosts = (l: string[]) => l.map((h) => h.replace(/[.]/g, "\\.")).join(" ");
const CSP = new RegExp(
  `^default-src 'self'; script-src 'self' ${hosts(THIRD_PARTY.script)} ${NONCE} 'strict-dynamic'; style-src 'self' ${NONCE}; img-src 'self' ${hosts(THIRD_PARTY.img)}; connect-src 'self' ${hosts(THIRD_PARTY.connect)}; ` +
    `font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; frame-src ${hosts(THIRD_PARTY.frame)}$`,
);
const STATIC = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "x-frame-options": "DENY",
};

function expectHtmlHeaders(h: Record<string, string>, label: string) {
  expect(h, label).toMatchObject(STATIC);
  expect(h["content-security-policy"], label).toMatch(CSP);
  expect(h["x-powered-by"], label).toBeUndefined();
  // Plain http in e2e and ENABLE_HSTS unset: no HSTS leaks onto a non-TLS origin.
  expect(h["strict-transport-security"], label).toBeUndefined();
  expect(h["x-request-id"], label).toMatch(/^[0-9a-f-]{36}$/);
}

/** Collects CSP violations two ways: Chromium's console error and the DOM event. */
async function watchCsp(page: Page) {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const w = window as unknown as { __csp: string[] };
      (w.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return {
    async all() {
      const dom = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
      return [...violations, ...dom];
    },
  };
}

/** Smallest valid 1x1 RGB PNG (the upload path sniffs the header). */
function png1x1(): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => ~b.reduce((c, x) => table[(c ^ x) & 0xff]! ^ (c >>> 8), 0xffffffff) >>> 0;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, 20, 90, 160]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("public surfaces: login, storefront, checkout, admin redirect carry the headers and render without CSP violations", async ({ page, request }) => {
  const csp = await watchCsp(page);
  const seen: string[] = [];

  const loginRes = (await page.goto("/login"))!;
  expectHtmlHeaders(loginRes.headers(), "/login");
  await expect(page.getByRole("button", { name: "Masuk" })).toBeVisible();
  seen.push(loginRes.headers()["content-security-policy"]!);

  const storeRes = (await page.goto("/s/toko-a"))!;
  expectHtmlHeaders(storeRes.headers(), "/s/toko-a");
  await expect(page.getByRole("heading", { name: "Produk" })).toBeVisible();
  seen.push(storeRes.headers()["content-security-policy"]!);

  // A product page exercises the add-to-cart Server Action (connect-src/form-action 'self').
  await page.getByRole("link", { name: /Kaos Katun Basic/ }).click();
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(page.getByRole("heading", { name: "Keranjang" })).toBeVisible();

  const checkoutRes = (await page.goto("/checkout?store=toko-a"))!;
  expectHtmlHeaders(checkoutRes.headers(), "/checkout");
  await expect(page.getByRole("heading", { name: /Checkout · Toko Ayu/ })).toBeVisible();
  seen.push(checkoutRes.headers()["content-security-policy"]!);

  // Unauthenticated /admin redirects to login; the redirect response is protected too.
  const admin = await request.get("/admin", { maxRedirects: 0 });
  expect(admin.status()).toBe(307);
  expect(admin.headers()["location"]).toBe("/login?next=/admin");
  expectHtmlHeaders(admin.headers(), "/admin redirect");

  // 404 page (not-found boundary) is an HTML response as well.
  const nf = (await page.goto("/halaman-yang-tidak-ada"))!;
  expect(nf.status()).toBe(404);
  expectHtmlHeaders(nf.headers(), "/404");

  // JSON API: static headers, no CSP (no HTML), no X-Powered-By.
  const api = await request.get("/api/health");
  expect(api.headers()).toMatchObject(STATIC);
  expect(api.headers()["content-security-policy"]).toBeUndefined();
  expect(api.headers()["x-powered-by"]).toBeUndefined();

  // Static assets get nosniff as well (next.config headers, outside the proxy matcher).
  const asset = await request.get("/_next/static/does-not-exist.js");
  expect(asset.headers()["x-content-type-options"]).toBe("nosniff");

  // One nonce per response, never reused.
  expect(new Set(seen).size).toBe(seen.length);
  expect(await csp.all()).toEqual([]);
});

test("seller admin after login and a served product image", async ({ page }, info) => {
  const csp = await watchCsp(page);
  await login(page, "owner-a@bukalaris.local");
  const res = (await page.goto("/seller/products"))!;
  expectHtmlHeaders(res.headers(), "/seller/products");
  await expect(page.getByRole("heading", { name: "Produk" })).toBeVisible();

  // The HTML nonce matches the header nonce on every script that has one.
  const headerNonce = /'nonce-([^']+)'/.exec(res.headers()["content-security-policy"]!)![1];
  const nonces = await page.locator("script").evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).nonce).filter(Boolean));
  expect(nonces.length).toBeGreaterThan(0);
  expect(new Set(nonces)).toEqual(new Set([headerNonce]));

  // Upload a tiny image so the media route has something to serve, then read it from the storefront.
  // Totebag: content.spec owns the Kaos Katun Basic gallery (its cover logic assumes two images).
  await page.getByRole("link", { name: "Totebag Kanvas" }).click();
  await page.getByLabel("Berkas gambar").setInputFiles({ name: "px.png", mimeType: "image/png", buffer: png1x1() });
  await page.getByLabel("Teks alternatif", { exact: true }).fill(`Piksel ${info.project.name}`);
  await page.getByRole("button", { name: "Unggah gambar" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  const src = await page.getByTestId("product-images").getByRole("img", { name: `Piksel ${info.project.name}` }).getAttribute("src");
  const mediaId = /^\/seller\/products\/[0-9]+\/media\/([0-9]+)$/.exec(src ?? "")?.[1];
  expect(mediaId, `unexpected src ${src}`).toBeTruthy();

  // Seller-side and public media routes share imageResponse(): sandboxed CSP, nosniff, inline only.
  for (const url of [src!, `/s/toko-a/media/${mediaId}`]) {
    const media = await page.request.get(url);
    expect(media.status(), url).toBe(200);
    const h = media.headers();
    expect(h["content-type"], url).toBe("image/png");
    expect(h["x-content-type-options"], url).toBe("nosniff");
    expect(h["referrer-policy"], url).toBe("strict-origin-when-cross-origin");
    expect(h["x-frame-options"], url).toBe("DENY");
    expect(h["x-powered-by"], url).toBeUndefined();
    // The route's own policy replaces the page CSP for binary responses.
    expect(h["content-security-policy"], url).toBe("default-src 'none'; sandbox");
  }
  // Leave the product as found (other specs screenshot the storefront).
  page.once("dialog", (d) => d.accept()); // T-28: deleting an image asks for confirmation first
  await page.getByRole("button", { name: /Hapus gambar/ }).first().click();
  await expect(page.getByTestId("product-images").getByRole("img")).toHaveCount(0);
  expect(await csp.all()).toEqual([]);
});

test("ENABLE_HSTS=1 and TRUST_PROXY_REQUEST_ID=1 behind a TLS-terminating proxy", async ({ request }, info) => {
  test.skip(info.project.name !== "desktop", "server-level check; viewport-independent");
  const port = Number(process.env.E2E_PORT ?? 3100) + 2;
  const child = spawn("node", [".next/standalone/apps/web/server.js"], {
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", DATABASE_URL: process.env.E2E_DATABASE_URL!, ENABLE_HSTS: "1", TRUST_PROXY_REQUEST_ID: "1" },
    stdio: "ignore",
  });
  try {
    await expect.poll(async () => (await request.get(`http://127.0.0.1:${port}/api/health`).catch(() => null))?.status(), { timeout: 30_000 }).toBe(200);
    await hstsAndTrustedId(request, `http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
});

async function hstsAndTrustedId(request: APIRequestContext, origin: string) {
  // Over plain http even with the flag on: no HSTS (the flag alone never poisons a non-TLS host).
  const plain = await request.get(`${origin}/login`);
  expect(plain.headers()["strict-transport-security"]).toBeUndefined();
  expect(plain.headers()["content-security-policy"]).not.toContain("upgrade-insecure-requests");
  // What the reverse proxy forwards after TLS termination.
  const tls = await request.get(`${origin}/login`, { headers: { "x-forwarded-proto": "https", "x-request-id": "edge-0123456789" } });
  expect(tls.headers()["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  expect(tls.headers()["content-security-policy"]).toMatch(/; upgrade-insecure-requests$/);
  expect(tls.headers()["x-request-id"]).toBe("edge-0123456789");
  // Malformed ids are still replaced even when the proxy is trusted.
  const bad = await request.get(`${origin}/api/health`, { headers: { "x-request-id": "bad id!<script>" } });
  expect(bad.headers()["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
}
