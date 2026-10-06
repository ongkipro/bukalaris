import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { chooseDestination, evidence, login } from "./helpers";

// signals track (T-38, PR-20). The seller configures Meta + TikTok with fake ids; the buyer
// funnel fires the browser pixels and the server leg with the SAME event ids. Every
// third-party request is intercepted here: the vendor loaders are replaced by recording
// stubs and anything else is aborted, so nothing reaches Meta, TikTok or Google. The
// worker runs in simulation mode (no SIGNALS_LIVE), so the server rows end as `simulated`.

const META_PIXEL = "123456789012345";
const TIKTOK_PIXEL = "C0FAKEPIXEL0001";
/** Recorded pixel call: `[docId, method, ...args]`; docId identifies the document that made it. */
type Call = unknown[];

/** Both stubs persist calls in sessionStorage so they survive the full-page loads of the funnel. */
const RECORDER = `var D=Math.random().toString(36).slice(2);function rec(k,c){var a=JSON.parse(sessionStorage.getItem(k)||"[]");a.push([D].concat(c));sessionStorage.setItem(k,JSON.stringify(a));}`;
/** Stub for fbevents.js: drains the base-code queue and records every later call. */
const FAKE_FBEVENTS = `(function(){${RECORDER}var f=window.fbq;(f.queue||[]).forEach(function(c){rec("fbq",Array.prototype.slice.call(c))});f.queue=[];f.callMethod=function(){rec("fbq",Array.prototype.slice.call(arguments))};})();`;
/** Stub for TikTok events.js: the base code queues [method, ...args] onto the ttq array. */
const FAKE_TTQ = `(function(){${RECORDER}var q=window.ttq;q.forEach(function(c){rec("ttq",c)});q.length=0;["page","track","identify"].forEach(function(m){q[m]=function(){rec("ttq",[m].concat(Array.prototype.slice.call(arguments)))}});})();`;

async function interceptThirdParties(page: Page) {
  const external: string[] = [];
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, async (route) => {
    const url = route.request().url();
    external.push(url);
    if (url.startsWith("https://connect.facebook.net/")) return route.fulfill({ status: 200, contentType: "application/javascript", body: FAKE_FBEVENTS });
    if (url.startsWith("https://analytics.tiktok.com/i18n/pixel/events.js")) return route.fulfill({ status: 200, contentType: "application/javascript", body: FAKE_TTQ });
    return route.abort("blockedbyclient");
  });
  return external;
}

const calls = (page: Page) =>
  page.evaluate(() => {
    const read = (k: string) => JSON.parse(sessionStorage.getItem(k) ?? "[]") as unknown[][];
    return { fbq: read("fbq"), ttq: read("ttq") };
  });
/** Calls of one method (and event name) without the leading document id. */
const of = (list: Call[], method: string, name?: string) => list.filter((c) => c[1] === method && (name === undefined || c[2] === name)).map((c) => c.slice(1));
const tracks = (list: Call[], name: string) => of(list, "track", name);

