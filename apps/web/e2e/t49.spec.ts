import { expect, type Page, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { chooseDestination, evidence, login, testPhone } from "./helpers";

// T-49: the AutoLaris payment contract end to end against the FAKE adapter (the worker, the second Playwright webServer, runs it).
// Buyer picks a channel from the provider's list, the worker stores a structured instruction, the signed-reference callback
// (HTTP-17) is only a trigger and the pulled inquiry decides. The fake inquiry answers "pending" (rc 02) in this run, so
// no callback can ever settle the order here: that is the point. Settlement paths are proven by packages/db/test/t49-payments.test.ts.
const url = process.env.E2E_DATABASE_URL;
if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
const sql = postgres(url, { max: 1, onnotice: () => {} });
test.afterAll(() => sql.end());

const CALLBACK = "/api/payments/autolaris/callback";
const sign = (reff: string) => `${reff}.${createHmac("sha256", process.env.AUTOLARIS_CALLBACK_SECRET!).update(`pay-callback:v1:${reff}`).digest("hex").slice(0, 32)}`;

async function buyOnline(page: Page, channel: string) {
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  await page.getByLabel("Jumlah").fill("1");
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(page);
  await page.getByLabel("Nama").fill("Budi Santoso");
  await page.getByLabel("Nomor HP").fill(testPhone());
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await page.locator('input[name="paymentMethod"][value="manual_transfer"]').check();
  await page.locator(`input[name="paymentChannel"][value="${channel}"]`).check();
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  return Number((await page.getByTestId("order-id").textContent())!.replace("#", ""));
}

/** The page never polls: reload until the worker has stored the instruction. */
const untilInstruction = (page: Page) =>
  expect.poll(async () => { await page.reload(); return page.getByTestId("payment-instruction").count(); }, { timeout: 20_000, intervals: [500, 1000] }).toBe(1);

const attemptOf = async (orderId: number) => (await sql`select * from payment_attempt where order_id = ${orderId}`)[0]!;
const digits = async (page: Page, testId: string) => Number((await page.getByTestId(testId).textContent())!.replace(/\D/g, ""));

test("buyer pays online: provider-listed channel, structured instruction, WIB expiry, unchanged QR; a signed callback only triggers a pull and never settles", async ({ page, browser }, info) => {
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  const orderId = await buyOnline(page, "QRIS");
  await untilInstruction(page);

  // One attempt, one provider bill, stable identifiers.
  const a = await attemptOf(orderId);
  expect(a).toMatchObject({ channel_code: "QRIS", request_state: "accepted", status: "pending", owner_kind: "order", owner_id: String(orderId) });
  expect(String(a.reff_id)).toMatch(/^[0-9]{1,30}$/);
  expect((await sql`select count(*)::int as n from payment_attempt where order_id = ${orderId}`)[0]!.n).toBe(1);
  expect((await sql`select count(*)::int as n from job where kind = 'payment.instruction' and key = ${`order:${orderId}`}`)[0]!.n).toBe(1);

  // The QR payload reaches the page byte for byte; the buyer sees the fee and the total of the attempt.
  await expect(page.getByTestId("payment-qr")).toHaveValue("000201010212\n  QRIS-BYTES-UNCHANGED-6304ABCD ");
  const o = (await sql`select subtotal, total from "order" where id = ${orderId}`)[0]!;
  expect(await digits(page, "payment-fee")).toBe(Math.round(Number(o.subtotal) * 0.007)); // 0.7% of the goods omset, not of the payable total
  expect(await digits(page, "payment-total")).toBe(Number(o.total) + Math.round(Number(o.subtotal) * 0.007));
  expect(Number(a.total_idr)).toBe(await digits(page, "payment-total"));
  await expect(page.getByTestId("payment-status")).toContainText("Menunggu pembayaran");
  await expect(page.getByText(/autolaris/i)).toHaveCount(0); // white label: the vendor name never reaches the buyer

  // Expiry: YYYYMMDDHHMMSS in WIB (UTC+7) whatever the server timezone; the page shows the same instant.
  const stamp = String((a.instruction as { expiresAt: string }).expiresAt);
  const wib = new Date(a.expires_at as Date).toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).replace(/\D/g, "");
  expect(stamp).toBe(wib);
  await expect(page.getByTestId("payment-expiry")).toHaveText(`${stamp.slice(6, 8)}/${stamp.slice(4, 6)}/${stamp.slice(0, 4)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)} WIB`);
  await evidence(page, info, "t49-instruction");

  // Another visitor cannot open this payment page (an order id alone grants nothing).
  const stranger = await browser.newContext({ baseURL: info.project.use.baseURL! });
  const sp = await stranger.newPage();
  expect((await sp.goto(`/checkout/confirmation?order=${orderId}`))?.status()).toBe(404);
  await stranger.close();

  // HTTP-17: authentication fails closed.
  const reff = String(a.reff_id);
  const body = (over: Record<string, unknown> = {}) => ({ data: { reff_id: reff, trx_id: a.transaction_id, amount: Number(a.total_idr), status: "PAID", ...over } });
  const post = (cb: string | null, data: ReturnType<typeof body>) => page.request.post(cb === null ? CALLBACK : `${CALLBACK}?cb=${encodeURIComponent(cb)}`, data);
  expect((await post(null, body())).status()).toBe(403); // no signed reference
  expect((await post(`${reff}.${"0".repeat(32)}`, body())).status()).toBe(403); // wrong signature
  expect((await post(sign("999999999999999999999999999"), body())).status()).toBe(404); // valid signature, unknown payment
  expect((await post(sign(reff), body({ reff_id: "123" }))).status()).toBe(403); // the valid URL replayed with another payment's body
  expect((await post(sign(reff), body({ amount: Number(a.total_idr) - 1 }))).status()).toBe(422); // amount mismatch
  expect((await post(sign(reff), body({ amount: Number(a.amount_idr) }))).status()).toBe(422); // the amount without the gateway fee
  expect((await page.request.get(`${CALLBACK}?cb=${sign(reff)}`)).status()).toBeGreaterThanOrEqual(400); // POST only
  expect((await sql`select count(*)::int as n from payment_callback where attempt_id = ${a.id}`)[0]!.n).toBe(0);
  expect((await sql`select count(*)::int as n from job where kind = 'payment.verify' and payload->>'attemptId' = ${a.id}`)[0]!.n).toBe(0);

  // A valid signed callback is a trigger: accepted once, replays are harmless, and nothing settles.
  const ok = await post(sign(reff), body());
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toEqual({ ok: true, outcome: "accepted" });
  expect(await (await post(sign(reff), body())).json()).toEqual({ ok: true, outcome: "replayed" });
  expect((await sql`select count(*)::int as n from payment_callback where attempt_id = ${a.id}`)[0]!.n).toBe(1);
  await expect.poll(async () => (await sql`select status from job where kind = 'payment.verify' and payload->>'attemptId' = ${a.id}`)[0]?.status, { timeout: 20_000, intervals: [500, 1000] }).toBe("done");
  expect((await sql`select classification from payment_observation where attempt_id = ${a.id}`).map((r) => r.classification)).toEqual(["pending"]); // the pulled inquiry said rc 02
  expect(await attemptOf(orderId)).toMatchObject({ status: "pending", paid_at: null });
  expect((await sql`select status, paid_at from "order" where id = ${orderId}`)[0]).toMatchObject({ status: "awaiting_payment", paid_at: null });
  await page.reload();
  await expect(page.getByTestId("payment-status")).toContainText("Menunggu pembayaran");

  // The seller sees status and total, never provider data; another store's owner cannot open the order.
  await page.context().clearCookies();
  await login(page, "owner-a@bukalaris.local");
  await page.goto(`/seller/orders/${orderId}`);
  await expect(page.getByTestId("payment-attempt")).toContainText("QRIS");
  await expect(page.getByTestId("payment-attempt")).toContainText("menunggu pembayaran");
  await expect(page.getByText(String(a.transaction_id))).toHaveCount(0);
  await page.context().clearCookies();
  await login(page, "owner-b@bukalaris.local");
  expect((await page.goto(`/seller/orders/${orderId}`))?.status()).toBe(404);
});

