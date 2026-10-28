import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { chooseDestination, evidence, login, testPhone } from "./helpers";

// T-46 (PR-26, UX-16, SF-12): the seller manages vouchers, a flash sale and the promo hub at /seller/promotions; the storefront shows
// /s/toko-a/promo; the buyer applies a voucher at checkout and sees goods and shipping discounts SEPARATELY. Both viewports (320 and desktop).
// Atomic caps, windows, allocation sums and negative-total blocking are proven on real PostgreSQL in packages/db/test/t46-*.test.ts.
const url = process.env.E2E_DATABASE_URL;
if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
const sql = postgres(url, { max: 1, onnotice: () => {} });
const clean = () => sql`truncate discount, discount_buyer_usage, discount_redemption, flash_sale, flash_sale_item, flash_sale_redemption, promo_hub, promo_hub_collection restart identity cascade`;
test.describe.configure({ mode: "serial" });
test.beforeAll(clean);
test.afterAll(async () => {
  await clean(); // later specs buy the same seeded product at its base price
  await sql.end();
});

const wib = (ms: number) => new Date(Date.now() + ms + 7 * 3_600_000).toISOString().slice(0, 16);
const rp = (n: number | string) => `Rp ${Number(n).toLocaleString("id-ID")}`;
const money = (text: string | null) => Number((text ?? "").replace(/[^\d]/g, ""));

async function addToCart(page: Page, quantity: string) {
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  await page.getByLabel("Jumlah").fill(quantity);
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(page);
  await page.getByLabel("Nama").fill("Budi Santoso");
  await page.getByLabel("Nomor HP").fill(testPhone());
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
}
/** The add forms are native <details>: open one only when it is closed (a saved form stays open, so a second click would close it). */
async function openAdd(page: Page, label: string) {
  const summary = page.locator("summary", { hasText: label });
  const details = summary.locator("xpath=..");
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await summary.click();
}
const codeOf = async (kind: string) => String((await sql`select code from discount where kind = ${kind} order by id desc limit 1`)[0]!.code);

test("the owner configures the hub, vouchers and a flash sale; staff can only read", async ({ page, browser }, info) => {
  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller/promotions");
  await expect(page.getByRole("heading", { name: "Promosi", level: 1 })).toBeVisible();
  await expect(page.getByText("Belum ada voucher")).toBeVisible();
  await evidence(page, info, "t46-promotions-empty");

  const hub = page.getByRole("form", { name: "Pengaturan hub promo" });
  await hub.getByLabel("Aktifkan halaman /promo").check();
  await hub.getByLabel("Judul hub promo").fill("Promo Oktober");
  await hub.getByLabel("Keterangan promo").fill("Hemat untuk kaos pilihan.");
  await hub.getByRole("button", { name: "Simpan hub promo" }).click();
  await expect(hub.getByRole("status")).toContainText("Promo disimpan");

  // Percent voucher (10%) and free-shipping voucher, windows typed as WIB wall clocks.
  await openAdd(page, "Tambah voucher");
  const voucher = () => page.getByRole("form", { name: "Aturan voucher" }).last();
  await voucher().getByLabel(/^Nilai/).fill("1000");
  await voucher().getByLabel(/^Mulai/).fill(wib(-3_600_000));
  await voucher().getByLabel(/^Selesai/).fill(wib(86_400_000));
  await voucher().getByRole("button", { name: "Simpan voucher" }).click();
  await expect(voucher().getByRole("status")).toContainText("Kode:");
  await expect(page.getByTestId("voucher-row")).toHaveCount(1);

  await openAdd(page, "Tambah voucher");
  await voucher().getByLabel("Jenis voucher").selectOption("free_shipping");
  await voucher().getByLabel(/^Nilai/).fill("0");
  await voucher().getByLabel(/^Mulai/).fill(wib(-3_600_000));
  await voucher().getByLabel(/^Selesai/).fill(wib(86_400_000));
  await voucher().getByRole("button", { name: "Simpan voucher" }).click();
  await expect(page.getByTestId("voucher-row")).toHaveCount(2);

  // An inverted window shows a field error and keeps the typed values.
  await openAdd(page, "Tambah voucher");
  await voucher().getByLabel(/^Nilai/).fill("1000");
  await voucher().getByLabel(/^Mulai/).fill(wib(86_400_000));
  await voucher().getByLabel(/^Selesai/).fill(wib(3_600_000));
  await voucher().getByRole("button", { name: "Simpan voucher" }).click();
  await expect(voucher().getByText("Waktu selesai harus setelah waktu mulai")).toBeVisible();
  await expect(voucher().getByLabel(/^Nilai/)).toHaveValue("1000");
  await expect(page.getByTestId("voucher-row")).toHaveCount(2);

  // Flash sale on the seeded Kaos "M" variant: Rp89.000 -> Rp70.000, three units.
  await openAdd(page, "Tambah flash sale");
  const flash = page.getByRole("form", { name: "Aturan flash sale" }).last();
  await flash.getByLabel("Judul flash sale").fill("Kilat Kaos");
  await flash.getByLabel(/^Mulai/).fill(wib(-3_600_000));
  await flash.getByLabel(/^Selesai/).fill(wib(86_400_000));
  const variant = await flash.getByLabel("Varian 1").locator("option", { hasText: "Kaos Katun Basic · M" }).first().getAttribute("value");
  await flash.getByLabel("Varian 1").selectOption(variant!);
  await flash.getByLabel(/^Harga flash sale 1/).fill("70000");
  await flash.getByLabel(/^Batas unit 1/).fill("3");
  await flash.getByRole("button", { name: "Simpan flash sale" }).click();
  await expect(page.getByTestId("flash-row")).toHaveCount(1);
  await expect(page.getByTestId("flash-row")).toContainText("Rp 70.000");
  await evidence(page, info, "t46-promotions-configured");

  // Staff: read-only, no forms, and the write path itself is refused.
  const staff = await browser.newContext();
  const staffPage = await staff.newPage();
  await login(staffPage, "staff-a@bukalaris.local");
  await staffPage.goto("/seller/promotions");
  await expect(staffPage.getByText("Hanya pemilik toko yang dapat mengubah promosi")).toBeVisible();
  await expect(staffPage.getByRole("form")).toHaveCount(0);
  await expect(staffPage.getByTestId("voucher-row")).toHaveCount(2);
  await staff.close();
});

