import { expect, test } from "@playwright/test";
import { enrolTotpViaApi, login, seedFixtureStore, totp } from "./helpers";

// T-105 OPT-IN SANDBOX RUN (ADR-0013 decisions 33 and 34). SPECIFIED, NOT RUN: it calls the real Mengantar SANDBOX with a seller test key.
// It is skipped unless ALL of these hold, and it is started only after the owner approved that run:
//   - T105_SANDBOX=1;
//   - MENGANTAR_SANDBOX_TEST_KEY comes from `secrets-env run -- …` (never a file, never a shell `source`);
//   - MENGANTAR_SANDBOX_ORIGIN=https://sandbox.mengantar.com is set for the web server AND the worker (Playwright passes the environment on).
//     The origin was read from the Mengantar documentation (companion repo `docs/01-api-reference.md` §1 and `spec/openapi.yaml` servers; the
//     official page renders its base URL per host and serves the same text on sandbox.mengantar.com/docs/). UNVERIFIED until this run passes.
// Command (by hand, after approval):
//   T105_SANDBOX=1 MENGANTAR_SANDBOX_ORIGIN=https://sandbox.mengantar.com secrets-env run -- pnpm --filter web exec playwright test t105-sandbox --project=desktop
// Sandbox limits documented on the sandbox host: JNE needs a Jakarta pickup address, SAP only non-COD Jakarta→Jakarta, SPX only a Jakarta
// origin. The run therefore uses a Jakarta pickup, a Jakarta destination, JNE and a prepaid order. A pass is recorded by the operator in the
// Owner console (Ongkir → "Catat uji sandbox") with the date and where this run's output is kept; only then may production calls be opened.
const enabled = process.env.T105_SANDBOX === "1" && !!process.env.MENGANTAR_SANDBOX_TEST_KEY && !!process.env.MENGANTAR_SANDBOX_ORIGIN;
test.skip(!enabled, "opt-in sandbox run: needs owner approval, T105_SANDBOX=1, MENGANTAR_SANDBOX_ORIGIN and a secrets-env test key");

test("sandbox: connect a seller test key, register a Jakarta pickup, quote, order and book on the store's own sandbox account", async ({ page }) => {
  test.setTimeout(300_000);
  const store = seedFixtureStore("t105sbx");
  await login(page, store.email, "/seller");
  const secret = await enrolTotpViaApi(page, store.email);

  // The key first: without a pickup area the live check reads the account's pickup-address list (no area id needed).
  await page.goto("/seller/payments");
  // T-116: owner accepts the current seller terms before saving a provider key.
  const termsForm = page.getByRole("form", { name: "Setujui syarat penjual" });
  await termsForm.getByRole("checkbox").check();
  await termsForm.getByRole("button", { name: "Setujui syarat penjual" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("Persetujuan syarat penjual tercatat");
  const form = page.getByRole("form", { name: "Simpan kunci Mengantar" });
  await form.getByLabel("Lingkungan").selectOption("sandbox");
  await form.getByLabel("Kunci API").fill(process.env.MENGANTAR_SANDBOX_TEST_KEY!);
  await form.getByLabel(/Kode verifikasi/).fill(totp(secret, Date.now() + 30_000));
  await form.getByRole("button", { name: "Simpan dan cek" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("Kunci lolos pengecekan");

  // Then the pickup area in Jakarta, searched on the store's own sandbox key.
  await page.goto("/seller/shipping?q=gambir");
  await page.getByRole("list", { name: "Hasil pencarian area" }).getByRole("button").first().click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Tersimpan.");
  await page.goto("/seller/shipping");
  const pickup = page.getByRole("form", { name: "Alamat pickup" });
  await pickup.getByLabel("Alamat lengkap pickup").fill("Jl. Medan Merdeka Barat No. 1 (uji sandbox)");
  await pickup.getByLabel("Nama penanggung jawab pickup").fill("Uji Sandbox");
  await pickup.getByLabel("Nomor HP penanggung jawab").fill("081234567890");
  await pickup.getByRole("button", { name: "Simpan dan daftarkan alamat" }).click();
  // T-115 (decision 41): the account is confirmed as new and dedicated (its order list is read on the key) before shipping is ready.
  await page.goto("/seller/shipping/account");
  const dedicated = page.getByRole("form", { name: "Konfirmasi akun khusus" });
  await dedicated.getByRole("checkbox").check();
  await dedicated.getByRole("button", { name: "Konfirmasi akun khusus" }).click();
  await page.goto("/seller/shipping");
  await expect(page.getByTestId("shipping-ready")).toHaveText("Siap kirim");
  const couriers = page.getByRole("form", { name: "Kurir dan COD" });
  await couriers.getByLabel("Aktifkan JNE Express").check();
  await couriers.getByRole("button", { name: "Simpan kurir" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Tersimpan.");
  // The buyer order, payment and booking steps follow t105.spec.ts (a Jakarta destination, JNE, prepaid, drop-off), then the shipment
  // must show a resi from the sandbox; the run's request log is checked for the absence of the key and of COD_AMOUNT on estimates.
});
