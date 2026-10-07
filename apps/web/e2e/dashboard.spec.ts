import { expect, test, type Page } from "@playwright/test";
import { chooseDestination, evidence, login, testPhone } from "./helpers";

/**
 * T-41 — Seller overview at /seller: period switcher (WIB), KPI tiles, work-queue link, funnel note,
 * top products, empty state; owner and staff; nav active state only on the exact path.
 * Toko B (seed) has no pickup area so it can never have orders → its dashboard is the empty state.
 */

const nav = (page: Page) => page.getByRole("navigation", { name: "Seller", exact: true });
const periods = (page: Page) => page.getByRole("navigation", { name: "Periode" });

/** One COD order for Toko A through the hosted checkout, as a buyer would. */
async function placeCodOrder(page: Page) {
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(page);
  await page.getByLabel("Nama").fill("Budi Santoso");
  await page.getByLabel("Nomor HP").fill(testPhone());
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1 RT 02 RW 05, Jakarta 10310");
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
}

test("empty store: explicit empty state, work queue at zero, funnel note when signals are off", async ({ page }, info) => {
  await login(page, "owner-b@bukalaris.local");
  await page.goto("/seller");
  await expect(page.getByRole("heading", { name: "Ringkasan", level: 1 })).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "Ringkasan" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Belum ada pesanan hari ini")).toBeVisible();
  await expect(page.getByTestId("kpi-awaiting")).toContainText("0");
  await expect(page.getByTestId("kpi-orders")).toHaveCount(0);
  await expect(page.getByTestId("funnel-disabled")).toContainText("Sinyal iklan belum aktif");
  await evidence(page, info, "97-dashboard-empty");
  // The empty state's action moves to the 30-day period, which is also empty here.
  await page.getByRole("link", { name: "Lihat 30 hari" }).click();
  await expect(page).toHaveURL(/\/seller\?period=30d$/);
  await expect(periods(page).getByRole("link", { name: "30 hari" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Belum ada pesanan dalam 30 hari terakhir")).toBeVisible();
});

test("owner: a new COD order shows in the KPIs with the work-queue link; period switch by keyboard; staff sees the same", async ({ page }, info) => {
  await placeCodOrder(page);

  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller");
  await expect(page.getByRole("heading", { name: "Ringkasan", level: 1 })).toBeVisible();
  await expect(page.getByTestId("period-range")).toContainText("WIB");
  // At least this order today: the queue tile links to the awaiting filter (the link only renders when the queue is non-empty).
  await expect(page.getByTestId("kpi-awaiting").getByRole("link", { name: "Konfirmasi sekarang" })).toHaveAttribute("href", "/seller/orders?status=awaiting_confirmation");
  await expect(page.getByTestId("kpi-orders")).toBeVisible();
  await expect(page.getByTestId("kpi-goods")).toContainText("Rp");
  await expect(page.getByTestId("kpi-shipping")).toContainText("bukan pendapatan toko");
  await expect(page.getByTestId("kpi-cod-confirmed")).toContainText("pesanan COD");
  await expect(page.getByRole("heading", { name: "Produk terlaris" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Kaos Katun Basic" })).toBeVisible();
  await evidence(page, info, "98-dashboard-today");

  // Keyboard: focus the active period link, Tab to "7 hari", Enter switches the period (URL state).
  await periods(page).getByRole("link", { name: "Hari ini" }).focus();
  await page.keyboard.press("Tab");
  await expect(periods(page).getByRole("link", { name: "7 hari" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/seller\?period=7d$/);
  await expect(periods(page).getByRole("link", { name: "7 hari" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("period-range")).toContainText("7 hari");
  await expect(page.getByTestId("kpi-orders")).toBeVisible();
  await evidence(page, info, "99-dashboard-7d");

  // Nav: "Ringkasan" is current only on /seller itself.
  await page.getByRole("link", { name: "Konfirmasi sekarang" }).click();
  await expect(page).toHaveURL(/\/seller\/orders\?status=awaiting_confirmation$/);
  await expect(nav(page).getByRole("link", { name: "Ringkasan" })).not.toHaveAttribute("aria-current", "page");
  await expect(nav(page).getByRole("link", { name: "Pesanan", exact: true })).toHaveAttribute("aria-current", "page");

  // Unknown period falls back to today instead of erroring.
  await page.goto("/seller?period=year");
  await expect(periods(page).getByRole("link", { name: "Hari ini" })).toHaveAttribute("aria-current", "page");

  // Staff reads the same overview (orders.read is owner + staff).
  await page.context().clearCookies();
  await login(page, "staff-a@bukalaris.local");
  await page.goto("/seller");
  await expect(page.getByRole("heading", { name: "Ringkasan", level: 1 })).toBeVisible();
  await expect(page.getByTestId("kpi-orders")).toBeVisible();
});
