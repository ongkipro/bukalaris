import { expect, test, type Page } from "@playwright/test";
import { evidence, login } from "./helpers";

// landing track (T-42, PR-9): builder → publish → /lp/<slug> independent of the storefront
// theme → order section adds to the store cart and hands off to hosted checkout.

const saved = (page: Page, text = "Tersimpan.") => expect(page.getByRole("status")).toHaveText(text);
/** Every builder save appends a revision; waiting for the new number (not the notice, which is
 *  already "Tersimpan." from the previous save) proves the redirect after this save landed. */
const atRevision = async (page: Page, n: number) => {
  await expect(page.getByTestId("draft-revision")).toHaveText(String(n));
  await saved(page);
};

async function setTheme(page: Page, theme: "responsive" | "mobile") {
  await page.goto("/seller/settings");
  await page.getByRole("radio", { name: theme === "mobile" ? /Mobile/ : /Responsif/ }).check();
  await page.getByRole("button", { name: "Simpan pengaturan" }).click();
  await saved(page);
}

/** What UI-6 says must not move when the store theme changes. */
const lpLook = (page: Page) =>
  page.getByTestId("lp-root").evaluate((root) => {
    const h1 = root.querySelector("h1")!;
    const wrap = root.querySelector(".lp-wrap")!;
    return {
      width: Math.round(root.getBoundingClientRect().width),
      wrapWidth: Math.round(wrap.getBoundingClientRect().width),
      h1Size: getComputedStyle(h1).fontSize,
      bg: getComputedStyle(root).backgroundColor,
      color: getComputedStyle(root).color,
      shell: document.querySelector(".sf-shell, [data-theme]") !== null,
    };
  });

