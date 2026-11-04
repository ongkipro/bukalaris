import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { chooseDestination, DEV_PASSWORD, enrolTotpViaApi, login, seedFixtureStore, testPhone, totp } from "./helpers";

// CSRF/session values stay in memory; never capture request bodies/headers in a trace.
test.use({ trace: "off" });

test("T82 original seller action rejects missing/forged/duplicate tokens; native pre-JS submission succeeds", async ({ page, browser, baseURL }) => {
  await login(page, "owner-a@bukalaris.local");
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: page.viewportSize() ?? undefined, storageState: await page.context().storageState() });
  try {
    // No loading.tsx: unlike settings, this document does not need a streaming reveal script.
    const native = await context.newPage();
    const path = "/seller/products/1";
    await native.goto(path);
    const title = native.getByLabel("Judul produk", { exact: true });
    await expect(title).toBeVisible();
    const original = await title.inputValue();
    const rejected = `T82 must not persist ${Date.now()}`;
    for (const mode of ["missing", "forged", "duplicate"] as const) {
      await native.goto(path);
      const form = native.locator("form").filter({ has: title });
      await expect(form.locator('input[name="_csrf"]')).toHaveCount(1);
      if (mode === "missing") await form.locator('input[name="_csrf"]').evaluate((field) => field.remove());
      else if (mode === "forged") await form.locator('input[name="_csrf"]').evaluate((field: HTMLInputElement) => { field.value = `v1.${"A".repeat(43)}`; });
      else await form.locator('input[name="_csrf"]').evaluate((field) => field.after(field.cloneNode(true)));
      await title.fill(rejected);
      const [response] = await Promise.all([
        native.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === path),
        form.getByRole("button", { name: "Simpan produk", exact: true }).click(),
      ]);
      await response.finished();
      await native.waitForLoadState("domcontentloaded");
      const recoveryShown = (await native.getByRole("alert").allTextContents()).some((message) => message.includes("Muat ulang"));
      // Prove the persisted refusal before testing recovery; never retry an unknown-outcome POST.
      await native.goto(path);
      await expect(title, `${mode} token must leave product metadata unchanged`).toHaveValue(original);
      expect(recoveryShown, "expected refusal needs actionable recovery, not the generic error boundary").toBe(true);
    }
    const changed = `T82 native ${Date.now()}`;
    await title.fill(changed);
    await native.getByRole("button", { name: "Simpan produk", exact: true }).click();
    await expect(native).toHaveURL(/\/seller\/products\/1\?saved=1$/);
    await native.reload();
    await expect(title).toHaveValue(changed);
    await title.fill(original);
    await native.getByRole("button", { name: "Simpan produk", exact: true }).click();
    await expect(native).toHaveURL(/\/seller\/products\/1\?saved=1$/);
    expect(await native.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  } finally { await context.close(); }
});

