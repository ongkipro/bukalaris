import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { chooseDestination, enrolTotpViaApi, evidence, login, seedFixtureStore, testPhone, totp } from "./helpers";

// T-105 (ADR-0013 sections 4 and 7, SC-22 and SC-09): a store on its OWN Mengantar account, end to end on the fake seller client (no origin is
// configured, so no request leaves the process). The owner connects the key (T-104 screen), registers the pickup address, switches couriers
// and COD on, blocks a province for COD; the buyer sees only the enabled couriers and no COD to the blocked province; the owner books with a
// drop-off and the worker issues the resi. A disposable store and owner per project (TOTP enrolment is persistent auth state, T-82).

const DB_CWD = resolve(process.cwd(), "../../packages/db");
function q<T>(body: string): T {
  const script = `
    import { createDb } from "./src/client.ts";
    import { createProduct } from "./src/seller/commerce/catalog.ts";
    import { sellerContext } from "./src/platform/scoped.ts";
    import { setPickupArea } from "./src/shipping/shipping.ts";
    const admin = createDb(process.env.E2E_DATABASE_URL);
    const app = createDb(process.env.E2E_APP_DATABASE_URL);
    const out = await (async () => { ${body} })();
    await admin.$client.end();
    await app.$client.end();
    console.log("@@" + JSON.stringify(out ?? null));
  `;
  const stdout = execFileSync("node", ["--input-type=module", "-e", script], { cwd: DB_CWD, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(stdout.slice(stdout.lastIndexOf("@@") + 2)) as T;
}

const main = (page: Page) => page.getByRole("main");
/** Submit a server-action form and wait for its POST, then load the page afresh: every form on the page starts from the saved state. */
async function saveAndReload(page: Page, form: Locator, button: string, path: string) {
  await Promise.all([page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === path), form.getByRole("button", { name: button }).click()]);
  await page.goto(path);
}
/** Load `path` afresh until the worker has applied the expected state (a fresh navigation, never a reload racing a pending action). */
const reloadUntil = (page: Page, path: string, testId: string, text: string | RegExp) =>
  expect
    .poll(
      async () => {
        await page.goto(path);
        return (await page.getByTestId(testId).textContent())?.trim() ?? "";
      },
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toMatch(text);

/** A TOTP code of the next window (the enrolment just spent the current one). */
const nextCode = (secret: string) => totp(secret, Date.now() + 30_000);

test("a store on its own courier account: pickup registered, couriers and COD filtered for the buyer, booked with a drop-off on the store's key", async ({ page, browser }, info) => {
  test.setTimeout(240_000);
  const store = seedFixtureStore("t105");
  const product = q<{ slug: string }>(`
    const [u] = await admin.$client.unsafe("select id from \\"user\\" where email = '${store.email}'");
    const ctx = await sellerContext(app, u.id);
    if (!ctx.ok) throw new Error(ctx.reason);
    const id = await createProduct(ctx.scope, { title: "Kaos Uji Kurir", status: "active", variant: { title: "M", price: 100000, stock: 20, weightGrams: 1000 } });
    await setPickupArea(ctx.scope, { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Sumur Bandung, Bandung, Jawa Barat 40111" });
    const [p] = await admin.$client.unsafe("select coalesce(slug, catalog_id::text) as slug from product where id = " + id); // canonical segment: slug, else catalog id
    return { slug: p.slug };
  `);

  // 1. The owner connects the store's own key in sandbox (T-104 screen, step-up with a TOTP code).
  await login(page, store.email, "/seller");
  const secret = await enrolTotpViaApi(page, store.email);
  await page.goto("/seller/payments");
  const mengantar = page.getByRole("form", { name: "Simpan kunci Mengantar" });
  await mengantar.getByLabel("Lingkungan").selectOption("sandbox");
  await mengantar.getByLabel("Kunci API").fill(`T105-E2E-${info.project.name}-key-0123456789abcdef`);
  await mengantar.getByLabel(/Kode verifikasi/).fill(nextCode(secret));
  await mengantar.getByRole("button", { name: "Simpan dan cek" }).click();
  await expect(main(page).getByRole("status")).toContainText("Kunci lolos pengecekan");

  // 2. Shipping page: not ready until the pickup address is registered with that account.
  await page.goto("/seller/shipping");
  await expect(page.getByTestId("shipping-ready")).toHaveText("Belum siap");
  await expect(page.getByTestId("shipping-gaps")).toContainText("Alamat pickup belum terdaftar");
  const pickup = page.getByRole("form", { name: "Alamat pickup" });
  await pickup.getByLabel("Alamat lengkap pickup").fill("Jl. Braga No. 10, samping toko roti");
  await pickup.getByLabel("Nama penanggung jawab pickup").fill("Budi Pemilik");
  await pickup.getByLabel("Nomor HP penanggung jawab").fill("081234567890");
  await saveAndReload(page, pickup, "Simpan dan daftarkan alamat", "/seller/shipping");
  await expect(page.getByTestId("shipping-ready")).toHaveText("Siap kirim");

  // 3. Couriers: JNE with COD, SiCepat without; every other courier stays closed. COD blocked to DKI Jakarta.
  const couriers = page.getByRole("form", { name: "Kurir dan COD" });
  await couriers.getByLabel("Aktifkan JNE Express").check();
  await couriers.getByLabel("COD JNE Express").check();
  await couriers.getByLabel("Aktifkan SiCepat Ekspres").check();
  await saveAndReload(page, couriers, "Simpan kurir", "/seller/shipping");
  await expect(page.getByRole("form", { name: "Kurir dan COD" }).getByLabel("COD JNE Express")).toBeChecked();
  const cod = page.getByRole("form", { name: "COD toko" });
  await expect(cod.getByLabel("Terima COD (bayar di tempat). Dicek lagi saat pesanan dibuat.")).toBeChecked();
  await cod.getByLabel(/^DKI Jakarta/).check();
  await cod.getByLabel("Biaya COD ditanggung").selectOption("seller");
  await saveAndReload(page, cod, "Simpan COD", "/seller/shipping");
  await expect(page.getByRole("form", { name: "COD toko" }).getByLabel(/^DKI Jakarta/)).toBeChecked();
  await expect(page.getByRole("form", { name: "COD toko" }).getByLabel("Biaya COD ditanggung")).toHaveValue("seller");
  await expect(page.getByRole("form", { name: "Kurir dan COD" }).getByLabel("Aktifkan Anteraja")).not.toBeChecked();
  await evidence(page, info, "t105-seller-shipping");

  // 4. The buyer (another browser context): only the enabled couriers, at the public rate; no COD to the blocked province.
  const buyerContext = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: page.viewportSize()!, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  const buyerPage = await buyerContext.newPage();
  await buyerPage.goto(`/s/${store.slug}/products/${product.slug}`);
  await buyerPage.getByLabel("Jumlah").fill("1");
  await buyerPage.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await buyerPage.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(buyerPage);
  const courierNames = buyerPage.locator('input[name="courier"]');
  await expect(courierNames).toHaveCount(2);
  await expect(buyerPage.locator('input[name="courier"][value="anteraja"]')).toHaveCount(0);
  await expect(buyerPage.getByText(/Transfer Rp\s?12\.000/)).toBeVisible(); // JNE at the public rate of the fake account, no margin
  await expect(buyerPage.locator('input[name="paymentMethod"][value="cod"]')).toHaveCount(0);
  await expect(buyerPage.getByText("COD tidak tersedia untuk area ini.")).toBeVisible();
  await evidence(buyerPage, info, "t105-checkout-no-cod");

  // Another province: COD on JNE only (SiCepat refuses COD on the route). The buyer orders COD with JNE.
  await buyerPage.getByRole("link", { name: "Ubah" }).click();
  await chooseDestination(buyerPage, "gubeng", /^Pilih Gubeng/);
  await expect(buyerPage.locator('input[name="paymentMethod"][value="cod"]')).toHaveCount(1);
  await buyerPage.locator('input[name="courier"][value="JNE"]').check();
  await buyerPage.getByLabel("Nama").fill("Budi Santoso");
  await buyerPage.getByLabel("Nomor HP").fill(testPhone());
  await buyerPage.getByLabel("Alamat lengkap").fill("Jl. Gubeng No. 5, Surabaya 60281");
  await buyerPage.locator('input[name="paymentMethod"][value="cod"]').check();
  await buyerPage.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(buyerPage.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const orderId = (await buyerPage.getByTestId("order-id").textContent())!.replace("#", "");
  await buyerContext.close();

  // 5. The owner confirms and books with a drop-off on the store's own account; the worker issues the resi.
  const orderPath = `/seller/orders/${orderId}`;
  await page.goto(orderPath);
  await saveAndReload(page, page.getByRole("region", { name: "Tindakan" }), "Konfirmasi pesanan", orderPath);
  await expect(page.getByTestId("order-status")).toHaveText("Baru");
  await expect(page.getByTestId("cod-locked")).toHaveCount(0); // the platform COD gate does not apply to the store's own account
  const book = page.getByRole("form", { name: "Booking pengiriman" });
  await book.getByLabel("Antar sendiri ke agen kurir").check();
  await evidence(page, info, "t105-order-book");
  await saveAndReload(page, book, "Booking sekarang", orderPath);
  await reloadUntil(page, orderPath, "order-status", "Dikirim");
  await expect(page.getByTestId("shipment-resi")).toHaveText(/^FAKE-JNE-/);
  await expect(page.getByTestId("shipment-status")).toHaveText("Resi terbit, menunggu pickup");
  await expect(page.getByTestId("order-shipping-account")).toHaveText("Akun Mengantar: milik toko Anda");
  await evidence(page, info, "t105-order-booked");
});

test("Owner console: the production switch for sellers' Mengantar keys stays closed until a sandbox pass is recorded", async ({ page }, info) => {
  await login(page, "admin@bukalaris.local", "/admin");
  await page.goto("/admin/shipping");
  const section = page.getByTestId("mengantar-production");
  await expect(section.getByRole("heading", { name: "Panggilan produksi pada akun Mengantar milik penjual" })).toBeVisible();
  // No spec records a sandbox pass, so the switch is closed and opening it is refused with a reason on record.
  await expect(section.getByTestId("production-state")).toHaveText("Tertutup");
  await expect(section.getByTestId("sandbox-pass")).toHaveText("Belum ada uji sandbox yang tercatat.");
  const request = section.getByRole("form", { name: "Ajukan pembukaan panggilan produksi Mengantar" });
  await request.getByLabel("Alasan").fill("Pilot dimulai");
  await request.getByRole("button", { name: "Ajukan pembukaan" }).click();
  await expect(main(page).getByRole("alert")).toContainText("Catat dulu uji sandbox");
  await expect(page.getByTestId("production-state")).toHaveText("Tertutup");
  await evidence(page, info, "t105-admin-production-switch");
});
