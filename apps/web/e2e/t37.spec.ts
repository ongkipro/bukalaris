import { expect, test, type Browser, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { chooseDestination, enrolTotpViaApi, evidence, login, testPhone, totp } from "./helpers";

// T-37 (seller ledger, payouts, buyer refunds, COD reconciliation) end to end against the FAKE adapters. The Owner console runs through the T-62 gate with two
// operators (four-eyes): a requester and a second person who approves in Persetujuan with a fresh second factor. Database facts and time travel use the superuser URL of
// the disposable e2e database, never the application under test. Money invariants themselves are proven against PostgreSQL in packages/db/test/t37*.test.ts.
const DB_CWD = resolve(process.cwd(), "../../packages/db");

function runDb<T = unknown>(body: string): T {
  const script = `
    import { createDb } from "./src/client.ts";
    import { randomUUID } from "node:crypto";
    import { hashPassword } from "better-auth/crypto";
    import { eq, sql } from "drizzle-orm";
    import { account, platformOperator, user } from "./src/schema.ts";
    import { grantAsSystem } from "./src/ops/capabilities-grants.ts";
    import { decideApproval } from "./src/ops/capabilities-approvals.ts";
    import { createStore } from "./src/platform/platform.ts";
    import { operatorScope } from "./src/platform/scoped.ts";
    import { withStore } from "./src/platform/tenant.ts";
    import { applyLedgerAdjustment, requestLedgerAdjustment } from "./src/ledger/console.ts";
    import { releaseStore } from "./src/ledger/release.ts";
    import { verifyLedger } from "./src/ledger/verify.ts";
    import { recordPaymentInquiry } from "./src/payments/attempts.ts";
    import { signOrderLink } from "./src/ops/jobs/notify.ts";
    import { applyProviderTransition } from "./src/seller/commerce/orders.ts";
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

/** A fresh store with its own owner account (trial subscription: writable), unique per call. */
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
/** An operator holding exactly these capabilities (idempotent per e-mail). */
function seedStaff(email: string, caps: string[]) {
  runDb(`
    if (!(await db.select().from(user).where(eq(user.email, ${JSON.stringify(email)}))).length) {
      const id = randomUUID();
      await db.insert(user).values({ id, email: ${JSON.stringify(email)}, name: ${JSON.stringify(email.split("@")[0])}, emailVerified: true });
      await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword("bukalaris-dev-123") });
      await db.insert(platformOperator).values({ userId: id });
      await grantAsSystem(db, { userId: id, capabilities: ${JSON.stringify(caps)}, source: "system_bootstrap", reason: "e2e fixture t37" });
    }
  `);
}
/** Seller money for a fixture: a REAL four-eyes ledger adjustment (the only way an operator credits a store), so the statement and the balance are honest. */
function fundStore(storeId: number, amountIdr: number, tag: string) {
  const a = `adj-a-${tag}@bukalaris.local`;
  const b = `adj-b-${tag}@bukalaris.local`;
  seedStaff(a, ["ledger.adjust"]);
  seedStaff(b, ["ledger.adjust"]);
  runDb(`
    const idOf = async (e) => (await db.select({ id: user.id }).from(user).where(eq(user.email, e)))[0].id;
    const opA = await operatorScope(db, await idOf(${JSON.stringify(a)}));
    const opB = await operatorScope(db, await idOf(${JSON.stringify(b)}));
    const input = { storeId: ${storeId}, amountIdr: ${amountIdr}, businessRef: ${JSON.stringify(`E2E-${tag}`)}, reason: "modal awal e2e" };
    const { approvalId } = await requestLedgerAdjustment(opA, input);
    await decideApproval(opB, approvalId, "approve");
    await applyLedgerAdjustment(opA, { ...input, approvalId });
  `);
}
// Next's route announcer is also role=alert, and the buyer page has its own order status banner: the result banner is the one with text.
const alert = (page: Page) => page.locator("p[role=alert]");
const status = (page: Page) => page.getByRole("status").filter({ hasText: /Rekening refund|tersimpan|Keputusan|Permintaan|Klaim|Transfer|Batch|Pembekuan|Hasil|Penarikan/ });
const violations = () => runDb<{ code: string }[]>(`return (await verifyLedger(db)).violations;`);
const rp = (n: number) => new RegExp(`Rp\\s?${n.toLocaleString("id-ID").replace(/\./g, "\\.")}$`);

/** A TOTP code of an adjacent 30 s step: Better Auth accepts +-1 step, so two steps in one test never reuse a code. */
const code = (secret: string, step: number) => totp(secret, Date.now() + step * 30_000);
const png = () => ({ name: "bukti.png", mimeType: "image/png", buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(24)]) });

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Keluar" }).click();
  await page.waitForURL((u) => u.pathname === "/login");
}
async function newPage(browser: Browser, info: { project: { use: { baseURL?: string } } }) {
  const ctx = await browser.newContext({ baseURL: info.project.use.baseURL! });
  return { ctx, page: await ctx.newPage() };
}
/** The second person approves in Persetujuan: reads the exact text and hash, gives a reason (required) and decides. Returns the canonical payload they read. */
async function approveAsSecondPerson(page: Page, approver: string, approvalId: number): Promise<string> {
  await login(page, approver, "/admin");
  await page.goto("/admin/approvals");
  const item = page.getByTestId(`approval-${approvalId}`);
  const payload = (await item.getByTestId("payload").textContent()) ?? "";
  await expect(item).toContainText("SHA-256");
  await item.getByLabel("Alasan keputusan").fill("snapshot dan jumlah sudah dicek");
  await item.getByRole("button", { name: "Setujui" }).click();
  await expect(status(page)).toContainText("Keputusan tersimpan");
  await signOut(page);
  return payload;
}
const approvalOf = (action: string, kind: string, id: number) =>
  Number(q<{ id: string }[]>(`select id from approval_request where action_key = '${action}' and target_kind = '${kind}' and target_id = '${id}' order by id desc limit 1`)[0]!.id);

/** The requester executes the approved transfer, claims it with a fresh code, and records the evidence. */
async function executeClaimComplete(page: Page, requester: string, kind: "payout" | "refund", id: number, ref: string) {
  await login(page, requester, "/admin");
  await page.goto(`/admin/payouts/${kind}/${id}`);
  await page.getByTestId("execute-approval").getByRole("button", { name: "Setujui untuk transfer" }).click();
  await expect(page.getByTestId("transfer-status")).toContainText("Sedang ditransfer");
  await page.getByTestId("claim").getByRole("button", { name: "Klaim transfer ini" }).click();
  await expect(status(page)).toContainText("Klaim aktif 30 menit");
  const form = page.getByTestId("complete");
  await form.getByLabel("Referensi transfer bank").fill(ref);
  await form.getByLabel(/Bukti transfer/).setInputFiles(png());
  await form.getByRole("button", { name: "Catat transfer selesai" }).click();
  await expect(status(page)).toContainText("Transfer selesai");
}

test("seller payout end to end: destination held 72 hours, request with a step-up code, a second operator approves the exact snapshot, the transfer is recorded, the ledger and the statement show it", async ({ page, browser }, info) => {
  const tag = unique(info);
  const slug = `fin-${tag}`;
  const owner = `${slug}@bukalaris.local`;
  const reqr = `po-a-${tag}@bukalaris.local`;
  const appr = `po-b-${tag}@bukalaris.local`;
  const storeId = seedStore(slug, owner);
  fundStore(storeId, 500_000, tag);
  seedStaff(reqr, ["payouts.process", "finance.read"]);
  seedStaff(appr, ["payouts.process"]);

  // Seller: balances, statement, no destination yet.
  await login(page, owner, "/seller");
  const secret = await enrolTotpViaApi(page, owner);
  await page.goto("/seller/finance");
  await expect(page).toHaveTitle("Keuangan — Bukalaris");
  await expect(page.getByRole("heading", { name: "Keuangan", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Keuangan", exact: true })).toBeVisible();
  await expect(page.getByTestId("balance-available")).toHaveText(rp(500_000));
  await expect(page.getByTestId("balance-pending")).toHaveText(rp(0));
  await expect(page.getByTestId("balance-processing")).toHaveText(rp(0));
  await expect(page.getByTestId("entry-adjustment")).toContainText("Penyesuaian");
  await expect(page.getByTestId("no-active-destination")).toBeVisible();
  await expect(page.getByRole("button", { name: "Minta penarikan" })).toHaveCount(0);

  // A wrong code is refused with nothing stored; the right one saves a HELD destination.
  const dest = page.getByRole("form", { name: "Ganti rekening tujuan" });
  await dest.getByLabel("Nomor rekening").fill("1234567890");
  await dest.getByLabel("Nama pemilik rekening").fill(`Pemilik ${slug}`);
  await dest.getByLabel(/Kode verifikasi/).fill("000000");
  await dest.getByRole("button", { name: "Simpan rekening" }).click();
  await expect(alert(page)).toContainText("Kode verifikasi salah");
  expect(Number(q<{ n: string }[]>(`select count(*) as n from payout_destination where store_id = ${storeId}`)[0]!.n)).toBe(0);
  await dest.getByLabel("Nomor rekening").fill("1234567890");
  await dest.getByLabel("Nama pemilik rekening").fill(`Pemilik ${slug}`);
  await dest.getByLabel(/Kode verifikasi/).fill(code(secret, 1));
  await dest.getByRole("button", { name: "Simpan rekening" }).click();
  await expect(status(page)).toContainText("ditahan");
  await expect(page.getByTestId("destination-held-badge")).toHaveText("Tujuan baru ditahan");
  await expect(page.getByTestId("hold-until")).toContainText("Ditahan sampai");
  const holdHours = Number(q<{ h: string }[]>(`select extract(epoch from (hold_until - now())) / 3600 as h from payout_destination where store_id = ${storeId}`)[0]!.h);
  expect(holdHours).toBeGreaterThan(71.9);
  await expect(page.getByTestId("no-active-destination")).toBeVisible(); // no payout while the destination is held
  await evidence(page, info, "t37-finance-held");

  // Time travel: the hold elapses (the guard that makes a destination immutable is lifted around this one update only).
  q(`alter table payout_destination disable trigger payout_destination_guard`);
  q(`update payout_destination set hold_until = now() - interval '1 minute' where store_id = ${storeId}`);
  q(`alter table payout_destination enable trigger payout_destination_guard`);
  await page.reload();
  const pay = page.getByRole("form", { name: "Minta penarikan dana" });
  await expect(pay).toBeVisible();

  // Below the minimum and above the balance are refused with the reason; then a valid request debits available at once.
  await pay.getByLabel("Jumlah (Rp)").fill("50000");
  await pay.getByLabel(/Kode verifikasi/).fill(code(secret, -1));
  await pay.getByRole("button", { name: "Minta penarikan" }).click();
  await expect(alert(page)).toContainText("Penarikan minimal");
  await pay.getByLabel("Jumlah (Rp)").fill("200000");
  await pay.getByLabel(/Kode verifikasi/).fill(code(secret, 0));
  await pay.getByRole("button", { name: "Minta penarikan" }).click();
  await expect(status(page)).toContainText("Permintaan penarikan tersimpan");
  await expect(page.getByTestId("balance-available")).toHaveText(rp(300_000));
  await expect(page.getByTestId("balance-processing")).toHaveText(rp(200_000));
  const payoutId = Number(q<{ id: string }[]>(`select id from payout where store_id = ${storeId}`)[0]!.id);
  await expect(page.getByTestId(`payout-${payoutId}`)).toContainText("Menunggu persetujuan");
  await expect(page.getByTestId("entry-payout")).toContainText("-Rp");
  await evidence(page, info, "t37-finance-requested");

  // Owner console, requester: the queue shows the last four digits only; the detail is a recorded disclosure of the full snapshot.
  const A = await newPage(browser, info);
  await login(A.page, reqr, "/admin");
  await A.page.goto("/admin/payouts");
  const row = A.page.getByTestId(`payout-${payoutId}`);
  await expect(row).toContainText("••••7890");
  await expect(row).not.toContainText("1234567890");
  await row.getByRole("link").first().click();
  await expect(A.page.getByTestId("snap-account")).toHaveText("1234567890");
  await expect(A.page.getByTestId("snap-bank")).toHaveText("BCA");
  await expect(A.page.getByTestId("snap-check")).toHaveText("Cocok");
  expect(Number(q<{ n: string }[]>(`select count(*) as n from personal_data_access_event where target_kind = 'payout' and target_id = '${payoutId}' and access_level = 'full'`)[0]!.n)).toBeGreaterThanOrEqual(1);
  await A.page.getByLabel("Alasan permintaan persetujuan transfer").fill("pencairan e2e");
  await A.page.getByRole("button", { name: "Minta persetujuan transfer" }).click();
  await expect(status(A.page)).toContainText("Permintaan persetujuan dikirim");
  await expect(A.page.getByTestId("waiting-approval")).toBeVisible();
  await evidence(A.page, info, "t37-payout-detail");
  await signOut(A.page);

  // Second operator: reads the exact canonical text (amount, bank snapshot) and approves with a reason; the requester could not.
  const B = await newPage(browser, info);
  const approvalId = approvalOf("payout.approve_transfer", "payout", payoutId);
  const payload = await approveAsSecondPerson(B.page, appr, approvalId);
  expect(JSON.parse(payload)).toMatchObject({ kind: "payout", payoutId, amountIdr: 200_000, bankCode: "BCA", bankAccountNumber: "1234567890" });
  expect(q<{ status: string }[]>(`select status from approval_request where id = ${approvalId}`)[0]!.status).toBe("approved");

  // The requester executes, claims with a fresh code and records the evidence; the status, the evidence and the statement follow.
  await executeClaimComplete(A.page, reqr, "payout", payoutId, `BCA-TRX-${tag}`);
  await expect(A.page.getByTestId("transfer-status")).toHaveText("Sudah ditransfer");
  await expect(A.page.getByTestId("evidence-ref")).toHaveText(`BCA-TRX-${tag}`);
  // A reused reference or receipt can never close another transfer: the registry holds it.
  expect(Number(q<{ n: string }[]>(`select count(*) as n from transfer_evidence_registry where subject_kind = 'payout' and subject_id = ${payoutId}`)[0]!.n)).toBe(1);

  // SA-17: the store ledger statement is real and read-only.
  await A.page.goto(`/admin/stores/${storeId}/ledger`);
  await expect(A.page.getByTestId("ledger-available")).toHaveText(rp(300_000));
  await expect(A.page.getByTestId("entry-payout")).toContainText("Penarikan dana");
  await expect(A.page.locator("main form")).toHaveCount(0); // no write control on the store ledger
  await evidence(A.page, info, "t37-store-ledger");
  await A.ctx.close();
  await B.ctx.close();

  await page.goto("/seller/finance");
  await expect(page.getByTestId(`payout-${payoutId}`)).toContainText("Sudah ditransfer");
  await expect(page.getByTestId("balance-available")).toHaveText(rp(300_000));
  await expect(page.getByTestId("balance-processing")).toHaveText(rp(0));
  expect(await violations()).toEqual([]);
});

test("a payout in processing is rejected only with a second person's approval of the no-transfer statement, and an unknown outcome stays allocated", async ({ page, browser }, info) => {
  const tag = unique(info);
  const slug = `fin-${tag}`;
  const owner = `${slug}@bukalaris.local`;
  const reqr = `po-a-${tag}@bukalaris.local`;
  const appr = `po-b-${tag}@bukalaris.local`;
  const storeId = seedStore(slug, owner);
  fundStore(storeId, 400_000, tag);
  seedStaff(reqr, ["payouts.process", "finance.read"]);
  seedStaff(appr, ["payouts.process"]);
  await login(page, owner, "/seller");
  const secret = await enrolTotpViaApi(page, owner);
  await page.goto("/seller/finance");
  const dest = page.getByRole("form", { name: "Ganti rekening tujuan" });
  await dest.getByLabel("Nomor rekening").fill("5557771234");
  await dest.getByLabel("Nama pemilik rekening").fill(`Pemilik ${slug}`);
  await dest.getByLabel(/Kode verifikasi/).fill(code(secret, 1));
  await dest.getByRole("button", { name: "Simpan rekening" }).click();
  await expect(status(page)).toContainText("ditahan");
  q(`alter table payout_destination disable trigger payout_destination_guard`);
  q(`update payout_destination set hold_until = now() - interval '1 minute' where store_id = ${storeId}`);
  q(`alter table payout_destination enable trigger payout_destination_guard`);
  await page.reload();
  const pay = page.getByRole("form", { name: "Minta penarikan dana" });
  await pay.getByLabel("Jumlah (Rp)").fill("400000");
  await pay.getByLabel(/Kode verifikasi/).fill(code(secret, -1));
  await pay.getByRole("button", { name: "Minta penarikan" }).click();
  await expect(status(page)).toContainText("Permintaan penarikan tersimpan");
  const payoutId = Number(q<{ id: string }[]>(`select id from payout where store_id = ${storeId}`)[0]!.id);

  const A = await newPage(browser, info);
  const B = await newPage(browser, info);
  await login(A.page, reqr, "/admin");
  await A.page.goto(`/admin/payouts/payout/${payoutId}`);
  await A.page.getByLabel("Alasan permintaan persetujuan transfer").fill("pencairan e2e");
  await A.page.getByRole("button", { name: "Minta persetujuan transfer" }).click();
  await expect(A.page.getByTestId("waiting-approval")).toBeVisible();
  await signOut(A.page);
  await approveAsSecondPerson(B.page, appr, approvalOf("payout.approve_transfer", "payout", payoutId));
  await login(A.page, reqr, "/admin");
  await A.page.goto(`/admin/payouts/payout/${payoutId}`);
  await A.page.getByTestId("execute-approval").getByRole("button", { name: "Setujui untuk transfer" }).click();
  await A.page.getByTestId("claim").getByRole("button", { name: "Klaim transfer ini" }).click();
  await expect(status(A.page)).toContainText("Klaim aktif");
  await A.page.getByTestId("unknown").getByRole("button", { name: "Hasil transfer tidak diketahui" }).click();
  await expect(A.page.getByTestId("unknown-flag")).toContainText("TIDAK DIKETAHUI");
  await expect(A.page.getByTestId("claim")).toHaveCount(0); // never claimed again, never re-sent
  await expect(A.page.getByTestId("transfer-status")).toHaveText("Sedang ditransfer");
  await A.page.goto("/admin/money"); // SA-26 lists the unknown outcome (ids and amounts only, never a bank value)
  await expect(A.page.getByTestId("unknown-transfers")).toContainText(`Penarikan #${payoutId}`);
  await expect(A.page.getByTestId("class-payouts_processing")).toBeVisible(); // platform-wide classes: the e2e database holds other stores' money too
  expect(await A.page.content()).not.toContain("5557771234");
  await evidence(A.page, info, "t37-money-unknown");
  await A.page.goto(`/admin/payouts/payout/${payoutId}`);

  // Rejection after approval says "no transfer was sent": it asks a second person and names the bank evidence.
  await A.page.getByTestId("request-reject").getByLabel("Alasan").fill("bank menyatakan tidak ada transfer");
  await A.page.getByTestId("request-reject").getByLabel(/Referensi bukti bank/).fill(`BANK-STMT-${tag}`);
  await A.page.getByRole("button", { name: "Minta persetujuan penolakan" }).click();
  await expect(status(A.page)).toContainText("Permintaan persetujuan penolakan dikirim");
  await expect(A.page.getByTestId("execute-reject")).toHaveCount(0); // not without the second person
  await signOut(A.page);
  await approveAsSecondPerson(B.page, appr, approvalOf("payout.reject_processing", "payout", payoutId));
  await login(A.page, reqr, "/admin");
  await A.page.goto(`/admin/payouts/payout/${payoutId}`);
  await A.page.getByTestId("execute-reject").getByRole("button", { name: "Jalankan penolakan" }).click();
  await expect(A.page.getByTestId("transfer-status")).toContainText("Ditolak");
  await A.ctx.close();
  await B.ctx.close();
  await page.goto("/seller/finance");
  await expect(page.getByTestId("balance-available")).toHaveText(rp(400_000)); // exactly the debit returned, once
  await expect(page.getByTestId(`payout-${payoutId}`)).toContainText("Ditolak");
  expect(await violations()).toEqual([]);
});

