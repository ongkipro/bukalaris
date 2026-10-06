import { expect, test, type Locator, type Page } from "@playwright/test";
import { evidence, login } from "./helpers";

/**
 * T-28 — Seller and Super Admin UI consistency pass. Every seller/admin page is captured at 320 px and
 * desktop through `evidence()` (which also asserts zero CSP violations and no horizontal page overflow),
 * plus keyboard-only paths for the shell navigation and one form, and the status codes that a route-level
 * loading boundary would have broken (soft 404/redirect, docs/tracks/catalog.md).
 */

/** Press Tab until `target` owns focus (bounded: a shell with ~20 stops before the main content). */
async function tabTo(page: Page, target: Locator, max = 40) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("focus never reached the target");
}

const nav = (page: Page, name: "Seller" | "Super Admin") => page.getByRole("navigation", { name, exact: true });

test.describe("Seller Admin shell and pages", () => {
  test("shell: skip link, scrollable nav with active state, keyboard navigation", async ({ page }, info) => {
    await login(page, "owner-a@bukalaris.local");
    await expect(page.getByRole("heading", { name: "Produk", level: 1 })).toBeVisible();
    await expect(nav(page, "Seller").getByRole("link", { name: "Produk", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Toko Ayu · Pemilik")).toBeVisible();
    await evidence(page, info, "70-ui-seller-products");

    // The nav strip scrolls inside the header at 320 px instead of widening the page.
    const strip = nav(page, "Seller");
    const scrolls = await strip.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrolls).toBe(info.project.name === "mobile-320");

    // Keyboard: on a fresh document the first Tab lands on the skip link; Enter moves focus into <main>.
    // (After the login redirect, React's client navigation keeps the old focus start point, so reload first.)
    await page.goto("/seller/products");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Lewati ke konten utama" })).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");

    // Keyboard: reach the active nav item, step to the next one and activate it.
    await tabTo(page, strip.getByRole("link", { name: "Produk", exact: true }));
    await page.keyboard.press("Tab");
    await expect(strip.getByRole("link", { name: "Inventaris" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/seller\/inventory$/);
    await expect(nav(page, "Seller").getByRole("link", { name: "Inventaris" })).toHaveAttribute("aria-current", "page");
    await expect(nav(page, "Seller").getByRole("link", { name: "Produk", exact: true })).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Inventaris", level: 1 })).toBeVisible(); // past the route skeleton
    await evidence(page, info, "71-ui-seller-inventory");
  });

  test("new product form is completable by keyboard only; detail, lists and empty states render", async ({ page }, info) => {
    const title = `Tas Kanvas ${info.project.name} ${Date.now()}`;
    await login(page, "owner-a@bukalaris.local");
    await page.goto("/seller/products/new");
    await evidence(page, info, "72-ui-seller-product-new");

    await tabTo(page, page.getByLabel("Judul produk"));
    await page.keyboard.type(title);
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Deskripsi")).toBeFocused();
    await page.keyboard.type("Kanvas tebal, jahitan ganda.");
    await page.keyboard.press("Tab"); // status (keep Draf)
    await expect(page.getByLabel("Status")).toBeFocused();
    await page.keyboard.press("Tab"); // slug
    await page.keyboard.press("Tab"); // variant title (prefilled "Default")
    await expect(page.getByLabel("Nama varian")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Harga (Rp)")).toBeFocused();
    await page.keyboard.type("120000");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Stok")).toBeFocused();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("5");
    await page.keyboard.press("Tab"); // sku
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Simpan produk" })).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Tersimpan.");
    await expect(page.locator("[data-slot=badge]", { hasText: "Draf" })).toBeVisible(); // status badge, Indonesian label
    await evidence(page, info, "73-ui-seller-product-detail");

    await page.goto("/seller/orders");
    await evidence(page, info, "74-ui-seller-orders");
    const order = page.getByRole("row").getByRole("link", { name: /^#\d+$/ }).first();
    if (await order.count()) {
      await order.click();
      await expect(page.getByRole("heading", { name: /^Pesanan #\d+$/ })).toBeVisible();
      await evidence(page, info, "75-ui-seller-order-detail");
    }
    await page.goto("/seller/orders?status=on_hold");
    await expect(page.getByText(/Tidak ada pesanan berstatus "Ditahan"|^#\d+$/).first()).toBeVisible();
    await evidence(page, info, "76-ui-seller-orders-filtered");

    for (const [path, step] of [
      ["/seller/collections", "77-ui-seller-collections"],
      ["/seller/collections/new", "78-ui-seller-collection-new"],
      ["/seller/pages", "79-ui-seller-pages"],
      ["/seller/pages/new", "80-ui-seller-page-new"],
      ["/seller/members", "81-ui-seller-members"],
      ["/seller/shipping", "82-ui-seller-shipping"],
      ["/seller/channels", "83-ui-seller-channels"],
      ["/seller/settings", "84-ui-seller-settings"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await evidence(page, info, step);
    }

    // Detail pages exist only when earlier specs created content; capture them when they do.
    await page.goto("/seller/collections");
    const collection = page.getByRole("row").getByRole("link").first();
    if (await collection.count()) {
      await collection.click();
      await expect(page.getByTestId("collection-id")).toBeVisible();
      await evidence(page, info, "85-ui-seller-collection-detail");
    }
    await page.goto("/seller/pages");
    const cmsPage = page.getByRole("row").getByRole("link").first();
    if (await cmsPage.count()) {
      await cmsPage.click();
      await expect(page.getByTestId("page-id")).toBeVisible();
      await evidence(page, info, "86-ui-seller-page-detail");
    }

    // No route-level Suspense above these pages: cross-store / unknown ids are real 404s, not streamed 200s.
    expect((await page.goto("/seller/products/999999999"))?.status()).toBe(404);
    expect((await page.goto("/seller/orders/999999999"))?.status()).toBe(404);
    expect((await page.goto("/seller/collections/999999999"))?.status()).toBe(404);
    expect((await page.goto("/seller/pages/999999999"))?.status()).toBe(404);
  });

  test("staff sees read-only and denied states; a seller is denied in Super Admin", async ({ page }, info) => {
    await login(page, "staff-a@bukalaris.local");
    await expect(page.getByText("Toko Ayu · Staf")).toBeVisible();
    await page.goto("/seller/channels");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Hanya pemilik toko");
    await evidence(page, info, "87-ui-seller-channels-denied");
    await page.goto("/seller/settings");
    await expect(page.getByLabel("Nama toko")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Simpan pengaturan" })).toHaveCount(0);
    await evidence(page, info, "88-ui-seller-settings-readonly");
    await page.goto("/admin");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Akses ditolak.");
    await expect(nav(page, "Super Admin")).toHaveCount(0);
    await evidence(page, info, "89-ui-admin-denied");
  });
});

test.describe("Super Admin shell and pages", () => {
  test("stores, store detail, create form, shipping margin, logs; keyboard nav; real 404", async ({ page }, info) => {
    await login(page, "admin@bukalaris.local", "/admin");
    await expect(page.getByRole("heading", { name: "Toko", level: 1 })).toBeVisible();
    await expect(nav(page, "Super Admin").getByRole("link", { name: "Toko", exact: true })).toHaveAttribute("aria-current", "page");
    await evidence(page, info, "90-ui-admin-stores");

    await page.goto("/admin");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Lewati ke konten utama" })).toBeFocused();
    await tabTo(page, nav(page, "Super Admin").getByRole("link", { name: "Log System" }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admin\/logs$/);
    await expect(nav(page, "Super Admin").getByRole("link", { name: "Log System" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Log System", level: 1 })).toBeVisible(); // past the route skeleton
    await evidence(page, info, "91-ui-admin-logs");
    const event = page.getByRole("table").getByRole("link", { name: /^Detail kejadian/ }).first();
    if (await event.count()) {
      await event.click();
      await expect(page.getByRole("heading", { name: "Detail kejadian" })).toBeVisible();
      await evidence(page, info, "92-ui-admin-log-detail");
    }
    await page.goto("/admin/logs?requestId=tidak-ada-00000000");
    await expect(page.getByTestId("empty")).toContainText("cocok dengan filter");
    await evidence(page, info, "93-ui-admin-logs-empty");

    await page.goto("/admin");
    await page.getByRole("listitem").filter({ hasText: "/toko-a" }).getByRole("link", { name: "Toko Ayu" }).click();
    await expect(page.getByRole("heading", { name: "Toko Ayu", level: 1 })).toBeVisible();
    await expect(page.locator("header p", { hasText: /tema (Responsif|Mobile)/ })).toBeVisible(); // theme is labelled, not the raw enum
    await evidence(page, info, "94-ui-admin-store-detail");

    await page.goto("/admin/stores/new");
    await expect(page.getByRole("heading", { name: "Buat toko", level: 1 })).toBeVisible();
    await evidence(page, info, "95-ui-admin-store-new");

    await page.goto("/admin/shipping");
    await expect(page.getByRole("heading", { name: "Margin ongkir" })).toBeVisible();
    await evidence(page, info, "96-ui-admin-shipping");

    expect((await page.goto("/admin/stores/999999999"))?.status()).toBe(404);
  });

  test("unauthenticated seller/admin routes still redirect with a real 307", async ({ request }) => {
    for (const path of ["/seller", "/seller/inventory", "/admin", "/admin/logs"]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(307);
      expect(res.headers()["location"], path).toMatch(/^\/login\?next=/);
    }
  });
});
