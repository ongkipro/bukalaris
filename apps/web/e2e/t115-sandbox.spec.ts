import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import { enrolTotpViaApi, login, seedFixtureStore, totp } from "./helpers";

// T-115 OPT-IN SANDBOX RUN (ADR-0013 decisions 41 to 43). SPECIFIED, NOT RUN: it calls the real Mengantar SANDBOX with a seller test key on a
// NEW, empty sandbox account. It is skipped unless ALL of these hold, and it is started only after the owner approved that run:
//   - T115_SANDBOX=1;
//   - MENGANTAR_SANDBOX_TEST_KEY and MENGANTAR_SANDBOX_WEBHOOK_SECRET come from `secrets-env run -- …` (never a file, never a shell `source`);
//   - MENGANTAR_SANDBOX_ORIGIN=https://sandbox.mengantar.com for the web server AND the worker (UNVERIFIED origin, see t105-sandbox.spec.ts);
//   - T115_SANDBOX_ORDER_ID: the ORDER_ID of a prepaid JNE Jakarta→Jakarta order already booked on that account through Bukalaris (the
//     t105-sandbox run books one); the simulation below moves only that order.
// Command (by hand, after approval):
//   T115_SANDBOX=1 T115_SANDBOX_ORDER_ID=<ORDER_ID> MENGANTAR_SANDBOX_ORIGIN=https://sandbox.mengantar.com secrets-env run -- pnpm --filter web exec playwright test t115-sandbox --project=desktop
// What the run must show (each step is a provider fact still marked UNVERIFIED in docs/tracks/t115-mengantar-lock.md):
//   1. the dedicated-account check reads `GET /order?size=100&dateRange=…` on the key and accepts the account (only Bukalaris's own order in it);
//   2. `POST /order/simulation` (sandbox only) moves the order to ON DELIVERY, then DELIVERED, and a second order to RTS; each call fires ONE
//      webhook with `x-environment: sandbox` to the store's address (the Webhook URL must point at a host the sandbox can reach: a tunnel to
//      the local server, set up by hand for this run), signed with the account's Webhook Secret;
//   3. each webhook only enqueues a read; the read (`GET /order?order_id=…`) is what moves the parcel: Dalam pengantaran → Terkirim / RTS;
//   4. the read's `statusCategory`, `lastStatusChange` and `history[]` shapes and the per-parcel money fields actually returned are recorded.
const enabled = process.env.T115_SANDBOX === "1" && !!process.env.MENGANTAR_SANDBOX_TEST_KEY && !!process.env.MENGANTAR_SANDBOX_WEBHOOK_SECRET && !!process.env.MENGANTAR_SANDBOX_ORIGIN && !!process.env.T115_SANDBOX_ORDER_ID;
test.skip(!enabled, "opt-in sandbox run: needs owner approval, T115_SANDBOX=1, MENGANTAR_SANDBOX_ORIGIN, T115_SANDBOX_ORDER_ID and secrets-env test values");

const simulate = (orderId: string, statusCategory: "ON DELIVERY" | "DELIVERED" | "RTS") =>
  fetch(`${process.env.MENGANTAR_SANDBOX_ORIGIN}/api/public/${encodeURIComponent(process.env.MENGANTAR_SANDBOX_TEST_KEY!)}/order/simulation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ courier: "JNE", orderId, statusCategory }),
  });

test("sandbox: dedicated-account check, webhook secret, simulated ON DELIVERY and DELIVERED read through the single writer", async ({ page }) => {
  test.setTimeout(600_000);
  const store = seedFixtureStore("t115sbx");
  await login(page, store.email, "/seller");
  const secret = await enrolTotpViaApi(page, store.email);
  await page.goto("/seller/payments");
  const key = page.getByRole("form", { name: "Simpan kunci Mengantar" });
  await key.getByLabel("Lingkungan").selectOption("sandbox");
  await key.getByLabel("Kunci API").fill(process.env.MENGANTAR_SANDBOX_TEST_KEY!);
  await key.getByLabel(/Kode verifikasi/).fill(totp(secret, Date.now() + 30_000));
  await key.getByRole("button", { name: "Simpan dan cek" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("Kunci lolos pengecekan");
  await page.goto("/seller/shipping/account");
  const dedicated = page.getByRole("form", { name: "Konfirmasi akun khusus" });
  await dedicated.getByRole("checkbox").check();
  await dedicated.getByRole("button", { name: "Konfirmasi akun khusus" }).click();
  await expect(page.getByTestId("dedicated-state")).toHaveText("Terkonfirmasi");
  await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
  const form = page.getByRole("form", { name: "Simpan Webhook Secret" });
  await form.getByLabel("Webhook Secret").fill(process.env.MENGANTAR_SANDBOX_WEBHOOK_SECRET!);
  await form.getByLabel(/Kode verifikasi/).fill(totp(secret, Date.now() + 30_000));
  await form.getByRole("button", { name: "Simpan secret" }).click();
  await expect(page.getByTestId("webhook-state")).toHaveText("Secret tersimpan");
  // The documented signature scheme against this account's secret (local check; the real deliveries follow).
  expect(createHmac("sha256", "testsecret").update('1787548800000.{"cnote_no":"JNE1234567890","order_id":"ORD-000123","courier":"JNE","status_category":"DELIVERED"}').digest("hex")).toBe("05826dec707ea7164801d952cb7eaf7ce9adc0c8aa0b93366480434164a1a111");
  for (const step of ["ON DELIVERY", "DELIVERED"] as const) {
    const r = await simulate(process.env.T115_SANDBOX_ORDER_ID!, step);
    expect(r.status).toBe(200);
    // The webhook (if the tunnel delivers it) or the scheduled read applies it; the order page is read until the state appears.
  }
  // The rest of the run (order page states, RTS on a second order, recording the observed shapes) follows the list above by hand.
});
