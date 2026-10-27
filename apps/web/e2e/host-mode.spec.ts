import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { setTimeout as sleep } from "node:timers/promises";
import { DEV_PASSWORD, login } from "./helpers";

// T-70 (ADR-0008 §3, DOM-5, DOM-6): exact-host dispatch and per-surface sessions against a real server whose
// per-surface origins are `<surface>.localhost:<port>` (second webServer in playwright.config.ts, same build).
// API probes connect to 127.0.0.1 and send the `Host` header themselves; browser steps use Chrome's native
// *.localhost resolution. Sessions are read off the Set-Cookie header, not a cookie jar, so the exact name,
// attributes and value are what is asserted.
// PORT + 1 and PORT + 2 belong to the servers that ops.spec and security-headers.spec start themselves.
const PORT = Number(process.env.E2E_PORT ?? 3100) + 3;
const SEED_USER = "owner-a@bukalaris.local";

/** `local` = plain localhost (one-host path mode); `*.example` = a foreign domain; anything else a label under localhost. */
const hostOf = (label: string) => (label === "local" ? `localhost:${PORT}` : label.endsWith(".example") ? `${label}:${PORT}` : `${label}.localhost:${PORT}`);
const originOf = (label: string) => `http://${hostOf(label)}`;
const SURFACES = ["local", "owner", "app", "affiliate", "buyer"] as const;
type Surface = (typeof SURFACES)[number];

async function api(label: string, headers: Record<string, string> = {}): Promise<APIRequestContext> {
  return request.newContext({ baseURL: `http://127.0.0.1:${PORT}`, extraHTTPHeaders: { host: hostOf(label), ...headers } });
}

/** Sign in on `label`'s host and return the session cookie exactly as the server set it. */
async function signIn(label: Surface): Promise<{ name: string; value: string; attrs: string }> {
  const ctx = await api(label);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await ctx.post("/api/auth/sign-in/email", { headers: { origin: originOf(label) }, data: { email: SEED_USER, password: DEV_PASSWORD } });
      if (res.status() === 429) {
        await sleep(11_000); // Better Auth production limit: 3 sign-ins / 10 s / IP
        continue;
      }
      expect(res.status(), `sign-in on ${label}`).toBe(200);
      const set = res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
      const session = set.find((c) => /^(__Host-bl_(owner|seller|aff|buyer)|better-auth\.session_token)=/.test(c));
      expect(session, `session cookie on ${label}: ${set.join(" | ")}`).toBeTruthy();
      const [pair, ...attrs] = session!.split(";");
      const eq = pair!.indexOf("=");
      return { name: pair!.slice(0, eq), value: pair!.slice(eq + 1), attrs: attrs.join(";").toLowerCase() };
    }
    throw new Error(`sign-in on ${label} kept being rate limited`);
  } finally {
    await ctx.dispose();
  }
}

async function sessionEmail(label: Surface, cookie: string): Promise<string | null> {
  const ctx = await api(label, { cookie });
  try {
    const res = await ctx.get("/api/auth/get-session");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { user?: { email: string } } | null;
    return body?.user?.email ?? null;
  } finally {
    await ctx.dispose();
  }
}

test.describe("exact-host dispatch (DOM-5) on a live server", () => {
  const status = async (label: string, path: string, method = "GET") => {
    const ctx = await api(label);
    try {
      const res = await ctx.fetch(path, { method, maxRedirects: 0, headers: method === "POST" ? { origin: originOf(label) } : {} });
      return { status: res.status(), location: res.headers().location ?? null, cookie: res.headers()["set-cookie"] ?? null };
    } finally {
      await ctx.dispose();
    }
  };

  test("each surface serves only its own paths; every other cell is a real 404", async () => {
    // [host, path, expected status]
    const cells: [string, string, number][] = [
      ["owner", "/seller", 404],
      ["owner", "/checkout", 404],
      ["owner", "/s/toko-a", 404],
      ["app", "/admin", 404],
      ["app", "/checkout", 404],
      ["app", "/s/toko-a", 404],
      ["checkout", "/admin", 404],
      ["checkout", "/seller", 404],
      ["checkout", "/login", 404],
      ["checkout", "/", 404],
      ["toko-a", "/admin", 404],
      ["toko-a", "/seller", 404],
      ["toko-a", "/checkout", 404],
      ["toko-a", "/api/storefront/v1/products", 404],
      ["bos", "/", 404],
      ["berkah", "/", 404],
      ["cname", "/", 404],
      ["nope.example", "/", 404],
      ["a.b", "/", 404],
    ];
    for (const [host, path, expected] of cells) {
      expect((await status(host, path)).status, `${host} ${path}`).toBe(expected);
    }
  });

  test("owner and seller hosts reach their own consoles, the store host serves /, local path mode is kept on plain localhost", async () => {
    expect((await status("owner", "/")).location).toMatch(/\/login\?next=\/admin$/);
    expect((await status("app", "/")).location).toMatch(/\/login\?next=\/seller$/);
    expect((await status("app", "/login")).status).toBe(200); // never resolved as the store `app`
    expect((await status("checkout", "/checkout")).status).toBe(200);
    expect((await status("toko-a", "/")).status).toBe(200);
    expect((await status("toko-a", "/s/toko-a/cart")).location).toBe(`${originOf("toko-a")}/cart`);
    expect((await status("local", "/s/toko-a")).status).toBe(200);
    expect((await status("app", "/o/1.2.abc")).location).toBe(`${originOf("checkout")}/o/1.2.abc`);
    expect((await status("www", "/x")).location).toBe(`http://localhost:${PORT}/x`); // www redirects safe methods to the same host without `www.`
  });

  test("the Update Log host is GET/HEAD only, sets no cookie, and answers only the probes under /api", async () => {
    const get = await status("logs", "/updates");
    expect(get.cookie).toBeNull();
    for (const method of ["POST", "PUT", "DELETE"]) expect((await status("logs", "/updates", method)).status, method).toBe(404);
    expect((await status("logs", "/checkout")).status).toBe(404);
    expect((await status("logs", "/api/storefront/v1/products")).status).toBe(404);
    const probe = await status("logs", "/api/health");
    expect(probe.status).toBe(200);
    expect(probe.cookie).toBeNull();
  });

  test("probes answer on every host, including unknown ones", async () => {
    for (const host of ["owner", "app", "checkout", "toko-a", "bos", "nope.example"]) {
      expect((await status(host, "/api/health")).status, host).toBe(200);
    }
  });
});