test("T82 duplicate live-session and cart cookies refuse original mutations with unchanged persisted state and exact-cookie controls", async ({ page, browser, playwright, baseURL }) => {
  await login(page, "owner-a@bukalaris.local");
  const nativeContext = await browser.newContext({ baseURL, javaScriptEnabled: false, storageState: await page.context().storageState() });
  const transport = await playwright.request.newContext({ baseURL });
  const origin = new URL(baseURL!).origin;
  try {
    const native = await nativeContext.newPage();
    const path = "/seller/products/1";
    await native.goto(path);
    const title = native.getByLabel("Judul produk", { exact: true });
    await expect(title).toBeVisible();
    const originalTitle = await title.inputValue();
    const form = native.locator("form").filter({ has: title });
    const entries = await form.evaluate((el) => Array.from(new FormData(el as HTMLFormElement).entries()).map(([k, v]) => [k, String(v)]));
    expect(entries.filter(([k]) => k === "_csrf").length, "original form carries one current CSRF field").toBe(1);
    const titleName = await title.getAttribute("name");
    expect(Boolean(titleName), "title field name exists").toBe(true);
    // Next's installed action-handler rejects URL-encoded actions; match the original multipart form.
    const payload = new FormData();
    for (const [name, value] of entries) payload.append(name!, value!);
    payload.set(titleName!, "T82 duplicate-cookie control");
    const allCookies = await nativeContext.cookies();
    const live = allCookies.find((c) => /session_token$/.test(c.name));
    expect(Boolean(live), "live session cookie exists").toBe(true);
    const rawCookie = allCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    for (const mode of ["identical", "conflicting"] as const) {
      const cookie = `${rawCookie}; ${live!.name}=${mode === "identical" ? live!.value : "invalid"}`;
      expect((await transport.get("/api/auth/csrf-token", { headers: { cookie } })).status(), `${mode}: ambiguous live issuer refused`).toBe(403);
      expect((await transport.post("/api/auth/sign-out", { headers: { origin, cookie, "x-bl-csrf": await form.locator('input[name="_csrf"]').inputValue() }, data: {} })).status(), `${mode}: ambiguous sign-out refused`).toBe(403);
      await transport.post(path, { headers: { origin, cookie }, multipart: payload, maxRedirects: 0 });
      await native.goto(path);
      await expect(title, `${mode}: original seller mutation did not persist`).toHaveValue(originalTitle);
    }
    await transport.post(path, { headers: { origin, cookie: rawCookie }, multipart: payload, maxRedirects: 0 });
    await native.goto(path);
    await expect(title, "identical form with unambiguous session persists").toHaveValue("T82 duplicate-cookie control");
    await title.fill(originalTitle);
    await native.getByRole("button", { name: "Simpan produk", exact: true }).click();
    await expect(native).toHaveURL(/saved=1$/);

    // The same native-form boundary for cart cookies: no token tampering, only cookie ambiguity.
    await native.goto("/s/toko-a/products/kaos-katun-basic");
    await native.getByRole("button", { name: "Tambah ke keranjang" }).click();
    const quantity = native.getByRole("spinbutton", { name: /Jumlah/ });
    await expect(quantity).toHaveValue("1");
    const cartForm = native.locator("form").filter({ has: quantity });
    const cartEntries = await cartForm.evaluate((el) => Array.from(new FormData(el as HTMLFormElement).entries()).map(([k, v]) => [k, String(v)]));
    expect(cartEntries.filter(([k]) => k === "_csrf").length).toBe(1);
    const quantityName = await quantity.getAttribute("name");
    expect(Boolean(quantityName)).toBe(true);
    const cartPayload = new FormData();
    for (const [name, value] of cartEntries) cartPayload.append(name!, value!);
    cartPayload.set(quantityName!, "9");
    const cookies = await nativeContext.cookies();
    const cartCookie = cookies.find((c) => /^(?:__Host-)?bl_cart_\d+$/.test(c.name));
    expect(Boolean(cartCookie), "cart capability exists").toBe(true);
    const rawCartCookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const cartPath = new URL(native.url()).pathname;
    for (const mode of ["identical", "conflicting"] as const) {
      const cookie = `${rawCartCookie}; ${cartCookie!.name}=${mode === "identical" ? cartCookie!.value : "invalid"}`;
      await transport.post(cartPath, { headers: { origin, cookie }, multipart: cartPayload, maxRedirects: 0 });
      await native.goto(cartPath);
      await expect(quantity, `${mode}: duplicate-cart mutation did not persist`).toHaveValue("1");
    }
    await transport.post(cartPath, { headers: { origin, cookie: rawCartCookie }, multipart: cartPayload, maxRedirects: 0 });
    await native.goto(cartPath);
    await expect(quantity, "identical form with unambiguous cart persists").toHaveValue("9");
  } finally { await transport.dispose(); await nativeContext.close(); }
});

test("T82 anonymous cart native forms reject forged tokens and accept the current cart binding", async ({ browser, baseURL, page }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: page.viewportSize() ?? undefined });
  try {
    const native = await context.newPage();
    await native.goto("/s/toko-a/products/kaos-katun-basic");
    await expect(native.locator('main form input[name="_csrf"]')).toHaveCount(1);
    await native.getByRole("button", { name: "Tambah ke keranjang" }).click();
    await expect(native.getByRole("heading", { name: "Keranjang", exact: true })).toBeVisible();
    const quantity = native.getByRole("spinbutton", { name: /Jumlah/ });
    await expect(quantity).toHaveValue("1");
    await native.locator('main form input[name="_csrf"]').evaluate((field: HTMLInputElement) => { field.value = "forged"; });
    await quantity.fill("9");
    await native.getByRole("button", { name: "Ubah", exact: true }).click();
    await expect(native.getByRole("alert")).toContainText("Muat ulang");
    await expect(quantity).toHaveValue("1");
    await quantity.fill("2");
    await native.getByRole("button", { name: "Ubah", exact: true }).click();
    await expect(quantity).toHaveValue("2");
    expect(await native.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  } finally { await context.close(); }
});

