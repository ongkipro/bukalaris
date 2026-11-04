import { expect, request, test, type APIRequestContext } from "@playwright/test";
const request_ = request;
import { setTimeout as sleep } from "node:timers/promises";
import { chooseDestination, DEV_PASSWORD, login, testPhone } from "./helpers";
import postgres from "postgres";

// These probes deliberately carry session/CSRF material; do not persist request traces.
test.use({ trace: "off" });

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
      expect(Boolean(session), `session cookie on ${label}`).toBe(true);
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

async function csrfToken(label: Surface, cookie: string): Promise<string> {
  const ctx = await api(label, { cookie });
  try {
    const res = await ctx.get("/api/auth/csrf-token");
    expect(res.status(), "CSRF issuance").toBe(200);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["vary"]).toContain("Cookie");
    expect(res.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    const body = await res.json() as { token?: unknown };
    if (typeof body.token !== "string") throw new Error("Expected a current surface binding");
    return body.token;
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

  test("owner and seller hosts reach their own consoles, the store host serves /, local path mode is kept on plain localhost", async ({ page }) => {
    expect((await status("owner", "/")).location).toMatch(/\/login\?next=\/admin$/);
    expect((await status("app", "/")).location).toMatch(/\/login\?next=\/seller$/);
    expect((await status("app", "/login")).status).toBe(200); // never resolved as the store `app`
    expect((await status("checkout", "/checkout")).status).toBe(200);
    expect((await status("toko-a", "/")).status).toBe(200);
    expect((await status("toko-a", "/s/toko-a/cart")).location).toBe(`${originOf("toko-a")}/cart`);
    expect((await status("local", "/s/toko-a")).status).toBe(200);
    expect((await status("app", "/o/1.2.abc")).location).toBe(`${originOf("checkout")}/o/1.2.abc`);
    // A relative Location under a Host-overridden transport does not prove an apex transition.
    for (const method of ["GET", "HEAD"]) {
      const redirect = await status("www", "/x", method);
      expect(redirect.status, `WWW ${method}`).toBe(308);
      expect(redirect.location, `WWW ${method}`).toBe(`${originOf("local")}/x`);
    }
    for (const width of [320, 390, 1280]) {
      await test.step(`WWW named regression ${width}px`, async () => {
        await page.setViewportSize({ width, height: 900 });
        const response = await page.goto(`${originOf("www")}/x`);
        const redirect = await response?.request().redirectedFrom()?.response();
        expect(redirect?.status()).toBe(308);
        expect(redirect?.headers().location).toBe(`${originOf("local")}/x`);
        await expect(page).toHaveURL(`${originOf("local")}/x`);
        console.info(JSON.stringify({ regression: "host-mode WWW", width, status: 308, exactApex: true }));
      });
    }
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
      const token = await csrfToken("app", cookie);
      const post = (headers: Record<string, string>) => ctx.post("/api/auth/sign-out", { headers, data: {} });
      expect((await post({ origin: originOf("owner"), cookie, "x-bl-csrf": token })).status(), "wrong origin").toBe(403);
      expect((await post({ origin: originOf("app"), "sec-fetch-site": "cross-site", cookie, "x-bl-csrf": token })).status(), "cross-site").toBe(403);
      expect((await post({ cookie, "x-bl-csrf": token })).status(), "cookie without origin").toBe(403);
      expect((await post({ origin: originOf("app"), cookie })).status(), "missing token").toBe(403);
      expect((await post({ origin: originOf("app"), cookie, "x-bl-csrf": `v1.${"A".repeat(43)}` })).status(), "forged MAC").toBe(403);
      expect((await post({ origin: originOf("app"), cookie, "x-bl-csrf": `${token}, ${token}` })).status(), "duplicate token").toBe(403);
      expect(await sessionEmail("app", cookie), "refused requests left the session alone").toBe(SEED_USER);
      expect((await post({ origin: originOf("app"), cookie, "x-bl-csrf": token })).status(), "exact origin and current token").toBe(200);
      expect(await sessionEmail("app", cookie), "valid sign-out revoked the session").toBeNull();
    } finally {
      await ctx.dispose();
    }
  });

  test("CSRF rejects a token from an earlier session of the same user and a revoked session", async () => {
    const first = await signIn("app");
    const oldCookie = `${first.name}=${first.value}`;
    const oldToken = await csrfToken("app", oldCookie);
    const second = await signIn("app");
    const newCookie = `${second.name}=${second.value}`;
    const newToken = await csrfToken("app", newCookie);
    const ctx = await api("app");
    try {
      const post = (cookie: string, token: string) => ctx.post("/api/auth/sign-out", { headers: { origin: originOf("app"), cookie, "x-bl-csrf": token }, data: {} });
      expect((await post(newCookie, oldToken)).status(), "old token must not authorize another session of the same user").toBe(403);
      expect(await sessionEmail("app", newCookie)).toBe(SEED_USER);
      expect((await post(oldCookie, oldToken)).status()).toBe(200);
      expect((await post(oldCookie, oldToken)).status(), "revoked authority must not downgrade to anonymous sign-out").toBe(403);
      expect(await sessionEmail("app", newCookie), "unrelated session preserved").toBe(SEED_USER);
      expect((await post(newCookie, newToken)).status()).toBe(200);
    } finally { await ctx.dispose(); }
  });

  test("CSRF tokens never authorize another surface even with that recipient's valid same-user cookie", async () => {
    const sessions = {} as Record<Surface, { cookie: string; token: string }>;
    for (const s of SURFACES) {
      const c = await signIn(s);
      const cookie = `${c.name}=${c.value}`;
      sessions[s] = { cookie, token: await csrfToken(s, cookie) };
    }
    for (const from of SURFACES) for (const to of SURFACES) {
      if (from === to) continue;
      const ctx = await api(to);
      try {
        const res = await ctx.post("/api/auth/sign-out", { headers: { origin: originOf(to), cookie: sessions[to].cookie, "x-bl-csrf": sessions[from].token }, data: {} });
        expect(res.status(), `${from} token on ${to}`).toBe(403);
        expect(await sessionEmail(to, sessions[to].cookie), `${to} session preserved`).toBe(SEED_USER);
      } finally { await ctx.dispose(); }
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

test.describe("T82 store-host cart mutations bind to the exact configured Host", () => {
  test.use({ baseURL: originOf("toko-a") });

  test("hydrated store-host add succeeds; a valid token on another port or a sibling store host is refused", async ({ page }) => {
    // Successful hydrated flow on the configured store host.
    await page.goto("/products/kaos-katun-basic");
    await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
    await expect(page.getByRole("heading", { name: "Keranjang", exact: true })).toBeVisible();
    expect(new URL(page.url()).host).toBe(hostOf("toko-a"));
    const quantity = page.getByRole("spinbutton", { name: /Jumlah/ });
    await expect(quantity).toHaveValue("1");

    // Capture the exact native form post the cart page sends (contains the current rendered token), then
    // replay it with a different Host. Only booleans/status are asserted; no body is logged.
    await quantity.fill("2");
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/cart"),
      page.getByRole("button", { name: "Ubah", exact: true }).click(),
    ]);
    await expect(quantity).toHaveValue("2");
    const headers = await request.allHeaders();
    const cookie = (await page.context().cookies()).filter((c) => /bl_cart_/.test(c.name)).map((c) => `${c.name}=${c.value}`).join("; ");
    // The body is multipart: rebuild with quantity 9 so an accepted request would be observable.
    const original = (request.postDataBuffer() ?? Buffer.alloc(0)).toString("latin1");
    const body = original.replace(/(name="[^"]*quantity"\r\n\r\n)2/, "$19");
    expect(body !== original, "replayed body asks for quantity 9").toBe(true);
    expect(original.includes('name="') && /_csrf"/.test(original), "replayed body carries the rendered token field").toBe(true);
    // The last case is the positive control: the identical request on the exact Host must be accepted,
    // proving the refusals are Host enforcement rather than a malformed replay.
    // Host and Origin are kept self-consistent so the framework's own forwarded-host check passes and the
    // Bukalaris binding (configured audience + exact Host) is what decides. A mismatched pair is refused earlier
    // by Next itself (observed 500 in b36286fbb) and is recorded separately.
    const otherPort = `toko-a.localhost:${PORT + 7}`;
    for (const [label, host, origin, expected] of [
      ["other port, consistent origin", otherPort, `http://${otherPort}`, "2"],
      ["sibling store, consistent origin", hostOf("toko-b"), originOf("toko-b"), "2"],
      ["exact host control", hostOf("toko-a"), originOf("toko-a"), "9"],
    ] as const) {
      const ctx = await request_.newContext({ baseURL: `http://127.0.0.1:${PORT}` });
      try {
        const res = await ctx.post("/cart", {
          headers: { host, origin, cookie, "content-type": headers["content-type"]!, "next-action": headers["next-action"]!, accept: headers.accept ?? "text/x-component" },
          data: Buffer.from(body, "latin1"),
          maxRedirects: 0,
        });
        console.info(JSON.stringify({ case: label, status: res.status() }));
      } finally { await ctx.dispose(); }
      await page.goto("/cart");
      await expect(quantity, `${label}: expected cart quantity`).toHaveValue(expected);
    }
  });
});

test("T82 #31 a render whose forwarded host names another surface is refused, never re-targeted", async () => {
  for (const [label, host, forwarded, refused] of [
    ["internal render: listener host, seller forwarded", hostOf("local"), hostOf("app"), true],
    ["forged forwarded host on a real surface", hostOf("app"), hostOf("owner"), true],
    ["store host forwarded to a sibling store", hostOf("toko-a"), hostOf("toko-b"), true],
    ["matching forwarded host", hostOf("app"), hostOf("app"), false],
    ["no forwarded host", hostOf("app"), null, false],
    ["plain localhost forwarded as itself", hostOf("local"), hostOf("local"), false],
    ["multi-value: only the first forwarded value counts", hostOf("app"), `${hostOf("owner")}, ${hostOf("app")}`, true],
    ["same surface, different case and port", hostOf("app"), `APP.LOCALHOST:${PORT + 9}`, false],
    ["127.0.0.1 and localhost are the same local surface", `127.0.0.1:${PORT}`, hostOf("local"), false],
  ] as const) {
    const ctx = await request_.newContext({ baseURL: `http://127.0.0.1:${PORT}` });
    try {
      const res = await ctx.get("/api/health", { headers: { host, ...(forwarded ? { "x-forwarded-host": forwarded } : {}) }, maxRedirects: 0 });
      expect(res.status() === 421, `${label}: refused=${refused}`).toBe(refused);
      if (refused) {
        expect(res.headers()["cache-control"]).toContain("no-store");
        expect(Boolean(res.headers()["x-request-id"]), `${label}: 421 is traceable`).toBe(true);
      }
    } finally { await ctx.dispose(); }
  }
});

test("T82 seller-host landing redirect diagnostic requires the authenticated editor after a successful mutation", async ({ browser }) => {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl || !/_e2e\b/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const context = await browser.newContext({ baseURL: originOf("app") });
  try {
    const p = await context.newPage();
    await login(p, SEED_USER);
    await p.goto("/seller/landing-pages/new");
    const slug = `t82-redirect-${Date.now().toString(36)}`;
    await p.getByLabel("Judul", { exact: true }).fill("T82 seller redirect diagnostic");
    await p.getByLabel("Slug URL").fill(slug);
    const before = Boolean((await (await context.request.get("/api/auth/get-session")).json())?.user);
    const [response] = await Promise.all([
      p.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/seller/landing-pages/new"),
      p.getByRole("button", { name: "Buat dan lanjut mengedit", exact: true }).click(),
    ]);
    const [row] = await sql`select lp.id from landing_page lp join store s on s.id = lp.store_id where s.slug = 'toko-a' and lp.slug = ${slug}`;
    expect(Boolean(row), "diagnostic mutation persisted").toBe(true);
    const editorPath = `/seller/landing-pages/${row!.id}`;
    const advertisedEditor = (response.headers()["x-action-redirect"] ?? "").startsWith(`${editorPath}?saved=1;`);
    // Wait for one of the real terminal UIs, not an arbitrary delay or raw RSC payload extraction.
    await expect(p.getByTestId("draft-revision").or(p.getByRole("button", { name: "Masuk", exact: true }))).toBeVisible();
    const renderedEditor = await p.getByTestId("draft-revision").isVisible();
    const renderedLogin = await p.getByRole("button", { name: "Masuk", exact: true }).isVisible();
    const after = Boolean((await (await context.request.get("/api/auth/get-session")).json())?.user);
    await p.goto(editorPath);
    await expect(p.getByTestId("draft-revision")).toHaveText("1");
    console.info(JSON.stringify({ probe: "seller-host landing redirect", postStatus: response.status(), beforeSession: before, afterSession: after, advertisedEditor, renderedEditor, renderedLogin, freshEditorGetWorks: true }));
    expect(before && after, "session remains live before and after the action").toBe(true);
    expect(advertisedEditor, "action advertises its correct editor redirect").toBe(true);
    expect(renderedEditor, "successful seller-host action must render its authenticated editor, not login").toBe(true);
  } finally { await context.close(); await sql.end(); }
});

test("T82 configured store-host landing original action refuses a forged token and accepts the current token without automatic host handoff", async ({ browser }) => {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl || !/_e2e\b/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  // Fixture creation uses the existing single-host builder flow. app-host post-submit redirect
  // unexpectedly showed login in b6a56f0e3 despite persisting the page; that observation remains open.
  // This test targets the public store-host landing action, not seller-host redirect acceptance.
  const seller = await browser.newContext({ baseURL: originOf("local") });
  const buyer = await browser.newContext({ baseURL: originOf("toko-a"), javaScriptEnabled: false });
  try {
    const editor = await seller.newPage();
    await login(editor, SEED_USER);
    const slug = `t82-host-${Date.now().toString(36)}`;
    await editor.goto("/seller/landing-pages/new");
    await editor.getByLabel("Judul", { exact: true }).fill("T82 configured host landing");
    await editor.getByLabel("Slug URL").fill(slug);
    await editor.getByRole("button", { name: "Buat dan lanjut mengedit", exact: true }).click();
    await expect(editor.getByTestId("draft-revision")).toHaveText("1");
    await editor.getByLabel("Tambah blok").selectOption("order");
    await editor.getByRole("button", { name: "Tambah blok", exact: true }).click();
    await expect(editor.getByTestId("draft-revision")).toHaveText("2");
    const order = editor.getByTestId("block-order");
    await order.getByLabel("Produk", { exact: true }).selectOption({ label: "Kaos Katun Basic" });
    await order.getByRole("button", { name: /Simpan blok/ }).click();
    await expect(editor.getByTestId("draft-revision")).toHaveText("3");
    await editor.getByRole("button", { name: "Publikasikan", exact: true }).click();
    await expect(editor.getByRole("status")).toHaveText("Landing page dipublikasikan.");
    const p = await buyer.newPage();
    const path = `/lp/${slug}`;
    await p.goto(path);
    const form = p.locator("#order form");
    await expect(form.getByRole("button", { name: "Lanjut ke checkout", exact: true })).toBeVisible();
    const entries = await form.evaluate((el) => Array.from(new FormData(el as HTMLFormElement).entries()).map(([k, v]) => [k, String(v)]));
    expect(entries.filter(([k]) => k === "_csrf").length).toBe(1);
    const current = new FormData();
    for (const [key, value] of entries) current.append(key!, value!);
    current.set("quantity", "2");
    const forged = new FormData();
    for (const [key, value] of current) forged.append(key, value);
    forged.set("_csrf", "forged");
    const cartCount = async () => Number((await sql`select count(*)::int as n from cart c join store s on s.id = c.store_id where s.slug = 'toko-a'`)[0]!.n);
    const before = await cartCount();
    const denied = await buyer.request.post(path, { headers: { origin: originOf("toko-a") }, multipart: forged, maxRedirects: 0 });
    expect(denied.status(), "landing refusal completes with recovery redirect").toBe(303);
    expect((denied.headers().location ?? "").includes("error="), "landing refusal supplies recovery").toBe(true);
    expect(await cartCount(), "forged landing token creates no cart").toBe(before);
    expect((await buyer.cookies()).some((c) => /^(?:__Host-)?bl_cart_\d+$/.test(c.name)), "forged landing token issues no cart capability").toBe(false);
    // Only exercise the original landing mutation, without following the relative /checkout redirect.
    // Automatic store-host → checkout-host handoff is outside this CSRF evidence, not silently patched here.
    const accepted = await buyer.request.post(path, { headers: { origin: originOf("toko-a") }, multipart: current, maxRedirects: 0 });
    expect(accepted.status(), "current landing token succeeds on the configured store host").toBe(303);
    expect(accepted.headers().location).toBe("/checkout?store=toko-a");
    expect(await cartCount(), "current landing token creates one cart").toBe(before + 1);
    const cookie = (await buyer.cookies()).find((c) => /^(?:__Host-)?bl_cart_\d+$/.test(c.name));
    expect(Boolean(cookie), "accepted landing action issues a cart capability").toBe(true);
    const [row] = await sql`select s.slug, sum(l.quantity)::int as quantity from cart c join store s on s.id = c.store_id join cart_line l on l.cart_id = c.id where c.id = ${cookie!.value}::uuid group by s.slug`;
    expect(row?.slug).toBe("toko-a");
    expect(Number(row?.quantity)).toBe(2);
  } finally { await buyer.close(); await seller.close(); await sql.end(); }
});

test("T82 direct configured checkout host accepts its own cart-bound form and creates exactly one order", async ({ browser }) => {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl || !/_e2e\b/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const store = await browser.newContext({ baseURL: originOf("toko-a") });
  const checkout = await browser.newContext({ baseURL: originOf("checkout") });
  try {
    const p = await store.newPage();
    await p.goto("/products/kaos-katun-basic");
    await p.getByRole("button", { name: "Tambah ke keranjang" }).click();
    await expect(p.getByRole("heading", { name: "Keranjang", exact: true })).toBeVisible();
    const cart = (await store.cookies()).find((c) => /^(?:__Host-)?bl_cart_\d+$/.test(c.name));
    expect(Boolean(cart), "owned fixture cart exists").toBe(true);
    // Fixture setup ONLY: copy the owned cart into an isolated checkout-host cookie jar.
    // This proves checkout's configured-host CSRF audience, NOT an automatic cross-host cart handoff.
    // __Host- cookies remain host-only; no production cookie/routing behavior is altered.
    await checkout.addCookies([{ ...cart!, domain: "checkout.localhost" }]);
    const c = await checkout.newPage();
    await c.goto("/checkout?store=toko-a");
    await expect(c.getByRole("heading", { name: /Checkout · / })).toBeVisible();
    expect(new URL(c.url()).origin).toBe(originOf("checkout"));
    await chooseDestination(c);
    await c.getByLabel("Nama", { exact: true }).fill("Budi Host Checkout");
    await c.getByLabel("Nomor HP").fill(testPhone());
    await c.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 4, Menteng, Jakarta");
    expect(Number((await sql`select count(*)::int as n from "order" where cart_id = ${cart!.value}::uuid`)[0]!.n), "fixture has no order before submit").toBe(0);
    await c.getByRole("button", { name: "Buat pesanan", exact: true }).click();
    await expect(c.getByRole("heading", { name: "Pesanan diterima", exact: true })).toBeVisible();
    expect(new URL(c.url()).origin).toBe(originOf("checkout"));
    expect(Number((await sql`select count(*)::int as n from "order" where cart_id = ${cart!.value}::uuid`)[0]!.n), "configured-host checkout creates exactly one order").toBe(1);
  } finally { await checkout.close(); await store.close(); await sql.end(); }
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
