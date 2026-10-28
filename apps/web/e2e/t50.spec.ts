import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { evidence, login } from "./helpers";

// T-50 (platform subscription billing, seller access policy, Owner console billing) against the FAKE AutoLaris adapter. The worker (second Playwright
// webServer) creates the payment instruction. Database facts and time travel use the superuser URL of the disposable e2e database, never the app under test.
// Settlement paths (callback replay, exact amount, expiry) are proven against PostgreSQL in packages/db/test/t50-*.test.ts: the fake inquiry answers
// "pending" here, so nothing in this file can settle an invoice, which is the point of "a payment return is not settlement".
const DB_CWD = resolve(process.cwd(), "../../packages/db");

function runDb<T = unknown>(body: string): T {
  const script = `
    import { createDb } from "./src/client.ts";
    import { randomUUID } from "node:crypto";
    import { hashPassword } from "better-auth/crypto";
    import { eq, sql } from "drizzle-orm";
    import { account, membership, platformOperator, user } from "./src/schema.ts";
    import { grantAsSystem } from "./src/ops/capabilities-grants.ts";
    import { createStore } from "./src/platform/platform.ts";
    import { operatorScope } from "./src/platform/scoped.ts";
    const db = createDb(process.env.E2E_PLATFORM_DATABASE_URL);
    const admin = createDb(process.env.E2E_DATABASE_URL);
    const out = await (async () => { ${body} })();
    await db.$client.end();
    await admin.$client.end();
    console.log("@@" + JSON.stringify(out ?? null));
  `;
  const stdout = execFileSync("node", ["--input-type=module", "-e", script], { cwd: DB_CWD, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(stdout.slice(stdout.lastIndexOf("@@") + 2)) as T;
}
const q = <T,>(statement: string) => runDb<T>(`return await admin.$client.unsafe(${JSON.stringify(statement)});`);

/** A fresh store with its own owner account and its own subscription (the trigger bootstraps it), unique per call. */
function seedStore(slug: string, ownerEmail: string): number {
  return runDb<number>(`
    const adminUser = (await admin.$client.unsafe("select id from \\"user\\" where email = 'admin@bukalaris.local'"))[0].id;
    const op = await operatorScope(db, adminUser);
    const id = randomUUID();
    await db.insert(user).values({ id, email: ${JSON.stringify(ownerEmail)}, name: "Pemilik ${slug}", emailVerified: true });
    await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword("bukalaris-dev-123") });
    return await createStore(op, { slug: ${JSON.stringify(slug)}, name: "Toko ${slug}", ownerUserId: id });
  `);
}
/** An operator holding exactly these capabilities. */
function seedOperator(email: string, caps: string[]) {
  runDb(`
    if (!(await db.select().from(user).where(eq(user.email, ${JSON.stringify(email)}))).length) {
      const id = randomUUID();
      await db.insert(user).values({ id, email: ${JSON.stringify(email)}, name: ${JSON.stringify(email.split("@")[0])}, emailVerified: true });
      await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword("bukalaris-dev-123") });
      await db.insert(platformOperator).values({ userId: id });
      await grantAsSystem(db, { userId: id, capabilities: ${JSON.stringify(caps)}, source: "system_bootstrap", reason: "e2e fixture t50" });
    }
  `);
}
/** Time travel: end the trial `days` ago (the immutable-column trigger is lifted around this one update; the trigger is the subject of the database tests). */
function endTrial(storeId: number, days: number) {
  q(`alter table store_subscription disable trigger store_subscription_guard`);
  q(`update store_subscription set trial_ends_at = now() - interval '${days} days', billing_anchor_date = ((now() - interval '${days} days') at time zone 'Asia/Jakarta')::date, status = 'trial', past_due_at = null, grace_ends_at = null, current_period_start = null, current_period_end = null where store_id = ${storeId}`);
  q(`alter table store_subscription enable trigger store_subscription_guard`);
}
const unique = (info: { project: { name: string } }) => `${info.project.name === "mobile-320" ? "m" : "d"}${Date.now().toString(36)}`;
// The hourly cron creates a new store's period-0 invoice at once (the invoice window opens one trial length before the anchor), which would race the
// "no invoice yet" assertions below: freeze it for this file (the post-restore switch) and release it afterwards. The cycle itself is proven in t50-cycle.test.ts.
test.beforeAll(() => { q(`update billing_control set jobs_frozen = true`); });
test.afterAll(() => { q(`update billing_control set jobs_frozen = false`); });
const count = (statement: string) => Number(q<{ n: string }[]>(statement)[0]!.n);

async function loginOwner(page: Page, email: string) {
  await login(page, email, "/seller");
  await page.goto("/seller/billing");
}

test("seller billing: trial status and plan, a double Pay gives one invoice and one live instruction, the return page never says paid, keyboard flow", async ({ page }, info) => {
  const slug = `bill-${unique(info)}`;
  const email = `${slug}@bukalaris.local`;
  const storeId = seedStore(slug, email);
  await loginOwner(page, email);
  await expect(page).toHaveTitle("Langganan — Bukalaris");
  await expect(page.getByRole("heading", { name: "Langganan", level: 1 })).toBeVisible();
  await expect(page.getByTestId("billing-state")).toHaveText("Masa percobaan");
  await expect(page.getByTestId("billing-summary")).toContainText("Masa percobaan sampai");
  await expect(page.getByText(/Rp\s?175\.000 per toko per bulan/)).toBeVisible();
  await expect(page.getByText("Belum dipungut (Rp0).")).toBeVisible(); // PPN off by default
  await expect(page.getByTestId("billing-banner")).toHaveCount(0); // writable: no restriction banner
  await expect(page.getByRole("link", { name: "Langganan", exact: true })).toBeVisible();
  await expect(page.getByText("Belum ada tagihan")).toBeVisible(); // an empty history differs from no filter matches
  await evidence(page, info, "t50-billing-trial");

  // Keyboard-only: focus the channel select, Tab to the button, Enter. Then a second click of the same action from a stale form (double submit).
  await page.getByLabel("Metode pembayaran").selectOption("QRIS");
  await page.getByLabel("Metode pembayaran").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Buat tagihan dan bayar" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/seller\/billing\/invoices\/[0-9a-f-]{36}\?returned=1/);
  const invoiceUrl = page.url();
  await expect(page.getByTestId("billing-returned")).toContainText("Menunggu verifikasi pembayaran"); // returning from Pay is not settlement
  await expect(page.getByTestId("invoice-status")).toHaveText("Menunggu pembayaran");
  await expect(page.getByTestId("invoice-total")).toHaveText(/Rp\s?175\.000/);
  await expect(page.getByTestId("invoice-ppn")).toContainText("Rp0");
  const pay = page.getByRole("button", { name: /Buat instruksi baru|Bayar sekarang/ });
  await Promise.all([pay.click(), page.waitForURL(/returned=1/)]); // second submit of the same period

  // One invoice, one reference, one live attempt, one instruction job, even after two submits.
  expect(count(`select count(*) as n from subscription_invoice where store_id = ${storeId}`)).toBe(1);
  expect(count(`select count(*) as n from subscription_payment_attempt where store_id = ${storeId}`)).toBe(1);
  expect(count(`select count(*) as n from job where kind = 'subscription.instruction' and store_id = ${storeId}`)).toBe(1);

  // The worker stores the instruction; the page never polls, so reload until it is there. The QR payload reaches the page byte for byte.
  await expect.poll(async () => { await page.goto(invoiceUrl); return page.getByTestId("billing-instruction").count(); }, { timeout: 20_000, intervals: [500, 1000] }).toBe(1);
  await expect(page.getByTestId("billing-qr")).toHaveValue("000201010212\n  QRIS-BYTES-UNCHANGED-6304ABCD ");
  await expect(page.getByTestId("billing-attempt-status")).toHaveText("Menunggu pembayaran");
  const a = q<{ channel_code: string; owner_kind: string; request_state: string; status: string; total_idr: string }[]>(`select * from subscription_payment_attempt where store_id = ${storeId}`)[0]!;
  expect(a).toMatchObject({ channel_code: "QRIS", owner_kind: "subscription_invoice", request_state: "accepted", status: "pending", total_idr: "175000" });
  await expect(page.getByText(/autolaris/i)).toHaveCount(0); // white label
  await evidence(page, info, "t50-invoice-instruction");

  // Back keeps the filter context and the pending instruction is reused from the list page.
  await page.goto("/seller/billing?status=pending");
  await expect(page.getByTestId("billing-invoices").getByRole("listitem")).toHaveCount(1);
  await expect(page.getByTestId("billing-instruction")).toBeVisible();
  await page.getByTestId("billing-invoices").getByRole("link").first().click();
  await page.getByRole("link", { name: "Kembali ke langganan" }).click();
  await expect(page).toHaveURL(/\/seller\/billing\?status=pending$/);
  await page.goto("/seller/billing?status=paid");
  await expect(page.getByText("Tidak ada tagihan dengan status ini")).toBeVisible(); // filtered empty, not "no invoices"
  await evidence(page, info, "t50-billing-filtered-empty");
});

test("past due: a banner, Seller Admin writes denied by the server, billing and payment still usable, storefront and data intact", async ({ page, request }, info) => {
  const slug = `late-${unique(info)}`;
  const email = `${slug}@bukalaris.local`;
  const storeId = seedStore(slug, email);
  endTrial(storeId, 4); // 1 day past the 3-day grace? trial ended 4 days ago, grace 3 days: suspended (billing)
  await login(page, email, "/seller");
  await page.goto("/seller/settings");
  await expect(page.getByTestId("billing-banner")).toContainText("Ditangguhkan (tagihan)");
  await expect(page.getByTestId("billing-banner")).toContainText("hanya bisa dibaca");
  await evidence(page, info, "t50-readonly-banner");

  // A direct write (the real form action) is refused by the server with the billing reason; nothing changes.
  await page.getByLabel("Nama toko").fill("Nama Diubah");
  await page.getByRole("button", { name: "Simpan pengaturan" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("hanya bisa dibaca");
  expect(q<{ name: string }[]>(`select name from store where id = ${storeId}`)[0]!.name).toBe(`Toko ${slug}`);

  // The billing page stays usable and tells the truth: status, deadline, and Pay.
  await page.goto("/seller/billing");
  await expect(page.getByTestId("billing-state")).toHaveText("Ditangguhkan (tagihan)");
  await expect(page.getByTestId("billing-readonly-note")).toContainText("tetap berjalan");
  await expect(page.getByRole("button", { name: "Buat tagihan dan bayar" })).toBeVisible();
  await page.getByRole("button", { name: "Buat tagihan dan bayar" }).click();
  await page.waitForURL(/\/seller\/billing\/invoices\/[0-9a-f-]{36}/);
  await expect(page.getByTestId("invoice-status")).toHaveText("Menunggu pembayaran");
  await evidence(page, info, "t50-readonly-pay");

  // Buyer-facing and data surfaces are untouched by a billing-only restriction.
  expect((await request.get(`/s/${slug}`)).status()).toBe(200);
  await page.goto("/seller/privacy");
  await expect(page.getByRole("heading", { name: /Data pembeli/ })).toBeVisible();
  await page.goto("/seller/products");
  await expect(page.getByRole("heading", { name: "Produk", level: 1 })).toBeVisible();
  expect(count(`select count(*) as n from store where id = ${storeId} and status = 'active' and suspended_at is null`)).toBe(1); // billing never sets the operator timestamp
});

test("store A cannot open store B's invoice (not found)", async ({ page }, info) => {
  const slug = `iso-${unique(info)}`;
  const email = `${slug}@bukalaris.local`;
  const storeId = seedStore(slug, email);
  const { id: invoiceId, number } = runDb<{ id: string; number: string }>(`
    const { ensureSubscriptionInvoice } = await import("./src/billing/invoices.ts");
    const r = await ensureSubscriptionInvoice(db, { storeId: ${storeId}, source: "operator", actor: "e2e", periodIndex: 0 });
    return { id: r.invoice.id, number: r.invoice.number };
  `);
  await login(page, "owner-b@bukalaris.local", "/seller");
  const res = await page.goto(`/seller/billing/invoices/${invoiceId}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByText(email)).toHaveCount(0);
  await expect(page.getByText(invoiceId)).toHaveCount(0);
  await page.goto("/seller/billing");
  await expect(page.getByText(number)).toHaveCount(0); // B's own history does not list A's invoice
});

test("Owner console: manual create returns the seller's invoice (never a duplicate), the PPN switch refuses without a policy, a viewer cannot change anything", async ({ page }, info) => {
  const tag = unique(info);
  const slug = `own-${tag}`;
  const email = `${slug}@bukalaris.local`;
  const storeId = seedStore(slug, email);
  const manager = `bill-mgr-${tag}@bukalaris.local`;
  const viewer = `bill-view-${tag}@bukalaris.local`;
  seedOperator(manager, ["dashboard.read", "billing.read", "billing.manage", "tax.manage", "tenants.read"]);
  seedOperator(viewer, ["dashboard.read", "billing.read"]);
  // The seller's invoice exists first (the creator the seller Pay path uses).
  const first = runDb<{ id: string }>(`
    const { ensureSubscriptionInvoice } = await import("./src/billing/invoices.ts");
    return (await ensureSubscriptionInvoice(db, { storeId: ${storeId}, source: "seller", actor: "e2e" })).invoice;
  `);

  await login(page, manager, "/admin");
  await page.goto("/admin/billing");
  await expect(page.getByRole("heading", { name: "Langganan dan tagihan", level: 1 })).toBeVisible();
  await expect(page.getByTestId("billing-plan")).toContainText(/Rp\s175\.000/);
  await expect(page.getByTestId("billing-ppn-state")).toContainText("Mati");
  await expect(page.getByTestId("billing-store-row").filter({ hasText: `Toko ${slug}` })).toBeVisible();
  await evidence(page, info, "t50-admin-billing");

  await page.getByLabel("ID toko").first().fill(String(storeId));
  await page.getByLabel(/Periode ke- \(kosong/).fill("0");
  await page.locator("#reason").fill("buat manual untuk uji e2e");
  await page.getByRole("button", { name: "Buat tagihan" }).click();
  await expect(page.getByTestId("billing-created")).toContainText("sudah ada; tidak dibuat ganda");
  await expect(page.getByTestId("billing-created").getByRole("link")).toHaveAttribute("href", `/admin/billing/invoices/${first.id}`);
  expect(count(`select count(*) as n from subscription_invoice where store_id = ${storeId}`)).toBe(1);

  await page.getByTestId("billing-created").getByRole("link").click();
  await expect(page.getByTestId("admin-invoice-coverage")).toHaveText("Belum diberikan");
  await expect(page.getByRole("heading", { name: "Tindakan" })).toBeVisible();
  await evidence(page, info, "t50-admin-invoice");

  // PPN switch: refused with no effective vat_output policy (the page says why); the rate is never typed here.
  await page.goto("/admin/billing");
  await page.locator("#ppn-reason").fill("uji tanpa kebijakan pajak");
  await page.getByLabel(/Saya paham/).check();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Nyalakan PPN" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("belum ada kebijakan PPN keluaran");
  await expect(page.getByTestId("billing-ppn-state")).toContainText("Mati");
  expect(count(`select count(*) as n from subscription_plan`)).toBe(1);

  // A viewer sees the page but none of the change forms, and the server refuses a forged call (the gate names the missing capability).
  await page.context().clearCookies();
  await login(page, viewer, "/admin");
  await page.goto("/admin/billing");
  await expect(page.getByRole("heading", { name: "Langganan dan tagihan", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Buat tagihan" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Nyalakan PPN|Matikan PPN/ })).toHaveCount(0);
  await page.goto(`/admin/billing/invoices/${first.id}`);
  await expect(page.getByRole("button", { name: "Batalkan" })).toHaveCount(0);
  await evidence(page, info, "t50-admin-viewer");
});