test("T82 pending-MFA authority is limited to verification, refuses missing/invalid/duplicate input and transitions to a session binding", async ({ page, playwright, baseURL }) => {
  // Fresh owner: TOTP enrolment is permanent and must not leak into shared seed users or other projects.
  const { email } = seedFixtureStore("t82mfa");
  await login(page, email);
  const secret = await enrolTotpViaApi(page, email);
  const origin = new URL(baseURL!).origin;
  const ctx = await playwright.request.newContext({ baseURL });
  try {
    // Native sign-in limit is 3 per 10 s per IP and login() above already spent part of it: wait out a 429
    // (same pattern as helpers.login and host-mode signIn) instead of relaxing the limiter.
    let signIn = await ctx.post("/api/auth/sign-in/email", { headers: { origin }, data: { email, password: DEV_PASSWORD } });
    for (let attempt = 0; signIn.status() === 429 && attempt < 3; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 11_000));
      signIn = await ctx.post("/api/auth/sign-in/email", { headers: { origin }, data: { email, password: DEV_PASSWORD } });
    }
    expect(signIn.status(), "password step").toBe(200);
    expect(((await signIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect, "challenge issued, no session yet").toBe(true);
    const pendingCookie = (await ctx.storageState()).cookies.find((c) => /two_factor|2fa/.test(c.name));
    expect(Boolean(pendingCookie), "pending challenge cookie exists").toBe(true);
    const issue = async (headers: Record<string, string> = {}) => ctx.get("/api/auth/csrf-token", { headers });
    const pendingToken = ((await (await issue()).json()) as { token?: string }).token!;
    expect(typeof pendingToken).toBe("string");
    const session = async () => ((await (await ctx.get("/api/auth/get-session")).json()) as { user?: unknown } | null)?.user ?? null;

    // Duplicate challenge cookie: ambiguous authority is refused, nothing issued.
    const dup = `${pendingCookie!.name}=${pendingCookie!.value}; ${pendingCookie!.name}=${pendingCookie!.value}`;
    expect((await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: dup } }).then(async (c) => { try { return (await c.get("/api/auth/csrf-token")).status(); } finally { await c.dispose(); } })), "duplicate pending cookie").toBe(403);

    // A pending-class token never reaches session-only endpoints.
    for (const path of ["/sign-out", "/two-factor/enable", "/revoke-other-sessions"]) {
      expect((await ctx.post(`/api/auth${path}`, { headers: { origin, "x-bl-csrf": pendingToken }, data: {} })).status(), `pending token on ${path}`).toBe(403);
    }
    // Verification itself needs the current pending token; refusals happen before the challenge is consumed.
    const verify = (headers: Record<string, string>) => ctx.post("/api/auth/two-factor/verify-totp", { headers: { origin, ...headers }, data: { code: totp(secret) } });
    expect((await verify({})).status(), "missing token").toBe(403);
    expect((await verify({ "x-bl-csrf": `v1.${"A".repeat(43)}` })).status(), "invalid token").toBe(403);
    expect((await verify({ "x-bl-csrf": `${pendingToken}, ${pendingToken}` })).status(), "duplicate token").toBe(403);
    expect(await session(), "refusals created no session").toBeNull();

    // Replace the browser's pending challenge. Its previous MAC cannot authorize the new cookie.
    const previous = await playwright.request.newContext({ baseURL, storageState: await ctx.storageState() });
    // Pre-expiry control: the previous challenge is still live server-side before it is replaced, so the later 401 is
    // attributable to expiry, not to an already-dead challenge (review 4d65c038 P2).
    const liveBefore = Number((await (async () => {
      const s = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
      try { return await s`select count(*)::int as n from verification where identifier = ${decodeURIComponent(pendingCookie!.value).split(".")[0]!} and expires_at > now()`; } finally { await s.end(); }
    })())[0]!.n);
    expect(liveBefore, "previous challenge is live before expiry").toBe(1);
    // Same native 3/10 s sign-in window handling as the first password step (review 4d65c038 P2).
    let replacement = await ctx.post("/api/auth/sign-in/email", { headers: { origin, "x-bl-csrf": pendingToken }, data: { email, password: DEV_PASSWORD } });
    for (let attempt = 0; replacement.status() === 429 && attempt < 3; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 11_000));
      replacement = await ctx.post("/api/auth/sign-in/email", { headers: { origin, "x-bl-csrf": pendingToken }, data: { email, password: DEV_PASSWORD } });
    }
    expect(replacement.status(), "replacement password step").toBe(200);
    expect((await replacement.json() as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    const currentPendingToken = ((await (await issue()).json()) as { token?: string }).token!;
    expect(typeof currentPendingToken === "string" && currentPendingToken !== pendingToken, "replacement challenge has a distinct token").toBe(true);
    expect((await verify({ "x-bl-csrf": pendingToken })).status(), "old challenge token with replacement cookie").toBe(403);
    expect(Boolean(await session()), "replacement refusal creates no session").toBe(false);

    // Expire only the known disposable fixture's previous challenge server-side; keep its browser cookie.
    const databaseUrl = process.env.E2E_DATABASE_URL;
    if (!databaseUrl || !/_e2e\b/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      const identifier = decodeURIComponent(pendingCookie!.value).split(".")[0]!;
      // better-auth crypto/random.mjs: generateRandomString alphabet is a-z, 0-9, A-Z, '-' and '_' (20 chars here).
      expect(/^2fa-[A-Za-z0-9_-]{20}$/.test(identifier), "captured pending cookie contains a native challenge identifier").toBe(true);
      const expired = await sql`update verification set expires_at = now() - interval '1 minute' where identifier = ${identifier} and value in (select id from "user" where email = ${email}) returning 1`;
      expect(expired.count, "exactly one fixture challenge expired").toBe(1);
      const refusal = await previous.post("/api/auth/two-factor/verify-totp", { headers: { origin, "x-bl-csrf": pendingToken }, data: { code: totp(secret) } });
      expect(refusal.status(), "native expiry refuses a correctly MAC-bound pending request").toBe(401);
      expect(Boolean((await (await previous.get("/api/auth/get-session")).json())?.user), "expired challenge creates no session").toBe(false);
    } finally { await previous.dispose(); await sql.end(); }

    // Retain the current pending cookie before verification, then replay that consumed challenge independently.
    const consumed = await playwright.request.newContext({ baseURL, storageState: await ctx.storageState() });
    try {
      // Native Better Auth two-factor endpoints allow 3 requests per 10 seconds (plugin/index.mjs).
      // Enrolment and the expiry probe used that budget. Wait one full window so replay reaches
      // consumed-challenge validation instead of merely proving the independent rate limiter (429).
      await new Promise<void>((resolve) => setTimeout(resolve, 10_100));
      expect((await verify({ "x-bl-csrf": currentPendingToken })).status(), "current replacement challenge verifies").toBe(200);
      const replay = await consumed.post("/api/auth/two-factor/verify-totp", { headers: { origin, "x-bl-csrf": currentPendingToken }, data: { code: totp(secret) } });
      expect(replay.status(), "consumed pending challenge cannot be replayed without the new session").toBe(401);
      expect(Boolean((await (await consumed.get("/api/auth/get-session")).json())?.user), "consumed challenge replay creates no session").toBe(false);
    } finally { await consumed.dispose(); }
    expect(await session(), "verified challenge created a session").not.toBeNull();

    // Transition: the old pending token no longer authorizes anything; a fresh session-class token does.
    expect((await ctx.post("/api/auth/sign-out", { headers: { origin, "x-bl-csrf": currentPendingToken }, data: {} })).status(), "old pending token after transition").toBe(403);
    expect(await session(), "session kept after refused sign-out").not.toBeNull();
    const sessionToken = ((await (await issue()).json()) as { token?: string }).token!;
    expect(typeof sessionToken === "string" && sessionToken.length > 0, "session token exists").toBe(true);
    expect(sessionToken !== currentPendingToken, "authority transition changes the token").toBe(true);
    expect((await ctx.post("/api/auth/sign-out", { headers: { origin, "x-bl-csrf": sessionToken }, data: {} })).status(), "fresh session token").toBe(200);
    expect(await session(), "signed out").toBeNull();
  } finally { await ctx.dispose(); }
});