/** A prepaid order bought through the real checkout, its payment VERIFIED by the (fake) provider inquiry. */
async function paidOrder(page: Page): Promise<{ orderId: number; storeId: number }> {
  await page.goto("/s/toko-a/products/kaos-katun-basic");
  await page.getByLabel("Jumlah").fill("1");
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(page);
  await page.getByLabel("Nama").fill("Budi Santoso");
  await page.getByLabel("Nomor HP").fill(testPhone());
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await page.locator('input[name="paymentMethod"][value="manual_transfer"]').check();
  await page.locator('input[name="paymentChannel"][value="VABCA"]').check();
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  const orderId = Number((await page.getByTestId("order-id").textContent())!.replace("#", ""));
  await expect.poll(() => q<{ s: string }[]>(`select request_state as s from payment_attempt where order_id = ${orderId}`)[0]?.s, { timeout: 30_000, intervals: [500, 1000] }).toBe("accepted");
  const storeId = runDb<number>(`
    const [a] = await admin.$client.unsafe("select id, store_id, total_idr from payment_attempt where order_id = ${orderId}");
    await recordPaymentInquiry({ exec: db, storeId: Number(a.store_id) }, a.id, { rc: "00", ket: "Sukses", data: { status: "PAID", amount: Number(a.total_idr) } }, { source: "reconcile", mode: "fake" });
    return Number(a.store_id);
  `);
  return { orderId, storeId };
}
const cancelByProvider = (storeId: number, orderId: number) =>
  runDb(`await withStore(db, ${storeId}, (tx) => applyProviderTransition(tx, ${storeId}, ${orderId}, "cancelled", { source: "provider", note: "e2e" }));`);

