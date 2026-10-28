import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import postgres from "postgres";
import { chooseDestination, evidence, login, testPhone } from "./helpers";

// T-45 (PR-25, UX-15, SC-26): hosted checkout captures what the buyer typed (after the notice, nothing before), the cleanup sweep abandons an idle
// session, the seller queue ranks it and opens wa.me with a signed resume link (recording "WA dibuka"), the buyer resumes through the link and orders,
// and the honest Recovery Rate counts that rescue. Both viewports (320 and desktop). Rates math, guard, token tamper/expiry/wrong-store, redaction and
// cross-store denial are proven on real PostgreSQL in packages/db/test/t45-*.test.ts.
const url = process.env.E2E_DATABASE_URL;
if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
const sql = postgres(url, { max: 1, onnotice: () => {} });
const DB_CWD = resolve(process.cwd(), "../../packages/db");
const clean = () => sql`truncate checkout_session`;
test.describe.configure({ mode: "serial" });
test.beforeAll(clean);
test.afterAll(async () => {
  await clean();
  await sql.end();
});

const phone = testPhone();
let resumeUrl = "";
let subtotalText = "";

const sessions = () => sql`select cs.id, cs.status, cs.buyer_name, cs.buyer_phone, cs.shipping_address, cs.subtotal_idr, cs.abandoned_at, cs.recovered_at, cs.wa_opened_at, s.slug from checkout_session cs join store s on s.id = cs.store_id order by cs.id`;
/** The cleanup command as cron runs it, on the platform role. */
const cleanup = () => execFileSync("node", ["src/cleanup.ts"], { cwd: DB_CWD, env: { ...process.env, PLATFORM_DATABASE_URL: process.env.E2E_PLATFORM_DATABASE_URL }, stdio: "pipe" });
const percent = (n: number, d: number) => (d === 0 ? "—" : `${(Math.round((n * 10_000) / d) / 100).toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`);

async function toCheckout(page: Page) {
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  await page.getByLabel("Jumlah").fill("2");
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page.getByRole("heading", { name: /Checkout · Toko Ayu/ })).toBeVisible();
  await chooseDestination(page);
}

test("checkout: the notice is shown, nothing is stored before the buyer types, then name, phone and address are captured for this store", async ({ page }, info) => {
  await toCheckout(page);
  await expect(page.getByTestId("capture-notice")).toContainText("disimpan sementara");
  await expect(page.getByTestId("capture-notice")).toContainText("tidak dibagikan ke platform iklan");
  subtotalText = (await page.getByTestId("subtotal").textContent()) ?? "";
  await page.waitForTimeout(2500); // longer than the debounce: an untouched form sends nothing
  expect(await sessions()).toEqual([]);

  await page.getByLabel("Nama").fill("Siti Aminah");
  await expect.poll(async () => (await sessions())[0]?.buyer_name, { timeout: 15_000 }).toBe("Siti Aminah");
  expect((await sessions())[0]).toMatchObject({ status: "active", buyer_phone: null, shipping_address: null, slug: "toko-a", abandoned_at: null, recovered_at: null });
  await page.getByLabel("Nomor HP").fill(phone);
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await expect.poll(async () => (await sessions())[0]?.shipping_address, { timeout: 15_000 }).toBe("Jl. Merdeka No. 1, Bandung 40111");
  const rows = await sessions();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ buyer_phone: phone, status: "active" });
  expect(String(rows[0]!.subtotal_idr)).toBe(subtotalText.replace(/\D/g, ""));
  await evidence(page, info, "t45-checkout-capture");
  // The buyer leaves without ordering: the session stays active until the sweep runs.
  await page.close();
});

test("cleanup abandons only an idle session; it keeps the contact and stamps abandoned_at", async () => {
  cleanup();
  expect((await sessions())[0]).toMatchObject({ status: "active", abandoned_at: null }); // typed seconds ago: not idle
  await sql`update checkout_session set updated_at = now() - interval '70 minutes'`;
  cleanup();
  const [row] = await sessions();
  expect(row).toMatchObject({ status: "abandoned", buyer_phone: phone, recovered_at: null });
  expect(row!.abandoned_at).not.toBeNull();
  cleanup(); // idempotent
  expect((await sessions())[0]!.abandoned_at).toEqual(row!.abandoned_at);
});

