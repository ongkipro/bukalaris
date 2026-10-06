import { expect, type Page, test } from "@playwright/test";
import { chooseDestination, evidence, testPhone, login } from "./helpers";

// checkout2 track (T-34 phase 2, T-35, T-30). The e2e server has no MENGANTAR_* env,
// so every quote comes from the fake adapter: no network call leaves the test.

async function fillRecipient(page: Page, phone = testPhone(), address = "Jl. Merdeka No. 1 RT 02 RW 05, Bandung 40111") {
  await page.getByLabel("Nama").fill("Budi Santoso");
  await page.getByLabel("Nomor HP").fill(phone);
  await page.getByLabel("Alamat lengkap").fill(address);
}

const courierRadios = (page: Page) => page.getByRole("group", { name: "2. Kurir" }).getByRole("radio");

/** Submit the checkout form and wait for the server-action redirect to re-render it (fields come back empty). */
async function submitExpectingError(page: Page) {
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByLabel("Nama")).toHaveValue("");
  return page.getByRole("main").getByRole("alert");
}

async function cartWithKaos(page: Page) {
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page.getByRole("heading", { name: /Checkout · Toko Ayu/ })).toBeVisible();
}

test("checkout quotes couriers per destination area; COD gating and the server re-quote hold", async ({ page }, info) => {
  await cartWithKaos(page);
  // No courier or order form before a destination is chosen.
  await expect(page.getByRole("button", { name: "Buat pesanan" })).toHaveCount(0);
  await page.getByLabel(/Cari kelurahan/).fill("bandung");
  await page.getByRole("button", { name: "Cari area" }).click();
  await expect(page.getByRole("list", { name: "Hasil pencarian area" }).getByRole("listitem")).toHaveCount(2);
  await evidence(page, info, "60-checkout-area-search");

  await page.getByRole("link", { name: /^Pilih Cihapit/ }).click();
  await expect(page.getByTestId("destination-area")).toContainText("Cihapit, Bandung Wetan");
  // Unsupported POS is hidden; SiCepat refuses COD; JNE (supports COD) is preselected.
  await expect(courierRadios(page)).toHaveCount(2);
  await expect(page.getByText(/POS Indonesia/)).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /JNE Express/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /SiCepat/ })).toHaveAccessibleName(/Tidak melayani COD/);
  await evidence(page, info, "61-checkout-courier-options");

  // The server re-quotes and rejects COD on a courier that refuses it, keeping the chosen area.
  await page.getByRole("radio", { name: /SiCepat/ }).check();
  await fillRecipient(page);
  await expect(await submitExpectingError(page)).toContainText("tidak melayani COD");
  await expect(page.getByTestId("destination-area")).toContainText("Cihapit, Bandung Wetan");

  // SiCepat prepaid is fine: 89.000 + (8.000 + Rp 2.000 margin → 10.000).
  await page.getByRole("radio", { name: /SiCepat/ }).check();
  await page.locator('input[name="paymentMethod"][value="manual_transfer"]').check();
  await fillRecipient(page);
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  await expect(page.getByTestId("shipping-route")).toContainText("SiCepat Ekspres (simulasi)");
  await expect(page.getByTestId("shipping-route")).toContainText("Cihapit, Bandung Wetan");
  await expect(page.getByTestId("order-shipping")).toHaveText("Rp 10.000");
  await expect(page.getByTestId("order-total")).toHaveText("Rp 99.000");
  await evidence(page, info, "62-checkout-confirmation-transfer");
});

test("a store without a pickup area cannot be checked out; an area without COD hides COD", async ({ page }, info) => {
  // Toko B (seed) has no pickup area: the buyer is told before filling anything.
  await page.goto("/s/toko-b");
  await page.getByRole("link", { name: /Kopi Arabika/ }).click();
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page.getByRole("heading", { name: /Checkout · Toko Bima/ })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("belum mengatur area pickup");
  await expect(page.getByLabel(/Cari kelurahan/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Buat pesanan" })).toHaveCount(0);
  await evidence(page, info, "63-checkout-no-pickup-area");

  // Toko A to a destination where every courier refuses COD: couriers listed, COD not offered.
  await cartWithKaos(page);
  await chooseDestination(page, "wamena", /^Pilih Wamena/);
  await expect(courierRadios(page)).toHaveCount(2);
  await expect(page.getByRole("radio", { name: /Bayar di tempat/ })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Transfer bank/ })).toBeChecked();
  await expect(page.getByText("COD tidak tersedia untuk area ini.")).toBeVisible();
  await evidence(page, info, "64-checkout-no-cod-area");
});

