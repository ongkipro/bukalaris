import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { evidence, login, seedFixtureStore } from "./helpers";

// T-107 (ADR-0013 section 8, C-P9): the money boundary on the seller's screens. A disposable store per project on its OWN (sandbox, fake) AutoLaris
// account with two paid QRIS orders made through the real services: the order page shows the money record and records a refund made by the seller,
// the finance screen shows collected amounts by method instead of balance and payouts, the dashboard shows the same, the buyer's signed link shows
// the refund, and the Owner console money screen says it lists platform-held money only.

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
 * A store on its own sandbox AutoLaris account (sealed with the real code, as T-106's spec does) and two QRIS orders placed through `placeOrder` and
 * confirmed by hand by the owner (decision 24). The orders are sandbox test orders; they are marked real here (superuser, guard lifted for one
 * statement) so the collected figures count them.
 */
function sellerOwnedStoreWithPaidOrders(slug: string, email: string, apiKey: string) {
  return node<{ storeId: number; orderIds: number[]; bills: number[] }>(`
    const { randomUUID } = await import("node:crypto");
    const { sellerContext } = await import("./src/platform/scoped.ts");
    const { storefrontScope } = await import("./src/platform/scoped.ts");
    const { createProduct } = await import("./src/seller/commerce/catalog.ts");
    const { setPickupArea } = await import("./src/shipping/shipping.ts");
    const { setCartLine } = await import("./src/storefront/storefront.ts");
    const { placeOrder } = await import("./src/seller/commerce/checkout.ts");
    const { confirmPaymentByHand } = await import("./src/payments/seller.ts");
    const { fakeProviders } = await import("./src/payments/providers.ts");
    const { sealCredential, keyFingerprint, keyHint } = await import("./src/shipping/credentials.ts");
    const [u] = await admin.$client.unsafe("select id from \\"user\\" where email = '${email}'");
    const [s] = await admin.$client.unsafe("select id from store where slug = '${slug}'");
    const ctx = await sellerContext(app, u.id, Number(s.id));
    const productId = await createProduct(ctx.scope, { title: "Kaos T107 ${slug.slice(-6)}", status: "active", variant: { title: "M", price: 100000, stock: 20, weightGrams: 1000 } });
    await setPickupArea(ctx.scope, { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Sumur Bandung, Bandung, Jawa Barat 40111" });
    const [acc] = await admin.$client.unsafe("insert into store_payment_account (store_id, environment, status) values ($1, 'sandbox', 'needs_key') returning id", [s.id]);
    const sealed = sealCredential("payment_credentials", ${JSON.stringify(apiKey)}, Number(s.id), Number(acc.id), "autolaris");
    await admin.$client.unsafe("update store_payment_account set sealed_key = $1, key_id = $2, sealed_at = now(), key_fingerprint = $3, key_hint = $4, status = 'active', last_result = 'ready', last_checked_at = now(), origin_area_id = '3517100', destination_area_id = '3518010', shipper_email = 'toko@example.invalid', sender_address = 'Jl. Braga No. 1, Bandung 40111', payment_only_confirmed_at = now(), payment_only_confirmed_by = $5 where id = $6",
      [sealed.sealedKey, sealed.keyId, keyFingerprint("payment_credentials", ${JSON.stringify(apiKey)}), keyHint(${JSON.stringify(apiKey)}), u.id, acc.id]);
    const [v] = await admin.$client.unsafe("select id from variant where product_id = $1", [productId]);
    const sf = await storefrontScope(app, '${slug}');
    const orderIds = [];
    for (const n of [1, 2]) {
      const cartId = await setCartLine(sf, undefined, { variantId: Number(v.id), quantity: n }, "add");
      const { orderId } = await placeOrder(app, cartId, { idempotencyKey: randomUUID(), buyerName: "Budi Santoso", buyerPhone: "08129" + String(Date.now() % 1000000).padStart(6, "0") + n, shippingAddress: "Jl. Merdeka No. 1, Bandung 40111",
        destinationAreaId: "b1b1b1b1b1b1b1b1b1b1b1b1", destinationAreaLabel: "Menteng, Menteng, Jakarta Pusat, DKI Jakarta 10310", courier: "JNE", paymentMethod: "manual_transfer", paymentChannel: "QRIS" }, fakeProviders);
      const [a] = await admin.$client.unsafe("select id from payment_attempt where order_id = $1", [orderId]);
      await confirmPaymentByHand(ctx.scope, { attemptId: a.id, reason: "uang masuk di mutasi AutoLaris", evidence: "MUT-" + orderId });
      orderIds.push(orderId);
    }
    await admin.$client.unsafe("alter table \\"order\\" disable trigger order_test_marker_guard");
    await admin.$client.unsafe("update \\"order\\" set test_order = false where id = $1", [orderIds[1]]);
    await admin.$client.unsafe("alter table \\"order\\" enable trigger order_test_marker_guard");
    const bills = [];
    for (const id of orderIds) bills.push(Number((await admin.$client.unsafe("select payable_idr + buyer_fee_idr as b from order_financials where order_id = $1", [id]))[0].b));
    return { storeId: Number(s.id), orderIds, bills };
  `);
}
const orderLink = (orderId: number) => {
  const exp = Math.floor((Date.now() + 3_600_000) / 1000);
  const secret = process.env.ORDER_LINK_SECRET ?? process.env.BETTER_AUTH_SECRET!;
  return `/o/${orderId}.${exp}.${createHmac("sha256", secret).update(`order-link:${orderId}.${exp}`).digest("base64url")}`;
};
const status = (page: Page) => page.getByRole("main").getByRole("status");
const rp = (n: number) => new RegExp(`Rp\\s?${n.toLocaleString("id-ID").replace(/\./g, "\\.")}`);

test("seller-owned store: the order records the money and a refund made by the seller, finance and dashboard show collected amounts by method with no balance or payout, the buyer link shows the refund", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  const tag = `${info.project.name === "mobile-320" ? "m" : "d"}${randomBytes(3).toString("hex")}`;
  const store = seedFixtureStore("t107");
  const { orderIds, bills } = sellerOwnedStoreWithPaidOrders(store.slug, store.email, `CANARY-T107-${tag}-e2e-autolaris-key-0123456789`);
  const [testOrder, realOrder] = orderIds as [number, number];
  const realBill = bills[1]!;

  await login(page, store.email, "/seller");

  // Order page: the money record of a sandbox (test) order on the store's own AutoLaris account.
  await page.goto(`/seller/orders/${testOrder}`);
  await expect(page.getByTestId("test-order")).toHaveText("Pesanan uji");
  await expect(page.getByTestId("order-money")).toContainText("Dibayar langsung ke akun AutoLaris milik toko Anda");
  await expect(page.getByTestId("order-bill")).toHaveText(rp(bills[0]!));

  // Record a refund on the real order (a record only), then see it on the order.
  await page.goto(`/seller/orders/${realOrder}`);
  await expect(page.getByTestId("test-order")).toHaveCount(0);
  // No platform booking for an order paid to the store's own accounts (no own Mengantar account here): the seller ships with an own waybill.
  await expect(page.getByTestId("platform-booking-closed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Kirim dengan Bukalaris Kirim" })).toHaveCount(0);
  const form = page.getByRole("form", { name: "Catat refund" });
  await form.getByLabel("Jumlah refund (Rp)").fill("25000");
  await form.getByLabel("Cara refund").selectOption("bank_transfer");
  await form.getByLabel(/Referensi transfer/).fill("TRF-T107-1");
  await form.getByLabel("Alasan").fill("Satu kaos cacat, uang dikembalikan sebagian");
  await form.getByRole("button", { name: "Catat refund" }).click();
  await expect(status(page)).toContainText("Refund tercatat pada pesanan ini");
  await expect(page.getByTestId("order-refunded")).toHaveText(/Rp\s?25\.000/);
  await expect(page.getByTestId("order-refunds")).toContainText("Transfer bank");
  await evidence(page, info, "t107-order-money");
  // Above the remaining bill is refused with the amount still recordable.
  await form.getByLabel("Jumlah refund (Rp)").fill(String(realBill));
  await form.getByLabel("Alasan").fill("Melebihi tagihan pembeli");
  await form.getByRole("button", { name: "Catat refund" }).click();
  await expect(page.getByRole("alert").first()).toContainText("Total refund melebihi tagihan pembeli");

  // Finance: collected amounts by method, labelled as paid to the store's own accounts; no balance, no payout form.
  await page.goto("/seller/finance");
  await expect(page.getByTestId("finance-own-accounts")).toBeVisible();
  await expect(page.getByTestId("finance-no-balance")).toContainText("Tidak ada Saldo Bukalaris");
  await expect(page.getByTestId("finance-balances")).toHaveCount(0);
  await expect(page.getByTestId("finance-payout")).toHaveCount(0);
  await expect(page.getByTestId("collected-30d-qris")).toContainText("QRIS (lewat AutoLaris)");
  await expect(page.getByTestId("collected-30d-total")).toHaveText(rp(realBill)); // the test order is not counted
  await expect(page.getByTestId("collected-30d-refunded")).toHaveText(/Rp\s?25\.000/);
  await evidence(page, info, "t107-finance");

  // Dashboard: the same figure for today.
  await page.goto("/seller");
  await expect(page.getByTestId("dashboard-collected")).toContainText("Uang diterima di akun Anda");
  await expect(page.getByTestId("collected-period-total")).toHaveText(rp(realBill));
  await evidence(page, info, "t107-dashboard");

  // Buyer: the signed order-status link shows the refund the seller recorded, without the seller's note or reference.
  const buyerCtx = await browser.newContext({ baseURL: info.project.use.baseURL!, viewport: page.viewportSize()! });
  const bp = await buyerCtx.newPage();
  await bp.goto(orderLink(realOrder));
  await expect(bp.getByTestId("seller-refunds")).toContainText("Transfer bank");
  await expect(bp.getByTestId("seller-refunds")).toContainText(/Rp\s?25\.000/);
  await expect(bp.getByTestId("seller-refunds")).not.toContainText("TRF-T107-1");
  await expect(bp.getByTestId("seller-refunds")).not.toContainText("cacat");
  await evidence(bp, info, "t107-buyer-refund");
  await buyerCtx.close();
});

