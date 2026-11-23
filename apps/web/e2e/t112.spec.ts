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

const ACCESS_URL = "https://drive.google.com/file/d/t112-e2e-canary-998877/view";
const ACCESS_NOTE = "Gunakan email pembelian. <b>Bukan HTML</b>";

// T-112 (PR-2, ADR-0016):
// E2E at 320 px and desktop: seller configures digital access links & note, digital-only purchase ->
// payment confirmed -> buyer sees label, host, no-referrer link and plain-text note on /o/[token]
// (absent from storefront HTML and Storefront API); mixed purchase grants digital line on payment;
// seller extends and revokes grant -> links disappear; reserved member-area paths return 404.

test("digital delivery end-to-end: access links, plain-text note, mixed order, seller extend/revoke and 404 reserved paths", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  const store = seedFixtureStore("t112");
  const { digId, digSlug, physSlug, apiToken } = node<{ digId: number; digSlug: string; physSlug: string; apiToken: string }>(`
    const { sellerContext } = await import("./src/platform/scoped.ts");
    const { createProduct } = await import("./src/seller/commerce/catalog.ts");
    const { createChannel } = await import("./src/storefront/channels.ts");
    const { setPickupArea, setPickupAddress } = await import("./src/shipping/shipping.ts");
    const { sealCredential, keyFingerprint, keyHint } = await import("./src/shipping/credentials.ts");
    const { saveCourierRules } = await import("./src/shipping/rules.ts");
    const { confirmDedicatedAccount } = await import("./src/shipping/sync.ts");
    const { acceptSellerTerms } = await import("./src/platform/terms.ts");
    const [u] = await admin.$client.unsafe("select id from \\"user\\" where email = $1", [${JSON.stringify(store.email)}]);
    const [s] = await admin.$client.unsafe("select id from store where slug = $1", [${JSON.stringify(store.slug)}]);
    const ctx = await sellerContext(app, u.id, Number(s.id));
    if (!ctx.ok) throw new Error(ctx.reason);
    const physId = await createProduct(ctx.scope, { title: "Buku Cetak T112", status: "active", variant: { title: "Softcover", price: 90000, stock: 10, weightGrams: 500 } });
    const digId = await createProduct(ctx.scope, { title: "E-Book T112", kind: "digital", status: "draft", variant: { title: "PDF", price: 65000, stock: 0 } });
    await acceptSellerTerms(ctx.scope, { version: 1, agreed: true });
    await setPickupArea(ctx.scope, { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Sumur Bandung, Bandung, Jawa Barat 40111" });
    const mkey = "E2E-T112-MENGANTAR-" + Date.now() + "-0123456789abcdef";
    const [sacc] = await admin.$client.unsafe("insert into store_shipping_account (store_id, kind, status, external_user_id, environment) values ($1, 'seller_owned', 'needs_key', $2, 'sandbox') returning id", [s.id, "store:" + s.id]);
    const sealed = sealCredential("shipping_credentials", mkey, Number(s.id), Number(sacc.id), "seller_owned");
    await admin.$client.unsafe("update store_shipping_account set sealed_key = $1, key_id = $2, sealed_at = now(), key_fingerprint = $3, key_hint = $4, status = 'active', last_result = 'ready', last_checked_at = now() where id = $5",
      [sealed.sealedKey, sealed.keyId, keyFingerprint("shipping_credentials", mkey), keyHint(mkey), sacc.id]);
    await confirmDedicatedAccount(ctx.scope, { confirmed: true });
    await setPickupAddress(ctx.scope, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
    await saveCourierRules(ctx.scope, { couriers: [{ courierCode: "JNE", enabled: true, codEnabled: true }] });
    await admin.$client.begin(async (tx) => {
      const [p] = await tx.unsafe("insert into store_step_up_proof (store_id, user_id, session_id, action_key, subject_kind, subject_id, expires_at, consumed_at) values ($1, $2, 'e2e-t112', 'integrations.bank_account', 'store', 'bank_transfer', now() + interval '5 minutes', now()) returning id", [s.id, u.id]);
      await tx.unsafe("insert into store_bank_account (store_id, bank_code, account_number, holder_name, created_by, step_up_ref) values ($1, 'BCA', '1234567890', 'Pemilik Digital', $2, $3)", [s.id, u.id, p.id]);
    });
    const ch = await createChannel(ctx.scope, { name: "T112 API", origin: "https://t112.example.com" });
    const [dp] = await admin.$client.unsafe("select coalesce(slug, catalog_id::text) as slug from product where id = $1", [digId]);
    const [pp] = await admin.$client.unsafe("select coalesce(slug, catalog_id::text) as slug from product where id = $1", [physId]);
    return { storeId: Number(s.id), digId, digSlug: dp.slug, physSlug: pp.slug, apiToken: ch.token };
  `);

  // 1. Seller adds access link + plain-text note on SC-03 and activates the digital product.
  await login(page, store.email, "/seller");
  await page.goto(`/seller/products/${digId}`);
  await expect(page.getByTestId("digital-access-section")).toContainText("tetap diatur di host penyimpanan Anda");
  const linkForm = page.getByRole("form", { name: "Tambah tautan akses" });
  await linkForm.getByLabel("Label tautan").fill("Unduh E-Book PDF");
  await linkForm.getByLabel("Tautan https://").fill(ACCESS_URL);
  await linkForm.getByRole("button", { name: "Tambah tautan" }).click();
  await expect(page.getByTestId("access-links-list")).toContainText("Unduh E-Book PDF");
  const noteForm = page.getByRole("form", { name: "Catatan akses produk digital" });
  await noteForm.getByLabel(/Catatan akses/).fill(ACCESS_NOTE);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/seller/products/${digId}`)),
    noteForm.getByRole("button", { name: "Simpan catatan akses" }).click(),
  ]);
  await page.goto(`/seller/products/${digId}`);
  await expect(noteForm.getByLabel(/Catatan akses/)).toHaveValue(ACCESS_NOTE);
  await page.getByLabel("Status").selectOption("active");
  await page.getByRole("button", { name: "Simpan produk" }).click();
  await expect(page.locator("[data-slot=badge]", { hasText: "Aktif" })).toBeVisible();

  // 2. Storefront HTML, Storefront API, and reserved member-area paths leak NOTHING and reserved paths return 404.
  const buyerCtx = await browser.newContext({ baseURL: info.project.use.baseURL!, viewport: page.viewportSize()! });
  const bp = await buyerCtx.newPage();
  const pdpHtml = await (await bp.request.get(`/s/${store.slug}/products/${digSlug}`)).text();
  expect(pdpHtml).not.toContain("t112-e2e-canary-998877");
  expect(pdpHtml).not.toContain("Bukan HTML");
  const apiText = await (await bp.request.get(`/api/storefront/v1/products/${digSlug}`, { headers: { Authorization: `Bearer ${apiToken}` } })).text();
  expect(apiText).not.toContain("t112-e2e-canary-998877");
  expect(apiText).not.toContain("Bukan HTML");
  for (const reserved of ["/member", "/members", "/buyer/members", "/seller/memberships"]) {
    expect((await bp.request.get(reserved)).status()).toBe(404);
  }

  // 3. Buyer places digital-only order -> unpaid order-status page shows NO access link.
  await bp.goto(`/s/${store.slug}/products/${digSlug}`);
  await bp.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(bp).toHaveURL(/\/cart/);
  await bp.getByRole("link", { name: "Checkout" }).click();
  await bp.getByLabel("Nama").fill("Pembeli T112");
  await bp.getByLabel("Nomor HP").fill(testPhone());
  await bp.getByLabel("Email").fill("t112-buyer@example.com");
  await bp.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(bp.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const orderId = Number((await bp.getByTestId("order-id").textContent())!.replace("#", ""));
  const exp = Math.floor((Date.now() + 3_600_000) / 1000);
  const sig = createHmac("sha256", process.env.ORDER_LINK_SECRET!).update(`order-link:${orderId}.${exp}`).digest("base64url");
  const statusUrl = `/o/${orderId}.${exp}.${sig}`;
  await bp.goto(statusUrl);
  await expect(bp.getByTestId("access-link")).toHaveCount(0);

  // 4. Seller confirms transfer -> buyer now sees label, host, no-referrer link and literal plain-text note.
  await page.goto(`/seller/orders/${orderId}`);
  page.on("dialog", (d) => d.accept());
  const confirmForm = page.getByRole("form", { name: "Konfirmasi transfer bank" });
  await confirmForm.getByLabel("Alasan").fill("Dana masuk mutasi BCA");
  await confirmForm.getByRole("button", { name: "Konfirmasi transfer diterima" }).click();
  await expect(page.getByTestId("seller-digital-grants")).toBeVisible();

  await bp.goto(statusUrl);
  const link = bp.getByTestId("access-link");
  await expect(link).toHaveAttribute("href", ACCESS_URL);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(bp.getByTestId("access-link-host")).toHaveText("drive.google.com");
  await expect(bp.getByTestId("access-note")).toHaveText(ACCESS_NOTE);
  await expect(bp.locator('[data-testid="access-note"] b')).toHaveCount(0); // rendered as text, never HTML
  await evidence(bp, info, "t112-buyer-digital-access");

  // 5. Seller extends then revokes grant -> buyer sees no link after revocation.
  const extForm = page.getByRole("form", { name: /Perpanjang akses/ });
  await extForm.getByLabel(/Tambah hari/).fill("30");
  await extForm.getByLabel("Alasan perpanjangan").fill("Perpanjangan akses 30 hari");
  await extForm.getByRole("button", { name: "Perpanjang akses" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("Masa berlaku akses digital diperbarui");
  await evidence(page, info, "t112-seller-grant-controls");

  const revForm = page.getByRole("form", { name: /Cabut akses/ });
  await revForm.getByLabel("Alasan pencabutan").fill("Permintaan refund selesai");
  await revForm.getByRole("button", { name: "Cabut akses" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("Akses digital dicabut");

  await bp.goto(statusUrl);
  await expect(bp.getByTestId("access-link")).toHaveCount(0);
  await expect(bp.getByTestId("grant-inactive")).toContainText("dicabut");

  // 6. Mixed order purchase grants access on payment while keeping order in `placed` (awaiting shipment).
  await bp.goto(`/s/${store.slug}/products/${digSlug}`);
  await bp.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(bp).toHaveURL(/\/cart/);
  await bp.goto(`/s/${store.slug}/products/${physSlug}`);
  await bp.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(bp).toHaveURL(/\/cart/);
  await bp.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(bp);
  await bp.getByLabel("Nama").fill("Pembeli Mixed");
  await bp.getByLabel("Nomor HP").fill(testPhone());
  await bp.getByLabel("Email").fill("t112-mixed@example.com");
  await bp.getByLabel("Alamat lengkap").fill("Jl. Menteng Raya No. 10, Jakarta Pusat");
  await bp.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(bp.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const mixedId = Number((await bp.getByTestId("order-id").textContent())!.replace("#", ""));
  await page.goto(`/seller/orders/${mixedId}`);
  const mixConfirm = page.getByRole("form", { name: "Konfirmasi transfer bank" });
  await mixConfirm.getByLabel("Alasan").fill("Dana mixed order masuk");
  await mixConfirm.getByRole("button", { name: "Konfirmasi transfer diterima" }).click();
  await expect(page.getByTestId("seller-digital-grants")).toBeVisible();
  const mSig = createHmac("sha256", process.env.ORDER_LINK_SECRET!).update(`order-link:${mixedId}.${exp}`).digest("base64url");
  await bp.goto(`/o/${mixedId}.${exp}.${mSig}`);
  await expect(bp.getByTestId("access-link")).toHaveAttribute("href", ACCESS_URL);
  await expect(bp.getByTestId("courier")).toBeVisible();
  await buyerCtx.close();
});