test("T82 fresh issuance: issuer failure sends no POST; a session change between issue and POST is refused once, never replayed; stale-state recovery stays usable", async ({ page, browser, baseURL }) => {
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname.startsWith("/api/auth/")) posts.push(new URL(r.url()).pathname); });

  // Fresh owner: the session is signed out elsewhere mid-test; keep shared seed users untouched.
  const { email } = seedFixtureStore("t82iss");
  // 1. Issuer failure: the login form must not send the sign-in POST.
  await page.route("**/api/auth/csrf-token", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "UNAVAILABLE" }) }));
  await page.goto("/login?next=/seller/products");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Kata sandi").fill("bukalaris-dev-123");
  await page.getByRole("button", { name: "Masuk" }).click();
  // The form only shows a generic error; the contract asserted here is that no sign-in POST was sent.
  // #login-error, not getByRole("alert"): Next's route announcer is also an alert.
  await expect(page.locator("#login-error")).toBeVisible();
  expect(posts, "issuer failure sends no auth POST").toEqual([]);
  await page.unroute("**/api/auth/csrf-token");

  // 2. Drive SecurityEnrol's actual authPost caller; another tab revokes its session after issuance.
  await login(page, email);
  await page.goto("/account/security");
  await page.getByLabel("Kata sandi", { exact: true }).fill(DEV_PASSWORD);
  const other = await browser.newContext({ baseURL, storageState: await page.context().storageState() });
  let issued = 0;
  await page.route("**/api/auth/csrf-token", async (route) => {
    const response = await route.fetch();
    issued++;
    // Revoke the live session before releasing its token to the actual authPost caller.
    const tab = await other.newPage();
    try {
      await tab.goto("/seller/products");
      const status = await tab.evaluate(async () => {
        const t = await (await fetch("/api/auth/csrf-token", { cache: "no-store" })).json();
        return (await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json", "x-bl-csrf": t.token }, body: "{}" })).status;
      });
      expect(status, "other tab revoked the session before releasing the issued token").toBe(200);
    } finally { await tab.close(); }
    await route.fulfill({ response });
  });
  posts.length = 0;
  const [refusal] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/auth/two-factor/enable"),
    page.getByRole("button", { name: "Mulai aktivasi", exact: true }).click(),
  ]);
  expect(refusal.status(), "actual authPost caller refuses the revoked-session token").toBe(403);
  await expect(page.locator("#pw-error")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mulai aktivasi", exact: true })).toBeEnabled();
  expect(issued, "authPost issues once and does not fetch a replacement after refusal").toBe(1);
  expect(posts, "actual authPost completes with exactly one POST and no replay").toEqual(["/api/auth/two-factor/enable"]);
  await page.unroute("**/api/auth/csrf-token");
  await other.close();

  // 3. Stale browser state (cookie of the now-revoked session): anonymous recovery still works.
  posts.length = 0;
  await page.goto("/account/recovery");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Kirim tautan" }).click();
  await expect(page.getByRole("status")).toBeVisible();
  expect(posts).toEqual(["/api/auth/request-password-reset"]);
});

