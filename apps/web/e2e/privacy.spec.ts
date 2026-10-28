import { expect, test, type Page } from "@playwright/test";
import { chooseDestination, evidence, login, testPhone } from "./helpers";

// privacy track (T-43, SEC-19, PRIV-4): a buyer places a COD order; the owner finds the buyer by
// phone (in another spelling), downloads the JSON export, is refused a redaction of the still-open
// order, overrides with a reason, and the order detail keeps amounts while contact fields read
// "[dihapus]". Staff only see the read-only notice and cannot export.

const EMAIL = "privasi-e2e@example.com";

async function buyerOrder(page: Page, phone: string) {
  await page.goto("/s/toko-a");
  await page.getByRole("link", { name: /Kaos Katun Basic/ }).click();
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(page.getByRole("heading", { name: "Keranjang" })).toBeVisible();
  await page.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(page);
  await page.getByLabel("Nama").fill("Privasi Uji");
  await page.getByLabel("Nomor HP").fill(phone);
  await page.getByLabel(/^Email/).fill(EMAIL);
  await page.getByLabel("Alamat lengkap").fill("Jl. Privasi No. 43, Bandung 40111");
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  return Number(await page.getByTestId("order-id").innerText().then((t) => t.replace("#", "")));
}

test("owner finds a buyer by phone, exports JSON, is refused for an open order, overrides with a reason; detail keeps the money", async ({ page }, info) => {
  const phone = testPhone();
  const orderId = await buyerOrder(page, phone);
  await page.context().clearCookies();

  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller/privacy");
  await expect(page.getByRole("heading", { name: "Data pembeli" })).toBeVisible();
  await evidence(page, info, "privacy-search");

  // Invalid key → inline alert, no results.
  await page.getByLabel("Nomor HP atau email pembeli").fill("bukan nomor");
  await page.getByRole("button", { name: "Cari" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("nomor HP");

  // +62 spelling finds the 0… order.
  const spelled = `+62 ${phone.slice(1, 4)}-${phone.slice(4)}`;
  await page.getByLabel("Nomor HP atau email pembeli").fill(spelled);
  await page.getByRole("button", { name: "Cari" }).click();
  const row = page.getByTestId(`privacy-order-${orderId}`);
  await expect(row).toContainText("Privasi Uji");
  await expect(row).toContainText("Menunggu konfirmasi");
  await expect(page.getByTestId("privacy-results")).toContainText(`62${phone.slice(1)}`); // T-57: the lookup key is the canonical 62… form
  await evidence(page, info, "privacy-results");

  // Export: a downloaded JSON with this order, never cached.
  const href = await page.getByTestId("privacy-export").getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="pembeli-toko-a-.*\.json"$/);
  expect(res.headers()["cache-control"]).toBe("no-store");
  const data = (await res.json()) as { store: { slug: string }; orders: { id: number; buyerPhone: string; buyerEmail: string; lines: unknown[] }[] };
  expect(data.store.slug).toBe("toko-a");
  const exported = data.orders.find((o) => o.id === orderId)!;
  expect(exported).toMatchObject({ buyerPhone: phone, buyerEmail: EMAIL });
  expect(exported.lines.length).toBe(1);
  expect((await page.request.get("/seller/privacy/export?q=abc")).status()).toBe(400);

  // Redaction of an open order is refused without the override…
  page.on("dialog", (d) => d.accept());
  await page.getByLabel(`Pilih pesanan #${orderId}`).check();
  await page.getByRole("button", { name: "Hapus data terpilih" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("belum selesai/dibatalkan");

  // …and goes through with the override + reason; the buyer is then no longer findable.
  await page.getByLabel(`Pilih pesanan #${orderId}`).check();
  await page.getByLabel(/Tetap hapus pesanan/).check();
  await page.getByLabel("Alasan (wajib bila tetap hapus)").fill("Permintaan pembeli lewat WhatsApp (uji e2e)");
  await page.getByRole("button", { name: "Hapus data terpilih" }).click();
  await expect(page.getByRole("status")).toContainText("Data kontak 1 pesanan dihapus permanen.");
  await expect(page.getByTestId("privacy-empty")).toBeVisible();
  await evidence(page, info, "privacy-redacted");

  // Order detail: contact fields replaced, status and total intact.
  await page.goto(`/seller/orders/${orderId}`);
  await expect(page.locator("section[aria-labelledby=buyer]")).toContainText("[dihapus]");
  expect(await page.content()).not.toContain(phone);
  expect(await page.content()).not.toContain(EMAIL);
  await expect(page.getByTestId("order-status")).toHaveText("Menunggu konfirmasi");
  await expect(page.getByTestId("order-total")).not.toHaveText("—");
  await expect(page.getByTestId("order-total")).toContainText("Rp");
});

test("staff see the read-only notice and cannot export", async ({ page }) => {
  await login(page, "staff-a@bukalaris.local");
  await page.goto("/seller/privacy");
  await expect(page.getByRole("note")).toContainText("pemilik toko");
  await expect(page.getByLabel("Nomor HP atau email pembeli")).toHaveCount(0);
  const res = await page.request.get(`/seller/privacy/export?q=${testPhone()}`);
  expect(res.status()).toBe(403);
  expect(res.headers()["cache-control"]).toBe("no-store");
});
