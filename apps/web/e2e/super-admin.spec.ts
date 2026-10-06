import { expect, test } from "@playwright/test";
import { evidence, login } from "./helpers";

test("operator suspends a store (storefront blocked) and reactivates it", async ({ page }, info) => {
  await login(page, "admin@bukalaris.local", "/admin");
  const row = page.getByRole("listitem").filter({ hasText: "/toko-b" });
  await row.getByLabel(/Alasan/).fill(`E2E ${info.project.name}: verifikasi dokumen`);
  // T-28: suspending is destructive for the storefront, so it asks for confirmation first.
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Tangguhkan" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await expect(row.getByText("Ditangguhkan")).toBeVisible();
  await evidence(page, info, "20-admin-suspended");

  const blocked = await page.request.get("/s/toko-b");
  expect(blocked.status()).toBe(404);

  await row.getByLabel(/Alasan/).fill(`E2E ${info.project.name}: selesai`);
  await row.getByRole("button", { name: "Aktifkan kembali" }).click();
  await expect(row.getByText("Aktif", { exact: true })).toBeVisible();
  expect((await page.request.get("/s/toko-b")).status()).toBe(200);
});

test("a seller cannot open Super Admin", async ({ page }) => {
  await login(page, "owner-a@bukalaris.local");
  await page.goto("/admin");
  await expect(page.getByText("Akses ditolak.")).toBeVisible();
  await expect(page.getByText("/toko-b")).toHaveCount(0);
});