test.describe("per-surface sessions (DOM-6)", () => {
  test.setTimeout(180_000);

  test("a session cookie of one surface never opens a session on another, under its own or any other name", async () => {
    const sessions = {} as Record<Surface, { name: string; value: string; attrs: string }>;
    for (const s of SURFACES) sessions[s] = await signIn(s);

    // Own host: the session works.
    for (const s of SURFACES) expect(await sessionEmail(s, `${sessions[s].name}=${sessions[s].value}`), `${s} own session`).toBe(SEED_USER);

    // Every ordered pair: S's cookie presented to T under S's name and renamed to T's expected name.
    for (const from of SURFACES) {
      for (const to of SURFACES) {
        if (from === to) continue;
        const own = `${sessions[from].name}=${sessions[from].value}`;
        const renamed = `${sessions[to].name}=${sessions[from].value}`;
        expect(await sessionEmail(to, own), `${from} cookie on ${to} (own name)`).toBeNull();
        expect(await sessionEmail(to, renamed), `${from} cookie on ${to} (renamed)`).toBeNull();
      }
    }
  });

  test("session cookies are host-only, HttpOnly, Secure, Path=/, named per surface with __Host-", async () => {
    const names: Record<string, string> = {};
    for (const s of ["owner", "app", "affiliate", "buyer"] as const) {
      const c = await signIn(s);
      names[s] = c.name;
      expect(c.attrs, s).toContain("httponly");
      expect(c.attrs, s).toContain("secure");
      expect(c.attrs, s).toContain("path=/");
      expect(c.attrs, s).not.toContain("domain="); // a Domain attribute can never satisfy __Host-
    }
    expect(names).toEqual({ owner: "__Host-bl_owner", app: "__Host-bl_seller", affiliate: "__Host-bl_aff", buyer: "__Host-bl_buyer" });
  });

  test("non-safe auth requests need the surface's exact Origin; cross-site and cookie-without-Origin are refused", async () => {
    const seller = await signIn("app");
    const cookie = `${seller.name}=${seller.value}`;
    const ctx = await api("app");
    try {
      const post = (headers: Record<string, string>) => ctx.post("/api/auth/sign-out", { headers, data: {} });
      expect((await post({ origin: originOf("owner"), cookie })).status(), "wrong origin").toBe(403);
      expect((await post({ origin: originOf("app"), "sec-fetch-site": "cross-site", cookie })).status(), "cross-site").toBe(403);
      expect((await post({ cookie })).status(), "cookie without origin").toBe(403);
      expect(await sessionEmail("app", cookie), "refused requests left the session alone").toBe(SEED_USER);
      expect((await post({ origin: originOf("app"), cookie })).status(), "exact origin").toBe(200);
    } finally {
      await ctx.dispose();
    }
  });

  test("a host that serves no sign-in surface does not even route the auth API", async () => {
    for (const host of ["checkout", "toko-a", "logs"]) {
      const ctx = await api(host);
      try {
        expect((await ctx.get("/api/auth/get-session")).status(), host).toBe(404);
      } finally {
        await ctx.dispose();
      }
    }
  });
});

test.describe("Seller Admin on its own host", () => {
  test.use({ baseURL: originOf("app") });

  test("a real sign-in works on app.localhost, the Owner host has no such session, no third-party script runs", async ({ page }) => {
    await login(page, SEED_USER);
    await expect(page.getByRole("heading", { name: "Produk", level: 1 })).toBeVisible();
    expect(new URL(page.url()).host).toBe(hostOf("app"));

    // Same browser, Owner host: the seller session is not sent there and would not verify anyway.
    await page.goto(`${originOf("owner")}/admin`);
    await expect(page).toHaveURL(/\/login\?next=\/admin$/);
    // The seller prefix is a plain 404 on the Owner host.
    expect((await page.goto(`${originOf("owner")}/seller`))?.status()).toBe(404);

    // Admin surfaces load no third-party script (pixels mount only on the storefront and checkout hosts).
    await page.goto(`${originOf("app")}/seller/products`);
    const foreign = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter((src) => src && new URL(src).origin !== location.origin));
    expect(foreign).toEqual([]);
  });
});