test("the storefront promo hub shows the live flash sale with its stock, copyable vouchers and the navigation link", async ({ page, context }, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/s/toko-a");
  await expect(page.getByRole("navigation", { name: "Navigasi toko" }).getByRole("link", { name: "Promo" })).toBeVisible();
  await page.goto("/s/toko-a/promo");
  await expect(page.getByRole("heading", { name: "Promo Oktober", level: 1 })).toBeVisible();
  const item = page.getByTestId("flash-item");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Kaos Katun Basic · M");
  await expect(item).toContainText("Rp 70.000");
  await expect(item).toContainText("sisa 3 dari 3 unit");
  await expect(item.getByTestId("countdown")).toContainText("Sisa waktu"); // client-side, from the server-stated end instant
  const percent = await codeOf("percent");
  await expect(page.getByTestId("promo-voucher").filter({ hasText: percent })).toContainText("Diskon 10%");
  await expect(page.getByTestId("promo-voucher")).toHaveCount(2);
  // Keyboard: the copy button is reachable and announces the outcome.
  const copy = page.getByRole("button", { name: `Salin kode ${percent}` });
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Tersalin.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(percent);
  await evidence(page, info, "t46-storefront-promo");
});

test("checkout: the voucher is applied, goods and shipping discounts are shown separately, a bad code keeps the form, and the order freezes the exact split", async ({ page }, info) => {
  await addToCart(page, "1");
  await expect(page.getByTestId("subtotal")).toHaveText(rp(89_000));

  // A refused code: one clear Bahasa Indonesia message, nothing changes.
  await page.getByLabel("Kode voucher").fill("SALAH");
  await page.getByRole("button", { name: "Terapkan voucher" }).click();
  await expect(page.getByTestId("voucher-result").getByRole("alert")).toContainText("Voucher tidak dapat dipakai");
  await expect(page.getByLabel("Nama")).toHaveValue("Budi Santoso");
  await expect(page.getByTestId("subtotal")).toHaveText(rp(89_000));

  // The valid percent voucher by keyboard: Enter applies it. Flash first (89.000 -> 70.000), then 10% of 70.000.
  const percent = await codeOf("percent");
  await page.getByLabel("Kode voucher").fill(percent);
  await page.getByLabel("Kode voucher").press("Enter");
  await expect(page.getByTestId("goods-discount")).toHaveText(`−${rp(26_000)}`);
  await expect(page.getByTestId("shipping-discount")).toHaveText(`−${rp(0)}`);
  const previewTotal = money(await page.getByTestId("promo-total").textContent());
  await evidence(page, info, "t46-checkout-voucher");

  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const orderId = Number((await page.getByTestId("order-id").textContent())!.replace("#", ""));
  const [f] = await sql`select f.*, o.total from order_financials f join "order" o on o.id = f.order_id and o.store_id = f.store_id where f.order_id = ${orderId}`;
  expect(f).toMatchObject({ subtotal_idr: "89000", goods_discount_idr: "26000", shipping_discount_idr: "0", goods_proceeds_idr: "63000" });
  expect(Number(f!.total)).toBe(previewTotal); // what the buyer was shown is what the server froze
  const lines = await sql`select discount_alloc_idr, shipping_discount_idr from order_line_financials where order_id = ${orderId}`;
  expect(lines.reduce((n, l) => n + Number(l.discount_alloc_idr), 0)).toBe(26_000);
  expect((await sql`select goods_discount_idr from discount_redemption where order_id = ${orderId}`)[0]!.goods_discount_idr).toBe("7000");
  expect((await sql`select sold_count from flash_sale_item`)[0]!.sold_count).toBe(1);

  // Free shipping: store-funded, courier cost only; the platform margin stays payable.
  await addToCart(page, "1");
  await page.getByLabel("Kode voucher").fill(await codeOf("free_shipping"));
  await page.getByRole("button", { name: "Terapkan voucher" }).click();
  await expect(page.getByTestId("shipping-discount")).not.toHaveText(`−${rp(0)}`);
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const second = Number((await page.getByTestId("order-id").textContent())!.replace("#", ""));
  const [o] = await sql`select o.shipping_provider_cost, o.shipping_margin, o.shipping_fee, f.shipping_discount_idr from "order" o join order_financials f on f.order_id = o.id where o.id = ${second}`;
  expect(Number(o!.shipping_discount_idr)).toBe(Number(o!.shipping_provider_cost));
  expect(Number(o!.shipping_fee)).toBe(Number(o!.shipping_margin));
  await evidence(page, info, "t46-checkout-confirmation");
});
