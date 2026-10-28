import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { evidence, login } from "./helpers";

// T-48 (unified Partner shipping accounts) end to end against the FAKE adapters. The worker (a Playwright web server) provisions the accounts through the
// scheduler sweep with its own fake Partner transport; no provider is ever called and the entry gate stays locked (no rotation is recorded in this environment).
// Database facts and four-eyes shortcuts use the superuser/platform URLs of the disposable e2e database, never the application under test.
const DB_CWD = resolve(process.cwd(), "../../packages/db");

function runDb<T = unknown>(body: string): T {
  const script = `
    import { createDb } from "./src/client.ts";
    import { randomUUID } from "node:crypto";
    import { hashPassword } from "better-auth/crypto";
    import { eq } from "drizzle-orm";
    import { account, platformOperator, user } from "./src/schema.ts";
    import { grantAsSystem } from "./src/ops/capabilities-grants.ts";
    import { decideApproval } from "./src/ops/capabilities-approvals.ts";
    import { createStore } from "./src/platform/platform.ts";
    import { operatorScope } from "./src/platform/scoped.ts";
    import { applyApprovedMargin, applyShippingSettings, requestMarginRule, requestShippingSettings } from "./src/shipping/policy.ts";
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
const unique = (info: { project: { name: string } }) => `${info.project.name === "mobile-320" ? "m" : "d"}${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

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
function seedStaff(email: string, caps: string[]) {
  runDb(`
    if (!(await db.select().from(user).where(eq(user.email, ${JSON.stringify(email)}))).length) {
      const id = randomUUID();
      await db.insert(user).values({ id, email: ${JSON.stringify(email)}, name: ${JSON.stringify(email.split("@")[0])}, emailVerified: true });
      await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword("bukalaris-dev-123") });
      await db.insert(platformOperator).values({ userId: id });
      await grantAsSystem(db, { userId: id, capabilities: ${JSON.stringify(caps)}, source: "system_bootstrap", reason: "e2e fixture t48" });
    }
  `);
}
/** Restore the shipped defaults through the real four-eyes services (the database guard refuses any other write). */
function restoreDefaults(a: string, b: string) {
  runDb(`
    const idOf = async (e) => (await db.select({ id: user.id }).from(user).where(eq(user.email, e)))[0].id;
    const opA = await operatorScope(db, await idOf(${JSON.stringify(a)}));
    const opB = await operatorScope(db, await idOf(${JSON.stringify(b)}));
    const margin = { fixedIdr: 2000, percentBps: 0, roundTo: 500 };
    const m = await requestMarginRule(opA, margin);
    await decideApproval(opB, m.approvalId, "approve");
    await applyApprovedMargin(opA, margin, m.approvalId);
    const rev = Number((await admin.$client.unsafe("select revision from shipping_control where key = 'default'"))[0].revision);
    const body = { revision: rev, preferPartner: false, discountIdr: 0, discountBps: 0, reason: "pemulihan bawaan e2e" };
    const s = await requestShippingSettings(opA, body);
    await decideApproval(opB, s.approvalId, "approve");
    await applyShippingSettings(opA, s.approvalId, body);
  `);
}
function approveByDb(b: string, approvalId: number) {
  runDb(`
    const idB = (await db.select({ id: user.id }).from(user).where(eq(user.email, ${JSON.stringify(b)})))[0].id;
    await decideApproval(await operatorScope(db, idB), ${approvalId}, "approve");
  `);
}

const alert = (page: Page) => page.getByRole("main").getByRole("alert");
const status = (page: Page) => page.getByRole("main").getByRole("status");
const lastApproval = (action: string) => Number(q<{ id: string }[]>(`select id from approval_request where action_key = '${action}' order by id desc limit 1`)[0]!.id);
async function signOut(page: Page) {
  await page.getByRole("button", { name: "Keluar" }).click();
  await page.waitForURL((u) => u.pathname === "/login");
}

test("Owner console SA-07: locked provider gate, four-eyes margin and discount, cashback stays a draft, courier policy, account health and recovery; the seller sees the account without any secret", async ({ page }, info) => {
  test.setTimeout(240_000);
  const tag = unique(info);
  const slug = `ship-${tag}`;
  const owner = `${slug}@bukalaris.local`;
  const a = `ship-a-${tag}@bukalaris.local`;
  const b = `ship-b-${tag}@bukalaris.local`;
  const storeId = seedStore(slug, owner); // the worker's sweep provisions its Partner account while the rest of this test runs
  seedStaff(a, ["shipping.manage", "payouts.reconcile"]);
  seedStaff(b, ["shipping.manage"]);

  await login(page, a, "/admin");
  await page.goto("/admin/shipping");
  await expect(page.getByRole("heading", { name: /Margin ongkir/, level: 1 })).toBeVisible();
  await expect(page.getByTestId("gate-state")).toContainText("Terkunci");
  await expect(page.getByTestId("cashback-state")).toContainText("Cashback mati");
  await evidence(page, info, "t48-admin-shipping");

  // The margin changes only after a second person approved exactly this payload: a plain Save without an approval is refused and the rule stays.
  await page.getByLabel("Margin tetap (Rp)").fill("2600");
  await page.getByLabel("Margin persen (%)").fill("0");
  await page.getByRole("button", { name: "Simpan aturan" }).click();
  await expect(alert(page)).toContainText("ID persetujuan");
  await expect(page.getByTestId("margin-preview").filter({ hasText: "Rp 22.320" })).toContainText("Rp 24.500"); // still the default: 22.320 + 2.000 -> 24.500
  await page.getByLabel("Margin tetap (Rp)").fill("2600"); // the refused Save reloaded the page with the stored values
  await page.getByLabel("Margin persen (%)").fill("0");
  await page.getByRole("button", { name: "Ajukan perubahan" }).first().click();
  await expect(status(page)).toContainText("Perubahan margin diajukan");
  const marginApproval = lastApproval("shipping.margin");
  await signOut(page);

  await login(page, b, "/admin");
  await page.goto("/admin/approvals");
  const item = page.getByTestId(`approval-${marginApproval}`);
  await expect(item).toContainText("SHA-256");
  await item.getByLabel("Alasan keputusan").fill("angka dan cakupan sudah dicek");
  await item.getByRole("button", { name: "Setujui" }).click();
  await expect(status(page)).toContainText("Keputusan tersimpan");
  await signOut(page);

  await login(page, a, "/admin");
  await page.goto("/admin/shipping");
  await page.getByLabel("Margin tetap (Rp)").fill("2600");
  await page.getByLabel("Margin persen (%)").fill("0");
  await page.getByLabel("Pembulatan ke atas").selectOption("500");
  await page.getByLabel("ID persetujuan (untuk menerapkan)").first().fill(String(marginApproval));
  await page.getByRole("button", { name: "Simpan aturan" }).click();
  await expect(status(page)).toHaveText("Tersimpan.");
  await expect(page.getByTestId("margin-preview").filter({ hasText: "Rp 22.320" })).toContainText("Rp 25.000"); // 22.320 + 2.600 = 24.920 -> 25.000
  await page.getByLabel("Margin tetap (Rp)").fill("2600");
  await page.getByLabel("ID persetujuan (untuk menerapkan)").first().fill(String(marginApproval));
  await page.getByRole("button", { name: "Simpan aturan" }).click(); // the approval is single use
  await expect(alert(page)).toContainText("Persetujuan tidak berlaku");

  // Discount and routing: request in the UI, the second person approves, the requester applies.
  const settings = page.getByRole("form", { name: "Kebijakan pengiriman" });
  await settings.getByLabel("Diskon ongkir tetap (Rp)").fill("1000");
  await settings.getByLabel(/Pakai akun mitra toko/).check();
  await settings.getByLabel("Alasan").fill("diskon uji e2e");
  await settings.getByRole("button", { name: "Ajukan perubahan" }).click();
  await expect(status(page)).toContainText("Perubahan kebijakan diajukan");
  const settingsApproval = lastApproval("shipping.margin");
  approveByDb(b, settingsApproval);
  await page.goto("/admin/shipping");
  await settings.getByLabel("Diskon ongkir tetap (Rp)").fill("1000");
  await settings.getByLabel(/Pakai akun mitra toko/).check();
  await settings.getByLabel("Alasan").fill("diskon uji e2e");
  await settings.getByLabel("ID persetujuan (untuk menerapkan)").fill(String(settingsApproval));
  await settings.getByRole("button", { name: "Terapkan yang disetujui" }).click();
  await expect(status(page)).toHaveText("Tersimpan.");
  await expect(settings.getByLabel("Diskon ongkir tetap (Rp)")).toHaveValue("1000");

  // Cashback: a draft only; it never becomes an effective rule.
  const cashback = page.getByRole("form", { name: "Draf aturan cashback" });
  await cashback.getByLabel("Kode kurir (kosong = semua)").fill("JNE");
  await cashback.getByLabel("Bagian seller (%)").fill("50");
  await cashback.getByLabel("Alasan").fill("draf pembagian e2e");
  await cashback.getByRole("button", { name: "Simpan draf" }).click();
  await expect(status(page)).toContainText("Cashback tetap mati");
  await expect(page.getByTestId("cashback")).toContainText("Draf, tidak berlaku");
  expect(q<{ n: string }[]>(`select count(*) as n from cashback_rule where status <> 'disabled'`)[0]!.n).toBe("0");

  // Courier service policy is data: the new row shows up and the seeded SPX row stays.
  const code = `TX${tag.slice(-5).toUpperCase()}`;
  const courier = page.getByRole("form", { name: "Kebijakan layanan kurir" });
  await courier.getByLabel("Kode kurir").fill(code);
  await courier.getByLabel("Alasan").fill("uji kebijakan layanan");
  await courier.getByRole("button", { name: "Simpan kebijakan" }).click();
  await expect(status(page)).toContainText("hanya berlaku untuk pesanan baru");
  await expect(page.getByTestId(`service-${code}`)).toContainText("COD tidak");
  await expect(page.getByTestId("service-SPX")).toContainText("Retur gratis");

  // Account health: statuses and results only. Wait for the worker's sweep to provision the store, then recover its key through the console.
  await expect.poll(() => q<{ status: string }[]>(`select status from store_shipping_account where store_id = ${storeId} and kind = 'partner_managed'`)[0]!.status, { timeout: 120_000, intervals: [1000, 2000] }).toBe("active");
  await page.goto("/admin/shipping");
  const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: String(storeId), exact: true }) }).filter({ hasText: "Akun mitra toko" });
  await expect(row).toContainText("Aktif");
  const html = await page.content();
  expect(html).not.toMatch(/fake-[0-9a-f]{40}/);
  expect(html).not.toMatch(/sealed|api[-_ ]?key/i);
  await row.getByLabel(/Alasan pemulihan akun/).fill("uji pemulihan kunci e2e");
  await row.getByRole("button", { name: "Pulihkan" }).click();
  await expect(status(page)).toContainText("Pemulihan akun dijadwalkan");
  await expect.poll(() => q<{ status: string }[]>(`select status from store_shipping_account where store_id = ${storeId} and kind = 'partner_managed'`)[0]!.status, { timeout: 60_000, intervals: [1000, 2000] }).toBe("active");
  await evidence(page, info, "t48-admin-accounts");

  // Reconciliation by account (SA-53): the store's summary row exists per account.
  await page.goto("/admin/money/cod-reconciliation");
  await expect(page.getByTestId("cod-accounts")).toBeVisible();
  await signOut(page);

  // Seller: which account is used, no secret anywhere; staff and the other store's owner see only their own store.
  await login(page, owner, "/seller");
  await page.goto("/seller/shipping");
  await expect(page.getByTestId("shipping-account-kind")).toHaveText("Akun khusus toko Anda");
  await expect(page.locator("body")).not.toContainText(/mengantar/i);
  expect(await page.content()).not.toMatch(/fake-[0-9a-f]{40}|sealed/i);
  await evidence(page, info, "t48-seller-shipping");
  restoreDefaults(a, b);
});

test("an owner without a provisioned partner account is shown the shared account for now, and nothing about keys", async ({ page }) => {
  await login(page, "owner-b@bukalaris.local");
  await page.goto("/seller/shipping");
  await expect(page.getByTestId("shipping-account")).toBeVisible();
  await expect(page.getByTestId("shipping-account")).not.toContainText(/mengantar|sealed/i);
});

test("a staff member can read the shipping account but not manage the pickup", async ({ page }) => {
  await login(page, "staff-a@bukalaris.local");
  await page.goto("/seller/shipping");
  await expect(page.getByTestId("shipping-account")).toBeVisible();
  await expect(page.getByLabel("Alamat lengkap pickup")).toHaveCount(0);
});
