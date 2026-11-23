import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { enrolTotpViaApi, evidence, login, seedFixtureStore, totp } from "./helpers";

// T-115 (ADR-0013 section 11, SC-22b "Akun Mengantar", SC-13): a store on its OWN Mengantar account, end to end on the fake seller client (no
// origin is configured, so no request leaves the process). The owner is refused an account that already holds orders, connects an empty one,
// confirms it as dedicated, stores the Webhook Secret with a step-up; a signed webhook only triggers a tracking read, and the read updates the
// parcel; a foreign parcel makes the sync "not exact" until resolved; Mengantar's balance and invoices appear read-only with their read time.
// A disposable store and owner per project (TOTP enrolment is persistent auth state, T-82).

const DB_CWD = resolve(process.cwd(), "../../packages/db");
function q<T>(body: string): T {
  const script = `
    import { createDb } from "./src/client.ts";
    import { createProduct } from "./src/seller/commerce/catalog.ts";
    import { placeOrder } from "./src/seller/commerce/checkout.ts";
    import { transitionOrder } from "./src/seller/commerce/orders.ts";
    import { sellerContext, storefrontScope } from "./src/platform/scoped.ts";
    import { formatShippingQuote, saveCourierRules } from "./src/shipping/rules.ts";
    import { setPickupArea, shippingOptions } from "./src/shipping/shipping.ts";
    import { setCartLine } from "./src/storefront/storefront.ts";
    const admin = createDb(process.env.E2E_DATABASE_URL);
    const app = createDb(process.env.E2E_APP_DATABASE_URL);
    const out = await (async () => { ${body} })();
    await admin.$client.end();
    await app.$client.end();
    console.log("@@" + JSON.stringify(out ?? null));
  `;
  const stdout = execFileSync("node", ["--input-type=module", "-e", script], { cwd: DB_CWD, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(stdout.slice(stdout.lastIndexOf("@@") + 2)) as T;
}

/** A TOTP code no earlier step-up of this test used (the rule of t104.spec.ts). */
function codes(page: Page, secret: string) {
  const used = new Set<string>();
  return async () => {
    for (;;) {
      if (Date.now() % 30_000 < 25_000) {
        for (const step of [1, 0]) {
          const c = totp(secret, Date.now() + step * 30_000);
          if (!used.has(c)) {
            used.add(c);
            return c;
          }
        }
      }
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
    }
  };
}
const status = (page: Page) => page.getByRole("main").getByRole("status");
const alert = (page: Page) => page.locator("p[role=alert]");
const PAGE = "/seller/shipping/account";
const reloadUntil = (page: Page, path: string, testId: string, text: string | RegExp) =>
  expect
    .poll(
      async () => {
        await page.goto(path);
        return (await page.getByTestId(testId).textContent().catch(() => ""))?.trim() ?? "";
      },
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toMatch(text);

test("a store's own Mengantar account: a used account is refused, the dedicated account is confirmed, a signed webhook only triggers a read, foreign parcels and Mengantar's money are shown", async ({ page }, info) => {
  test.setTimeout(300_000);
  const store = seedFixtureStore("t115");
  const ids = q<{ storeId: number; userId: string }>(`
    const [u] = await admin.$client.unsafe("select id from \\"user\\" where email = '${store.email}'");
    const ctx = await sellerContext(app, u.id);
    if (!ctx.ok) throw new Error(ctx.reason);
    await createProduct(ctx.scope, { title: "Kaos Uji Sinkron", status: "active", variant: { title: "M", price: 100000, stock: 20, weightGrams: 1000 } });
    await setPickupArea(ctx.scope, { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Sumur Bandung, Bandung, Jawa Barat 40111" });
    return { storeId: ctx.scope.storeId, userId: u.id };
  `);
  page.on("dialog", (d) => d.accept());
  await login(page, store.email, "/seller");
  const code = codes(page, await enrolTotpViaApi(page, store.email));

  // 1. An account that already holds orders from elsewhere is refused at connection; nothing is stored.
  await page.goto("/seller/payments");
  // T-116: owner accepts the current seller terms before saving a provider key.
  const termsForm = page.getByRole("form", { name: "Setujui syarat penjual" });
  await termsForm.getByRole("checkbox").check();
  await termsForm.getByRole("button", { name: "Setujui syarat penjual" }).click();
  await expect(status(page)).toContainText("Persetujuan syarat penjual tercatat");
  const mengantar = page.getByRole("form", { name: "Simpan kunci Mengantar" });
  await mengantar.getByLabel("Lingkungan").selectOption("sandbox");
  await mengantar.getByLabel("Kunci API").fill(`USED-${info.project.name}-account-key-0123456789`);
  await mengantar.getByLabel(/Kode verifikasi/).fill(await code());
  await mengantar.getByRole("button", { name: "Simpan dan cek" }).click();
  await expect(alert(page)).toContainText("sudah berisi pesanan yang tidak dibuat Bukalaris");
  await expect(page.getByTestId("mengantar-status")).toHaveText("Belum terhubung");
  await evidence(page, info, "t115-used-account-refused");
  // An empty account is accepted.
  await mengantar.getByLabel("Kunci API").fill(`T115-E2E-${info.project.name}-key-0123456789abcdef`);
  await mengantar.getByLabel(/Kode verifikasi/).fill(await code());
  await mengantar.getByRole("button", { name: "Simpan dan cek" }).click();
  await expect(status(page)).toContainText("Kunci lolos pengecekan");

  // 2. Shipping is not ready until the account is confirmed as dedicated (and the pickup address registered).
  await page.goto("/seller/shipping");
  await expect(page.getByTestId("shipping-ready")).toHaveText("Belum siap");
  await expect(page.getByTestId("shipping-gaps")).toContainText("belum dikonfirmasi sebagai akun baru");
  const pickup = page.getByRole("form", { name: "Alamat pickup" });
  await pickup.getByLabel("Alamat lengkap pickup").fill("Jl. Braga No. 10, samping toko roti");
  await pickup.getByLabel("Nama penanggung jawab pickup").fill("Budi Pemilik");
  await pickup.getByLabel("Nomor HP penanggung jawab").fill("081234567890");
  await pickup.getByRole("button", { name: "Simpan dan daftarkan alamat" }).click();
  await expect(status(page)).toBeVisible();
  await page.getByTestId("own-account-sync-link").click();
  await expect(page).toHaveURL(/\/seller\/shipping\/account$/);
  await expect(page.getByRole("heading", { name: "Akun Mengantar", level: 1 })).toBeVisible();
  await expect(page.getByTestId("dedicated-state")).toHaveText("Belum dikonfirmasi");
  await expect(page.getByTestId("webhook-after-dedicated")).toBeVisible();
  await evidence(page, info, "t115-mengantar-unconfirmed");

  // 3. Dedicated-account confirmation, then the webhook address and the sealed Webhook Secret (step-up).
  const confirm = page.getByRole("form", { name: "Konfirmasi akun khusus" });
  await confirm.getByRole("checkbox").check();
  await confirm.getByRole("button", { name: "Konfirmasi akun khusus" }).click();
  await expect(status(page)).toContainText("hanya dipakai toko ini");
  await expect(page.getByTestId("dedicated-state")).toHaveText("Terkonfirmasi");
  const webhookUrl = (await page.getByTestId("webhook-url").textContent())!.trim();
  expect(webhookUrl).toMatch(/\/api\/shipping\/mengantar\/webhook\?h=[a-f0-9]{32}$/);
  const SECRET = `t115-e2e-${info.project.name}-webhook-secret-0123`;
  const secretForm = page.getByRole("form", { name: "Simpan Webhook Secret" });
  await secretForm.getByLabel("Webhook Secret").fill(SECRET);
  await secretForm.getByLabel(/Kode verifikasi/).fill(await code());
  await secretForm.getByRole("button", { name: "Simpan secret" }).click();
  await expect(status(page)).toContainText("Webhook Secret tersimpan");
  await expect(page.getByTestId("webhook-state")).toHaveText("Secret tersimpan");
  expect(await page.content()).not.toContain(SECRET);
  await evidence(page, info, "t115-mengantar-confirmed");
  await page.goto("/seller/shipping");
  await expect(page.getByTestId("shipping-ready")).toHaveText("Siap kirim");

  // 4. A paid order on the store's own account, booked by the owner; the worker issues the resi.
  const orderId = q<number>(`
    const ctx = await sellerContext(app, ${JSON.stringify(ids.userId)});
    if (!ctx.ok) throw new Error(ctx.reason);
    await saveCourierRules(ctx.scope, { couriers: [{ courierCode: "JNE", enabled: true, codEnabled: false }] });
    // T-107 (Ceiling T-106-1 closed for it): QRIS/VA of a store on its own Mengantar account run on its OWN AutoLaris account (sandbox fake, ready).
    const { sealCredential, keyFingerprint, keyHint } = await import("./src/shipping/credentials.ts");
    const pkey = "E2E-T115-OWN-AUTOLARIS-" + Date.now() + "-0123456789";
    const [acc] = await admin.$client.unsafe("insert into store_payment_account (store_id, environment, status) values ($1, 'sandbox', 'needs_key') returning id", [${ids.storeId}]);
    const sealed = sealCredential("payment_credentials", pkey, ${ids.storeId}, Number(acc.id), "autolaris");
    await admin.$client.unsafe("update store_payment_account set sealed_key = $1, key_id = $2, sealed_at = now(), key_fingerprint = $3, key_hint = $4, status = 'active', last_result = 'ready', last_checked_at = now(), origin_area_id = '3517100', destination_area_id = '3518010', shipper_email = 'toko-t115@example.invalid', sender_address = 'Jl. Braga No. 1, Bandung 40111', payment_only_confirmed_at = now(), payment_only_confirmed_by = $5 where id = $6",
      [sealed.sealedKey, sealed.keyId, keyFingerprint("payment_credentials", pkey), keyHint(pkey), ${JSON.stringify(ids.userId)}, acc.id]);
    const sf = await storefrontScope(app, ${JSON.stringify(store.slug)});
    const [v] = await admin.$client.unsafe("select id from variant where store_id = ${ids.storeId} limit 1");
    const cart = await setCartLine(sf, undefined, { variantId: Number(v.id), quantity: 1 }, "add");
    const quote = await shippingOptions(sf, "b1b1b1b1b1b1b1b1b1b1b1b1", { lines: [{ quantity: 1, weightGrams: 1000 }], subtotal: 100000 });
    const { orderId } = await placeOrder(app, cart, { idempotencyKey: crypto.randomUUID(), buyerName: "Budi Santoso", buyerPhone: "081234567890", shippingAddress: "Jl. Merdeka No. 1, Jakarta", destinationAreaId: "b1b1b1b1b1b1b1b1b1b1b1b1", destinationAreaLabel: "Menteng, Menteng, Jakarta Pusat, DKI Jakarta 10310", courier: "JNE", paymentMethod: "manual_transfer", paymentChannel: "VABCA", shippingQuote: formatShippingQuote(quote.options) });
    // T-107: a prepaid order of a store on its own accounts is confirmed by the owner by hand on the attempt (no bare "pay").
    const { confirmPaymentByHand } = await import("./src/payments/seller.ts");
    const [a] = await admin.$client.unsafe("select id from payment_attempt where order_id = $1", [orderId]);
    await confirmPaymentByHand(ctx.scope, { attemptId: a.id, reason: "uang masuk di mutasi AutoLaris", evidence: "MUT-" + orderId });
    return orderId;
  `);
  const orderPath = `/seller/orders/${orderId}`;
  await page.goto(orderPath);
  const book = page.getByRole("form", { name: "Booking pengiriman" });
  await book.getByLabel("Antar sendiri ke agen kurir").check();
  await book.getByRole("button", { name: "Booking sekarang" }).click();
  await reloadUntil(page, orderPath, "order-status", "Dikirim");
  await expect(page.getByTestId("parcel-state")).toHaveText("Menunggu pickup kurir");

  // 5. A forged delivery is refused; a signed one only enqueues a read, and the read (worker, store's key) moves the parcel.
  const hook = new URL(webhookUrl);
  const target = `${hook.pathname}${hook.search}`;
  const providerOrderId = `MGT-FAKE-${orderId}`;
  const body = JSON.stringify({ cnote_no: `FAKE-JNE-${orderId}`, order_id: providerOrderId, courier: "JNE", status_category: "ON DELIVERY" });
  const ts = String(Date.now());
  const forged = await page.request.post(target, { headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": createHmac("sha256", "wrong-secret").update(`${ts}.${body}`).digest("hex") }, data: body });
  expect(forged.status()).toBe(401);
  const signed = await page.request.post(target, { headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex") }, data: body });
  expect(signed.status()).toBe(200);
  expect(await signed.json()).toEqual({ ok: true, outcome: "read_enqueued" });
  await reloadUntil(page, orderPath, "parcel-state", "Dalam pengantaran");
  await expect(page.getByTestId("parcel-status-history")).toContainText("Dalam pengantaran");
  await expect(page.getByTestId("parcel-figures")).toBeHidden(); // the local fake answers no money field: nothing is invented
  await evidence(page, info, "t115-order-parcel");
  await page.goto(PAGE);
  await expect(page.getByTestId("webhook-last")).toContainText("Webhook terakhir diterima");

  // 6. A foreign parcel found in the account (recorded as the account scan does): sync not exact until the seller resolves it.
  q(`await admin.$client.unsafe("insert into shipping_foreign_parcel (store_id, provider_order_id, tracking_number, provider_status, provider_created_at) values (${ids.storeId}, 'FOREIGNE2E01', 'JNE0000000099', 'PICKED UP', now() - interval '1 day')");`);
  await page.goto(PAGE);
  await expect(page.getByTestId("sync-state")).toHaveText("Tidak sinkron");
  await expect(page.getByTestId("foreign-FOREIGNE2E01")).toContainText("PICKED UP");
  await evidence(page, info, "t115-mengantar-foreign");
  const resolveForm = page.getByRole("form", { name: "Tandai FOREIGNE2E01 sudah ditangani" });
  await resolveForm.getByLabel("Catatan").fill("Paket lama dari toko offline, sudah dibatalkan di akun");
  await resolveForm.getByRole("button", { name: "Tandai sudah ditangani" }).click();
  await expect(status(page)).toContainText("sudah ditangani");
  await expect(page.getByTestId("sync-state")).toHaveText("Sinkron");

  // 7. Mengantar's balance and invoices: read by the account scan on the store's key, shown read-only with the read time.
  // The scheduled scan reads a never-scanned store at its next sweep, which can land before this step: start from "not read" with a fresh scan time
  // (the sweep then waits ACCOUNT_SCAN_EVERY_MS) and no queued scan, so only the seller's request below reads the account.
  q(`await admin.$client.unsafe("delete from job where kind = 'shipping.account_scan' and store_id = ${ids.storeId} and status = 'pending'");
    await admin.$client.unsafe("update store_shipping_sync set account_read_at = null, balance_idr = null, invoices = '[]'::jsonb, last_scan_at = now() where store_id = ${ids.storeId}");`);
  await page.goto(PAGE);
  await expect(page.getByTestId("mengantar-not-read")).toBeVisible();
  await page.getByRole("button", { name: "Periksa akun sekarang" }).click();
  await expect(status(page)).toContainText("Pemeriksaan akun Mengantar diminta");
  await reloadUntil(page, PAGE, "mengantar-balance", /250\.000/);
  await expect(page.getByTestId("mengantar-read-at")).toContainText("WIB");
  await expect(page.getByTestId("mengantar-invoices")).toContainText("Isi saldo");
  await evidence(page, info, "t115-mengantar-account");
});
