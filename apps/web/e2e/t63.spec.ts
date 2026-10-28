import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { DEV_PASSWORD, evidence, login } from "./helpers";

// T-63 (account governance for stores and seller team accounts). Database facts are read and fixtures are seeded with the superuser /
// platform URLs of the disposable e2e database, never through the application under test. Every account here carries the project
// name, so the desktop and mobile-320 runs never share one.
const DB_CWD = resolve(process.cwd(), "../../packages/db");

function runDb<T = unknown>(body: string): T {
  const script = `
    import { createDb } from "./src/client.ts";
    import { randomUUID } from "node:crypto";
    import { hashPassword } from "better-auth/crypto";
    import { eq, sql } from "drizzle-orm";
    import { account, platformOperator, user } from "./src/schema.ts";
    import { grantAsSystem } from "./src/ops/capabilities-grants.ts";
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

/** An operator with exactly these capabilities (idempotent per e-mail). */
function seedStaff(email: string, caps: string[]) {
  runDb(`
    if (!(await db.select().from(user).where(eq(user.email, ${JSON.stringify(email)}))).length) {
      const id = randomUUID();
      await db.insert(user).values({ id, email: ${JSON.stringify(email)}, name: ${JSON.stringify(email.split("@")[0])}, emailVerified: true });
      await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword(${JSON.stringify(DEV_PASSWORD)}) });
      await db.insert(platformOperator).values({ userId: id });
      await grantAsSystem(db, { userId: id, capabilities: ${JSON.stringify(caps)}, source: "system_bootstrap", reason: "e2e fixture t63" });
    }
  `);
}
/** A seller team member (staff role in the seeded store toko-a) with a verified e-mail. Returns the internal id. */
function seedSeller(email: string, name = "Siti Rahayu") {
  return runDb<string>(`
    const found = await db.select().from(user).where(eq(user.email, ${JSON.stringify(email)}));
    if (found.length) return found[0].id;
    const id = randomUUID();
    await db.insert(user).values({ id, email: ${JSON.stringify(email)}, name: ${JSON.stringify(name)}, emailVerified: true });
    await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword(${JSON.stringify(DEV_PASSWORD)}) });
    await admin.$client.unsafe("insert into membership (store_id, user_id, role) select id, '" + id + "', 'staff' from store where slug = 'toko-a'");
    return id;
  `);
}

const SUPPORT = ["dashboard.read", "accounts.read", "accounts.support", "accounts.suspend", "accounts.reveal", "cases.read", "cases.write", "tenants.read", "tenants.manage", "tenants.verify", "audit.read"];
const tag = (info: { project: { name: string } }) => info.project.name.replace(/[^a-z0-9]/g, "");
const menu = (page: Page) => page.getByRole("navigation", { name: "Owner console" });

test("search: e-mail in any case or spacing and the internal id reach the same masked record, by keyboard, without overflow", async ({ page }, info) => {
  const staff = `support-${tag(info)}-t63@bukalaris.local`;
  const target = `siti-${tag(info)}-t63@bukalaris.local`;
  seedStaff(staff, SUPPORT);
  const userId = seedSeller(target);
  await login(page, staff, "/admin");
  await expect(menu(page).getByRole("link", { name: "Akun pengguna", exact: true })).toBeVisible();
  await page.goto("/admin/accounts");
  await expect(page.getByRole("heading", { name: "Cari akun", level: 1 })).toBeVisible();
  // Keyboard only: focus the field, type, Enter.
  const field = page.getByLabel("Email, nomor ponsel atau ID akun");
  const masked = `s***@b***.local`;
  const searches = () => Number(q<{ n: string }[]>(`select count(*) as n from audit_log where action = 'account.search' and outcome = 'allowed'`)[0]!.n);
  let done = searches();
  for (const variant of [target, target.toUpperCase(), `  ${target.slice(0, 5)} ${target.slice(5)} `, userId]) {
    await field.focus();
    await field.fill(variant);
    await page.keyboard.press("Enter");
    await expect.poll(searches, { timeout: 20_000 }).toBe(done + 1); // this variant really ran (not a stale result on screen)
    done += 1;
    const hit = page.getByTestId("hit");
    await expect(hit).toHaveCount(1, { timeout: 20_000 });
    await expect(hit).toContainText(masked);
    await expect(hit).toContainText("S*** R***");
    await expect(page.getByRole("link", { name: "Buka rekam" })).toHaveAttribute("href", `/admin/accounts/seller/${userId}`);
    expect(page.url()).not.toContain("q="); // a POST: the query is in no URL
    expect(page.url()).not.toContain(target.split("@")[0]!);
    expect(await page.content()).not.toContain("Rahayu");
    expect(await page.content()).not.toContain(target);
    await field.fill(""); // the next variant starts from an empty box
  }
  await expect(page.getByTestId("buyer-note")).toContainText("butuh kasus terbuka dan tujuan");
  await evidence(page, info, "t63-01-search");
  // The raw query is never written anywhere: not the log, not the audit rows.
  const audit = q<{ action: string; reason: string | null; subject_id: string | null }[]>(`select action, reason, subject_id from audit_log where action = 'account.search'`);
  expect(audit.length).toBeGreaterThanOrEqual(4);
  expect(JSON.stringify(audit)).not.toContain(target.split("@")[0]);
  // Staff identities never appear.
  await field.fill(staff);
  await page.keyboard.press("Enter");
  await expect(page.getByText("Tidak ada akun yang cocok")).toBeVisible({ timeout: 20_000 });
});

test("detail: open a case, queue a recovery link (nothing shown), redeem it once, revoke sessions and the stale seller tab stops", async ({ page, browser }, info) => {
  test.setTimeout(300_000);
  const staff = `support2-${tag(info)}-t63@bukalaris.local`;
  const target = `rina-${tag(info)}-t63@bukalaris.local`;
  seedStaff(staff, SUPPORT);
  const userId = seedSeller(target, "Rina Wulandari");

  // The seller is signed in on another browser context: this is the "stale tab".
  const sellerCtx = await browser.newContext({ baseURL: info.project.use.baseURL });
  const sellerPage = await sellerCtx.newPage();
  await login(sellerPage, target, "/seller");
  await expect(sellerPage).toHaveURL(/\/seller\/products/);

  await login(page, staff, "/admin");
  await page.goto(`/admin/accounts/seller/${userId}`);
  await expect(page.getByRole("heading", { name: "Akun seller", level: 1 })).toBeVisible();
  await expect(page.getByTestId("sesi")).toHaveText("1");
  await expect(page.getByTestId("email")).toContainText("r***@");
  expect(await page.content()).not.toContain("Wulandari");
  expect(await page.content()).not.toContain(target);
  // Actions are refused without an open case: the field is required and the server refuses a closed or unknown one as well.
  await page.getByRole("button", { name: "Kirim tautan" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/accounts/seller/${userId}$`)); // native validation stopped it

  // Open a case from the page, then the case select appears in every action form.
  await page.getByLabel("Judul kasus").fill("Seller kehilangan akses");
  await page.getByLabel("Alasan", { exact: true }).first().fill("pelapor menghubungi dukungan");
  await page.getByRole("button", { name: "Buka kasus" }).click();
  await expect(page.getByRole("status")).toContainText("Kasus dibuka.");
  await evidence(page, info, "t63-02-detail");

  // Recovery link: the outcome says "queued, delivery not confirmed"; the link is only in the mail.
  const recovery = page.getByRole("region", { name: "Kirim tautan pemulihan" });
  await recovery.getByLabel("Alasan", { exact: true }).fill("seller tidak bisa masuk");
  await recovery.getByRole("button", { name: "Kirim tautan" }).click();
  await expect(page.getByRole("status")).toContainText("diantrekan ke kontak yang tercatat; pengiriman belum dikonfirmasi");
  const html = await page.content();
  expect(html).not.toContain("support-recovery/");
  const [{ text_body: body }] = q<{ text_body: string }[]>(`select text_body from mail_outbox where to_email = '${target}' and one_time_purpose = 'support_recovery' order by id desc limit 1`);
  const link = /https?:\/\/\S+\/account\/support-recovery\/[A-Za-z0-9_-]+/.exec(body)![0];
  const tokenPart = link.split("/").pop()!;
  expect(JSON.stringify(q(`select reason from audit_log`))).not.toContain(tokenPart);

  // The seller redeems the link (the page changes nothing until the button), sets a new password, and the link is dead afterwards.
  const mailPage = await sellerCtx.newPage();
  await mailPage.goto(link);
  await expect(mailPage.getByRole("heading", { name: "Pemulihan akun" })).toBeVisible();
  await mailPage.getByRole("button", { name: "Lanjutkan pemulihan" }).click();
  await mailPage.waitForURL((u) => u.pathname === "/account/recovery/reset" && u.searchParams.has("token"));
  const newPassword = `Sandi-${tag(info)}-${Date.now()}`;
  await mailPage.getByLabel("Kata sandi baru", { exact: true }).fill(newPassword);
  await mailPage.getByLabel("Ulangi kata sandi baru").fill(newPassword);
  await mailPage.getByRole("button", { name: "Simpan kata sandi" }).click();
  await expect(mailPage.getByRole("status")).toContainText("berhasil diubah");
  await mailPage.goto(link);
  await mailPage.getByRole("button", { name: "Lanjutkan pemulihan" }).click();
  await mailPage.waitForURL((u) => u.pathname === "/account/support-recovery/invalid");
  await expect(mailPage.getByRole("main").getByRole("alert")).toContainText("sudah dipakai");
  await mailPage.close();

  // The password reset ended the stale tab's session already (revokeSessionsOnPasswordReset); sign in again, then staff revokes sessions.
  await login(sellerPage, target, "/seller", newPassword);
  await expect(sellerPage).toHaveURL(/\/seller\/products/);
  await page.goto(`/admin/accounts/seller/${userId}`);
  await expect(page.getByTestId("sesi")).toHaveText("1");
  const revoke = page.getByRole("region", { name: "Akhiri semua sesi" });
  await revoke.getByLabel("Alasan", { exact: true }).fill("perangkat hilang");
  page.once("dialog", (d) => d.accept());
  await revoke.getByRole("button", { name: "Akhiri sesi" }).click();
  await expect(page.getByRole("status")).toContainText("1 sesi diakhiri");
  await expect(page.getByTestId("sesi")).toHaveText("0");
  // The stale seller tab cannot read or mutate any more.
  await sellerPage.reload();
  await expect(sellerPage).toHaveURL(/\/login/);
  await sellerCtx.close();
  const audit = q<{ n: string }[]>(`select count(*) as n from audit_log where action in ('support.start_recovery', 'support.revoke_sessions') and case_id is not null`);
  expect(Number(audit[0]!.n)).toBeGreaterThanOrEqual(2);
});

