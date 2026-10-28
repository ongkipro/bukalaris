import { expect, test, type Page, type TestInfo } from "@playwright/test";
import postgres from "postgres";
import { chooseDestination, evidence, login, testPhone } from "./helpers";

// T-52 (platform affiliate data model and checkout attribution): the referral link `GET /r/<token>`, the typed code, malformed / expired / self-referral selectors that must
// still place the order, cookie stuffing, a forged cross-store click, a duplicate submit and the existing landing-page handoff. Database facts come from the superuser URL of the
// disposable e2e database, never from the app under test. Synthetic contacts only. The resolver matrix, concurrency, retention and role isolation are proven against PostgreSQL in
// packages/db/test/t52-*.test.ts.
const url = process.env.E2E_DATABASE_URL;
if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
const sql = postgres(url, { max: 1, onnotice: () => {} });
test.afterAll(async () => {
  await sql`update affiliate_seller_policy set participation = 'closed'`; // leave the shared seed the way later specs expect it: no store open to affiliates
  await sql.end();
});

const canonical = (phone: string) => `62${phone.replace(/^\+?(62|0)/, "")}`;
let seq = 0;
const proj = (info: TestInfo) => (info.project.name === "desktop" ? "D" : "M");
const unique = (info: TestInfo, what: string) => `${what}${proj(info)}${Date.now().toString(36)}${(seq++).toString(36)}`.toUpperCase();

/** Open toko-a to affiliates (10 %) with the seed's first product opted in. Idempotent: every test calls it. */
async function openStoreA() {
  const [store] = await sql`select id from store where slug = 'toko-a'`;
  const [product] = await sql`select id from product where store_id = ${store!.id} and title = 'Kaos Katun Basic'`;
  await sql`insert into affiliate_seller_policy (store_id, participation, default_rate_bps, updated_by) values (${store!.id}, 'open', 1000, 't52-e2e') on conflict (store_id) do update set participation = 'open', default_rate_bps = 1000`;
  await sql`insert into affiliate_offer (store_id, product_id, rate_bps, updated_by) values (${store!.id}, ${product!.id}, null, 't52-e2e') on conflict (store_id, source, product_id) do update set status = 'active', rate_bps = null`;
  return store!.id as number;
}
/** A synthetic active affiliate with its own user, phone, code and links to toko-a and toko-b. */
async function makeAffiliate(info: TestInfo, phone = testPhone()) {
  const userId = `t52-${unique(info, "U").toLowerCase()}`;
  await sql`insert into "user" (id, name, email, email_verified) values (${userId}, 'Afiliasi Uji', ${`${userId}@example.com`}, true)`;
  const [a] = await sql`insert into affiliate (user_id, display_name, contact_phone) values (${userId}, 'Afiliasi Uji', ${canonical(phone)}) returning id`;
  await sql`update affiliate set status = 'active' where id = ${a!.id}`;
  const code = unique(info, "KODE");
  await sql`insert into affiliate_code (affiliate_id, code) values (${a!.id}, ${code})`;
  const tokenA = `tok${unique(info, "A")}${"x".repeat(12)}`;
  const tokenB = `tok${unique(info, "B")}${"x".repeat(12)}`;
  const [sa] = await sql`select id from store where slug = 'toko-a'`;
  const [sb] = await sql`select id from store where slug = 'toko-b'`;
  await sql`insert into affiliate_link (affiliate_id, token, store_id) values (${a!.id}, ${tokenA}, ${sa!.id}), (${a!.id}, ${tokenB}, ${sb!.id})`;
  return { id: Number(a!.id), phone, code, tokenA, tokenB };
}

