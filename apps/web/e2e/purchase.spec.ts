import { expect, test } from "@playwright/test";
import { chooseDestination, evidence } from "./helpers";

test("buyer: storefront → cart → hosted checkout → confirmation", async ({ page }, info) => {
  await page.goto("/s/toko-a");
  await expect(page.getByRole("heading", { name: "Produk" })).toBeVisible();
  await evidence(page, info, "10-storefront-home");

  await page.getByRole("link", { name: /Kaos Katun Basic/ }).click();
  await expect(page).toHaveURL(/\/products\/kaos-katun-basic$/);
  await page.getByLabel("Jumlah").fill("2");
  await evidence(page, info, "11-storefront-product");
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();

  await expect(page.getByRole("heading", { name: "Keranjang" })).toBeVisible();
  await expect(page.getByText("Rp 178.000")).toBeVisible();
  await evidence(page, info, "12-cart");
  await page.getByRole("link", { name: "Checkout" }).click();

  await expect(page.getByRole("heading", { name: /Checkout · Toko Ayu/ })).toBeVisible();
  await expect(page.getByTestId("subtotal")).toHaveText("Rp 178.000");
  await chooseDestination(page);
  // A tampered hidden price field is ignored: the server derives totals.
  await page.locator("form").last().evaluate((f) => {
    const i = document.createElement("input");
    i.type = "hidden";
    i.name = "total";
    i.value = "1";
    f.appendChild(i);
  });
  await page.getByLabel("Nama").fill("Budi Santoso");
  await page.getByLabel("Nomor HP").fill("081234567890");
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await evidence(page, info, "13-checkout");
  await page.getByRole("button", { name: "Buat pesanan" }).click();

  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  // 178.000 + fake JNE COD 15.494 + platform margin (Rp 2.000, rounded up to Rp 500) = 17.500
  await expect(page.getByTestId("order-shipping")).toHaveText("Rp 17.500");
  await expect(page.getByTestId("order-total")).toHaveText("Rp 195.500");
  await expect(page.getByRole("status")).toContainText("COD");
  await evidence(page, info, "14-confirmation");

  // The order outcome is bound to this buyer's cookie, not the order number.
  const url = page.url();
  await page.context().clearCookies();
  expect((await page.goto(url))?.status()).toBe(404);
});

test("carts of two stores coexist in path mode and checkout uses the right one", async ({ page }) => {
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(page.getByRole("heading", { name: "Keranjang" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Kaos Katun Basic" })).toBeVisible();

  await page.goto("/s/toko-b");
  await page.getByRole("link", { name: /Kopi Arabika/ }).click();
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(page.getByRole("heading", { name: "Keranjang" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Kopi Arabika 250g" })).toBeVisible();

  // Store A's cart is still there (previously a single cookie silently replaced it).
  await page.goto("/s/toko-a/cart");
  await expect(page.getByRole("link", { name: "Kaos Katun Basic" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Kopi Arabika/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/checkout\?store=toko-a$/);
  await expect(page.getByRole("heading", { name: /Checkout · Toko Ayu/ })).toBeVisible();
  await expect(page.getByText(/Kaos Katun Basic · M × 1/)).toBeVisible();

  await page.goto("/checkout?store=toko-b");
  await expect(page.getByRole("heading", { name: /Checkout · Toko Bima/ })).toBeVisible();
  await expect(page.getByText(/Kopi Arabika 250g · Biji × 1/)).toBeVisible();
});
