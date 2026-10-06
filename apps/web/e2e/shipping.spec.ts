import { expect, test } from "@playwright/test";
import { evidence, login } from "./helpers";

// Shipping track (T-34). The e2e server has no MENGANTAR_* env, so the pages run
// on the fake adapter: no network call leaves the test.

test("operator edits the platform margin rule; preview and audit follow", async ({ page }, info) => {
  await login(page, "admin@bukalaris.local", "/admin");
  await page.goto("/admin/shipping");
  await expect(page.getByRole("heading", { name: "Margin ongkir" })).toBeVisible();
  await evidence(page, info, "40-admin-shipping");

  // Rp 1.500 + 2,5 %, rounded up to Rp 1.000: 22_320 → 22_320 + 1_500 + 558 = 24_378 → 25_000
  await page.getByLabel("Margin tetap (Rp)").fill("1500");
  await page.getByLabel("Margin persen (%)").fill("2.5");
  await page.getByLabel("Pembulatan ke atas").selectOption("1000");
  await page.getByRole("button", { name: "Simpan aturan" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  const row = page.getByTestId("margin-preview").filter({ hasText: "Rp 22.320" });
  await expect(row).toContainText("Rp 2.680");
  await expect(row).toContainText("Rp 25.000");
  await expect(page.getByRole("region", { name: "Riwayat perubahan" }).getByRole("listitem").first()).toContainText("fixed=1500 bps=250 roundTo=1000");
  await evidence(page, info, "41-admin-shipping-saved");

  // Invalid input is rejected server-side and the rule stays.
  await page.getByLabel("Margin tetap (Rp)").fill("-5");
  await page.getByLabel("Margin tetap (Rp)").evaluate((el: HTMLInputElement) => el.removeAttribute("min"));
  await page.getByRole("button", { name: "Simpan aturan" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("margin-preview").filter({ hasText: "Rp 22.320" })).toContainText("Rp 25.000");

  // Restore the default so the other project / later tests start from it.
  await page.getByLabel("Margin tetap (Rp)").fill("2000");
  await page.getByLabel("Margin persen (%)").fill("0");
  await page.getByLabel("Pembulatan ke atas").selectOption("500");
  await page.getByRole("button", { name: "Simpan aturan" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
});

test("owner searches an area, picks it, saves the pickup address; staff can only view", async ({ page }, info) => {
  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller/shipping");
  await expect(page.getByRole("heading", { name: "Pengiriman" })).toBeVisible();
  // The seeded store has no pickup area until the first project of this run sets one.
  if (await page.getByTestId("pickup-area").getByText("Belum diatur").isVisible()) {
    await expect(page.getByLabel("Alamat lengkap pickup")).toBeDisabled();
  }

  await page.getByLabel(/Cari area/).fill("bandung");
  await page.getByRole("button", { name: "Cari" }).click();
  const results = page.getByRole("list", { name: "Hasil pencarian area" }).getByRole("listitem");
  await expect(results).toHaveCount(2);
  await evidence(page, info, "42-seller-shipping-search");

  await page.getByRole("button", { name: /^Pilih Braga/ }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await expect(page.getByTestId("pickup-area")).toContainText("Braga, Sumur Bandung, Bandung, Jawa Barat 40111");

  await page.getByLabel("Alamat lengkap pickup").fill(`Jl. Braga No. 10, samping toko roti (${info.project.name})`);
  await page.getByRole("button", { name: "Simpan alamat" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await expect(page.getByTestId("pickup-area")).toContainText(`Jl. Braga No. 10, samping toko roti (${info.project.name})`);
  await evidence(page, info, "43-seller-shipping-saved");

  // Staff of the same store: read-only view, no forms.
  await page.context().clearCookies();
  await login(page, "staff-a@bukalaris.local");
  await page.goto("/seller/shipping");
  await expect(page.getByTestId("pickup-area")).toContainText("Braga, Sumur Bandung");
  await expect(page.getByRole("button", { name: "Cari" })).toHaveCount(0);
  await expect(page.getByLabel("Alamat lengkap pickup")).toHaveCount(0);

  // Another store's owner does not see store A's pickup area (TEN-1, browser path).
  await page.context().clearCookies();
  await login(page, "owner-b@bukalaris.local");
  await page.goto("/seller/shipping");
  await expect(page.getByTestId("pickup-area")).toContainText("Belum diatur");
});
