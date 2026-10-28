import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { chooseDestination, evidence, login, testPhone } from "./helpers";

// Shipment booking + tracking (T-39). The worker (second Playwright webServer) runs the fake
// Mengantar adapter: booking issues a `FAKE-<courier>-<order>` resi at once, each tracking read
// advances one step (ON DELIVERY → DELIVERED). The signed buyer link is read from the dev mail
// outbox in the e2e database, as in notify.spec.ts.
const url = process.env.E2E_DATABASE_URL;
if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
const sql = postgres(url, { max: 1, onnotice: () => {} });
test.afterAll(() => sql.end());

const OWNER = "owner-a@bukalaris.local";

async function buy(page: Page, payment: "cod" | "manual_transfer", email?: string) {
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  await page.getByLabel("Jumlah").fill("1");
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(page);
  await page.getByLabel("Nama").fill("Budi Santoso");
  await page.getByLabel("Nomor HP").fill(testPhone());
  if (email) await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await page.locator(`input[name="paymentMethod"][value="${payment}"]`).check();
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  return (await page.getByTestId("order-id").textContent())!.replace("#", "");
}

/** Reload until the worker has applied the expected state (the page itself never polls). */
const reloadUntil = (page: Page, testId: string, text: string | RegExp) =>
  expect
    .poll(
      async () => {
        await page.reload();
        return (await page.getByTestId(testId).textContent())?.trim() ?? "";
      },
      { timeout: 20_000, intervals: [500, 1000] },
    )
    .toMatch(text);

test("seller books a paid order through Mengantar → resi + shipped by the worker → tracking to delivered → buyer link shows the timeline", async ({ page }, info) => {
  const email = `fulfil-${info.project.name}@example.com`;
  const id = await buy(page, "manual_transfer", email);

  await page.context().clearCookies();
  await login(page, OWNER);
  await page.goto(`/seller/orders/${id}`);
  // No booking before the order is paid.
  await expect(page.getByTestId("shipment")).toHaveCount(0);
  await page.getByRole("button", { name: "Tandai sudah dibayar" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Baru");

  await expect(page.getByRole("button", { name: "Kirim dengan Bukalaris Kirim" })).toBeVisible();
  await evidence(page, info, "100-fulfillment-book");
  await page.getByRole("button", { name: "Kirim dengan Bukalaris Kirim" }).click();
  await expect(page.getByText(/Booking diminta/).first()).toBeVisible();

  // The worker books once, stores the resi and moves the order to shipped through the transition.
  await reloadUntil(page, "order-status", "Dikirim");
  const resi = `FAKE-JNE-${id}`;
  await expect(page.getByTestId("shipment-resi")).toHaveText(resi);
  await expect(page.getByTestId("shipment-status")).toHaveText("Resi terbit, menunggu pickup");
  await expect(page.getByRole("button", { name: "Kirim dengan Bukalaris Kirim" })).toHaveCount(0);
  expect((await sql`select count(*)::int as n from shipment where order_id = ${id}`)[0]!.n).toBe(1);
  expect((await sql`select count(*)::int as n from job where kind = 'shipment.book' and key like ${`shipment:${id}:%`}`)[0]!.n).toBe(1);

  // Manual refresh: one read-only poll each (fake: in transit, then delivered → order completed).
  await page.getByRole("button", { name: "Perbarui status" }).click();
  await reloadUntil(page, "shipment-status", "Dalam pengiriman");
  await expect(page.getByTestId("shipment-provider-status")).toHaveText("Dalam pengantaran");
  await evidence(page, info, "101-fulfillment-in-transit");

  // Buyer link (from the shipped mail) shows status, resi and the courier timeline.
  const shippedMail = async () => (await sql<{ text_body: string }[]>`select text_body from mail_outbox where to_email = ${email} and subject like ${`%#${id} dikirim%`}`)[0]?.text_body ?? "";
  await expect.poll(shippedMail, { timeout: 20_000 }).toContain(resi);
  const mail = await shippedMail();
  const path = new URL(/https?:\/\/\S+\/o\/[0-9]+\.[0-9]+\.[A-Za-z0-9_-]+/.exec(mail)![0]).pathname;

  await page.getByRole("button", { name: "Perbarui status" }).click();
  await reloadUntil(page, "order-status", "Selesai");
  await expect(page.getByTestId("shipment-status")).toHaveText("Terkirim ke pembeli");
  await expect(page.getByRole("button", { name: "Perbarui status" })).toHaveCount(0);
  await evidence(page, info, "102-fulfillment-delivered");

  await page.context().clearCookies();
  await page.goto(path);
  await expect(page.getByTestId("order-status")).toHaveText("Selesai");
  await expect(page.getByTestId("tracking")).toHaveText(resi);
  await expect(page.getByTestId("tracking-status")).toHaveText("Terkirim ke pembeli");
  await expect(page.getByTestId("tracking-timeline")).toContainText("Paket diterima pembeli (simulasi)");
  await evidence(page, info, "103-fulfillment-buyer-tracking");
});

test("COD orders cannot be booked through Mengantar while Q-17 is open", async ({ page }, info) => {
  const id = await buy(page, "cod");
  await page.context().clearCookies();
  await login(page, OWNER);
  await page.goto(`/seller/orders/${id}`);
  await page.getByRole("button", { name: "Konfirmasi pesanan" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Baru");
  await expect(page.getByTestId("cod-locked")).toBeVisible();
  await expect(page.getByRole("button", { name: "Kirim dengan Bukalaris Kirim" })).toHaveCount(0);
  await evidence(page, info, "104-fulfillment-cod-locked");
  expect((await sql`select count(*)::int as n from shipment where order_id = ${id}`)[0]!.n).toBe(0);
});