test("suspend: sessions end, sign-in is refused, the history shows one event; restoring lets the account in again", async ({ page, browser }, info) => {
  test.setTimeout(300_000);
  const staff = `support3-${tag(info)}-t63@bukalaris.local`;
  const target = `dewi-${tag(info)}-t63@bukalaris.local`;
  seedStaff(staff, SUPPORT);
  const userId = seedSeller(target, "Dewi Lestari");
  const sellerCtx = await browser.newContext({ baseURL: info.project.use.baseURL });
  const sellerPage = await sellerCtx.newPage();
  await login(sellerPage, target, "/seller");

  await login(page, staff, "/admin");
  await page.goto(`/admin/accounts/seller/${userId}`);
  await page.getByLabel("Judul kasus").fill("Dugaan penyalahgunaan");
  await page.getByLabel("Alasan", { exact: true }).first().fill("laporan pembeli");
  await page.getByRole("button", { name: "Buka kasus" }).click();
  await expect(page.getByRole("status")).toContainText("Kasus dibuka.");
  const box = page.getByRole("region", { name: "Tangguhkan akun" });
  await box.getByLabel("Alasan", { exact: true }).fill("dugaan penyalahgunaan akun");
  page.once("dialog", (d) => d.accept());
  await box.getByRole("button", { name: "Tangguhkan akun" }).click();
  await expect(page.getByRole("status")).toContainText("Akun ditangguhkan dan 1 sesi diakhiri");
  await expect(page.getByText("Ditangguhkan", { exact: true })).toBeVisible();
  await evidence(page, info, "t63-03-suspended");

  // The suspended seller: the old tab is gone and a fresh sign-in gets no session.
  await sellerPage.reload();
  await expect(sellerPage).toHaveURL(/\/login/);
  await sellerPage.getByLabel("Email").fill(target);
  await sellerPage.getByLabel("Kata sandi").fill(DEV_PASSWORD);
  await sellerPage.getByRole("button", { name: "Masuk" }).click();
  await expect(sellerPage.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(sellerPage).toHaveURL(/\/login/);
  expect(Number(q<{ n: string }[]>(`select count(*) as n from session where user_id = '${userId}'`)[0]!.n)).toBe(0);
  expect(q<{ to_status: string }[]>(`select to_status from account_status_event where subject_kind = 'user' and subject_id = '${userId}'`).map((r) => r.to_status)).toEqual(["suspended"]);

  // Restore.
  await page.goto(`/admin/accounts/seller/${userId}`);
  const back = page.getByRole("region", { name: "Pulihkan akun" });
  await back.getByLabel("Alasan", { exact: true }).fill("terbukti keliru");
  await back.getByRole("button", { name: "Pulihkan akun" }).click();
  await expect(page.getByRole("status")).toContainText("Penangguhan akun dicabut");
  await login(sellerPage, target, "/seller");
  await expect(sellerPage).toHaveURL(/\/seller\/products/);
  await sellerCtx.close();
});

test("reveal: needs an open case and a purpose; the value shows inside the window, every read is an access event, the audit log never holds it", async ({ page }, info) => {
  const staff = `support4-${tag(info)}-t63@bukalaris.local`;
  const target = `maya-${tag(info)}-t63@bukalaris.local`;
  seedStaff(staff, SUPPORT);
  const userId = seedSeller(target, "Maya Anggraini");
  await login(page, staff, "/admin");
  await page.goto(`/admin/accounts/seller/${userId}`);
  const reveal = page.getByRole("region", { name: "Ungkap nilai asli" });
  // Without an open case the server refuses (the number is validated against open cases, not only by the pattern).
  await reveal.getByLabel("Nomor kasus terbuka").fill("C-999999");
  await reveal.getByLabel("Alasan", { exact: true }).fill("memastikan alamat seller");
  await reveal.getByRole("button", { name: "Ungkap" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(/kasus/i);
  await expect(page.getByTestId("email")).not.toContainText(target);
  expect(Number(q<{ n: string }[]>(`select count(*) as n from personal_data_access_event where access_level = 'full' and target_id = '${userId}'`)[0]!.n)).toBe(0);

  await page.getByLabel("Judul kasus").fill("Verifikasi alamat");
  await page.getByLabel("Alasan", { exact: true }).first().fill("memastikan alamat seller");
  await page.getByRole("button", { name: "Buka kasus" }).click();
  await expect(page.getByRole("status")).toContainText("Kasus dibuka.");
  const caseNumber = q<{ case_number: string }[]>(`select case_number from support_case where subject_id = '${userId}' order by id desc limit 1`)[0]!.case_number;
  const form = page.getByRole("region", { name: "Ungkap nilai asli" });
  await form.getByLabel("Nomor kasus terbuka").fill(caseNumber);
  await form.getByLabel("Alasan", { exact: true }).fill("memastikan alamat seller");
  await form.getByRole("button", { name: "Ungkap" }).click();
  await expect(page.getByRole("status").first()).toContainText("jendela pengungkapan");
  await expect(page.getByTestId("email")).toContainText(target);
  await evidence(page, info, "t63-04-revealed");
  const events = q<{ purpose_code: string; case_id: string; access_level: string }[]>(`select purpose_code, case_id, access_level from personal_data_access_event where target_id = '${userId}' and access_level = 'full'`);
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events[0]).toMatchObject({ purpose_code: "support_case", case_id: caseNumber });
  expect(JSON.stringify(q(`select reason from audit_log`))).not.toContain(target);
  // The window ends: backdate it (database clock) and the page is masked again.
  q(`alter table personal_data_access_event disable trigger personal_data_access_event_append_only`);
  q(`update personal_data_access_event set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where access_level = 'full' and target_id = '${userId}'`);
  q(`alter table personal_data_access_event enable trigger personal_data_access_event_append_only`);
  await page.reload();
  await expect(page.getByTestId("email")).not.toContainText(target);
  expect(await page.content()).not.toContain(target);
});

test("stores: create and suspend with and without a verification record; history and cases; the record never blocks anything", async ({ page }, info) => {
  test.setTimeout(300_000);
  const staff = `stores-${tag(info)}-t63@bukalaris.local`;
  seedStaff(staff, SUPPORT);
  const owner = `owner-${tag(info)}-t63@bukalaris.local`;
  seedSeller(owner, "Pemilik Uji");
  await login(page, staff, "/admin");
  // Create (the creation by staff is the approval) with no verification record at all.
  const slug = `uji-${tag(info)}-${Date.now().toString(36)}`;
  await page.goto("/admin/stores/new");
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Nama toko").fill("Toko Uji Tata Kelola");
  await page.getByLabel("Email pemilik").fill(owner);
  await page.getByRole("button", { name: /Buat toko|Simpan|Tambah/ }).click();
  await expect(page).toHaveURL(/\/admin\/stores\/\d+\?saved=1/);
  const storeId = page.url().match(/stores\/(\d+)/)![1]!;
  await expect(page.getByText("store_created")).toBeVisible(); // the first history event
  expect(await page.content()).not.toContain(owner); // the team summary is masked
  await page.getByLabel("Judul kasus").fill("Penangguhan uji");
  await page.locator("#case-reason").fill("kasus untuk penangguhan");
  await page.getByRole("button", { name: "Buka kasus" }).click();
  await expect(page.getByRole("status")).toContainText("Kasus dibuka.");
  const caseNumber = q<{ case_number: string }[]>(`select case_number from support_case where subject_kind = 'store' and subject_id = '${storeId}'`)[0]!.case_number;

  // Suspend with reason code and case, then reactivate.
  await page.getByLabel("Kode alasan").selectOption("risk_review");
  await page.getByLabel(/Alasan penangguhan/).fill("tinjauan risiko berjalan");
  await page.getByLabel("Nomor kasus (opsional)").fill(caseNumber);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Tangguhkan toko" }).click();
  await expect(page.getByRole("status")).toContainText("Tersimpan");
  await expect(page.getByText("active → suspended").or(page.getByText("→ suspended").first())).toBeVisible();
  await page.getByLabel(/Alasan pengaktifan kembali/).fill("tinjauan selesai");
  await page.getByRole("button", { name: "Aktifkan kembali" }).click();
  await expect(page.getByRole("status")).toContainText("Tersimpan");
  expect(q<{ to_status: string }[]>(`select to_status from account_status_event where subject_kind = 'store' and subject_id = '${storeId}' order by id`).map((r) => r.to_status)).toEqual(["active", "suspended", "active"]);

  // The optional record: add a version, see it masked, reject it; the store stays open for business.
  await page.goto(`/admin/stores/${storeId}/verification`);
  await expect(page.getByText("Belum ada catatan verifikasi")).toBeVisible();
  await page.getByLabel("Nama (opsional)").fill("Budi Santoso");
  await page.getByLabel("Email kontak (opsional)").fill("budi.santoso@contoh.id");
  await page.getByLabel("Telepon kontak (opsional)").fill("081234567890");
  await page.getByLabel("Alasan", { exact: true }).first().fill("pengajuan atas nama seller");
  await page.getByRole("button", { name: "Simpan versi" }).click();
  await expect(page.getByRole("status")).toContainText("informasional");
  const version = page.getByTestId(/versi-/);
  await expect(version).toContainText("B*** S***");
  await expect(version).toContainText("***7890");
  const verHtml = await page.content();
  for (const leak of ["Budi", "Santoso", "budi.santoso", "081234567890"]) expect(verHtml).not.toContain(leak);
  await evidence(page, info, "t63-05-verification");
  await version.getByLabel(/Alasan keputusan/).fill("bukti belum lengkap");
  await version.getByRole("button", { name: "Tolak" }).click();
  await expect(version).toContainText("Ditolak");
  expect(Number(q<{ n: string }[]>(`select count(*) as n from store where id = ${storeId} and status = 'active'`)[0]!.n)).toBe(1);
  // Risk queue: reachable, honest about sources that do not exist yet.
  await page.goto("/admin/risk");
  await expect(page.getByRole("heading", { name: "Risiko toko", level: 1 })).toBeVisible();
  await expect(page.getByText("belum tersedia (subscription state (T-50))")).toBeVisible();
});

test("denied direct URLs: a staff member with one capability gets the denied state on every other governance page; sellers are denied everywhere", async ({ page }, info) => {
  const email = `cases-only-${tag(info)}-t63@bukalaris.local`;
  seedStaff(email, ["cases.read"]);
  await login(page, email, "/admin");
  await expect(menu(page).getByRole("link")).toHaveText(["Ringkasan"]);
  await menu(page).getByRole("link", { name: "Ringkasan" }).click();
  await expect(page).toHaveURL(/\/admin\/cases$/);
  for (const path of ["/admin/accounts", "/admin/accounts/seller/anything12345", "/admin/risk", "/admin/stores/1/verification", "/admin/staff", "/admin/staff/anything12345", "/admin/staff/access-reviews", "/admin/staff/break-glass"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Akses ditolak." }), path).toBeVisible();
    await expect(page.getByRole("table"), path).toHaveCount(0);
  }
  // no case form without cases.write
  await page.goto("/admin/cases");
  await expect(page.getByRole("button", { name: "Buka kasus" })).toHaveCount(0);

  await page.context().clearCookies();
  await login(page, "owner-a@bukalaris.local");
  for (const path of ["/admin/cases", "/admin/cases/1", "/admin/accounts", "/admin/accounts/seller/anything12345", "/admin/risk", "/admin/stores/1/verification", "/admin/staff", "/admin/staff/access-reviews", "/admin/staff/break-glass"]) {
    await page.goto(path);
    await expect(page.getByRole("main").getByRole("alert"), path).toContainText("Akses ditolak.");
  }
  // an unauthenticated visitor is sent to sign-in
  const res = await page.request.get("/admin/staff/access-reviews", { maxRedirects: 0, headers: { cookie: "" } });
  expect([307, 302]).toContain(res.status());
});

test("staff: list with last use, access review confirm, deactivation ends the other staff member's session", async ({ page, browser }, info) => {
  test.setTimeout(300_000);
  const boss = `boss-${tag(info)}-t63@bukalaris.local`;
  const other = `other-${tag(info)}-t63@bukalaris.local`;
  seedStaff(boss, ["dashboard.read", "staff.read", "staff.manage", "access.review", "audit.read"]);
  seedStaff(other, ["dashboard.read", "tenants.read"]);
  const otherCtx = await browser.newContext({ baseURL: info.project.use.baseURL });
  const otherPage = await otherCtx.newPage();
  await login(otherPage, other, "/admin");
  await otherPage.goto("/admin/stores"); // a console operation: stamps the grant's last use
  await expect(otherPage.getByRole("heading", { name: "Toko", level: 1 })).toBeVisible();

  await login(page, boss, "/admin");
  await page.goto("/admin/staff");
  await expect(page.getByRole("heading", { name: "Staf dan izin", level: 1 })).toBeVisible();
  await expect(page.getByTestId(`staf-${other}`)).toContainText("Aktif");
  await evidence(page, info, "t63-06-staff");
  await page.goto("/admin/staff/access-reviews");
  const row = page.getByTestId("izin-tenants.read").filter({ hasText: other });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("belum pernah"); // a real last-use stamp exists
  await row.getByLabel("Alasan").fill("masih dibutuhkan untuk dukungan");
  await row.getByRole("button", { name: "Tetap berlaku" }).click();
  await expect(page.getByRole("status")).toContainText("Keputusan review akses disimpan");
  expect(Number(q<{ n: string }[]>(`select count(*) as n from access_review_decision where decision = 'confirmed'`)[0]!.n)).toBeGreaterThanOrEqual(1);
  // Own grants are reviewed by someone else.
  await expect(page.getByTestId("izin-access.review").filter({ hasText: boss })).toContainText("ditinjau oleh orang lain");

  // Deactivate: the other session stops at once.
  const otherId = q<{ id: string }[]>(`select id from "user" where email = '${other}'`)[0]!.id;
  await page.goto(`/admin/staff/${otherId}`);
  await page.getByLabel("Alasan", { exact: true }).nth(1).fill("pindah tugas");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Nonaktifkan", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Perubahan staf disimpan");
  await otherPage.goto("/admin/stores");
  await expect(otherPage).toHaveURL(/\/login/);
  await otherCtx.close();
  // Own row: no change controls for oneself.
  const bossId = q<{ id: string }[]>(`select id from "user" where email = '${boss}'`)[0]!.id;
  await page.goto(`/admin/staff/${bossId}`);
  await expect(page.getByRole("button", { name: "Nonaktifkan", exact: true })).toHaveCount(0);
  await expect(page.getByText("tidak bisa Anda ubah sendiri")).toBeVisible();
});