/** The checkout from the storefront product page, without clearing cookies (the referral cookie must survive). */
async function buy(page: Page, o: { phone: string; code?: string; startAt?: string; double?: boolean }) {
  await page.goto(o.startAt ?? "/s/toko-a");
  await page.getByRole("link", { name: /Kaos Katun Basic/ }).first().click();
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  return finishCheckout(page, o);
}
async function finishCheckout(page: Page, o: { phone: string; code?: string; double?: boolean }) {
  await chooseDestination(page);
  await page.getByLabel("Nama").fill("Pembeli T52");
  await page.getByLabel("Nomor HP").fill(o.phone);
  await page.getByLabel("Alamat lengkap").fill("Jl. Afiliasi No. 52, Bandung 40111");
  if (o.code !== undefined) await page.getByLabel("Kode afiliasi (opsional)").fill(o.code);
  const submit = page.getByRole("button", { name: "Buat pesanan" });
  if (o.double) await submit.dblclick();
  else await submit.click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible({ timeout: 30_000 }); // a loaded shared machine: the order transaction is slower than the default 5 s
  return Number((await page.getByTestId("order-id").textContent())!.replace("#", ""));
}
const attribution = async (orderId: number) => (await sql`select a.method, a.click_id, a.commission_idr, a.commission_base_idr, a.status, a.store_id, a.affiliate_id from affiliate_attribution a where a.order_id = ${orderId}`)[0];
const financials = async (orderId: number) => (await sql`select goods_proceeds_idr, affiliate_commission_idr, sale_amount_idr, payable_idr, affiliate_id from order_financials where order_id = ${orderId}`)[0]!;
// The suite runs the production build: the continuity cookie carries the `__Host-` prefix there (Secure, Path=/, no Domain), plain `bl_click` in development.
const COOKIE = "__Host-bl_click";
/** Every Set-Cookie of the continuity cookie in a response (the proxy's own request-id cookie is not ours). */
const setCookies = (res: { headersArray(): { name: string; value: string }[] }) => res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie" && h.value.includes("bl_click")).map((h) => h.value);
const cookieOf = async (page: Page) => (await page.context().cookies()).find((c) => c.name === COOKIE);

test("a referral link captures one click on a navigation, and the guest checkout earns the single-floor commission with the buyer's total unchanged", async ({ page }, info) => {
  await openStoreA();
  const a = await makeAffiliate(info);
  await page.context().clearCookies();
  await page.goto(`/r/${a.tokenA}`);
  await expect(page).toHaveURL(/\/s\/toko-a$/); // the destination comes from the link record
  const cookie = (await cookieOf(page))!;
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  expect(cookie.value).toMatch(/^c[0-9a-f]{32}$/);
  expect(cookie.domain).not.toMatch(/^\./); // host-only: no Domain attribute
  await evidence(page, info, "t52-link-landing");
  const clicks = await sql`select id, store_id, affiliate_id from affiliate_click where link_id = (select id from affiliate_link where token = ${a.tokenA})`;
  expect(clicks).toHaveLength(1);
  expect(clicks[0]!.id).toBe(cookie.value);

  const phone = testPhone();
  const orderId = await buy(page, { phone });
  await evidence(page, info, "t52-link-confirmation");
  const f = await financials(orderId);
  expect(Number(f.affiliate_commission_idr)).toBe(Math.floor((Number(f.goods_proceeds_idr) * 1000) / 10_000));
  expect(Number(f.sale_amount_idr)).toBe(Number(f.goods_proceeds_idr) - Number(f.affiliate_commission_idr));
  expect(Number(f.affiliate_id)).toBe(a.id);
  expect(await attribution(orderId)).toMatchObject({ method: "link", click_id: cookie.value, status: "pending", affiliate_id: String(a.id) });
  // the buyer's page shows what it always showed: no commission, no affiliate, no rate
  const text = await page.getByRole("main").innerText();
  expect(text).not.toMatch(/komisi|afiliasi|commission|affiliate/i);
});

test("a typed code earns without any click, and every spelling of it works", async ({ page }, info) => {
  await openStoreA();
  const a = await makeAffiliate(info);
  await page.context().clearCookies();
  const orderId = await buy(page, { phone: testPhone(), code: ` ${a.code.slice(0, 4).toLowerCase()}-${a.code.slice(4).toLowerCase()} ` });
  expect(await attribution(orderId)).toMatchObject({ method: "code", click_id: null, affiliate_id: String(a.id) });
  expect(Number((await financials(orderId)).affiliate_commission_idr)).toBeGreaterThan(0);
  await evidence(page, info, "t52-code-confirmation");
});