test("seller builds and publishes a landing page; buyer orders from it in either store theme", async ({ page }, info) => {
  const tag = `${info.project.name}-${Date.now().toString(36)}`;
  const slug = `promo-${tag}`;
  const lpUrl = `/s/toko-a/lp/${slug}`;
  await login(page, "owner-a@bukalaris.local");

  // --- Create: reserved slug refused, then a draft with revision 1.
  await page.goto("/seller/landing-pages");
  await page.getByRole("link", { name: "Buat landing page" }).first().click();
  await page.getByLabel("Judul").fill(`Promo Kaos ${tag}`);
  await page.getByLabel("Slug URL").fill("cart");
  await page.getByRole("button", { name: "Buat dan lanjut mengedit" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("dicadangkan");
  await page.getByLabel("Judul").fill(`Promo Kaos ${tag}`);
  await page.getByLabel("Slug URL").fill(slug);
  await page.getByRole("button", { name: "Buat dan lanjut mengedit" }).click();
  await saved(page);
  await expect(page.getByTestId("draft-revision")).toHaveText("1");
  expect((await page.request.get(lpUrl)).status()).toBe(404); // a draft is never public

  // --- Blocks: order section (default choice), FAQ; edit hero and bind the order product.
  await page.getByLabel("Tambah blok").selectOption("order");
  await page.getByRole("button", { name: "Tambah blok" }).click();
  await atRevision(page, 2);
  await page.getByLabel("Tambah blok").selectOption("faq");
  await page.getByRole("button", { name: "Tambah blok" }).click();
  await atRevision(page, 3);
  const hero = page.getByTestId("block-hero");
  await hero.getByLabel("Judul utama").fill(`Kaos katun adem ${tag}`);
  await hero.getByLabel("Kalimat pendukung").fill("Bahan lembut, jahitan rapi, dikirim dari Bandung.");
  await hero.getByRole("button", { name: /Simpan blok/ }).click();
  await atRevision(page, 4);
  const order = page.getByTestId("block-order");
  await order.getByLabel("Produk").selectOption({ label: "Kaos Katun Basic" });
  await order.getByRole("button", { name: /Simpan blok/ }).click();
  await atRevision(page, 5);
  const faq = page.getByTestId("block-faq");
  await faq.getByLabel("Jawaban").first().fill("Dua sampai empat hari kerja untuk Pulau Jawa.");
  await faq.getByRole("button", { name: /Simpan blok/ }).click();
  await atRevision(page, 6);
  // Move FAQ above the order section (button alternative to drag-and-drop).
  await page.getByTestId("block-faq").getByRole("button", { name: /Naikkan blok/ }).click();
  await atRevision(page, 7);
  await expect(page.getByTestId("block-faq").getByRole("heading", { level: 3 })).toContainText("2.");
  await page.getByRole("radio", { name: "Toska" }).check({ force: true });
  await page.getByRole("button", { name: "Simpan pengaturan" }).click();
  await atRevision(page, 8);
  await evidence(page, info, "60-seller-landing-editor");

  // --- Private preview renders the draft with a disabled order button.
  await page.getByRole("link", { name: "Pratinjau draf" }).click();
  const preview = page.getByTestId("lp-preview");
  await expect(preview.getByRole("heading", { level: 1, name: `Kaos katun adem ${tag}` })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Lanjut ke checkout" })).toBeDisabled();
  await evidence(page, info, "61-seller-landing-preview");
  await page.getByRole("link", { name: "Kembali ke editor" }).click();

  // --- Publish.
  await page.getByRole("button", { name: "Publikasikan", exact: true }).click();
  await saved(page, "Landing page dipublikasikan.");

  // --- Public page: own presentation, no storefront shell; identical in both themes.
  await page.goto(lpUrl);
  await expect(page.getByRole("heading", { level: 1, name: `Kaos katun adem ${tag}` })).toBeVisible();
  await expect(page.getByTestId("lp-root")).toHaveAttribute("data-accent", "teal");
  const responsiveLook = await lpLook(page);
  expect(responsiveLook.shell).toBe(false);
  await evidence(page, info, "62-landing-public");

  await setTheme(page, "mobile");
  await page.goto("/s/toko-a");
  expect(await page.locator(".sf-shell").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(480); // theme really applied
  await page.goto(lpUrl);
  expect(await lpLook(page)).toEqual(responsiveLook);
  await setTheme(page, "responsive");

  // --- Order section → store cart → hosted checkout (no buyer fields on the LP).
  await page.goto(lpUrl);
  const section = page.locator("#order");
  await expect(section.locator("input[name=name], input[name=phone], input[name=address]")).toHaveCount(0);
  await section.getByRole("radio", { name: /^L/ }).check();
  await section.getByLabel("Jumlah").fill("2");
  await evidence(page, info, "63-landing-order-section");
  await section.getByRole("button", { name: "Lanjut ke checkout" }).click();
  await expect(page).toHaveURL(/\/checkout\?store=toko-a$/);
  await expect(page.getByRole("heading", { name: /Checkout · / })).toBeVisible();
  await expect(page.getByText("Kaos Katun Basic").first()).toBeVisible();
  await evidence(page, info, "64-landing-checkout-handoff");
  // Same cart as the storefront (D-6): the line is in the store cart.
  await page.goto("/s/toko-a/cart");
  await expect(page.getByText("Kaos Katun Basic").first()).toBeVisible();

  // --- Another store never resolves it; unpublish takes it offline.
  expect((await page.request.get(`/s/toko-b/lp/${slug}`)).status()).toBe(404);
  await page.goto("/seller/landing-pages");
  await page.getByRole("link", { name: `Promo Kaos ${tag}` }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Tarik dari publik" }).click();
  await saved(page, "Landing page ditarik dari publik; draf tetap tersimpan.");
  expect((await page.request.get(lpUrl)).status()).toBe(404);
});

test("another store's seller never sees the landing pages", async ({ page }) => {
  await login(page, "owner-b@bukalaris.local");
  await page.goto("/seller/landing-pages");
  await expect(page.getByText(/Promo Kaos/)).toHaveCount(0);
});
