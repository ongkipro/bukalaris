import { expect, test } from "@playwright/test";
import { evidence, login } from "./helpers";

test("seller creates a product with a variant and it appears on the storefront", async ({ page }, info) => {
  const title = `Kemeja Linen ${info.project.name} ${Date.now()}`;
  await login(page, "owner-a@bukalaris.local");
  await expect(page.getByRole("heading", { name: "Produk" })).toBeVisible();
  await evidence(page, info, "01-seller-products");

  await page.getByRole("link", { name: "Tambah produk" }).click();
  await page.getByLabel("Judul produk").fill(title);
  await page.getByLabel("Deskripsi").fill("Linen adem untuk cuaca tropis.");
  await page.getByLabel("Status").selectOption("active");
  await page.getByLabel("Nama varian").fill("L");
  await page.getByLabel("Harga (Rp)").fill("175000");
  await page.getByLabel("Stok").fill("7");
  await evidence(page, info, "02-seller-new-product");
  await page.getByRole("button", { name: "Simpan produk" }).click();

  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  const id = await page.getByTestId("product-id").textContent();
  expect(id).toMatch(/^[0-9]+$/);
  await evidence(page, info, "03-seller-product-detail");

  await page.goto(`/s/toko-a/products/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("Rp 175.000").first()).toBeVisible();

  // Another store's owner cannot open this product (TEN-1, browser path).
  await page.context().clearCookies();
  await login(page, "owner-b@bukalaris.local");
  const res = await page.goto(`/seller/products/${id}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByText(title)).toHaveCount(0);
});