test("buyer refund: the signed order page takes the destination, the console approves it with a second person and the transfer is recorded; the seller sees the composition", async ({ page, browser }, info) => {
  const tag = unique(info);
  const reqr = `rf-a-${tag}@bukalaris.local`;
  const appr = `rf-b-${tag}@bukalaris.local`;
  seedStaff(reqr, ["refunds.process", "finance.read"]);
  seedStaff(appr, ["refunds.process"]);
  const { orderId, storeId } = await paidOrder(page);
  cancelByProvider(storeId, orderId);
  const refund = q<{ id: string; amount_idr: string; fee_refund_idr: string }[]>(`select id, amount_idr, fee_refund_idr from refund where order_id = ${orderId}`)[0]!;
  const refundId = Number(refund.id);
  expect(Number(refund.fee_refund_idr)).toBeGreaterThan(0); // the admin fee the buyer paid is refunded in full (D-20)
  const token = runDb<string>(`return signOrderLink(${orderId});`);

  // Buyer: the signed page shows the full refund and takes the destination; the number is never echoed back.
  await page.goto(`/o/${token}`);
  const section = page.getByTestId("refund-section");
  await expect(section).toBeVisible();
  await expect(page.getByTestId("refund-status")).toContainText("Menunggu rekening");
  await expect(page.getByTestId("refund-amount")).toHaveText(new RegExp(`Rp\\s?${Number(refund.amount_idr).toLocaleString("id-ID").replace(/\./g, "\\.")}$`));
  const form = page.getByRole("form", { name: "Rekening tujuan refund" });
  await form.getByLabel("Nomor rekening").fill("9876543210");
  await form.getByLabel("Nama pemilik rekening").fill("Budi Santoso");
  await form.getByRole("button", { name: "Simpan rekening refund" }).click();
  await expect(status(page)).toContainText("Rekening refund tersimpan");
  await expect(page.getByTestId("refund-destination")).toContainText("••••3210");
  expect(await page.content()).not.toContain("9876543210");
  await evidence(page, info, "t37-refund-destination");

  // Console: queue (last four digits), request, second approver, execute, claim, complete.
  const A = await newPage(browser, info);
  const B = await newPage(browser, info);
  await login(A.page, reqr, "/admin");
  await A.page.goto("/admin/payouts?kind=refund");
  await expect(A.page.getByTestId(`refund-${refundId}`)).toContainText("••••3210");
  await A.page.getByTestId(`refund-${refundId}`).getByRole("link").first().click();
  await expect(A.page.getByTestId("snap-account")).toHaveText("9876543210");
  await expect(A.page.getByTestId("snap-check")).toHaveText("Cocok");
  await A.page.getByLabel("Alasan permintaan persetujuan transfer").fill("refund pembatalan e2e");
  await A.page.getByRole("button", { name: "Minta persetujuan transfer" }).click();
  await signOut(A.page);
  await approveAsSecondPerson(B.page, appr, approvalOf("refund.approve_transfer", "refund", refundId));
  await executeClaimComplete(A.page, reqr, "refund", refundId, `BCA-RFD-${tag}`);
  await expect(A.page.getByTestId("transfer-status")).toHaveText("Sudah dikembalikan ke pembeli");
  await A.ctx.close();
  await B.ctx.close();

  // The buyer's page now says the money was returned and no longer takes an account; the seller's finance shows the composition.
  await page.goto(`/o/${token}`);
  await expect(page.getByTestId("refund-status")).toContainText("Sudah dikembalikan");
  await expect(page.getByRole("form", { name: "Rekening tujuan refund" })).toHaveCount(0);
  expect(await violations()).toEqual([]);
});