/** A platform operator holding only `finance.read` (the money screen's capability), created through the system grant path like the other specs. */
function seedFinanceReader(email: string) {
  node(`
    const { randomUUID } = await import("node:crypto");
    const { hashPassword } = await import("better-auth/crypto");
    const { account, platformOperator, user } = await import("./src/schema.ts");
    const { grantAsSystem } = await import("./src/ops/capabilities-grants.ts");
    const platform = createDb(process.env.E2E_PLATFORM_DATABASE_URL);
    const id = randomUUID();
    await platform.insert(user).values({ id, email: ${JSON.stringify(email)}, name: "keuangan t107", emailVerified: true });
    await platform.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword("bukalaris-dev-123") });
    await platform.insert(platformOperator).values({ userId: id });
    await grantAsSystem(platform, { userId: id, capabilities: ["finance.read"], source: "system_bootstrap", reason: "e2e fixture t107" });
    await platform.$client.end();
  `);
}

test("Owner console money screen lists only platform-held money", async ({ page }, info) => {
  const email = `t107-fin-${info.project.name === "mobile-320" ? "m" : "d"}${randomBytes(3).toString("hex")}@bukalaris.local`;
  seedFinanceReader(email);
  await login(page, email, "/admin");
  await page.goto("/admin/money");
  await expect(page.getByTestId("platform-held-only")).toContainText("Hanya uang yang dipegang Bukalaris");
  await evidence(page, info, "t107-admin-money");
});
