import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { enrolTotpViaApi, evidence, login, seedFixtureStore, totp } from "./helpers";

// T-104 (SC-32): the store owner connects, replaces, checks and removes the store's own Mengantar and AutoLaris keys on the FAKE connection
// check (no provider call leaves the process). Every key is a canary: the spec reads every response body the browser received (HTML, RSC
// payloads of navigations and server actions) plus the RSC payload of the page fetched directly, and the database rows a key could leak into.
// A disposable store and owner per project (T-82): TOTP enrolment is persistent auth state.

const DB_CWD = resolve(process.cwd(), "../../packages/db");
function q<T>(statement: string): T {
  const script = `
    import { createDb } from "./src/client.ts";
    const admin = createDb(process.env.E2E_DATABASE_URL);
    const out = await admin.$client.unsafe(${JSON.stringify(statement)});
    await admin.$client.end();
    console.log("@@" + JSON.stringify(out ?? null));
  `;
  const stdout = execFileSync("node", ["--input-type=module", "-e", script], { cwd: DB_CWD, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(stdout.slice(stdout.lastIndexOf("@@") + 2)) as T;
}

/** A TOTP code no earlier step-up of this test used; waits for the next 30 s window when the three accepted ones are spent or the window is about to roll. */
function codes(page: Page, secret: string) {
  const used = new Set<string>();
  return async () => {
    for (;;) {
      if (Date.now() % 30_000 < 25_000) {
        for (const step of [1, 0]) {
          const c = totp(secret, Date.now() + step * 30_000);
          if (!used.has(c)) { used.add(c); return c; }
        }
      }
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
    }
  };
}
const status = (page: Page) => page.getByRole("main").getByRole("status");
const alert = (page: Page) => page.locator("p[role=alert]");

test("seller connects, replaces, checks and removes the store's own provider keys with a step-up; no key reaches the browser, the logs, the audit rows or the mail", async ({ page }, info) => {
  test.setTimeout(240_000);
  const tag = `${info.project.name === "mobile-320" ? "m" : "d"}${randomBytes(3).toString("hex")}`;
  const CANARY = { autolaris: `CANARY-AL-${tag}-e2e-key-0123456789abcdef`, mengantar: `CANARY-MA-${tag}-e2e-key-0123456789abcdef` };
  const store = seedFixtureStore("t104");
  const storeId = Number(q<{ id: string }[]>(`select id from store where slug = '${store.slug}'`)[0]!.id);
  const bodies: string[] = [];
  page.on("response", async (r) => {
    const type = r.request().resourceType();
    if (type === "document" || type === "fetch" || type === "xhr") bodies.push(await r.text().catch(() => ""));
  });
  page.on("dialog", (d) => d.accept()); // ConfirmSubmit names the key before a removal

  await login(page, store.email, "/seller");
  const secret = await enrolTotpViaApi(page, store.email);
  const code = codes(page, secret);

  // The owner reaches the screen from the navigation and from the shipping page.
  await page.goto("/seller/shipping");
  await page.getByTestId("own-account-link").getByRole("link", { name: "Akun penyedia" }).click();
  await expect(page).toHaveURL(/\/seller\/payments$/);
  await expect(page).toHaveTitle("Akun penyedia — Bukalaris");
  await expect(page.getByRole("heading", { name: "Akun penyedia", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Akun penyedia", exact: true }).first()).toBeAttached();
  await expect(page.getByTestId("readiness-payment")).toContainText("Belum siap");
  await expect(page.getByTestId("readiness-shipping")).toContainText("Kunci API belum dihubungkan.");
  await expect(page.getByTestId("autolaris-status")).toHaveText("Belum terhubung");
  // No URL field anywhere: the environment is a fixed choice.
  await expect(page.locator("input[type=url], input[name*=url i], input[name*=origin i]")).toHaveCount(0);
  await evidence(page, info, "t104-providers-empty");

  const autolaris = page.getByRole("form", { name: "Simpan kunci AutoLaris" });
  // A wrong code stores nothing.
  await autolaris.getByLabel("Kunci API").fill(CANARY.autolaris);
  await autolaris.getByLabel(/Kode verifikasi/).fill("000000");
  await autolaris.getByRole("button", { name: "Simpan dan cek" }).click();
  await expect(alert(page)).toContainText("Kode verifikasi salah");
  expect(q<unknown[]>(`select id from store_payment_account where store_id = ${storeId}`)).toHaveLength(0);
  // Connect with a fresh code.
  await autolaris.getByLabel("Kunci API").fill(CANARY.autolaris);
  await autolaris.getByLabel(/Kode verifikasi/).fill(await code());
  await autolaris.getByRole("button", { name: "Simpan dan cek" }).click();
  await expect(status(page)).toContainText("Kunci lolos pengecekan");
  await expect(page.getByTestId("autolaris-status")).toHaveText("Terhubung");
  await expect(page.getByTestId("autolaris-hint")).toHaveText(`${CANARY.autolaris.slice(0, 4)}••••${CANARY.autolaris.slice(-4)}`);
  await expect(page.getByTestId("autolaris-last-check")).toContainText("Berhasil");
  await expect(page.getByTestId("autolaris-last-check")).toContainText("WIB");
  await expect(autolaris.getByLabel("Kunci API baru (opsional)")).toHaveValue(""); // never echoed back

  // Replace with a key the provider refuses: nothing changes, the previous key stays.
  const fingerprint = () => q<{ f: string }[]>(`select key_fingerprint as f from store_payment_account where store_id = ${storeId}`)[0]!.f;
  const before = fingerprint();
  await autolaris.getByLabel("Kunci API baru (opsional)").fill(`INVALID-${CANARY.autolaris}`);
  await autolaris.getByLabel(/Kode verifikasi/).fill(await code());
  await autolaris.getByRole("button", { name: "Simpan dan cek" }).click();
  await expect(alert(page)).toContainText("Kunci ditolak penyedia. Tidak ada yang diubah; kunci sebelumnya tetap dipakai.");
  expect(fingerprint()).toBe(before);
  await expect(page.getByTestId("autolaris-hint")).toHaveText(`${CANARY.autolaris.slice(0, 4)}••••${CANARY.autolaris.slice(-4)}`);

  // Check now (no step-up: nothing is changed but the check time).
  await page.getByRole("form", { name: "Cek kunci AutoLaris" }).getByRole("button", { name: "Cek sekarang" }).click();
  await expect(status(page)).toContainText("Pengecekan berhasil");

  // The AutoLaris readiness inputs make QRIS/VA ready.
  const details = page.getByRole("form", { name: "Data akun AutoLaris" });
  await details.getByLabel("ID area asal").fill("AREA-ASAL-1");
  await details.getByLabel("ID area tujuan").fill("AREA-TUJUAN-1");
  await details.getByLabel("E-mail pengirim").fill(`kirim-${tag}@example.invalid`);
  await details.getByLabel("Alamat pengirim").fill("Jl. Braga No. 10, Bandung 40111");
  await details.getByRole("checkbox").check();
  await details.getByRole("button", { name: "Simpan data" }).click();
  await expect(status(page)).toContainText("Data akun AutoLaris tersimpan");
  await expect(page.getByTestId("readiness-payment")).toContainText("Siap");
  await expect(page.getByTestId("readiness-open")).toContainText("setidaknya satu cara bayar yang siap.");

  // Mengantar in production: connected and checked, but shipping waits for the pickup registration of that account (T-105).
  const mengantar = page.getByRole("form", { name: "Simpan kunci Mengantar" });
  await mengantar.getByLabel("Lingkungan").selectOption("production");
  await mengantar.getByLabel("Kunci API").fill(CANARY.mengantar);
  await mengantar.getByLabel(/Kode verifikasi/).fill(await code());
  await mengantar.getByRole("button", { name: "Simpan dan cek" }).click();
  await expect(status(page)).toContainText("Kunci lolos pengecekan");
  await expect(page.getByTestId("mengantar-status")).toHaveText("Terhubung");
  await expect(page.getByTestId("mengantar-environment")).toHaveText("Produksi");
  await expect(page.getByTestId("readiness-shipping")).toContainText("Alamat pickup belum terdaftar di akun Mengantar ini.");
  await evidence(page, info, "t104-providers-connected");

  // The page itself, fetched as HTML and as an RSC payload, never carries a key.
  for (const headers of [{} as Record<string, string>, { RSC: "1" }]) bodies.push(await (await page.request.get("/seller/payments", { headers })).text());

  // Remove the Mengantar key: an explicit action with its own fresh code.
  const remove = page.getByRole("form", { name: "Hapus kunci Mengantar" });
  await remove.getByLabel("Kode verifikasi").fill(await code());
  await remove.getByRole("button", { name: "Hapus kunci" }).click();
  await expect(status(page)).toContainText("Kunci dihapus");
  await expect(page.getByTestId("mengantar-status")).toHaveText("Belum terhubung");
  await expect(page.getByTestId("mengantar-hint")).toHaveText("—");

  // Audit rows (fingerprints only), owner mail, and the literal scan.
  const audit = q<{ action: string; subject_id: string; reason: string }[]>(`select action, subject_id, reason from audit_log where store_id = ${storeId} and subject_kind = 'provider_account' order by id`);
  expect(audit.map((a) => `${a.action}:${a.subject_id}`)).toEqual(["provider.key.connect:autolaris", "provider.details.update:autolaris", "provider.key.connect:mengantar", "provider.key.remove:mengantar"]);
  expect(audit[0]!.reason).toMatch(/^environment=sandbox; fingerprint=hmac:[0-9a-f]{16}$/);
  const mails = q<{ subject: string }[]>(`select subject from mail_outbox where to_email = '${store.email}' and subject like 'Kunci %' order by id`);
  expect(mails.map((m) => m.subject)).toEqual([`Kunci AutoLaris toko ${store.name} diubah`, `Kunci Mengantar toko ${store.name} diubah`, `Kunci Mengantar toko ${store.name} dihapus`]);
  const forms = (k: string) => [k, encodeURIComponent(k), Buffer.from(k).toString("base64")];
  const rows = q<{ j: string }[]>(`select string_agg(t::text, E'\\n') as j from (select row_to_json(a)::text as t from audit_log a union all select row_to_json(m)::text from mail_outbox m union all select row_to_json(s)::text from system_log s union all select row_to_json(j)::text from job j) x`)[0]!.j ?? "";
  expect(bodies.length).toBeGreaterThan(10);
  for (const key of Object.values(CANARY)) {
    for (const form of forms(key)) {
      expect(bodies.some((b) => b.includes(form)), `response body holds ${key}`).toBe(false);
      expect(rows.includes(form), `database rows hold ${key}`).toBe(false);
    }
  }
});

test("staff of a store neither sees nor opens the provider accounts", async ({ page }) => {
  await login(page, "staff-a@bukalaris.local");
  await expect(page.getByRole("link", { name: "Akun penyedia", exact: true })).toHaveCount(0);
  await page.goto("/seller/payments");
  await expect(page.getByTestId("providers-denied")).toContainText("Hanya pemilik toko");
  await expect(page.getByRole("main").getByRole("form")).toHaveCount(0);
});