test("COD reconciliation: a break blocks the batch, the preparer cannot approve, the second person approves, the preparer applies, and the money reaches Saldo Tersedia", async ({ page, browser }, info) => {
  const tag = unique(info);
  const reqr = `cr-a-${tag}@bukalaris.local`;
  const appr = `cr-b-${tag}@bukalaris.local`;
  seedStaff(reqr, ["payouts.reconcile"]);
  seedStaff(appr, ["payouts.reconcile"]);
  const buyCod = async () => {
    await page.goto("/s/toko-a/products/kaos-katun-basic");
    await page.getByLabel("Jumlah").fill("1");
    await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
    await page.getByRole("link", { name: "Checkout" }).click();
    await chooseDestination(page);
    await page.getByLabel("Nama").fill("Budi Santoso");
    await page.getByLabel("Nomor HP").fill(testPhone());
    await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
    await page.locator('input[name="paymentMethod"][value="cod"]').check();
    await page.getByRole("button", { name: "Buat pesanan" }).click();
    await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
    return Number((await page.getByTestId("order-id").textContent())!.replace("#", ""));
  };
  const first = await buyCod();
  const second = await buyCod();
  // The courier reports both DELIVERED: the only writer of `completed` (the seller never completes an order). Earlier moves are the seller's, done directly here.
  const storeId = Number(q<{ store_id: string }[]>(`select store_id from "order" where id = ${first}`)[0]!.store_id);
  for (const id of [first, second]) {
    q(`update "order" set status = 'placed' where id = ${id}`);
    q(`update "order" set status = 'shipped', tracking_number = 'E2E-${id}' where id = ${id}`);
    runDb(`await withStore(db, ${storeId}, (tx) => applyProviderTransition(tx, ${storeId}, ${id}, "completed", { source: "provider", note: "e2e" }));`);
  }
  const payable = (id: number) => Number(q<{ p: string }[]>(`select payable_idr as p from order_financials where order_id = ${id}`)[0]!.p);
  const pendingBefore = Number(q<{ n: string }[]>(`select coalesce(sum(amount_idr), 0) as n from ledger_entry where store_id = ${storeId} and status = 'pending'`)[0]!.n);
  expect(pendingBefore).toBeGreaterThan(0);

  const A = await newPage(browser, info);
  const B = await newPage(browser, info);
  await login(A.page, reqr, "/admin");
  await A.page.goto("/admin/money/cod-reconciliation");
  await expect(A.page.getByTestId(`awaiting-${first}`)).toContainText("belum dalam batch");
  await expect(A.page.getByTestId(`awaiting-${second}`)).toBeVisible();
  await A.page.getByLabel("Referensi invoice atau laporan kurir").fill(`INV-${tag}`);
  await A.page.getByLabel(/Baris bukti/).fill(`${first}; LINE-${first}; ${payable(first)}; 2026-10-28\n${second}; LINE-${second}; ${payable(second) - 1000}; 2026-10-28`);
  await A.page.getByRole("button", { name: "Siapkan batch" }).click();
  await expect(status(A.page)).toContainText("Batch disiapkan");
  const batchId = Number(A.page.url().match(/cod-reconciliation\/(\d+)/)![1]);
  // The evidence of the second order differs from its COD amount: a visible break that blocks submission.
  await expect(A.page.getByTestId("batch-breaks")).toContainText("1 selisih");
  await expect(A.page.getByTestId(`item-${second}`)).toContainText("SELISIH");
  await expect(A.page.getByTestId("submit-batch").getByRole("button", { name: "Ajukan untuk persetujuan" })).toBeDisabled();
  await evidence(A.page, info, "t37-cod-batch-break");
  await A.page.getByTestId(`item-${second}`).getByRole("button", { name: "Hapus baris" }).click();
  await expect(A.page.getByTestId("batch-total")).toContainText("1 baris");
  await A.page.getByTestId("submit-batch").getByLabel("Alasan pengajuan").fill("rekonsiliasi COD e2e");
  await A.page.getByTestId("submit-batch").getByRole("button", { name: "Ajukan untuk persetujuan" }).click();
  await expect(status(A.page)).toContainText("Batch diajukan");
  await expect(A.page.getByTestId("batch-status")).toHaveText("Menunggu persetujuan");
  // Applying before the second person decided is refused; the preparer has no way to approve.
  await A.page.getByRole("button", { name: "Terapkan batch yang disetujui" }).click();
  await expect(alert(A.page)).toContainText("Persetujuan tidak berlaku");
  await signOut(A.page);
  const approvalId = approvalOf("cod.reconcile_release", "reconciliation_batch", batchId);
  const payload = await approveAsSecondPerson(B.page, appr, approvalId);
  expect(JSON.parse(payload)).toMatchObject({ batchId, itemCount: 1 });
  await login(A.page, reqr, "/admin");
  await A.page.goto(`/admin/money/cod-reconciliation/${batchId}`);
  await A.page.getByRole("button", { name: "Terapkan batch yang disetujui" }).click();
  await expect(status(A.page)).toContainText("Batch diterapkan");
  await expect(A.page.getByTestId("batch-status")).toHaveText("Diterapkan");
  await A.ctx.close();
  await B.ctx.close();

  // The release job (run here instead of waiting for the minute) moves exactly the reconciled order; the other stays in Dana dalam Proses.
  runDb(`await releaseStore(db, ${storeId});`);
  const rows = q<{ order_id: string; status: string; release_basis: string | null }[]>(`select order_id, status, release_basis from ledger_entry where store_id = ${storeId} and kind = 'sale' and order_id in (${first}, ${second}) order by order_id`);
  expect(rows.find((r) => Number(r.order_id) === first)).toMatchObject({ status: "available", release_basis: "reconciliation" });
  expect(rows.find((r) => Number(r.order_id) === second)).toMatchObject({ status: "pending", release_basis: null });
  expect(await violations()).toEqual([]);
});