test("checkout offers the provider's channels with their fee, and a virtual account order shows the flat fee and the account number", async ({ page }, info) => {
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  await page.getByLabel("Jumlah").fill("1");
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(page);
  const group = page.getByRole("group", { name: "Metode pembayaran online" });
  await expect(group.getByRole("radio")).toHaveCount(4); // exactly the fake provider's list: VABCA, QRIS, VABNI, OVO
  await expect(group.getByText("Biaya layanan Rp6.500")).toBeVisible();
  await expect(group.getByText(/Biaya layanan 0,7% dari nilai belanja/)).toBeVisible();
  await evidence(page, info, "t49-channels");
  await page.getByLabel("Nama").fill("Budi Santoso");
  await page.getByLabel("Nomor HP").fill(testPhone());
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await page.locator('input[name="paymentMethod"][value="manual_transfer"]').check();
  await page.locator('input[name="paymentChannel"][value="VABCA"]').check();
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const orderId = Number((await page.getByTestId("order-id").textContent())!.replace("#", ""));
  await untilInstruction(page);
  expect(await digits(page, "payment-fee")).toBe(6_500);
  await expect(page.getByTestId("payment-va")).toHaveText(/^SIM-VA-/);
  await expect(page.getByTestId("payment-qr")).toHaveCount(0);
  expect((await attemptOf(orderId)).transaction_id).toMatch(/^SIM-/);
});