async function configure(page: Page, info: { project: { name: string } }) {
  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller/marketing");
  await expect(page.getByRole("heading", { name: "Pemasaran" })).toBeVisible();
  await expect(page.getByTestId("signals-mode")).toContainText("simulasi");

  const meta = page.getByTestId("destination-meta");
  await meta.getByLabel("Pixel ID").fill(META_PIXEL);
  await meta.getByLabel("Access token Conversions API").fill("EAAB-fake-token-never-sent");
  await meta.getByLabel("Kode test event (opsional)").fill("TEST12345");
  await meta.getByLabel("Aktifkan pengiriman event").check();
  await meta.getByRole("button", { name: "Simpan Meta" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await expect(page.getByTestId("destination-meta")).toContainText("Aktif");
  // Write-only: the token never comes back into the form or the page.
  await expect(page.getByTestId("destination-meta").getByLabel("Access token Conversions API")).toHaveValue("");
  expect(await page.content()).not.toContain("EAAB-fake");
  await expect(page.getByTestId("destination-meta")).toContainText("Token terakhir disimpan");

  const tiktok = page.getByTestId("destination-tiktok");
  await tiktok.getByLabel("Pixel Code").fill(TIKTOK_PIXEL);
  await tiktok.getByLabel("Access token Events API").fill("tt-fake-token-never-sent");
  await tiktok.getByLabel("Aktifkan pengiriman event").check();
  await tiktok.getByRole("button", { name: "Simpan TikTok" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await expect(page.getByTestId("destination-tiktok")).toContainText("Aktif");
  await evidence(page, info as never, "70-marketing-settings");

  // Validation: a non-numeric Meta pixel id is refused with the hint.
  await page.getByTestId("destination-meta").getByLabel("Pixel ID").fill("abc");
  await page.getByTestId("destination-meta").getByRole("button", { name: "Simpan Meta" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("5–20 digit");
  await page.context().clearCookies();
}

test("seller configures Meta + TikTok; storefront → checkout → confirmation fires browser events whose ids the server queued; nothing leaves the test", async ({ page }, info) => {
  await configure(page, info);
  const external = await interceptThirdParties(page);

  // Landing with ad click ids: captured first-party (last click wins), later stored with the order.
  await page.goto("/s/toko-a?fbclid=IwAR1e2eclick&utm_source=facebook&utm_campaign=promo");
  await expect(page.getByRole("heading", { name: "Produk" })).toBeVisible();
  await expect.poll(() => calls(page).then((c) => c.fbq.length)).toBeGreaterThan(0);
  const cookies = await page.context().cookies();
  expect(JSON.parse(decodeURIComponent(cookies.find((c) => c.name === "bl_click")!.value))).toMatchObject({ fbclid: "IwAR1e2eclick", utm: { source: "facebook", campaign: "promo" } });

  const serverIds = new Map<string, string>();
  page.on("request", (r) => {
    if (r.url().endsWith("/api/signals") && r.method() === "POST") {
      const body = r.postDataJSON() as { event: string; eventId: string };
      serverIds.set(body.event, body.eventId);
    }
  });
  const collected = page.waitForResponse((r) => r.url().endsWith("/api/signals") && r.status() === 204);
  await page.getByRole("link", { name: /Kaos Katun Basic/ }).click();
  await expect(page).toHaveURL(/\/products\/kaos-katun-basic$/);
  await collected;
  await page.getByLabel("Jumlah").fill("2");
  const added = page.waitForResponse((r) => r.url().endsWith("/api/signals") && r.status() === 204);
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(page.getByRole("heading", { name: "Keranjang" })).toBeVisible();
  await added;
  const initiated = page.waitForResponse((r) => r.url().endsWith("/api/signals") && r.status() === 204);
  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page.getByRole("heading", { name: /Checkout · Toko Ayu/ })).toBeVisible();
  await initiated;
  await chooseDestination(page);
  await page.getByLabel("Nama").fill("Budi Santoso");
  // Own phone: the per-phone order limit (10 / 10 min, T-30) is shared by every spec that uses the seed buyer.
  await page.getByLabel("Nomor HP").fill("081355501234");
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const orderId = Number(await page.getByTestId("order-id").innerText().then((t) => t.replace("#", "")));
  const purchaseId = `purchase:${orderId}`;
  await expect(page.locator(`[data-purchase-event="${purchaseId}"]`)).toBeVisible();
  await expect.poll(() => calls(page).then((c) => tracks(c.fbq, "Purchase").length)).toBe(1);
  await evidence(page, info, "71-confirmation-signals");

  // Browser leg: one init per pixel, funnel events with the ids reported to the server, Purchase with the server id.
  const { fbq, ttq } = await calls(page);
  // Exactly one init per document (never a re-init on Purchase), and the same pixel id everywhere.
  const inits = fbq.filter((c) => c[1] === "init");
  expect(inits.every((c) => c[2] === META_PIXEL)).toBe(true);
  expect(new Set(inits.map((c) => c[0])).size).toBe(inits.length);
  expect(inits.length).toBeGreaterThanOrEqual(1);
  expect(tracks(fbq, "PageView").length).toBeGreaterThanOrEqual(4);
  for (const name of ["ViewContent", "AddToCart", "InitiateCheckout"]) {
    const [call] = tracks(fbq, name);
    expect(call, name).toBeTruthy();
    expect((call![3] as { eventID: string }).eventID, name).toBe(serverIds.get(name));
    expect((call![2] as { currency: string }).currency).toBe("IDR");
  }
  const [purchase] = tracks(fbq, "Purchase");
  expect(purchase![3]).toEqual({ eventID: purchaseId });
  expect(purchase![2]).toMatchObject({ value: 178_000, currency: "IDR", content_type: "product", order_id: String(orderId) });
  expect((purchase![2] as { content_ids: string[] }).content_ids[0]).toMatch(/^[0-9]{5,}$/);
  // `ttq.load` is not a queued method: the loader request (one per document, our pixel code) is the evidence.
  const loads = external.filter((u) => u.includes("sdkid="));
  expect(loads.length).toBe(inits.length);
  expect(loads.every((u) => u.includes(`sdkid=${TIKTOK_PIXEL}&`))).toBe(true);
  const [ttPurchase] = tracks(ttq, "Purchase");
  expect(ttPurchase![3]).toEqual({ event_id: purchaseId });
  expect(ttPurchase![2]).toMatchObject({ value: 178_000, currency: "IDR" });
  expect(of(ttq, "identify")[0]![1]).toMatchObject({ phone_number: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect((tracks(ttq, "ViewContent")[0]![3] as { event_id: string }).event_id).toBe(serverIds.get("ViewContent"));

  // Nothing left the test: every external request was answered or aborted here.
  expect(external.length).toBeGreaterThan(0);
  expect(external.every((u) => /^https:\/\/(connect\.facebook\.net|analytics\.tiktok\.com|www\.facebook\.com)\//.test(u)), external.join("\n")).toBe(true);

  // Server leg: same ids, both destinations, value = goods subtotal (no shipping), context stored, then simulated by the worker.
  const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    const ids = [...serverIds.values(), purchaseId];
    const rows = await sql<{ provider: string; event_id: string; event_name: string; status: string; payload: Record<string, unknown> }[]>`
      select provider, event_id, event_name, status, payload from signal_event
      where event_id in ${sql(ids)} and store_id = (select id from store where slug = 'toko-a') order by provider, event_name`;
    expect(rows.map((r) => `${r.provider}:${r.event_name}`).sort()).toEqual(
      ["meta", "tiktok"].flatMap((p) => ["AddToCart", "InitiateCheckout", "Purchase", "ViewContent"].map((e) => `${p}:${e}`)).sort(),
    );
    const purchaseRow = rows.find((r) => r.provider === "meta" && r.event_name === "Purchase")!;
    expect(purchaseRow.payload).toMatchObject({ value: 178_000, currency: "IDR", orderId: String(orderId) });
    expect((purchaseRow.payload.user as Record<string, unknown>).fbc).toMatch(/^fb\.1\.[0-9]+\.IwAR1e2eclick$/);
    expect(JSON.stringify(purchaseRow.payload)).not.toContain("081355501234");
    const [ctx] = await sql`select fbc, utm, client_ip, user_agent from order_signal_context where order_id = ${orderId}`;
    expect(ctx!.fbc).toMatch(/IwAR1e2eclick$/);
    expect(ctx!.utm).toMatchObject({ source: "facebook", campaign: "promo" });
    expect(ctx!.user_agent).toBeTruthy();
    await expect
      .poll(async () => (await sql`select count(*)::int as n from signal_event where event_id in ${sql(ids)} and status = 'simulated'`)[0]!.n, { timeout: 20_000 })
      .toBe(8);
  } finally {
    await sql.end();
  }

  // Seller health shows the simulated deliveries; staff cannot open the page's settings.
  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller/marketing");
  await expect(page.getByTestId("health-meta")).toContainText("Simulasi");
  const simulated = await page.getByTestId("health-meta").locator("dd").nth(1).innerText();
  expect(Number(simulated)).toBeGreaterThanOrEqual(4);
  await evidence(page, info, "72-marketing-health");
});

test("storefront without destinations loads no pixel and seller/admin never mount one; staff is read-only", async ({ page }) => {
  const external = await interceptThirdParties(page);
  await page.goto("/s/toko-b");
  await expect(page.getByRole("heading", { name: "Produk" })).toBeVisible();
  await page.getByRole("link", { name: /Kopi Arabika/ }).click();
  await expect(page.getByRole("button", { name: "Tambah ke keranjang" })).toBeVisible();
  expect(await page.evaluate(() => ({ fbq: typeof window.fbq, ttq: typeof window.ttq, gtag: typeof window.gtag }))).toEqual({ fbq: "undefined", ttq: "undefined", gtag: "undefined" });
  expect(external).toEqual([]);

  await login(page, "staff-a@bukalaris.local");
  await page.goto("/seller/marketing");
  await expect(page.getByRole("note")).toContainText("Hanya pemilik toko");
  await expect(page.getByRole("button", { name: /Simpan/ })).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.fbq)).toBe("undefined");
  expect(external).toEqual([]);
});