test("malformed, expired, unknown and self-referral selectors still place the order and earn nothing", async ({ page }, info) => {
  await openStoreA();
  const a = await makeAffiliate(info);
  await sql`insert into affiliate_code (affiliate_id, code, expires_at) values (${a.id}, ${`OLD${a.code}`.slice(0, 24)}, now() - interval '1 minute')`;
  await page.context().clearCookies();
  const placed: number[] = [];
  for (const code of ["!!", "x", `OLD${a.code}`.slice(0, 24), "TIDAKADA999", "'; drop table affiliate; --", "kodé😀"]) {
    const orderId = await buy(page, { phone: testPhone(), code });
    placed.push(orderId);
    expect(await attribution(orderId), code).toBeUndefined();
    expect(Number((await financials(orderId)).affiliate_commission_idr)).toBe(0);
  }
  // self-referral: the affiliate's own phone, typed in another spelling, with its own valid code
  const before = Number((await sql`select coalesce(sum(n), 0)::int as n from affiliate_counter where kind = 'self_referral_suppressed' and affiliate_id = ${a.id}`)[0]!.n);
  const own = await buy(page, { phone: `+62${a.phone.slice(1)}`, code: a.code });
  placed.push(own);
  expect(await attribution(own)).toBeUndefined();
  expect(Number((await sql`select coalesce(sum(n), 0)::int as n from affiliate_counter where kind = 'self_referral_suppressed' and affiliate_id = ${a.id}`)[0]!.n)).toBe(before + 1);
  expect(new Set(placed).size).toBe(placed.length);
  await evidence(page, info, "t52-selectors-confirmation");
});

test("cookie stuffing: an <img>, a hidden iframe and a plain request redirect without a click; only a real navigation captures (SEC-20)", async ({ page, request }, info) => {
  await openStoreA();
  const a = await makeAffiliate(info);
  await page.context().clearCookies();
  const base = new URL(page.url() === "about:blank" ? (info.project.use.baseURL as string) : page.url()).origin;
  await page.setContent(`<img src="${base}/r/${a.tokenA}" width="1" height="1"><iframe src="${base}/r/${a.tokenA}" style="display:none"></iframe><script src="${base}/r/${a.tokenA}"></script>`);
  await page.waitForTimeout(1_500);
  expect(await cookieOf(page)).toBeUndefined();
  const embedded = await sql`select count(*)::int as n from affiliate_click where link_id = (select id from affiliate_link where token = ${a.tokenA})`;
  expect(embedded[0]!.n).toBe(0);
  // a request without Fetch Metadata (curl, a crawler): the buyer is redirected, nothing is stored or set
  const plain = await request.get(`/r/${a.tokenA}`, { maxRedirects: 0 });
  expect(plain.status()).toBe(302);
  expect(plain.headers()["location"]).toMatch(/\/s\/toko-a$/);
  expect(setCookies(plain)).toEqual([]);
  expect((await sql`select count(*)::int as n from affiliate_click where link_id = (select id from affiliate_link where token = ${a.tokenA})`)[0]!.n).toBe(0);
  // unknown and revoked tokens give one identical not-found, with no cookie
  await sql`update affiliate_link set status = 'revoked', revoked_at = now() where token = ${a.tokenB}`;
  const unknown = await request.get(`/r/${"z".repeat(24)}`, { maxRedirects: 0 });
  const revoked = await request.get(`/r/${a.tokenB}`, { maxRedirects: 0 });
  expect([unknown.status(), revoked.status()]).toEqual([404, 404]);
  expect(await revoked.text()).toBe(await unknown.text());
  expect(setCookies(unknown)).toEqual([]);
  expect(setCookies(revoked)).toEqual([]);
  // a genuine navigation then captures exactly one
  await page.goto(`/r/${a.tokenA}`);
  expect(await cookieOf(page)).toBeDefined();
  expect((await sql`select count(*)::int as n from affiliate_click where link_id = (select id from affiliate_link where token = ${a.tokenA})`)[0]!.n).toBe(1);
  // the redirect answer carries no buyer, order or query data
  const head = await request.get(`/r/${a.tokenA}`, { maxRedirects: 0 });
  expect(head.headers()["location"]).not.toContain("?");
  expect(await head.text()).toBe("");
});

