import { expect, test, type Page } from "@playwright/test";
import { evidence, login } from "./helpers";

const CATALOG_ID = /^[1-9][0-9]{4,}$/;

/** Follow nothing: the storefront answers an old URL with exactly one 308 to the canonical path. */
async function redirect(page: Page, path: string) {
  const res = await page.request.get(path, { maxRedirects: 0 });
  return { status: res.status(), location: res.headers()["location"] ?? null };
}

test("catalog ids are shown and copyable, slug renames redirect without chains, changes are listed", async ({ page }, info) => {
  const tag = `${info.project.name}-${Date.now()}`.toLowerCase();
  const title = `Sepatu Kanvas ${tag}`;
  await login(page, "owner-a@bukalaris.local");

  // --- Create: product + first variant.
  await page.getByRole("link", { name: "Tambah produk" }).click();
  await page.getByLabel("Judul produk").fill(title);
  await page.getByLabel("Status").selectOption("active");
  await page.getByLabel("Slug URL (opsional)").fill(`sepatu-${tag}`);
  await page.getByLabel("Nama varian").fill("40");
  await page.getByLabel("Harga (Rp)").fill("250000");
  await page.getByLabel("Stok").fill("4");
  await page.getByRole("button", { name: "Simpan produk" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const editor = page.url();
  const dbId = new URL(editor).pathname.split("/").pop()!;

  // --- Ids: product and variant each carry a distinct ≥ 5-digit catalog id, separate from the database id.
  const productId = (await page.getByTestId("product-id").textContent())!;
  const variantId = (await page.getByTestId("variant-catalog-id").textContent())!;
  expect(productId).toMatch(CATALOG_ID);
  expect(variantId).toMatch(CATALOG_ID);
  expect(variantId).not.toBe(productId);
  expect(productId).not.toBe(dbId);
  await expect(page.getByRole("button", { name: "Salin ID produk" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Salin ID varian 40" })).toBeVisible();
  await expect(page.getByTestId("product-url")).toHaveText(`/s/toko-a/products/sepatu-${tag}`);
  await evidence(page, info, "50-seller-product-catalog-ids");

  // The products list shows the same id.
  await page.goto("/seller/products");
  await expect(page.getByRole("row", { name: new RegExp(title) })).toContainText(productId);

  // --- Numeric URLs: catalog id and legacy database id both 308 to the readable slug.
  expect(await redirect(page, `/s/toko-a/products/${productId}`)).toEqual({ status: 308, location: `/s/toko-a/products/sepatu-${tag}` });
  expect(await redirect(page, `/s/toko-a/products/${dbId}`)).toEqual({ status: 308, location: `/s/toko-a/products/sepatu-${tag}` });
  expect((await redirect(page, `/s/toko-a/products/sepatu-${tag}`)).status).toBe(200);

  // --- Rename the slug twice: every old slug lands on the current one in a single hop; the id never moves.
  for (const next of [`sepatu-baru-${tag}`, `sepatu-final-${tag}`]) {
    await page.goto(editor); // fresh page: the previous "Tersimpan." banner must not satisfy the next wait
    await page.getByLabel("Slug URL (opsional)").fill(next);
    await page.getByRole("button", { name: "Simpan produk" }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByRole("status")).toHaveText("Tersimpan.");
    await expect(page.getByLabel("Slug URL (opsional)")).toHaveValue(next);
  }
  await expect(page.getByTestId("product-id")).toHaveText(productId);
  for (const old of [`sepatu-${tag}`, `sepatu-baru-${tag}`, productId]) {
    expect(await redirect(page, `/s/toko-a/products/${old}`)).toEqual({ status: 308, location: `/s/toko-a/products/sepatu-final-${tag}` });
  }
  await page.goto(`/s/toko-a/products/sepatu-${tag}`);
  await expect(page).toHaveURL(`/s/toko-a/products/sepatu-final-${tag}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  // Another store does not know the alias or the id.
  expect((await redirect(page, `/s/toko-b/products/sepatu-${tag}`)).status).toBe(404);
  expect((await redirect(page, `/s/toko-b/products/${productId}`)).status).toBe(404);

  // --- An old slug cannot be taken by a new product of the same store.
  await page.goto("/seller/products/new");
  await page.getByLabel("Judul produk").fill(`Peniru ${tag}`);
  await page.getByLabel("Slug URL (opsional)").fill(`sepatu-${tag}`);
  await page.getByLabel("Harga (Rp)").fill("1000");
  await page.getByRole("button", { name: "Simpan produk" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Slug sudah dipakai" })).toBeVisible();

  // --- Price change → history panel row with before/after, actor and time.
  await page.goto(editor);
  await page.getByLabel("Harga (Rp)").first().fill("275000");
  await page.getByLabel("Stok").first().fill("3");
  await page.getByRole("button", { name: "Simpan varian" }).click();
  await page.waitForURL(/saved=1/);
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  const history = page.getByTestId("product-history");
  await expect(history.getByText("Varian diubah")).toBeVisible();
  await expect(history.getByText("harga: Rp 250.000 → Rp 275.000")).toBeVisible();
  await expect(history.getByText("stok: 4 → 3")).toBeVisible();
  await expect(history.getByText(`slug: sepatu-baru-${tag} → sepatu-final-${tag}`)).toBeVisible();
  await expect(history.getByText("Ayu (Toko A)").first()).toBeVisible();
  await evidence(page, info, "51-seller-product-history");

  // --- Storefront API exposes both ids as strings (channel token issued by the seller).
  await page.goto("/seller/channels");
  await page.getByLabel("Nama").fill(`Feed ${tag}`);
  await page.getByLabel("Origin storefront").fill("https://feed.example");
  await page.getByLabel("Path kembali").fill("/thanks");
  await page.getByRole("button", { name: "Buat channel" }).click();
  const token = (await page.getByTestId("channel-token").textContent())!.trim();
  const detail = (await (await page.request.get(`/api/storefront/v1/products/sepatu-${tag}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
    catalog_id: string;
    canonical_path: string;
    variants: { catalog_id: string }[];
  };
  expect(detail).toMatchObject({ catalog_id: productId, canonical_path: `/s/toko-a/products/sepatu-final-${tag}`, variants: [{ catalog_id: variantId }] });

  // --- Another store's staff sees no history of this product (store-scoped) — the editor itself is a 404 (TEN-1).
  await page.context().clearCookies();
  await login(page, "owner-b@bukalaris.local");
  expect((await page.goto(editor))?.status()).toBe(404);
});
