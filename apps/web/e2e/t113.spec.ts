import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { chooseDestination, evidence, login, seedFixtureStore, testPhone } from "./helpers";

// T-113 (ADR-0013 section 10, decisions 35 to 39): bank transfer to the seller's own bank account, at 320 px and desktop. A disposable store per
// project on its own (fake, sandbox) Mengantar account with one listed bank account; the buyer orders by bank transfer, sees the account and the
// exact total, uploads a proof on the signed order-status page; the public media route cannot serve it; the seller downloads it, confirms the
// transfer with a reason, and the buyer sees the order paid.

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

/**
 * The store's product and pickup, its own Mengantar account (sealed with the real code, dedicated account confirmed) and one bank account. The
 * account row is written as the superuser in one transaction with a step-up proof consumed in it, the shape the database guard accepts; the owner's
 * step-up UI is T-104's spec and the step-up rule of this list is proven in test/t113-bank-transfer.test.ts.
 */
function bankTransferStore(slug: string, email: string, accountNumber: string) {
  return node<{ storeId: number; productSlug: string }>(`
    const { sellerContext } = await import("./src/platform/scoped.ts");
    const { createProduct } = await import("./src/seller/commerce/catalog.ts");
    const { setPickupArea, setPickupAddress } = await import("./src/shipping/shipping.ts");
    const { sealCredential, keyFingerprint, keyHint } = await import("./src/shipping/credentials.ts");
    const { saveCourierRules } = await import("./src/shipping/rules.ts");
    const { confirmDedicatedAccount } = await import("./src/shipping/sync.ts");
    const [u] = await admin.$client.unsafe("select id from \\"user\\" where email = '${email}'");
    const [s] = await admin.$client.unsafe("select id from store where slug = '${slug}'");
    const ctx = await sellerContext(app, u.id, Number(s.id));
    const productId = await createProduct(ctx.scope, { title: "Kaos T113 ${slug.slice(-6)}", status: "active", variant: { title: "M", price: 100000, stock: 20, weightGrams: 1000 } });
    await setPickupArea(ctx.scope, { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Sumur Bandung, Bandung, Jawa Barat 40111" });
    const mkey = "E2E-T113-MENGANTAR-" + Date.now() + "-0123456789abcdef";
    const [sacc] = await admin.$client.unsafe("insert into store_shipping_account (store_id, kind, status, external_user_id, environment) values ($1, 'seller_owned', 'needs_key', $2, 'sandbox') returning id", [s.id, "store:" + s.id]);
    const sealed = sealCredential("shipping_credentials", mkey, Number(s.id), Number(sacc.id), "seller_owned");
    await admin.$client.unsafe("update store_shipping_account set sealed_key = $1, key_id = $2, sealed_at = now(), key_fingerprint = $3, key_hint = $4, status = 'active', last_result = 'ready', last_checked_at = now() where id = $5",
      [sealed.sealedKey, sealed.keyId, keyFingerprint("shipping_credentials", mkey), keyHint(mkey), sacc.id]);
    await confirmDedicatedAccount(ctx.scope, { confirmed: true });
    await setPickupAddress(ctx.scope, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
    await saveCourierRules(ctx.scope, { couriers: [{ courierCode: "JNE", enabled: true, codEnabled: false }] });
    await admin.$client.begin(async (tx) => {
      const [p] = await tx.unsafe("insert into store_step_up_proof (store_id, user_id, session_id, action_key, subject_kind, subject_id, expires_at, consumed_at) values ($1, $2, 'e2e-t113', 'integrations.bank_account', 'store', 'bank_transfer', now() + interval '5 minutes', now()) returning id", [s.id, u.id]);
      await tx.unsafe("insert into store_bank_account (store_id, bank_code, account_number, holder_name, created_by, step_up_ref) values ($1, 'BCA', $2, 'Budi Pemilik', $3, $4)", [s.id, '${accountNumber}', u.id, p.id]);
    });
    const [prod] = await admin.$client.unsafe("select coalesce(slug, catalog_id::text) as slug from product where id = $1", [productId]);
    return { storeId: Number(s.id), productSlug: prod.slug };
  `);
}
const status = (page: Page) => page.getByRole("main").getByRole("status");
/** A 1x1 PNG: the proof check reads the type and the dimensions from the bytes. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("bank transfer: the buyer pays the seller's own account and sends a private proof, the seller confirms with a reason, the buyer sees the order paid", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  const account = `70${randomBytes(4).readUInt32BE() % 100_000_000}`.padEnd(10, "0");
  const store = seedFixtureStore("t113");
  const { productSlug } = bankTransferStore(store.slug, store.email, account);

  // Seller: the payments screen shows the listed account and bank transfer as ready.
  await login(page, store.email, "/seller");
  await page.goto("/seller/payments");
  await expect(page.getByTestId("bank-accounts")).toContainText(account);
  await expect(page.getByTestId("readiness-bank")).toContainText("Siap");
  await evidence(page, info, "t113-seller-bank-accounts");

  // Buyer: checkout offers bank transfer; the confirmation shows the account and the exact total (no unique code).
  const buyerCtx = await browser.newContext({ baseURL: info.project.use.baseURL!, viewport: page.viewportSize()! });
  const bp = await buyerCtx.newPage();
  await bp.goto(`/s/${store.slug}/products/${productSlug}`);
  await bp.getByLabel("Jumlah").fill("1");
  await bp.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await bp.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(bp);
  await bp.getByLabel("Nama").fill("Budi Santoso");
  await bp.getByLabel("Nomor HP").fill(testPhone());
  await bp.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await bp.locator('input[name="paymentMethod"][value="bank_transfer"]').check();
  await evidence(bp, info, "t113-checkout-bank-transfer");
  await bp.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(bp.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const orderId = Number((await bp.getByTestId("order-id").textContent())!.replace("#", ""));
  const total = (await bp.getByTestId("order-total").textContent())!.trim();
  await expect(bp.getByTestId("bank-account")).toContainText(account);
  await expect(bp.getByTestId("bank-transfer-total")).toHaveText(total);
  await evidence(bp, info, "t113-confirmation-bank-transfer");

  // The signed order-status page: upload a proof; the order is still waiting for payment.
  await bp.getByTestId("order-status-link").click();
  await expect(bp.getByTestId("bank-transfer-section")).toBeVisible();
  await bp.getByLabel(/Foto bukti transfer/).setInputFiles({ name: "bukti.png", mimeType: "image/png", buffer: PNG });
  await bp.getByRole("button", { name: "Kirim bukti transfer" }).click();
  await expect(bp.getByTestId("proof-waiting")).toBeVisible();
  await expect(bp.getByTestId("order-status")).toHaveText("Menunggu pembayaran");
  await evidence(bp, info, "t113-order-status-proof-sent");
  const proofHref = (await bp.getByRole("link", { name: "Unduh foto 1" }).getAttribute("href"))!;
  const proofId = proofHref.split("/").at(-2)!;
  const own = await bp.request.get(proofHref);
  expect(own.status()).toBe(200);
  expect(own.headers()["content-disposition"]).toMatch(/^attachment;/);
  expect(own.headers()["content-security-policy"]).toContain("sandbox");
  // The public media route never serves a proof (by its id or by its key), and another order's link cannot reach it.
  for (const path of [`/s/${store.slug}/media/${proofId}`, `/s/${store.slug}/media/${encodeURIComponent(proofHref)}`]) expect((await bp.request.get(path)).status()).toBe(404);

  // Seller: download the proof (finance role), confirm the transfer with a reason.
  await page.goto(`/seller/orders/${orderId}`);
  const section = page.getByTestId("bank-transfer");
  await expect(section).toContainText(account);
  await expect(section.getByTestId("seller-proof-status")).toHaveText("Terkirim, menunggu penjual");
  const sellerFile = await page.request.get((await section.getByTestId("seller-proof-file").getAttribute("href"))!);
  expect(sellerFile.status()).toBe(200);
  expect(sellerFile.headers()["content-disposition"]).toMatch(/^attachment;/);
  await expect(page.getByRole("button", { name: "Tandai sudah dibayar" })).toHaveCount(0);
  await evidence(page, info, "t113-seller-order-proof");
  const confirm = page.getByRole("form", { name: "Konfirmasi transfer bank" });
  await confirm.getByLabel("Alasan").fill("Dana masuk di mutasi BCA hari ini");
  await confirm.getByRole("button", { name: "Konfirmasi transfer diterima" }).click();
  await expect(status(page)).toContainText("Transfer bank dikonfirmasi");
  await expect(page.getByTestId("bank-transfer-confirmation")).toContainText("Dana masuk di mutasi BCA hari ini");

  // Buyer: the order is paid.
  await bp.reload();
  await expect(bp.getByTestId("bank-transfer-confirmed")).toBeVisible();
  await expect(bp.getByTestId("order-status")).not.toHaveText("Menunggu pembayaran");
  await evidence(bp, info, "t113-order-status-paid");
  await buyerCtx.close();
});
