import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { chooseDestination, evidence, login, seedFixtureStore, testPhone } from "./helpers";

// T-106 (SC-32 preferences, SC-33 transactions, checkout and the signed order-status page): AutoLaris on the store's OWN key, against the
// fake AutoLaris accounts (no provider call leaves the process). A disposable store per project carries a ready sandbox AutoLaris account
// whose key is a canary: every response body the browser received and the rows a key could leak into are scanned for it.

const DB_CWD = resolve(process.cwd(), "../../packages/db");
function node<T>(body: string): T {
  const script = `
    import { createDb } from "./src/client.ts";
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
const q = <T,>(statement: string): T => node<T>(`return await admin.$client.unsafe(${JSON.stringify(statement)});`);

/**
 * The store's product and pickup area through the seller services, and a READY sandbox AutoLaris account (decision 13). The key row is
 * written as the owner connection with the real sealing code; the UI path of connecting a key is T-104's spec.
 */
function sellerReadyStore(slug: string, email: string, apiKey: string) {
  return node<{ storeId: number; productSlug: string }>(`
    const { sellerContext } = await import("./src/platform/scoped.ts");
    const { createProduct } = await import("./src/seller/commerce/catalog.ts");
    const { setPickupArea } = await import("./src/shipping/shipping.ts");
    const { sealCredential, keyFingerprint, keyHint } = await import("./src/shipping/credentials.ts");
    const { setPickupAddress } = await import("./src/shipping/shipping.ts");
    const { saveCourierRules } = await import("./src/shipping/rules.ts");
    const [u] = await admin.$client.unsafe("select id from \\"user\\" where email = '${email}'");
    const [s] = await admin.$client.unsafe("select id from store where slug = '${slug}'");
    const ctx = await sellerContext(app, u.id, Number(s.id));
    const productId = await createProduct(ctx.scope, { title: "Kaos T106 ${slug.slice(-6)}", status: "active", variant: { title: "M", price: 100000, stock: 20, weightGrams: 1000 } });
    await setPickupArea(ctx.scope, { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Sumur Bandung, Bandung, Jawa Barat 40111" });
    const [acc] = await admin.$client.unsafe("insert into store_payment_account (store_id, environment, status) values ($1, 'sandbox', 'needs_key') returning id", [s.id]);
    const sealed = sealCredential("payment_credentials", ${JSON.stringify(apiKey)}, Number(s.id), Number(acc.id), "autolaris");
    await admin.$client.unsafe("update store_payment_account set sealed_key = $1, key_id = $2, sealed_at = now(), key_fingerprint = $3, key_hint = $4, status = 'active', last_result = 'ready', last_checked_at = now(), origin_area_id = '3517100', destination_area_id = '3518010', shipper_email = 'toko@example.invalid', sender_address = 'Jl. Braga No. 1, Bandung 40111', payment_only_confirmed_at = now(), payment_only_confirmed_by = $5 where id = $6",
      [sealed.sealedKey, sealed.keyId, keyFingerprint("payment_credentials", ${JSON.stringify(apiKey)}), keyHint(${JSON.stringify(apiKey)}), u.id, acc.id]);
    // T-107 (review M1; ADR-0013 decision 40): a store on its own accounts ships only on its OWN Mengantar account (fake, sandbox, JNE with COD).
    const mkey = "E2E-OWN-MENGANTAR-" + Date.now() + "-0123456789abcdef"; // unrelated to the AutoLaris canary
    const [sacc] = await admin.$client.unsafe("insert into store_shipping_account (store_id, kind, status, external_user_id, environment) values ($1, 'seller_owned', 'needs_key', $2, 'sandbox') returning id", [s.id, "store:" + s.id]);
    const ssealed = sealCredential("shipping_credentials", mkey, Number(s.id), Number(sacc.id), "seller_owned");
    await admin.$client.unsafe("update store_shipping_account set sealed_key = $1, key_id = $2, sealed_at = now(), key_fingerprint = $3, key_hint = $4, status = 'active', last_result = 'ready', last_checked_at = now() where id = $5",
      [ssealed.sealedKey, ssealed.keyId, keyFingerprint("shipping_credentials", mkey), keyHint(mkey), sacc.id]);
    await setPickupAddress(ctx.scope, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
    await saveCourierRules(ctx.scope, { couriers: [{ courierCode: "JNE", enabled: true, codEnabled: true }] });
    const [p] = await admin.$client.unsafe("select slug from product where id = $1", [productId]);
    return { storeId: Number(s.id), productSlug: p.slug ?? String(productId) };
  `);
}

const CALLBACK = "/api/payments/autolaris/callback";
const PAY_LABEL = "Tandai sudah dibayar"; // orderActionLabel.pay (lib/status.ts)
const sign = (reff: string) => `${reff}.${createHmac("sha256", process.env.AUTOLARIS_CALLBACK_SECRET!).update(`pay-callback:v1:${reff}`).digest("hex").slice(0, 32)}`;
/** The buyer's signed order-status link (T-36 format), with the e2e secret the server reads too. */
const orderLink = (orderId: number) => {
  const exp = Math.floor((Date.now() + 3_600_000) / 1000);
  const secret = process.env.ORDER_LINK_SECRET!;
  return `/o/${orderId}.${exp}.${createHmac("sha256", secret).update(`order-link:${orderId}.${exp}`).digest("base64url")}`;
};
const status = (page: Page) => page.getByRole("main").getByRole("status");
const digits = async (page: Page, testId: string) => Number((await page.getByTestId(testId).first().textContent())!.replace(/\D/g, ""));
const untilInstruction = (page: Page) =>
  expect.poll(async () => { await page.reload(); return page.getByTestId("payment-instruction").count(); }, { timeout: 30_000, intervals: [500, 1000] }).toBe(1);

test("AutoLaris on the store's own key: seller preferences, buyer channels without the excluded one and without a fee, check now, a new instruction after expiry, manual confirmation; no key reaches the browser or the rows", async ({ page, browser }, info) => {
  test.setTimeout(240_000);
  const tag = `${info.project.name === "mobile-320" ? "m" : "d"}${randomBytes(3).toString("hex")}`;
  const KEY = `CANARY-T106-${tag}-e2e-autolaris-key-0123456789`;
  const store = seedFixtureStore("t106");
  const { storeId, productSlug } = sellerReadyStore(store.slug, store.email, KEY);
  const bodies: string[] = [];
  const collect = (p: Page) => p.on("response", async (r) => {
    const type = r.request().resourceType();
    if (type === "document" || type === "fetch" || type === "xhr") bodies.push(await r.text().catch(() => ""));
  });
  collect(page);
  page.on("dialog", (d) => d.accept()); // ConfirmSubmit of the manual confirmation

  // Seller: the AutoLaris preferences on SC-32 (exclude OVO, the seller bears the fee).
  await login(page, store.email, "/seller");
  await page.goto("/seller/payments");
  const prefs = page.getByRole("form", { name: "Pengaturan pembayaran AutoLaris" });
  await expect(prefs.getByRole("checkbox", { name: /Terima pembayaran QRIS\/VA/ })).toBeChecked();
  await prefs.getByRole("checkbox", { name: "OVO" }).check();
  await prefs.getByRole("radio", { name: /Penjual/ }).check();
  await prefs.getByRole("button", { name: "Simpan pengaturan" }).click();
  await expect(status(page)).toContainText("Pengaturan pembayaran tersimpan");
  await expect(prefs.getByRole("checkbox", { name: "OVO" })).toBeChecked();
  await evidence(page, info, "t106-preferences");

  // Buyer: the store's account list without OVO, no added fee, VA order on the store's own key (a test order: sandbox account).
  const buyerCtx = await browser.newContext({ baseURL: info.project.use.baseURL!, viewport: page.viewportSize()! });
  const bp = await buyerCtx.newPage();
  collect(bp);
  await bp.goto(`/s/${store.slug}/products/${productSlug}`);
  await bp.getByLabel("Jumlah").fill("1");
  await bp.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await bp.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(bp);
  const group = bp.getByRole("group", { name: "Metode pembayaran online" });
  await expect(group.getByRole("radio")).toHaveCount(3);
  await expect(group.locator('input[value="OVO"]')).toHaveCount(0);
  await expect(group.getByText("Tanpa biaya layanan tambahan").first()).toBeVisible();
  await evidence(bp, info, "t106-checkout-channels");
  await bp.getByLabel("Nama").fill("Budi Santoso");
  await bp.getByLabel("Nomor HP").fill(testPhone());
  await bp.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await bp.locator('input[name="paymentMethod"][value="manual_transfer"]').check();
  await bp.locator('input[name="paymentChannel"][value="VABCA"]').check();
  await bp.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(bp.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const orderId = Number((await bp.getByTestId("order-id").textContent())!.replace("#", ""));
  await untilInstruction(bp);
  const [first] = q<{ id: string; reff_id: string; total_idr: string; payment_account_id: string; environment: string; fee_bearer: string; admin_fee_idr: string; expected_fee_idr: string }[]>(`select * from payment_attempt where order_id = ${orderId}`);
  expect(first).toMatchObject({ environment: "sandbox", fee_bearer: "seller", admin_fee_idr: "0", expected_fee_idr: "6500" });
  expect(first!.payment_account_id).not.toBeNull();
  const [o] = q<{ total: string }[]>(`select total from "order" where id = ${orderId}`);
  expect(await digits(bp, "payment-total")).toBe(Number(o!.total)); // the seller bears the fee: the bill is the order total
  await expect(bp.getByTestId("payment-va")).toHaveText(/^SIM-VA-/);
  await expect(bp.getByTestId("test-order")).toBeVisible();
  // "I have paid, check": only a queued pull on the store's key; the fake account still answers pending.
  await bp.getByRole("button", { name: "Saya sudah bayar, cek status" }).click();
  await expect(bp.getByRole("status").filter({ hasText: "sedang dicek" })).toBeVisible();
  await expect(bp.getByTestId("payment-status")).toContainText("Menunggu pembayaran");
  await evidence(bp, info, "t106-confirmation");

  // RL-AUTOLARIS-CB: 10 callbacks per 10 minutes per signed reference; each is evidence only.
  const cb = (n: number) => bp.request.post(`${CALLBACK}?cb=${sign(first!.reff_id)}`, { data: { reff_id: first!.reff_id, amount: Number(first!.total_idr), status: "PAID", n } });
  for (let n = 0; n < 10; n++) expect((await cb(n)).status()).toBe(200);
  expect((await cb(10)).status()).toBe(429);
  expect(q<{ status: string }[]>(`select status from "order" where id = ${orderId}`)[0]!.status).toBe("awaiting_payment");

  // The instruction expires: the order-status page offers a new one; the old attempt is kept.
  q(`alter table payment_attempt disable trigger payment_attempt_guard; update payment_attempt set expires_at = now() - interval '1 hour' where id = '${first!.id}'; alter table payment_attempt enable trigger payment_attempt_guard`);
  await bp.goto(orderLink(orderId));
  const section = bp.getByTestId("payment-section");
  await expect(section.getByTestId("payment-retry-note")).toContainText("Batas waktu pembayaran sudah lewat");
  await evidence(bp, info, "t106-order-status-expired");
  await section.getByRole("button", { name: "Buat tagihan baru" }).click();
  await expect(bp.getByRole("status").filter({ hasText: "Tagihan baru sedang dibuat" })).toBeVisible();
  await expect.poll(async () => { await bp.reload(); return bp.getByTestId("payment-instruction").count(); }, { timeout: 30_000, intervals: [500, 1000] }).toBe(1);
  expect(q<{ attempt_no: number; request_state: string }[]>(`select attempt_no, request_state from payment_attempt where order_id = ${orderId} order by attempt_no`)).toEqual([{ attempt_no: 1, request_state: "accepted" }, { attempt_no: 2, request_state: "accepted" }]);
  await evidence(bp, info, "t106-order-status-retry");

  // Seller: the order page offers no bare "pay" for an own-account order, only the way to the payments screen.
  await page.goto(`/seller/orders/${orderId}`);
  await expect(page.getByTestId("own-account-confirm").getByRole("link", { name: "Transaksi pembayaran" })).toBeVisible();
  await expect(page.getByRole("button", { name: PAY_LABEL })).toHaveCount(0);
  // Seller: SC-33 lists both attempts; confirming the new one by hand pays the order and leaves a permanent record.
  await page.goto("/seller/payments");
  await page.getByTestId("transactions-link").click();
  await expect(page).toHaveURL(/\/seller\/payments\/transactions$/);
  await expect(page.getByRole("heading", { name: "Transaksi pembayaran", level: 1 })).toBeVisible();
  const second = page.getByTestId(`attempt-${orderId}-2`);
  await expect(page.getByTestId(`attempt-${orderId}-1`).getByTestId("attempt-state")).toHaveText("Kedaluwarsa");
  await expect(second.getByTestId("attempt-sandbox")).toBeVisible();
  await second.getByText("Konfirmasi pembayaran manual").click();
  await second.getByLabel("Alasan").fill("Uang masuk di dashboard AutoLaris");
  await second.getByLabel(/Bukti/).fill(`MUT-${tag}`);
  await second.getByRole("button", { name: "Konfirmasi lunas" }).click();
  await expect(status(page)).toContainText("Pembayaran dikonfirmasi manual");
  await expect(page.getByTestId(`attempt-${orderId}-2`).getByTestId("manual-record")).toContainText(`MUT-${tag}`);
  await expect(page.getByTestId(`attempt-${orderId}-2`).getByRole("button", { name: "Konfirmasi lunas" })).toHaveCount(0);
  await evidence(page, info, "t106-transactions");
  expect(q<{ status: string }[]>(`select status from "order" where id = ${orderId}`)[0]!.status).toBe("placed");
  expect(q<unknown[]>(`select id from payment_manual_confirmation where order_id = ${orderId}`)).toHaveLength(1);
  await bp.goto(orderLink(orderId));
  await expect(bp.getByTestId("payment-actions")).toHaveCount(0);

  // Literal scan: the page fetched as HTML and RSC, every response the browsers received, and the rows a key could reach.
  for (const headers of [{} as Record<string, string>, { RSC: "1" }]) bodies.push(await (await page.request.get("/seller/payments/transactions", { headers })).text());
  const rows = q<{ j: string | null }[]>(`select string_agg(t, E'\\n') as j from (select row_to_json(a)::text as t from payment_attempt a where store_id = ${storeId} union all select row_to_json(o)::text from payment_observation o where store_id = ${storeId} union all select row_to_json(j)::text from job j where store_id = ${storeId} union all select row_to_json(l)::text from audit_log l where store_id = ${storeId} union all select row_to_json(s)::text from system_log s) x`)[0]!.j ?? "";
  expect(bodies.length).toBeGreaterThan(10);
  for (const form of [KEY, encodeURIComponent(KEY), Buffer.from(KEY).toString("base64")]) {
    expect(bodies.some((b) => b.includes(form)), "a response body holds the key").toBe(false);
    expect(rows.includes(form), "a database row holds the key").toBe(false);
  }
  await buyerCtx.close();
});

test("staff of a store cannot open the payment transactions", async ({ page }) => {
  await login(page, "staff-a@bukalaris.local");
  await page.goto("/seller/payments/transactions");
  await expect(page.getByTestId("transactions-denied")).toContainText("Hanya pemilik toko");
  await expect(page.getByRole("main").getByRole("form")).toHaveCount(0);
});
