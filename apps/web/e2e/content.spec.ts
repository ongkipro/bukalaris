import { expect, test, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { evidence, login } from "./helpers";

/** A real solid-colour PNG (valid IHDR/IDAT/IEND) so the upload passes content sniffing and renders. */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => (~b.reduce((c, x) => table[(c ^ x) & 0xff]! ^ (c >>> 8), 0xffffffff) >>> 0);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const shellWidth = (page: Page) => page.locator(".sf-shell").evaluate((el) => el.getBoundingClientRect().width);

async function setTheme(page: Page, theme: "responsive" | "mobile") {
  await page.goto("/seller/settings");
  await page.getByRole("radio", { name: theme === "mobile" ? /Mobile/ : /Responsif/ }).check();
  await page.getByRole("button", { name: "Simpan pengaturan" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
}

test("seller publishes image, collection, page and theme; storefront shows them in both themes", async ({ page }, info) => {
  const tag = `${info.project.name}-${Date.now().toString(36)}`;
  const alt = `Kaos biru tampak depan ${tag}`;
  await login(page, "owner-a@bukalaris.local");

  // --- Product image upload: rejected non-image, then a real PNG with alt text.
  await page.getByRole("link", { name: "Kaos Katun Basic" }).click();
  await page.getByLabel("Berkas gambar").setInputFiles({ name: "bukan.png", mimeType: "image/png", buffer: Buffer.from("<svg/>") });
  await page.getByRole("button", { name: "Unggah gambar" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("JPG, PNG atau WebP");
  await page.getByLabel("Berkas gambar").setInputFiles({ name: "kaos.png", mimeType: "image/png", buffer: png(600, 600, [70, 110, 200]) });
  await page.getByLabel("Teks alternatif", { exact: true }).fill(alt);
  await page.getByRole("button", { name: "Unggah gambar" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  const sellerImg = page.getByTestId("product-images").getByRole("img", { name: alt });
  await expect(sellerImg).toBeVisible();
  // Make it the cover (an earlier run may already own position 0): one move up is enough for two images.
  const up = page.getByTestId("product-images").getByRole("listitem").filter({ has: page.getByRole("img", { name: alt }) }).getByRole("button", { name: /Naikkan/ });
  if ((await up.count()) > 0) {
    await up.click();
    await expect(page.getByRole("status")).toHaveText("Tersimpan.");
    await expect(page.getByTestId("product-images").getByRole("listitem").first().getByRole("img", { name: alt })).toBeVisible();
  }
  await evidence(page, info, "30-seller-product-images");

  // --- Collection with the product, published.
  await page.goto("/seller/collections/new");
  await page.getByLabel("Judul koleksi").fill(`Pilihan Ayu ${tag}`);
  await page.getByLabel("Slug URL").fill(`pilihan-${tag}`);
  await page.getByLabel("Status").selectOption("published");
  await page.getByRole("checkbox", { name: /Kaos Katun Basic/ }).check();
  await page.getByLabel("Urutan Kaos Katun Basic").fill("1");
  await evidence(page, info, "31-seller-collection-new");
  await page.getByRole("button", { name: "Simpan koleksi" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await expect(page.getByTestId("collection-id")).toHaveText(/^[0-9]+$/);

  // --- CMS page: reserved slug rejected, then published with markdown-lite and hostile text.
  await page.goto("/seller/pages/new");
  await page.getByLabel("Judul halaman").fill(`Tentang Kami ${tag}`);
  await page.getByLabel("Slug URL").fill("cart");
  await page.getByLabel("Isi").fill("x");
  await page.getByRole("button", { name: "Simpan halaman" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("dicadangkan");
  await page.getByLabel("Judul halaman").fill(`Tentang Kami ${tag}`);
  await page.getByLabel("Slug URL").fill(`tentang-${tag}`);
  await page.getByLabel("Isi").fill(`# Toko kami\n\nKami menjual **kaos lokal** sejak 2020.\n\n- Bahan katun\n- Dikirim dari Bandung\n\n<script>window.__pwned=1</script> [Hubungi](https://example.com)`);
  await page.getByLabel("Status").selectOption("published");
  await evidence(page, info, "32-seller-page-new");
  await page.getByRole("button", { name: "Simpan halaman" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");

  // --- Settings: mobile theme + profile.
  await page.goto("/seller/settings");
  await page.getByLabel("Deskripsi singkat").fill("Kaos katun dan aksesori lokal, dikirim dari Bandung.");
  await page.getByLabel(/WhatsApp/).fill("0812-3456-7890");
  await page.getByRole("radio", { name: /Mobile/ }).check();
  await page.getByRole("button", { name: "Simpan pengaturan" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await evidence(page, info, "33-seller-settings");

  // --- Storefront in the mobile theme: 480px column, image, nav, collection, page, search.
  await page.goto("/s/toko-a");
  expect(await shellWidth(page)).toBeLessThanOrEqual(480);
  await expect(page.getByRole("link", { name: "Tanya via WhatsApp" })).toHaveAttribute("href", /wa\.me\/6281234567890/);
  const cover = page.getByTestId("product-grid").getByRole("img", { name: alt });
  await expect(cover).toBeVisible();
  expect(await cover.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(600);
  await evidence(page, info, "34-storefront-home-mobile-theme");

  await page.getByRole("navigation", { name: "Navigasi toko" }).getByRole("link", { name: `Pilihan Ayu ${tag}` }).click();
  await expect(page.getByRole("heading", { name: `Pilihan Ayu ${tag}` })).toBeVisible();
  await expect(page.getByRole("link", { name: /Kaos Katun Basic/ })).toBeVisible();
  await evidence(page, info, "35-storefront-collection");

  await page.goto(`/s/toko-a/pages/tentang-${tag}`);
  await expect(page.getByRole("heading", { name: `Tentang Kami ${tag}` })).toBeVisible();
  await expect(page.locator(".prose-lite strong")).toHaveText("kaos lokal");
  await expect(page.locator(".prose-lite li")).toHaveCount(2);
  await expect(page.getByText("<script>window.__pwned=1</script>")).toBeVisible(); // rendered as text, not executed
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await evidence(page, info, "36-storefront-page");

  await page.goto("/s/toko-a/search?q=kaos");
  await expect(page.getByRole("status")).toContainText("hasil untuk");
  await expect(page.getByRole("link", { name: /Kaos Katun Basic/ })).toBeVisible();
  await evidence(page, info, "37-storefront-search");
  await page.goto("/s/toko-a/search?q=zzzz-tidak-ada");
  await expect(page.getByText("Produk tidak ditemukan.")).toBeVisible();

  // Product page shows the gallery image; the media id is not served under another store.
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  const src = await page.getByRole("img", { name: alt }).first().getAttribute("src");
  expect(src).toMatch(/\/media\/[0-9]+$/);
  expect((await page.request.get(src!)).status()).toBe(200);
  expect((await page.request.get(src!.replace("/s/toko-a/", "/s/toko-b/"))).status()).toBe(404);
  await evidence(page, info, "38-storefront-product-mobile-theme");

  // --- Back to the responsive theme: same content, wide shell on desktop.
  await setTheme(page, "responsive");
  await page.goto("/s/toko-a");
  const width = await shellWidth(page);
  if (info.project.name === "desktop") expect(width).toBeGreaterThan(480);
  await expect(page.getByTestId("product-grid").getByRole("img", { name: alt })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Navigasi toko" }).getByRole("link", { name: `Tentang Kami ${tag}` })).toBeVisible();
  await evidence(page, info, "39-storefront-home-responsive-theme");

  // Keyboard path to purchase still works from the product page.
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  await page.getByLabel("Jumlah").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Tambah ke keranjang" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Keranjang" })).toBeVisible();
  await expect(page.getByRole("img", { name: alt })).toBeVisible();
  await evidence(page, info, "40-storefront-cart");
});

test("staff cannot change settings; another store never sees the content", async ({ page }) => {
  await login(page, "staff-a@bukalaris.local");
  await page.goto("/seller/settings");
  await expect(page.getByText("Hanya pemilik toko")).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan pengaturan" })).toHaveCount(0);

  await page.context().clearCookies();
  await login(page, "owner-b@bukalaris.local");
  await page.goto("/seller/collections");
  await expect(page.getByText(/Pilihan Ayu/)).toHaveCount(0);
  await page.goto("/seller/pages");
  await expect(page.getByText(/Tentang Kami/)).toHaveCount(0);
  expect((await page.request.get("/s/toko-b/search?q=kaos")).status()).toBe(200);
  await page.goto("/s/toko-b/search?q=kaos");
  await expect(page.getByText("Produk tidak ditemukan.")).toBeVisible();
});

test("operator creates a store for an existing owner and opens its detail", async ({ page }, info) => {
  const slug = `toko-${info.project.name}-${Date.now().toString(36)}`;
  await login(page, "admin@bukalaris.local", "/admin");
  await page.goto("/admin/stores");
  await page.getByRole("link", { name: "Buat toko" }).click();
  await page.getByLabel("Nama toko").fill("Toko Baru");
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Email pemilik").fill("nobody@bukalaris.local");
  await page.getByRole("button", { name: "Buat toko" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("Tidak ada pengguna");
  await page.getByLabel("Nama toko").fill("Toko Baru");
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Email pemilik").fill("owner-b@bukalaris.local");
  await page.getByRole("button", { name: "Buat toko" }).click();
  await expect(page.getByRole("heading", { name: "Toko Baru" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await expect(page.getByText("o***@b***.local").first()).toBeVisible(); // T-63: the team summary is masked in the data layer
  expect(await page.content()).not.toContain("owner-b@bukalaris.local");
  await expect(page.getByText("Toko dibuat")).toBeVisible(); // T-28: audit codes render as labels (store.create → "Toko dibuat")
  await evidence(page, info, "41-admin-store-detail");
  expect((await page.request.get(`/s/${slug}`)).status()).toBe(200);
});
