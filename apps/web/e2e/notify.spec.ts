import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { chooseDestination, evidence, login } from "./helpers";

// Order e-mail notifications (T-36). The dev Mailer stores mail in `mail_outbox`; like
// accounts.spec.ts this spec reads it from the e2e database because `/dev/outbox` is
// hidden in the production build the suite runs against. The outbox worker (second
// Playwright webServer) renders and "sends" the mails.
const url = process.env.E2E_DATABASE_URL;
if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
const sql = postgres(url, { max: 1, onnotice: () => {} });
test.afterAll(() => sql.end());

type MailRow = { to_email: string; subject: string; text_body: string; html_body: string | null };
const mailsFor = (orderId: string) =>
  sql<MailRow[]>`select to_email, subject, text_body, html_body from mail_outbox where text_body like ${`%Pesanan #${orderId} ·%`} order by id`;
const BUYER = "budi@example.com";
const OWNER = "owner-a@bukalaris.local";

test("buyer with e-mail checks out → buyer and seller mails → signed status link → shipped mail with tracking; tampered link is 404", async ({ page }, info) => {
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  await page.getByLabel("Jumlah").fill("1");
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(page);
  await page.getByLabel("Nama").fill("Budi Santoso");
  await page.getByLabel("Nomor HP").fill("081234567890");
  await page.getByLabel(/^Email/).fill(BUYER);
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await evidence(page, info, "70-checkout-with-email");
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const id = (await page.getByTestId("order-id").textContent())!.replace("#", "");
  expect(id).toMatch(/^[0-9]+$/);

  // The worker sends one mail to the buyer and one to the store owner.
  await expect.poll(async () => (await mailsFor(id)).length, { timeout: 20_000 }).toBe(2);
  const created = await mailsFor(id);
  const buyerMail = created.find((m) => m.to_email === BUYER)!;
  const sellerMail = created.find((m) => m.to_email === OWNER)!;
  expect(buyerMail.subject).toBe(`Pesanan #${id} di Toko Ayu diterima`);
  expect(sellerMail.subject).toBe(`[Toko Ayu] Pesanan COD #${id} menunggu konfirmasi`);
  expect(buyerMail.html_body).toContain("<a href=");
  expect(sellerMail.text_body).toContain(`/seller/orders/${id}`);

  // The buyer link opens that order only: status, lines, totals, courier, area label — no phone or street.
  const link = /https?:\/\/\S+\/o\/[0-9]+\.[0-9]+\.[A-Za-z0-9_-]+/.exec(buyerMail.text_body)![0];
  const path = new URL(link).pathname;
  await page.context().clearCookies();
  await page.goto(path);
  await expect(page.getByRole("heading", { name: `Pesanan #${id}` })).toBeVisible();
  await expect(page.getByTestId("order-status")).toHaveText("Menunggu konfirmasi penjual");
  await expect(page.getByText(/Kaos Katun Basic · M × 1/)).toBeVisible();
  await expect(page.getByTestId("order-total")).toHaveText("Rp 106.500"); // 89.000 + COD ongkir 17.500
  await expect(page.getByTestId("courier")).toContainText("JNE");
  await expect(page.getByTestId("tracking")).toHaveText("Belum tersedia");
  await expect(page.getByText("Menteng")).toBeVisible();
  await expect(page.getByText("081234567890")).toHaveCount(0);
  await expect(page.getByText(/Jl\. Merdeka/)).toHaveCount(0);
  await evidence(page, info, "71-order-status-awaiting");

  // Seller confirms, processes and ships with a tracking number.
  await login(page, OWNER);
  await page.goto(`/seller/orders/${id}`);
  await page.getByRole("button", { name: "Konfirmasi pesanan" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Baru");
  await page.getByRole("button", { name: "Proses pesanan" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Diproses");
  const resi = `JNE-${id}-${info.project.name}`;
  await page.getByLabel("Nomor resi kurir").fill(resi);
  await page.getByRole("button", { name: "Kirim pesanan" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Dikirim");

  // Buyer gets "confirmed" and "shipped" (with the tracking number); the seller gets nothing more.
  await expect.poll(async () => (await mailsFor(id)).length, { timeout: 20_000 }).toBe(4);
  const all = await mailsFor(id);
  expect(all.filter((m) => m.to_email === OWNER)).toHaveLength(1);
  const shipped = all.at(-1)!;
  expect(shipped).toMatchObject({ to_email: BUYER, subject: `Pesanan #${id} dikirim · resi ${resi}` });
  expect(shipped.text_body).toContain(`Nomor resi: ${resi}`);
  expect(all[2]!.subject).toBe(`Pesanan #${id} dikonfirmasi oleh Toko Ayu`);

  // The same link now shows the shipped state and the tracking number.
  await page.context().clearCookies();
  await page.goto(path);
  await expect(page.getByTestId("order-status")).toHaveText("Dikirim");
  await expect(page.getByTestId("tracking")).toHaveText(resi);
  await evidence(page, info, "72-order-status-shipped");

  // Tampered signature, another order id with this signature, and junk: all 404 with a safe message.
  const flipped = path.slice(0, -1) + (path.endsWith("A") ? "B" : "A");
  expect((await page.goto(flipped))?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Tautan tidak berlaku" })).toBeVisible();
  await expect(page.getByText(resi)).toHaveCount(0);
  await evidence(page, info, "73-order-link-invalid");
  const [, , exp, sig] = path.split(/[/.]/).slice(1) as [string, string, string, string];
  expect((await page.goto(`/o/${Number(id) + 1}.${exp}.${sig}`))?.status()).toBe(404);
  expect((await page.goto(`/o/${id}.${exp}.${sig}`))?.status()).toBe(200);
  expect((await page.goto("/o/not-a-token"))?.status()).toBe(404);
});