test("seller sees COD risk reasons, holds, confirms, and rejects (restock) before anything ships", async ({ page }, info) => {
  const phone = `0813${info.project.name === "desktop" ? "7" : "3"}0001234`; // own phone per project: never the shared seed number
  const buy = async (address?: string) => {
    await page.context().clearCookies();
    await cartWithKaos(page);
    await chooseDestination(page);
    await fillRecipient(page, phone, address);
    await page.getByRole("button", { name: "Buat pesanan" }).click();
    await expect(page.getByRole("status")).toContainText("konfirmasi");
    return (await page.getByTestId("order-id").textContent())!.replace("#", "");
  };
  const stockRow = page.getByRole("listitem").filter({ hasText: "Kaos Katun Basic" }).filter({ hasText: "· M" });

  const first = await buy("Gang Mawar dekat masjid"); // no house number → address risk
  const second = await buy();
  await page.context().clearCookies();
  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller/inventory");
  const before = Number(await stockRow.getByTestId("stock").textContent());

  await page.goto(`/seller/orders/${first}`);
  await expect(page.getByTestId("order-status")).toHaveText("Menunggu konfirmasi");
  const risk = page.getByTestId("cod-risk");
  await expect(risk.getByRole("listitem")).toHaveCount(2);
  await expect(risk).toContainText("1 pesanan lain dengan nomor HP ini masih menunggu konfirmasi");
  await expect(risk).toContainText("Alamat terlalu pendek atau tanpa nomor rumah");
  await expect(page.getByRole("button", { name: "Proses pesanan" })).toHaveCount(0); // nothing ships unconfirmed
  await evidence(page, info, "65-seller-cod-awaiting");

  await page.getByLabel("Alasan penahanan").fill("Nomor belum bisa dihubungi");
  await page.getByRole("button", { name: "Tahan pesanan" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Ditahan");
  await expect(page.getByRole("button", { name: "Tahan pesanan" })).toHaveCount(0);
  await expect(page.getByText("Nomor belum bisa dihubungi")).toBeVisible();
  await evidence(page, info, "66-seller-cod-on-hold");
  await page.getByRole("button", { name: "Konfirmasi pesanan" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Baru");
  await expect(page.getByTestId("cod-risk")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Proses pesanan" })).toBeVisible();

  // The second order: the first is confirmed now, so no signal; rejecting it restocks once.
  await page.goto(`/seller/orders/${second}`);
  await expect(page.getByTestId("cod-risk")).toContainText("Tidak ada sinyal risiko");
  await page.getByLabel("Alasan penolakan").fill("Pembeli tidak mengakui pesanan");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Tolak pesanan" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Dibatalkan");
  await expect(page.getByRole("region", { name: "Tindakan" })).toHaveCount(0);
  await expect(page.getByText("Pembeli tidak mengakui pesanan")).toBeVisible();
  await evidence(page, info, "67-seller-cod-rejected");
  await page.goto("/seller/inventory");
  await expect(stockRow.getByTestId("stock")).toHaveText(String(before + 1));

  // A third order from the same phone now carries the repeat signal.
  const third = await buy();
  await page.context().clearCookies();
  await login(page, "owner-a@bukalaris.local");
  await page.goto(`/seller/orders/${third}`);
  await expect(page.getByTestId("cod-risk")).toContainText("1 pesanan sebelumnya dengan nomor HP ini dibatalkan atau ditolak");
  await evidence(page, info, "68-seller-cod-repeat-risk");
});

test("order submission is rate limited per cart with a retryable message (T-30)", async ({ page }, info) => {
  const phone = `0813${info.project.name === "desktop" ? "8" : "5"}5550000`; // per project: the per-phone window (10 / 10 min) spans both projects
  await cartWithKaos(page);
  await chooseDestination(page);
  // Five refused attempts (COD on a courier that refuses it) count; the sixth is stopped by the limiter before quoting.
  for (let i = 0; i < 5; i++) {
    await page.getByRole("radio", { name: /SiCepat/ }).check();
    await fillRecipient(page, phone);
    await expect(await submitExpectingError(page)).toContainText("tidak melayani COD");
  }
  await page.getByRole("radio", { name: /JNE Express/ }).check();
  await fillRecipient(page, phone);
  await expect(await submitExpectingError(page)).toContainText(/Terlalu banyak percobaan\. Coba lagi dalam \d+ detik\./);
  await expect(page.getByTestId("destination-area")).toBeVisible(); // the buyer keeps the chosen area
  await evidence(page, info, "69-checkout-rate-limited");
});
