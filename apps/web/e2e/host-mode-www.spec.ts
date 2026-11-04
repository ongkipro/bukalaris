import { expect, request, test } from "@playwright/test";

// This file shares the existing /host-mode/ project and isolated production server.
// Keep auth-bearing host-regression requests out of traces.
test.use({ trace: "off" });
const port = Number(process.env.E2E_PORT ?? 3100) + 3;
const apex = `http://localhost:${port}`;
const www = `http://www.localhost:${port}`;

for (const method of ["GET", "HEAD"]) {
  test(`WWW ${method} preserves the absolute canonical origin, path and query`, async () => {
    const context = await request.newContext({ baseURL: `http://127.0.0.1:${port}`, extraHTTPHeaders: { host: `www.localhost:${port}` } });
    try {
      const path = "/s/toko-a?campaign=www&return=%2Fs%2Ftoko-a&label=a%20b&plus=a%2Bb&tag=first&tag=second";
      const response = await context.fetch(path, { method, maxRedirects: 0 });
      expect(response.status()).toBe(308);
      // Default Next URLSearchParams normalization serializes spaces as +; preserve values, not the old opt-out encoding.
      const location = response.headers().location;
      expect(location).toBe(`${apex}/s/toko-a?campaign=www&return=%2Fs%2Ftoko-a&label=a+b&plus=a%2Bb&tag=first&tag=second`);
      expect([...new URL(location!).searchParams]).toEqual([...new URL(`${www}${path}`).searchParams]);
      if (method === "HEAD") expect(await response.body()).toHaveLength(0);
    } finally { await context.dispose(); }
  });
}

for (const javaScriptEnabled of [false, true]) {
  for (const width of [320, 390, 1280]) {
    test(`WWW browser navigation terminates at the canonical storefront (${width}px, JS ${javaScriptEnabled})`, async ({ browser }) => {
      const context = await browser.newContext({ javaScriptEnabled, viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        const path = "/s/toko-a?campaign=www";
        const response = await page.goto(`${www}${path}`);
        expect(response?.status()).toBe(200);
        await expect(page).toHaveURL(`${apex}${path}`);
        await expect(page.getByRole("heading", { name: "Produk", exact: true })).toBeVisible();
        const initial = response?.request().redirectedFrom();
        expect(initial?.url()).toBe(`${www}${path}`);
        const redirect = await initial?.response();
        expect(redirect?.status()).toBe(308);
        expect(redirect?.headers().location).toBe(`${apex}${path}`);
      } finally { await context.close(); }
    });
  }
}

test("WWW never redirects or routes unsafe auth requests", async () => {
  const context = await request.newContext({ baseURL: `http://127.0.0.1:${port}`, extraHTTPHeaders: { host: `www.localhost:${port}` } });
  try {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await context.fetch("/api/auth/sign-in/email", { method, maxRedirects: 0, headers: { origin: www }, data: {} });
      expect(response.status(), method).toBe(404);
      expect(response.headers().location, method).toBeUndefined();
      const authCookie = response.headersArray().some((header) => header.name.toLowerCase() === "set-cookie" && /^(?:__Host-bl_(?:owner|seller|aff|buyer)|better-auth\.session_token)=/.test(header.value));
      expect(authCookie, `${method}: no authentication cookie`).toBe(false);
    }
  } finally { await context.dispose(); }
});

test("raw Pages data paths do not bypass any exact-host surface gate", async () => {
  for (const host of ["owner", "app", "checkout", "affiliate", "buyer", "logs", "toko-a"]) {
    const context = await request.newContext({ baseURL: `http://127.0.0.1:${port}`, extraHTTPHeaders: { host: `${host}.localhost:${port}` } });
    try {
      const response = await context.get("/_next/data/not-a-build/seller.json", { maxRedirects: 0 });
      expect(response.status(), host).toBe(404);
    } finally { await context.dispose(); }
  }
});
