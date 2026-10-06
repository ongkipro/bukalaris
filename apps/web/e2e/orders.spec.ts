import { expect, type Page, test } from "@playwright/test";
import { chooseDestination, evidence, testPhone, login } from "./helpers";

/** Phone of the most recent buyKaos() order (fresh per order: checkout rate-limits per phone). */
let phone = "";

/** Buyer places a COD/transfer order for the seeded "Kaos Katun Basic" variant; returns the order id. */
async function buyKaos(page: Page, variant: "M" | "L", qty: number, payment: "cod" | "manual_transfer") {
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  await page.getByRole("radio", { name: new RegExp(`^${variant}\\b`) }).check();
  await page.getByLabel("Jumlah").fill(String(qty));
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(page);
  await page.getByLabel("Nama").fill("Budi Santoso");
  phone = testPhone();
  await page.getByLabel("Nomor HP").fill(phone);
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await page.locator(`input[name="paymentMethod"][value="${payment}"]`).check();
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const id = (await page.getByTestId("order-id").textContent())!.replace("#", "");
  expect(id).toMatch(/^[0-9]+$/);
  return id;
}

const inventoryRow = (page: Page, variant: string) =>
  page.getByRole("listitem").filter({ hasText: "Kaos Katun Basic" }).filter({ hasText: `· ${variant}` });
const stockOf = async (page: Page, variant: string) => {
  await page.goto("/seller/inventory");
  return Number(await inventoryRow(page, variant).getByTestId("stock").textContent());
};

test("buyer places an order → seller sees it, processes, ships and completes it", async ({ page }, info) => {
  const id = await buyKaos(page, "M", 1, "cod");

  await page.context().clearCookies();
  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller/orders");
  await expect(page.getByRole("heading", { name: "Pesanan" })).toBeVisible();
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: `#${id}`, exact: true }) });
  await expect(row.getByText("Menunggu konfirmasi")).toBeVisible(); // T-35: COD waits for the seller
  await evidence(page, info, "30-seller-orders");

  // Status filter keeps only matching orders.
  await page.getByRole("link", { name: "Selesai" }).click();
  await expect(page.getByRole("row").filter({ has: page.getByRole("link", { name: `#${id}`, exact: true }) })).toHaveCount(0);
  await page.getByRole("link", { name: "Semua" }).click();
  await row.getByRole("link", { name: `#${id}` }).click();

  await expect(page.getByRole("heading", { name: `Pesanan #${id}` })).toBeVisible();
  await expect(page.getByTestId("order-status")).toHaveText("Menunggu konfirmasi");
  await page.getByRole("button", { name: "Konfirmasi pesanan" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Baru");
  await expect(page.getByText("Budi Santoso")).toBeVisible();
  await expect(page.getByText(phone)).toBeVisible();
  await expect(page.getByText(/Kaos Katun Basic · M/)).toBeVisible();
  await expect(page.getByTestId("order-total")).toHaveText("Rp 106.500"); // 89.000 + COD ongkir 17.500
  await evidence(page, info, "31-seller-order-new");

  await page.getByRole("button", { name: "Proses pesanan" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await expect(page.getByTestId("order-status")).toHaveText("Diproses");

  await page.getByLabel("Nomor resi kurir").fill(`JNE-${id}-${info.project.name}`);
  await page.getByRole("button", { name: "Kirim pesanan" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Dikirim");
  await expect(page.getByTestId("tracking")).toHaveText(`JNE-${id}-${info.project.name}`);
  // Cancel is no longer offered once shipped.
  await expect(page.getByRole("button", { name: "Batalkan pesanan" })).toHaveCount(0);
  await evidence(page, info, "32-seller-order-shipped");

  await page.getByRole("button", { name: "Tandai selesai" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Selesai");
  const history = page.getByRole("region", { name: "Riwayat status" }).getByRole("listitem");
  await expect(history).toHaveCount(5); // created + confirm + 3 transitions
  await expect(history.last()).toContainText("Dikirim → Selesai oleh Ayu (Toko A)");
  await expect(page.getByRole("button")).toHaveCount(1); // only "Keluar" remains: nothing left to do

  // Another store's owner cannot open this order (TEN-1, browser path).
  await page.context().clearCookies();
  await login(page, "owner-b@bukalaris.local");
  expect((await page.goto(`/seller/orders/${id}`))?.status()).toBe(404);
  await page.goto("/seller/orders");
  await expect(page.getByText(`#${id}`)).toHaveCount(0);
});

test("seller confirms a transfer, cancels it (stock returns once) and adjusts inventory", async ({ page }, info) => {
  await login(page, "owner-a@bukalaris.local");
  const before = await stockOf(page, "L");

  const id = await buyKaos(page, "L", 2, "manual_transfer");
  expect(await stockOf(page, "L")).toBe(before - 2);

  await page.goto(`/seller/orders/${id}`);
  await expect(page.getByTestId("order-status")).toHaveText("Menunggu pembayaran");
  await expect(page.getByText(`FAKE-AL-${id}`)).toBeVisible();
  await page.getByRole("button", { name: "Tandai sudah dibayar" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Baru");

  // Cancelling asks for confirmation; dismissing it changes nothing.
  page.once("dialog", (d) => d.dismiss());
  await page.getByLabel("Alasan pembatalan").fill("Pembeli minta batal via WA");
  await page.getByRole("button", { name: "Batalkan pesanan" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Baru");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Batalkan pesanan" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Dibatalkan");
  await expect(page.getByText("Pembeli minta batal via WA")).toBeVisible();
  await expect(page.getByRole("region", { name: "Tindakan" })).toHaveCount(0);
  await evidence(page, info, "33-seller-order-cancelled");

  expect(await stockOf(page, "L")).toBe(before);
  const log = page.getByRole("region", { name: "Riwayat penyesuaian" }).getByRole("listitem").first();
  await expect(log).toContainText("+2");
  await expect(log).toContainText(`pesanan #${id}`);

  // Manual adjustment: +3 with a reason, then an over-decrement is rejected and leaves stock intact.
  const row = inventoryRow(page, "L");
  await row.getByLabel(/Perubahan stok/).fill("3");
  await row.getByLabel(/Alasan perubahan/).fill("Restock supplier");
  await row.getByRole("button", { name: "Sesuaikan" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await expect(inventoryRow(page, "L").getByTestId("stock")).toHaveText(String(before + 3));
  await evidence(page, info, "34-seller-inventory");

  // One more than the current stock, so it over-decrements whatever the seeded level is.
  await inventoryRow(page, "L").getByLabel(/Perubahan stok/).fill(String(-(before + 3 + 1)));
  await inventoryRow(page, "L").getByLabel(/Alasan perubahan/).fill("Salah hitung");
  await inventoryRow(page, "L").getByRole("button", { name: "Sesuaikan" }).click();
  // Scope to page content: Next's route announcer is also role=alert and now carries the page title.
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Stok tidak cukup");
  await expect(inventoryRow(page, "L").getByTestId("stock")).toHaveText(String(before + 3));
});