test("owner: the queue shows the abandoned checkout with the honest rates and opens WhatsApp with a signed resume link", async ({ page }, info) => {
  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller/customers/carts");
  await expect(page.getByRole("heading", { name: "Keranjang tertinggal", level: 1 })).toBeVisible();
  const row = page.getByTestId("queue-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Siti Aminah");
  await expect(row).toContainText(phone);
  await expect(row).toContainText("Kaos Katun Basic");
  const [{ orders }] = (await sql`select count(*)::int as orders from "order" o join store s on s.id = o.store_id where s.slug = 'toko-a' and o.created_at >= now() - interval '30 days'`) as unknown as { orders: number }[];
  await expect(page.getByTestId("abandon-rate")).toContainText(percent(1, 1 + orders)); // abandoned / (abandoned + orders)
  await expect(page.getByTestId("recovery-rate")).toContainText("0%"); // rescued / (rescued + abandoned): nobody rescued yet
  await evidence(page, info, "t45-carts-queue");

  await page.route("https://wa.me/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>wa.me</title>WhatsApp (stub)" }));
  await row.getByRole("button", { name: "Hubungi lewat WhatsApp" }).click();
  await page.waitForURL(/^https:\/\/wa\.me\//);
  const wa = new URL(page.url());
  expect(wa.pathname).toBe(`/62${phone.slice(1)}`); // the 62… comparison key of the typed 08… number
  const text = wa.searchParams.get("text")!;
  expect(text).toMatch(/^Halo Siti, kami dari Toko Ayu\./);
  expect(text).not.toMatch(/terkirim|dikirim|pasti sampai/i);
  resumeUrl = text.match(/https?:\/\/\S+\/checkout\/r\/\S+/)![0];
  expect(resumeUrl).toMatch(/\/checkout\/r\/v1\.e2er1\.\d+\.[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]{43}$/);
  const [stamped] = await sessions();
  expect(stamped!.wa_opened_at).not.toBeNull();
  expect(resumeUrl.split("/checkout/r/")[1]!.split(".")[3]).not.toBe(String(stamped!.id)); // the handle is a random uuid, never the primary key
  await page.unroute("https://wa.me/**");

  await page.goto("/seller/customers/carts");
  await expect(page.getByTestId("queue-row")).toContainText("WA dibuka");
  await expect(page.getByTestId("queue-row").getByRole("button", { name: "Hubungi lagi" })).toBeVisible();
});

test("staff may read and contact; another store's owner sees nothing of it", async ({ browser }, info) => {
  const staff = await browser.newContext();
  const staffPage = await staff.newPage();
  await login(staffPage, "staff-a@bukalaris.local");
  await staffPage.goto("/seller/customers/carts");
  await expect(staffPage.getByTestId("queue-row")).toHaveCount(1);
  await expect(staffPage.getByTestId("queue-row").getByRole("button", { name: "Hubungi lagi" })).toBeEnabled();
  await staff.close();

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await login(otherPage, "owner-b@bukalaris.local");
  await otherPage.goto("/seller/customers/carts");
  await expect(otherPage.getByText("Belum ada keranjang tertinggal")).toBeVisible();
  await expect(otherPage.getByText(phone)).toHaveCount(0);
  await evidence(otherPage, info, "t45-carts-other-store");
  await other.close();
});

test("buyer resumes from the link on another device; tampered and foreign links are dead ends; ordering marks the rescue and kills the link", async ({ browser }, info) => {
  const tampered = resumeUrl.replace(/\/r\/(v1\.[^.]+)\.(\d+)\./, (_m, v, id) => `/r/${v}.${Number(id) + 1}.`);
  const dead = await browser.newContext();
  const deadPage = await dead.newPage();
  await deadPage.goto(tampered);
  await expect(deadPage.getByRole("heading", { name: "Tautan checkout tidak berlaku" })).toBeVisible();
  await deadPage.goto(resumeUrl.replace(/\.[A-Za-z0-9_-]{43}$/, `.${"A".repeat(43)}`));
  await expect(deadPage.getByRole("heading", { name: "Tautan checkout tidak berlaku" })).toBeVisible();
  expect((await dead.cookies()).filter((c) => c.name.includes("cart"))).toEqual([]); // no cookie for a refused link
  await dead.close();

  const buyer = await browser.newContext();
  const page = await buyer.newPage();
  await page.goto(resumeUrl);
  await expect(page).toHaveURL(/\/checkout\?store=toko-a$/);
  await expect(page.getByTestId("subtotal")).toHaveText(subtotalText); // the saved cart is back
  await expect(page.locator("#buyerName")).toHaveCount(0); // the area comes first; nothing of the buyer is prefilled
  await chooseDestination(page);
  await expect(page.getByLabel("Nama")).toHaveValue(""); // the link carries no buyer data
  await page.getByLabel("Nama").fill("Siti Aminah");
  await page.getByLabel("Nomor HP").fill(phone);
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await evidence(page, info, "t45-resumed-checkout");
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();

  const [row] = await sessions();
  expect(row).toMatchObject({ status: "recovered", buyer_name: null, buyer_phone: null, shipping_address: null }); // the contact now lives on the order only
  expect(row!.abandoned_at).not.toBeNull(); // the abandonment it rescued is kept
  expect(row!.recovered_at).not.toBeNull();
  await page.goto(resumeUrl);
  await expect(page.getByRole("heading", { name: "Tautan checkout tidak berlaku" })).toBeVisible(); // the session is complete: the link is dead
  await buyer.close();
});

test("owner: the rescue is counted, the queue is empty and the contact is gone from the session", async ({ page }, info) => {
  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller/customers/carts");
  await expect(page.getByText("Belum ada keranjang tertinggal")).toBeVisible();
  await expect(page.getByTestId("recovery-rate")).toContainText("100%"); // 1 rescued of 1 ever abandoned
  await expect(page.getByTestId("recovery-rate")).toContainText("1 pesanan dibuat dari 1 checkout");
  await expect(page.getByTestId("abandon-rate")).toContainText("0%"); // nothing is abandoned right now
  await expect(page.getByText(phone)).toHaveCount(0);
  await evidence(page, info, "t45-carts-rescued");
});