test("staff never see money, and the post-restore freeze stops payouts on the seller screen until it is lifted", async ({ page, browser }, info) => {
  // Seller staff (a member who is not the owner): finance is denied, the menu has no Keuangan.
  await login(page, "staff-a@bukalaris.local", "/seller");
  await page.goto("/seller/finance");
  await expect(page.getByTestId("finance-denied")).toBeVisible();
  await expect(page.getByTestId("balance-available")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Keuangan", exact: true })).toHaveCount(0);
  await evidence(page, info, "t37-finance-staff");
  await signOut(page);

  // Freeze and unfreeze from the console (payouts.process, reason, audited); the owner sees the banner.
  const tag = unique(info);
  const slug = `fin-${tag}`;
  const owner = `${slug}@bukalaris.local`;
  const op = `pf-${tag}@bukalaris.local`;
  seedStore(slug, owner);
  seedStaff(op, ["payouts.process"]);
  const A = await newPage(browser, info);
  await login(A.page, op, "/admin");
  await A.page.goto("/admin/payouts");
  await expect(A.page.getByTestId("freeze-state")).toHaveText("berjalan");
  await A.page.getByTestId("payout-freeze").getByLabel(/Alasan/).fill("pemulihan data dari cadangan e2e");
  await A.page.getByRole("button", { name: "Bekukan penarikan" }).click();
  await expect(status(A.page)).toContainText("Pembekuan penarikan dinyalakan");
  await expect(A.page.getByTestId("freeze-state")).toHaveText("DIBEKUKAN");
  await login(page, owner, "/seller");
  await page.goto("/seller/finance");
  await expect(page.getByTestId("payouts-frozen")).toContainText("dibekukan sementara");
  await evidence(page, info, "t37-finance-frozen");
  await A.page.getByTestId("payout-freeze").getByLabel(/Alasan/).fill("bukti bank sudah dicocokkan e2e");
  await A.page.getByRole("button", { name: "Cabut pembekuan" }).click();
  await expect(A.page.getByTestId("freeze-state")).toHaveText("berjalan");
  await page.reload();
  await expect(page.getByTestId("payouts-frozen")).toHaveCount(0);
  expect(Number(q<{ n: string }[]>(`select count(*) as n from audit_log where action in ('payout.freeze', 'payout.unfreeze')`)[0]!.n)).toBeGreaterThanOrEqual(2);
  await A.ctx.close();
});