test("a forged or cross-store click cannot change checkout authority: the order is placed at the cart's own store and earns nothing", async ({ page }, info) => {
  await openStoreA();
  const a = await makeAffiliate(info);
  await page.context().clearCookies();
  await page.goto(`/r/${a.tokenB}`); // a genuine click, but for toko-b
  const bClick = (await cookieOf(page))!.value;
  expect(bClick).toMatch(/^c[0-9a-f]{32}$/);
  const orderId = await buy(page, { phone: testPhone() }); // checkout at toko-a with toko-b's click in the cookie
  expect(await attribution(orderId)).toBeUndefined();
  const [o] = await sql`select o.store_id, s.slug from "order" o join store s on s.id = o.store_id where o.id = ${orderId}`;
  expect(o!.slug).toBe("toko-a");
  // a forged id and a tampered genuine one are inert as well: replace the cookie the browser sends with a hand-made value
  const flipped = `${bClick.slice(0, -1)}${bClick.endsWith("0") ? "1" : "0"}`;
  await page.route("**/checkout**", async (route) => {
    const headers = { ...route.request().headers() };
    headers["cookie"] = `${(headers["cookie"] ?? "").split("; ").filter((c) => !c.startsWith(`${COOKIE}=`)).join("; ")}; ${COOKIE}=c${"0".repeat(32)}.${flipped}.not-an-id`;
    await route.continue({ headers });
  });
  const forged = await buy(page, { phone: testPhone() });
  expect(await attribution(forged)).toBeUndefined();
});

test("a duplicate submit yields one order, one attribution and one deduction", async ({ page }, info) => {
  await openStoreA();
  const a = await makeAffiliate(info);
  await page.context().clearCookies();
  const phone = testPhone();
  const first = await buy(page, { phone, code: a.code, double: true });
  await page.waitForTimeout(1_000);
  expect((await sql`select count(*)::int as n from "order" where buyer_phone = ${phone}`)[0]!.n).toBe(1);
  expect((await sql`select count(*)::int as n from affiliate_attribution where affiliate_id = ${a.id}`)[0]!.n).toBe(1);
  expect(await attribution(first)).toMatchObject({ method: "code" });
  expect((await sql`select count(*)::int as n from order_financials where affiliate_id = ${a.id} and affiliate_commission_idr > 0`)[0]!.n).toBe(1);
});

test("the existing landing-page handoff keeps the seller and the attribution", async ({ page }, info) => {
  await openStoreA();
  const a = await makeAffiliate(info);
  const slug = `afiliasi-${proj(info).toLowerCase()}-${Date.now().toString(36)}`;
  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller/landing-pages");
  await page.getByRole("link", { name: "Buat landing page" }).first().click();
  await page.getByLabel("Judul").fill(`Promo Afiliasi ${slug}`);
  await page.getByLabel("Slug URL").fill(slug);
  await page.getByRole("button", { name: "Buat dan lanjut mengedit" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await page.getByLabel("Tambah blok").selectOption("order");
  await page.getByRole("button", { name: "Tambah blok" }).click();
  await expect(page.getByTestId("draft-revision")).toHaveText("2");
  const order = page.getByTestId("block-order");
  await order.getByLabel("Produk").selectOption({ label: "Kaos Katun Basic" });
  await order.getByRole("button", { name: /Simpan blok/ }).click();
  await expect(page.getByTestId("draft-revision")).toHaveText("3");
  await page.getByRole("button", { name: "Publikasikan", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Landing page dipublikasikan.");
  // the buyer: a fresh browser state, the affiliate's link, then the published landing page of the SAME store
  await page.context().clearCookies();
  await page.goto(`/r/${a.tokenA}`);
  const cookie = (await cookieOf(page))!.value;
  await page.goto(`/s/toko-a/lp/${slug}`);
  const section = page.locator("#order");
  await section.getByRole("radio").first().check();
  await section.getByRole("button", { name: "Lanjut ke checkout" }).click();
  await expect(page).toHaveURL(/\/checkout\?store=toko-a$/);
  const orderId = await finishCheckout(page, { phone: testPhone() });
  expect(await attribution(orderId)).toMatchObject({ method: "link", click_id: cookie, affiliate_id: String(a.id) });
  const [o] = await sql`select s.slug from "order" o join store s on s.id = o.store_id where o.id = ${orderId}`;
  expect(o!.slug).toBe("toko-a"); // the selected seller is preserved
  await evidence(page, info, "t52-landing-handoff-confirmation");
});