test("T82 cross-store, closed and invalid cart cookies never let a rendered token change another cart", async ({ browser, baseURL }) => {
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const lines = async (cartId: string) => Number((await sql`select coalesce(sum(quantity), 0)::int as q from cart_line where cart_id = ${cartId}::uuid`)[0]!.q);
  type Cookie = Awaited<ReturnType<import("@playwright/test").BrowserContext["cookies"]>>[number];
  const add = async (slug: "toko-a" | "toko-b", productPath: string | null, cookie?: Cookie) => {
    const ctx = await browser.newContext({ baseURL, javaScriptEnabled: false });
    // Reuse a real captured cookie object (domain/path/secure/sameSite intact) and only swap its value.
    if (cookie) await ctx.addCookies([cookie]);
    const p = await ctx.newPage();
    if (productPath) await p.goto(productPath);
    else {
      // Follow the store's own first product link: seeded toko-b products have no slug (canonical path uses the catalog id).
      await p.goto(`/s/${slug}`);
      await p.locator(`main a[href*="/s/${slug}/products/"]`).first().click();
      await expect(p).toHaveURL(new RegExp(`/s/${slug}/products/`));
    }
    await p.getByLabel("Jumlah").fill("7");
    await p.getByRole("button", { name: "Tambah ke keranjang" }).click();
    await expect(p.getByRole("heading", { name: "Keranjang", exact: true })).toBeVisible();
    const cookies = (await ctx.cookies()).filter((c) => /bl_cart_/.test(c.name));
    await ctx.close();
    return cookies;
  };
  try {
    const ownProduct = "/s/toko-a/products/kaos-katun-basic";
    // A real open toko-b cart and the toko-a cookie name.
    const [foreign] = await add("toko-b", null);
    const [own] = await add("toko-a", ownProduct);
    expect(foreign!.name).not.toBe(own!.name);
    // A closed toko-a cart, created here by a real checkout so the case can never be skipped.
    const buyer = await browser.newContext({ baseURL });
    let closed: { id: string };
    try {
      const p = await buyer.newPage();
      await p.goto(ownProduct);
      await p.getByRole("button", { name: "Tambah ke keranjang" }).click();
      await expect(p.getByRole("heading", { name: "Keranjang", exact: true })).toBeVisible();
      const closedId = (await buyer.cookies()).find((c) => c.name === own!.name)!.value;
      await p.goto("/checkout?store=toko-a");
      await chooseDestination(p);
      await p.getByLabel("Nama").fill("Budi Tutup");
      await p.getByLabel("Nomor HP").fill(testPhone());
      await p.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 3, Bandung 40111");
      await p.getByRole("button", { name: "Buat pesanan" }).click();
      await expect(p.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
      expect(Number((await sql`select count(*)::int as n from "order" where cart_id = ${closedId}::uuid`)[0]!.n), "cart is closed by an order").toBe(1);
      closed = { id: closedId };
    } finally { await buyer.close(); }
    const before = { foreign: await lines(foreign!.value), closed: await lines(closed.id) };
    const cases: [string, string][] = [["cross-store cart under toko-a's name", foreign!.value], ["random uuid", crypto.randomUUID()], ["malformed id", "not-a-cart"], ["closed cart", closed.id]];
    for (const [label, value] of cases) {
      const after = await add("toko-a", ownProduct, { ...own!, value });
      const issued = after.find((c) => c.name === own!.name)?.value;
      expect(typeof issued === "string" && issued.length > 0, `${label}: replacement cart cookie exists`).toBe(true);
      expect(issued !== value, `${label}: presented capability is not reused`).toBe(true);
      const [replacement] = await sql`select s.slug, coalesce(sum(l.quantity), 0)::int as quantity from cart c join store s on s.id = c.store_id left join cart_line l on l.cart_id = c.id where c.id = ${issued!}::uuid group by s.slug`;
      expect(Boolean(replacement), `${label}: replacement cart exists in the database`).toBe(true);
      expect(replacement?.slug, `${label}: replacement belongs to the current store`).toBe("toko-a");
      expect(Number(replacement?.quantity), `${label}: add persisted only in the replacement cart`).toBe(7);
    }
    expect(await lines(foreign!.value), "toko-b cart untouched").toBe(before.foreign);
    expect(await lines(closed.id), "closed cart untouched").toBe(before.closed);
    console.info(JSON.stringify({ cases: cases.map(([l]) => l) }));
  } finally { await sql.end(); }
});

test("T82 a checkout form rendered for one cart cannot order a foreign or closed cart; the exact cart is the positive control", async ({ browser, baseURL }) => {
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const orders = async (cartId: string) => Number((await sql`select count(*)::int as n from "order" where cart_id = ${cartId}::uuid`)[0]!.n);
  const cartName = /^(?:__Host-)?bl_cart_\d+$/;
  const openCart = async (path: string | null, slug: string) => {
    const ctx = await browser.newContext({ baseURL });
    const p = await ctx.newPage();
    if (path) await p.goto(path);
    else { await p.goto(`/s/${slug}`); await p.locator(`main a[href*="/s/${slug}/products/"]`).first().click(); }
    await p.getByRole("button", { name: "Tambah ke keranjang" }).click();
    await expect(p.getByRole("heading", { name: "Keranjang", exact: true })).toBeVisible();
    return { ctx, page: p, cookie: (await ctx.cookies()).find((c) => cartName.test(c.name))! };
  };
  const own = await openCart("/s/toko-a/products/kaos-katun-basic", "toko-a");
  const foreign = await openCart(null, "toko-b");
  const closedCart = await openCart("/s/toko-a/products/kaos-katun-basic", "toko-a");
  try {
    expect(Boolean(own.cookie && foreign.cookie && closedCart.cookie), "fixture carts exist").toBe(true);
    // Close one toko-a cart through a real checkout.
    await closedCart.page.goto("/checkout?store=toko-a");
    await chooseDestination(closedCart.page);
    await closedCart.page.getByLabel("Nama").fill("Budi Tutup");
    await closedCart.page.getByLabel("Nomor HP").fill(testPhone());
    await closedCart.page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 5, Bandung 40111");
    await closedCart.page.getByRole("button", { name: "Buat pesanan" }).click();
    await expect(closedCart.page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
    expect(await orders(closedCart.cookie.value), "fixture cart closed").toBe(1);

    // Render the checkout form for the own cart and capture the exact original submission.
    const p = own.page;
    await p.goto("/checkout?store=toko-a");
    await chooseDestination(p);
    await p.getByLabel("Nama").fill("Budi Kontrol");
    await p.getByLabel("Nomor HP").fill(testPhone());
    await p.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 6, Bandung 40111");
    const form = p.locator("form").filter({ has: p.getByRole("button", { name: "Buat pesanan" }) });
    const entries = await form.evaluate((el) => Array.from(new FormData(el as HTMLFormElement).entries()).map(([k, v]) => [k, String(v)]));
    expect(entries.filter(([k]) => k === "_csrf").length, "checkout form carries one token").toBe(1);
    // Capture the exact hydrated submission and abort it before it reaches the server (no effect).
    const isSubmit = (u: URL) => u.pathname === "/checkout";
    await p.route((u) => isSubmit(u), (route) => route.request().method() === "POST" ? route.abort() : route.continue());
    const [request] = await Promise.all([
      p.waitForRequest((r) => r.method() === "POST" && isSubmit(new URL(r.url()))),
      p.getByRole("button", { name: "Buat pesanan" }).click(),
    ]);
    await p.unrouteAll({ behavior: "ignoreErrors" });
    const headers = await request.allHeaders();
    const body = request.postDataBuffer() ?? Buffer.alloc(0);
    expect(body.length > 0 && Boolean(headers["next-action"]), "captured hydrated checkout submission").toBe(true);
    expect(await orders(own.cookie.value), "capture did not submit").toBe(0);
    const origin = new URL(baseURL!).origin;
    const send = async (cartId: string) => {
      const ctx = await browser.newContext({ baseURL });
      try {
        const res = await ctx.request.post(new URL(request.url()).pathname + new URL(request.url()).search, {
          headers: { origin, cookie: `${own.cookie.name}=${cartId}`, "content-type": headers["content-type"]!, "next-action": headers["next-action"]!, accept: headers.accept ?? "text/x-component" },
          data: body,
          maxRedirects: 0,
        });
        // Cause isolation (review 4d65c038 P2): the refusal must be the CSRF refusal, which submitCheckout raises
        // before placeOrder; the recovery redirect carries that message. Only a boolean leaves this function.
        const location = decodeURIComponent((res.headers()["x-action-redirect"] ?? res.headers().location ?? "").replaceAll("+", " "));
        return { csrfRefused: location.includes("Sesi formulir berubah") };
      } finally { await ctx.close(); }
    };
    const foreignBefore = await orders(foreign.cookie.value);
    expect((await send(foreign.cookie.value)).csrfRefused, "foreign cart is refused by the CSRF binding").toBe(true);
    expect(await orders(foreign.cookie.value), "foreign toko-b cart gets no order").toBe(foreignBefore);
    expect((await send(closedCart.cookie.value)).csrfRefused, "closed cart is refused by the CSRF binding").toBe(true);
    expect(await orders(closedCart.cookie.value), "closed cart gets no second order").toBe(1);
    expect(await orders(own.cookie.value), "refusals did not order the rendered cart").toBe(0);
    expect((await send(own.cookie.value)).csrfRefused, "own cart passes the CSRF binding").toBe(false);
    expect(await orders(own.cookie.value), "identical submission with its own cart creates exactly one order").toBe(1);
  } finally { await own.ctx.close(); await foreign.ctx.close(); await closedCart.ctx.close(); await sql.end(); }
});

test("T82 refused checkout capture and submit leave no contact or order effect; current token recovers", async ({ page }) => {
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await page.goto("/s/toko-a/products/kaos-katun-basic");
    await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
    await expect(page.getByRole("heading", { name: "Keranjang", exact: true })).toBeVisible();
    // Stays in memory: only used to scope the disposable-database assertions.
    const cartId = (await page.context().cookies()).find((c) => /bl_cart_/.test(c.name))?.value;
    expect(cartId).toBeTruthy();
    const effects = async () => {
      const [row] = await sql`select (select count(*)::int from checkout_session where cart_id = ${cartId!}) as captured, (select count(*)::int from "order" where cart_id = ${cartId!}) as orders`;
      return row as { captured: number; orders: number };
    };
    await page.goto("/checkout?store=toko-a");
    await chooseDestination(page);
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Buat pesanan" }) });
    const forged = `v1.${"A".repeat(43)}`;
    const field = form.locator('input[name="_csrf"]');
    const forge = () => field.evaluate((input: HTMLInputElement, value: string) => { input.value = value; }, forged);
    // Only a boolean leaves the request body; nothing is logged.
    const carriesForged = (r: { postData(): string | null }) => (r.postData() ?? "").includes(forged);
    await forge();
    // Typing triggers the debounced capture action with the forged token.
    const capture = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/checkout");
    await page.getByLabel("Nama").fill("Budi Ditolak");
    await page.getByLabel("Nomor HP").fill(testPhone());
    await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
    const captured = await capture;
    expect(carriesForged(captured), "capture request carried the forged token").toBe(true);
    await captured.response();
    expect(await effects(), "refused capture stores no contact").toEqual({ captured: 0, orders: 0 });
    // Re-apply right before submit: a client re-render may restore the rendered value.
    const restoredByClient = (await field.inputValue()) !== forged;
    console.info(JSON.stringify({ phase: "checkout field before submit", restoredByClient }));
    await forge();
    const submit = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/checkout");
    await page.getByRole("button", { name: "Buat pesanan" }).click();
    expect(carriesForged(await submit), "submit request carried the forged token").toBe(true);
    await expect(page.getByRole("alert").filter({ hasText: "Muat ulang" })).toBeVisible();
    expect(await effects(), "refused submit creates no order").toEqual({ captured: 0, orders: 0 });

    // Recovery with the current rendered token.
    await page.reload();
    await expect(page.getByTestId("destination-area")).toBeVisible();
    await page.getByLabel("Nama").fill("Budi Pulih");
    await page.getByLabel("Nomor HP").fill(testPhone());
    await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 2, Bandung 40111");
    await expect.poll(async () => (await effects()).captured, { timeout: 10_000 }).toBe(1);
    await page.getByRole("button", { name: "Buat pesanan" }).click();
    await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
    expect((await effects()).orders).toBe(1);
  } finally { await sql.end(); }
});

for (const width of [320, 390, 1280]) {
  test(`T82 a rendered cart token cannot authorize a replacement cart capability (${width}px)`, async ({ browser, baseURL }) => {
    const first = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
    const second = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
    const a = await first.newPage();
    const b = await second.newPage();
    const completed = new WeakSet<object>();
    const failed = new WeakSet<object>();
    const browserAborted = new WeakSet<object>();
    const documentCart = new WeakSet<object>();
    const observed: { phase: string; request: object; status: number }[] = [];
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const events = new WeakMap<object, { resourceType: string; navigation: boolean; method: string; routeClass: string; rsc: boolean; prefetch: boolean; status?: number; requestedAtMs: number; finishedAtMs?: number; failedAtMs?: number }>();
    const reads: { page: string; request: object }[] = [];
    const counts = [a, b].map(() => ({ productPosts: 0, cartPosts: 0, pageErrors: 0 }));
    let primaryFailure: unknown;
    let didFail = false;
    for (const [index, page] of [a, b].entries()) {
      const count = counts[index];
      page.on("pageerror", () => { count.pageErrors++; });
      page.on("requestfinished", request => {
        completed.add(request);
        const event = events.get(request);
        if (event) event.finishedAtMs = elapsed();
      });
      page.on("requestfailed", request => {
        failed.add(request);
        const event = events.get(request);
        if (event) event.failedAtMs = elapsed();
        if (request.failure()?.errorText === "net::ERR_ABORTED") browserAborted.add(request);
        if (request.method() === "GET" && event && (event.resourceType === "fetch" || event.navigation)) {
          console.info(JSON.stringify({ phase: "GET terminal failure", page: index === 0 ? "A" : "B", browserAborted: browserAborted.has(request), ...event, observedAtMs: elapsed() }));
        }
      });
      page.on("response", response => {
        const event = events.get(response.request());
        if (event) event.status = response.status();
      });
      page.on("request", request => {
        const pathname = new URL(request.url()).pathname;
        const headers = request.headers();
        const routeClass = pathname === "/s/toko-a/cart" ? "cart" : pathname.includes("/products/") ? "product" : pathname === "/checkout" ? "checkout" : pathname.startsWith("/s/") ? "store-other" : "other";
        events.set(request, { resourceType: request.resourceType(), navigation: request.isNavigationRequest(), method: request.method(), routeClass, rsc: headers.rsc === "1", prefetch: headers["next-router-prefetch"] === "1" || headers.purpose === "prefetch", requestedAtMs: elapsed() });
        if (request.method() === "GET" && (request.resourceType() === "fetch" || request.isNavigationRequest())) reads.push({ page: index === 0 ? "A" : "B", request });
        if (request.isNavigationRequest() && pathname === "/s/toko-a/cart") documentCart.add(page);
        if (request.method() === "POST" && pathname === "/s/toko-a/products/kaos-katun-basic") count.productPosts++;
        if (request.method() === "POST" && pathname === "/s/toko-a/cart") count.cartPosts++;
      });
    }
    try {
      for (const [index, current] of [a, b].entries()) {
        const label = index === 0 ? "A" : "B";
        await test.step(`${label} product readiness`, async () => {
          await current.goto("/s/toko-a/products/kaos-katun-basic");
          await expect(current.locator('input[name="_csrf"]')).toHaveCount(1);
        }, { timeout: 8_000 });
        const actionPath = new URL(current.url()).pathname;
        const [addition] = await test.step(`${label} addition receipt`, () => Promise.all([
          current.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === actionPath),
          current.getByRole("button", { name: "Tambah ke keranjang" }).click(),
        ]), { timeout: 8_000 });
        observed.push({ phase: `${label} addition`, request: addition.request(), status: addition.status() });
        console.info(JSON.stringify({ phase: `${label} addition receipt`, status: addition.status(), observedAtMs: elapsed() }));
        await test.step(`${label} addition terminal event`, async () => {
          await expect.poll(() => completed.has(addition.request()) || failed.has(addition.request()), { timeout: 4_000 }).toBe(true);
        }, { timeout: 5_000 });
        await test.step(`${label} cart readiness`, async () => {
          await expect(current.getByRole("heading", { name: "Keranjang", exact: true })).toBeVisible();
          console.info(JSON.stringify({ phase: `${label} cart ready`, observedAtMs: elapsed() }));
        }, { timeout: 5_000 });
      }
      const replacement = (await second.cookies()).filter(cookie => /bl_cart_/.test(cookie.name));
      expect(replacement.length).toBe(1);
      await first.addCookies(replacement);
      await a.getByRole("spinbutton", { name: /Jumlah/ }).fill("9");
      const [refusal] = await test.step("refusal receipt", () => Promise.all([
        a.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/s/toko-a/cart"),
        a.getByRole("button", { name: "Ubah", exact: true }).click(),
      ]), { timeout: 8_000 });
      observed.push({ phase: "refusal", request: refusal.request(), status: refusal.status() });
      console.info(JSON.stringify({ phase: "refusal receipt", status: refusal.status(), observedAtMs: elapsed() }));
      await test.step("refusal terminal event", async () => {
        await expect.poll(() => completed.has(refusal.request()) || failed.has(refusal.request()), { timeout: 4_000 }).toBe(true);
      }, { timeout: 5_000 });
      await test.step("recipient reload", async () => {
        console.info(JSON.stringify({ phase: "reads before recipient reload", reads: reads.map(read => ({ page: read.page, ...events.get(read.request), finished: completed.has(read.request), failed: failed.has(read.request) })), observedAtMs: elapsed() }));
        console.info(JSON.stringify({ phase: "recipient reload begins", observedAtMs: elapsed() }));
        await b.reload();
        console.info(JSON.stringify({ phase: "recipient reload ready", observedAtMs: elapsed() }));
      }, { timeout: 8_000 });
      // Recipient state must be checked before the recovery Notice.
      await test.step("recipient quantity", async () => {
        await expect(b.getByRole("spinbutton", { name: /Jumlah/ })).toHaveValue("1", { timeout: 2_000 });
      }, { timeout: 5_000 });
      await test.step("filtered Notice", async () => {
        await expect(a.getByRole("alert").filter({ hasText: "Muat ulang" })).toBeVisible();
      }, { timeout: 5_000 });
      console.info(JSON.stringify({ phase: "security observations", recipientUnchanged: true, recoveryNoticeVisible: true, observedAtMs: elapsed() }));
      await test.step("one POST per intended click and no page errors", async () => {
        expect(counts).toEqual([
          { productPosts: 1, cartPosts: 1, pageErrors: 0 },
          { productPosts: 1, cartPosts: 0, pageErrors: 0 },
        ]);
      }, { timeout: 5_000 });
    } catch (error) {
      didFail = true;
      primaryFailure = error;
    } finally {
      for (const observation of observed) {
        console.info(JSON.stringify({ phase: "before teardown", action: observation.phase, status: observation.status, finished: completed.has(observation.request), failed: failed.has(observation.request), browserAborted: browserAborted.has(observation.request), ...events.get(observation.request), observedAtMs: elapsed() }));
      }
      console.info(JSON.stringify({ phase: "request counts and page errors", pages: counts, observedAtMs: elapsed() }));
      console.info(JSON.stringify({ phase: "reads before teardown", reads: reads.map(read => ({ page: read.page, ...events.get(read.request), finished: completed.has(read.request), failed: failed.has(read.request) })), observedAtMs: elapsed() }));
      const ui = await Promise.allSettled([a, b].map(page => page.getByRole("heading", { name: "Keranjang", exact: true }).isVisible()));
      console.info(JSON.stringify({ phase: "before teardown UI", cartA: ui[0].status === "fulfilled" ? ui[0].value : null, cartB: ui[1].status === "fulfilled" ? ui[1].value : null, documentCartA: documentCart.has(a), documentCartB: documentCart.has(b) }));
      const cleanup = await Promise.allSettled([
        test.step("close A", () => first.close(), { timeout: 5_000 }),
        test.step("close B", () => second.close(), { timeout: 5_000 }),
      ]);
      console.info(JSON.stringify({ phase: "cleanup", closedA: cleanup[0].status === "fulfilled", closedB: cleanup[1].status === "fulfilled", observedAtMs: elapsed() }));
      if (!didFail) {
        const failure = cleanup.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
    }
    if (didFail) throw primaryFailure;
  });
}
