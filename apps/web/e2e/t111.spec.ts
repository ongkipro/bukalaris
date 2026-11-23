import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { chooseDestination, evidence, login, seedFixtureStore, testPhone } from "./helpers";

const DB_CWD = resolve(process.cwd(), "../../packages/db");
function node<T>(body: string): T {
  const script = `
    import { createDb } from "./src/client.ts";
    const admin = createDb(process.env.E2E_DATABASE_URL);
    const app = createDb(process.env.E2E_APP_DATABASE_URL);
    const out = await (async () => { ${body} })();
    await admin.$client.end();
    await app.$client.end();
    process.stdout.write(JSON.stringify(out ?? null));
  `;
  return JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], { cwd: DB_CWD, encoding: "utf8" }).trim()) as T;
}

// T-111 (PR-4, ADR-0016):
// Seller creates a digital product (no weight, unlimited stock), buyer purchases digital-only order
// (no address/courier/shipping fee, email required, no COD), seller confirms bank transfer -> order
// immediately completes, and buyer/seller order pages show no shipping block; plus mixed cart
// (digital + physical) shows shipping step with COD disabled.

test("digital-only and mixed checkout flows at 320 px and desktop", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  const store = seedFixtureStore("t111");
  const { storeId, physSlug } = node<{ storeId: number; physSlug: string }>(`
    const { sellerContext } = await import("./src/platform/scoped.ts");
    const { createProduct } = await import("./src/seller/commerce/catalog.ts");
    const { setPickupArea, setPickupAddress } = await import("./src/shipping/shipping.ts");
    const { sealCredential, keyFingerprint, keyHint } = await import("./src/shipping/credentials.ts");
    const { saveCourierRules } = await import("./src/shipping/rules.ts");
    const { confirmDedicatedAccount } = await import("./src/shipping/sync.ts");
    const { acceptSellerTerms } = await import("./src/platform/terms.ts");
    const [u] = await admin.$client.unsafe("select id from \\"user\\" where email = $1", [${JSON.stringify(store.email)}]);
    const [s] = await admin.$client.unsafe("select id from store where slug = $1", [${JSON.stringify(store.slug)}]);
    const ctx = await sellerContext(app, u.id, Number(s.id));
    if (!ctx.ok) throw new Error(ctx.reason);
    const physId = await createProduct(ctx.scope, { title: "Buku Fisik T111", status: "active", variant: { title: "Softcover", price: 100000, stock: 20, weightGrams: 500 } });
    await acceptSellerTerms(ctx.scope, { version: 1, agreed: true });
    await setPickupArea(ctx.scope, { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Sumur Bandung, Bandung, Jawa Barat 40111" });
    const mkey = "E2E-T111-MENGANTAR-" + Date.now() + "-0123456789abcdef";
    const [sacc] = await admin.$client.unsafe("insert into store_shipping_account (store_id, kind, status, external_user_id, environment) values ($1, 'seller_owned', 'needs_key', $2, 'sandbox') returning id", [s.id, "store:" + s.id]);
    const sealed = sealCredential("shipping_credentials", mkey, Number(s.id), Number(sacc.id), "seller_owned");
    await admin.$client.unsafe("update store_shipping_account set sealed_key = $1, key_id = $2, sealed_at = now(), key_fingerprint = $3, key_hint = $4, status = 'active', last_result = 'ready', last_checked_at = now() where id = $5",
      [sealed.sealedKey, sealed.keyId, keyFingerprint("shipping_credentials", mkey), keyHint(mkey), sacc.id]);
    await confirmDedicatedAccount(ctx.scope, { confirmed: true });
    await setPickupAddress(ctx.scope, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
    await saveCourierRules(ctx.scope, { couriers: [{ courierCode: "JNE", enabled: true, codEnabled: true }] });
    await admin.$client.begin(async (tx) => {
      const [p] = await tx.unsafe("insert into store_step_up_proof (store_id, user_id, session_id, action_key, subject_kind, subject_id, expires_at, consumed_at) values ($1, $2, 'e2e-t111', 'integrations.bank_account', 'store', 'bank_transfer', now() + interval '5 minutes', now()) returning id", [s.id, u.id]);
      await tx.unsafe("insert into store_bank_account (store_id, bank_code, account_number, holder_name, created_by, step_up_ref) values ($1, 'BCA', '1234567890', 'Pemilik Digital', $2, $3)", [s.id, u.id, p.id]);
    });
    const [prod] = await admin.$client.unsafe("select coalesce(slug, catalog_id::text) as slug from product where id = $1", [physId]);
    return { storeId: Number(s.id), physSlug: prod.slug };
  `);

  // 1. Seller creates a digital product as draft, adds one access link (ADR-0016 decision 3), then activates it.
  await login(page, store.email, "/seller");
  await page.goto("/seller/products/new");
  await page.getByLabel("Judul produk").fill("E-Book Panduan Jualan");
  await page.getByLabel("Jenis produk").selectOption("digital");
  await page.getByLabel("Status").selectOption("draft");
  await page.getByLabel("Nama varian").fill("PDF Lengkap");
  await page.getByLabel("Harga (Rp)").fill("59000");
  await page.getByRole("button", { name: "Simpan produk" }).click();
  await expect(page).toHaveURL(/\/seller\/products\/\d+\?saved=1/);
  await expect(page.getByTestId("product-kind-badge")).toContainText("Produk digital");
  await expect(page.getByTestId("variant-stock")).toHaveText("Tak terbatas");
  const linkForm = page.getByRole("form", { name: "Tambah tautan akses" });
  await linkForm.getByLabel("Label tautan").fill("Unduh E-Book PDF");
  await linkForm.getByLabel("Tautan https://").fill("https://drive.google.com/file/d/t111-ebook/view");
  await linkForm.getByRole("button", { name: "Tambah tautan" }).click();
  await expect(page.getByTestId("access-links-list")).toContainText("Unduh E-Book PDF");
  await page.getByLabel("Status").selectOption("active");
  await page.getByRole("button", { name: "Simpan produk" }).click();
  await expect(page).toHaveURL(/\/seller\/products\/\d+\?saved=1/);
  await evidence(page, info, "t111-seller-digital-product");

  const digitalSlug = node<string>(`
    const [p] = await admin.$client.unsafe("select coalesce(slug, catalog_id::text) as slug from product where store_id = $1 and kind = 'digital' order by id desc limit 1", [${storeId}]);
    return p.slug;
  `);

  // 2. Buyer: digital-only PDP -> cart -> checkout (no area search, no courier, no address, no COD, email required).
  const buyerCtx = await browser.newContext({ baseURL: info.project.use.baseURL!, viewport: page.viewportSize()! });
  const bp = await buyerCtx.newPage();
  await bp.goto(`/s/${store.slug}/products/${digitalSlug}`);
  await expect(bp.getByTestId("pdp-digital-badge")).toContainText("Produk digital");
  await expect(bp.getByTestId("pdp-digital-delivery")).toBeVisible();
  await bp.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await bp.getByRole("link", { name: "Checkout" }).click();
  await expect(bp.getByRole("heading", { name: /1\. Area tujuan/ })).toHaveCount(0);
  await expect(bp.getByLabel("Alamat lengkap")).toHaveCount(0);
  await expect(bp.getByTestId("cod-disabled-digital")).toBeVisible();
  await expect(bp.getByLabel("Email")).toHaveAttribute("required", "");
  await evidence(bp, info, "t111-checkout-digital-only");

  await bp.getByLabel("Nama").fill("Pembeli Ebook");
  await bp.getByLabel("Nomor HP").fill(testPhone());
  await bp.getByLabel("Email").fill("pembeli-ebook@example.com");
  await bp.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(bp.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const orderId = Number((await bp.getByTestId("order-id").textContent())!.replace("#", ""));
  await expect(bp.getByTestId("digital-no-shipping")).toBeVisible();
  await expect(bp.getByTestId("order-shipping")).toHaveCount(0);
  await evidence(bp, info, "t111-confirmation-digital-only");

  // 3. Seller confirms bank transfer on SC-13 -> order completes immediately, no shipping block shown.
  await page.goto(`/seller/orders/${orderId}`);
  await expect(page.getByTestId("seller-order-digital")).toBeVisible();
  await expect(page.getByTestId("shipment")).toHaveCount(0);
  page.on("dialog", (d) => d.accept());
  const confirmForm = page.getByRole("form", { name: "Konfirmasi transfer bank" });
  await confirmForm.getByLabel("Alasan").fill("Dana masuk mutasi BCA");
  await confirmForm.getByRole("button", { name: "Konfirmasi transfer diterima" }).click();
  await expect(page.getByRole("main")).toContainText("Selesai");
  await evidence(page, info, "t111-seller-order-digital-completed");

  // Buyer signed order-status page shows completed and no shipping rows.
  const exp = Math.floor((Date.now() + 3_600_000) / 1000);
  const sig = createHmac("sha256", process.env.ORDER_LINK_SECRET!).update(`order-link:${orderId}.${exp}`).digest("base64url");
  await bp.goto(`/o/${orderId}.${exp}.${sig}`);
  await expect(bp.getByTestId("order-status")).toHaveText("Selesai");
  await expect(bp.getByTestId("digital-no-shipping")).toBeVisible();
  await expect(bp.getByTestId("courier")).toHaveCount(0);

  // 4. Mixed cart (digital + physical): shipping step appears, COD is removed.
  await bp.goto(`/s/${store.slug}/products/${digitalSlug}`);
  await bp.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(bp).toHaveURL(/\/cart/);
  await bp.goto(`/s/${store.slug}/products/${physSlug}`);
  await bp.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(bp).toHaveURL(/\/cart/);
  await bp.getByRole("link", { name: "Checkout" }).click();
  await expect(bp.getByRole("heading", { name: /1\. Area tujuan/ })).toBeVisible();
  await chooseDestination(bp);
  await expect(bp.getByTestId("cod-disabled-digital")).toBeVisible();
  await expect(bp.locator('input[name="paymentMethod"][value="cod"]')).toHaveCount(0);
  await buyerCtx.close();
});
