import { expect, test, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { chooseDestination, enrolTotpViaApi, evidence, login, seedFixtureStore, testPhone, totp } from "./helpers";

// T-116 (PR-27, ADR-0013 section 8 & D-33, ADR-0015 decision 8, ADR-0016 decision 23):
// Seller terms on SC-32 (draft badge, required disclosures, acceptance gate before saving a provider key or bank account),
// provider-copy redaction notice on SC-24 (/seller/privacy), terms notice on /seller/settings, and payee notice naming
// the store on checkout, confirmation and the signed order-status page (/o/[token]) at 320 px and desktop.

const alert = (page: Page) => page.getByRole("main").getByRole("alert");
const status = (page: Page) => page.getByRole("main").getByRole("status");
/** A fresh TOTP code within Better Auth's accepted window, waiting for the next 30 s step when spent. */
function codes(page: Page, secret: string) {
  const used = new Set<string>();
  return async () => {
    for (;;) {
      if (Date.now() % 30_000 < 25_000) {
        for (const step of [1, 0]) {
          const c = totp(secret, Date.now() + step * 30_000);
          if (!used.has(c)) { used.add(c); return c; }
        }
      }
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
    }
  };
}

test("seller terms gate provider keys and bank accounts, privacy shows provider-copy notice, and checkout/order-status name the store as payee", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  const store = seedFixtureStore("t116");
  await login(page, store.email, "/seller");
  const nextCode = codes(page, await enrolTotpViaApi(page, store.email));

  // 1. SC-32: terms start as draft and unaccepted; saving a provider key without acceptance is refused on the server.
  await page.goto("/seller/payments");
  const terms = page.getByTestId("seller-terms");
  await expect(terms).toBeVisible();
  await expect(terms.getByTestId("terms-draft-badge")).toContainText("Draf");
  await expect(terms.getByTestId("terms-status-badge")).toHaveText("Belum disetujui");
  await expect(terms.getByTestId("terms-body")).toContainText("tidak pernah melalui, dipegang");
  await expect(terms.getByTestId("terms-body")).toContainText("tidak menjangkau atau menghapus salinan data pembeli");
  await expect(terms.getByTestId("terms-body")).toContainText("produk digital");
  await evidence(page, info, "t116-seller-terms-unaccepted");

  const bankForm = page.getByRole("form", { name: "Tambah rekening" });
  await bankForm.getByLabel("Nomor rekening").fill("1234567890");
  await bankForm.getByLabel("Nama pemilik rekening").fill("Pemilik Toko");
  await bankForm.getByLabel(/Kode verifikasi/).fill(await nextCode());
  await bankForm.getByRole("button", { name: "Tambah rekening" }).click();
  await expect(alert(page)).toContainText("Setujui syarat penjual");
  await expect(page.getByTestId("bank-accounts-empty")).toBeVisible();

  // Accept terms -> badge updates and saving a bank account now succeeds.
  const acceptForm = page.getByRole("form", { name: "Setujui syarat penjual" });
  await acceptForm.getByRole("checkbox").check();
  await acceptForm.getByRole("button", { name: "Setujui syarat penjual" }).click();
  await expect(status(page)).toContainText("Persetujuan syarat penjual tercatat");
  await expect(terms.getByTestId("terms-status-badge")).toContainText("Disetujui");
  await expect(terms.getByTestId("terms-accepted-info")).toBeVisible();
  await evidence(page, info, "t116-seller-terms-accepted");

  await bankForm.getByLabel("Nomor rekening").fill("1234567890");
  await bankForm.getByLabel("Nama pemilik rekening").fill("Pemilik Toko");
  await bankForm.getByLabel(/Kode verifikasi/).fill(await nextCode());
  await bankForm.getByRole("button", { name: "Tambah rekening" }).click();
  await expect(status(page)).toContainText("Rekening ditambahkan");
  await expect(page.getByTestId("bank-accounts")).toContainText("1234567890");

  // 2. Settings and SC-24 privacy notice at 320 px and desktop.
  await page.goto("/seller/settings");
  await expect(page.getByTestId("settings-terms-notice")).toContainText("sudah menyetujui syarat penjual versi 1");
  await page.goto("/seller/privacy");
  await expect(page.getByTestId("privacy-provider-notice")).toContainText("tidak menjangkau salinan data pembeli yang sudah terkirim ke akun Mengantar atau AutoLaris");
  await evidence(page, info, "t116-seller-privacy-notice");

  // 3. Buyer checkout, confirmation and signed order-status page name the store as payee (and never name Mengantar/AutoLaris).
  const buyerCtx = await browser.newContext({ baseURL: info.project.use.baseURL!, viewport: page.viewportSize()! });
  const bp = await buyerCtx.newPage();
  await bp.goto("/s/toko-a/products/kaos-katun-basic");
  await bp.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await bp.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(bp);
  await expect(bp.getByTestId("payee-notice")).toContainText("Toko A");
  await evidence(bp, info, "t116-checkout-payee-notice");
  await bp.getByLabel("Nama").fill("Pembeli T116");
  await bp.getByLabel("Nomor HP").fill(testPhone());
  await bp.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await bp.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(bp.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const orderId = Number((await bp.getByTestId("order-id").textContent())!.replace("#", ""));
  await expect(bp.getByTestId("payee-notice")).toContainText("Toko A");
  await evidence(bp, info, "t116-confirmation-payee-notice");
  const exp = Math.floor((Date.now() + 3_600_000) / 1000);
  const sig = createHmac("sha256", process.env.ORDER_LINK_SECRET!).update(`order-link:${orderId}.${exp}`).digest("base64url");
  await bp.goto(`/o/${orderId}.${exp}.${sig}`);
  await expect(bp.getByTestId("payee-notice")).toContainText("Toko A");
  await evidence(bp, info, "t116-order-status-payee-notice");
  await buyerCtx.close();
});
