import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { evidence, login, seedFixtureStore } from "./helpers";

// T-117 (PR-27, D-37): the owner checklist on /seller, at 320 px and desktop. A NEW store (legacy_platform_shipping = false,
// the fail-closed default since migration 0027) sees every step open and cannot activate a physical product; after the owner
// accepts the seller terms and one bank account is listed (written as the superuser in one transaction with a consumed step-up
// proof, the shape the database guard accepts — see e2e/t113.spec.ts), digital becomes activatable and the first digital
// product goes Aktif through the UI.

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

function addBankAccount(slug: string, email: string, accountNumber: string) {
  node(`
    const [u] = await admin.$client.unsafe("select id from \\"user\\" where email = '${email}'");
    const [s] = await admin.$client.unsafe("select id from store where slug = '${slug}'");
    await admin.$client.begin(async (tx) => {
      const [p] = await tx.unsafe("insert into store_step_up_proof (store_id, user_id, session_id, action_key, subject_kind, subject_id, expires_at, consumed_at) values ($1, $2, 'e2e-t117', 'integrations.bank_account', 'store', 'bank_transfer', now() + interval '5 minutes', now()) returning id", [s.id, u.id]);
      await tx.unsafe("insert into store_bank_account (store_id, bank_code, account_number, holder_name, created_by, step_up_ref) values ($1, 'BCA', $2, 'Budi Pemilik', $3, $4)", [s.id, '${accountNumber}', u.id, p.id]);
    });
  `);
}

// Hydration re-applies defaultValue on the uncontrolled status select once, wiping a pre-hydration selection: re-apply
// until the choice survives a settle window before submitting.
async function selectStatusActive(page: Page) {
  const status = page.locator("#status");
  for (let i = 0; i < 20; i++) {
    await status.selectOption("active");
    await expect(status).toHaveValue("active");
    await page.waitForTimeout(300);
    if ((await status.inputValue()) === "active") return;
  }
  throw new Error("#status did not keep the active selection");
}

test("setup checklist: an empty new store is gated, then terms + bank account unlock the first digital product", async ({ page }, info) => {
  test.setTimeout(180_000);
  const store = seedFixtureStore("t117", { legacy: false });

  // Owner dashboard: the checklist card with every step open and nothing activatable.
  await login(page, store.email, "/seller");
  await page.goto("/seller");
  await expect(page.getByTestId("setup-checklist")).toBeVisible();
  for (const id of ["terms", "mengantar_account", "pickup", "autolaris", "bank_account"]) {
    await expect(page.getByTestId(`setup-step-${id}-status`)).toHaveText("Belum");
  }
  await expect(page.getByTestId("setup-step-webhook-status")).toHaveText("Disarankan");
  await expect(page.getByTestId("setup-unlocked")).toContainText("Belum ada yang bisa diaktifkan");
  await evidence(page, info, "t117-checklist-empty");

  // A physical product stays a draft: activation is refused by the new-store shipping gate.
  await page.goto("/seller/products/new");
  await page.getByLabel("Judul produk").fill("Kaos T117");
  await page.getByLabel("Harga (Rp)").fill("100000");
  await page.getByLabel("Berat (gram)").fill("500");
  await page.getByRole("button", { name: "Simpan produk" }).click();
  await selectStatusActive(page);
  await page.getByRole("button", { name: "Simpan produk" }).click();
  await expect(page.getByRole("main")).toContainText("Produk fisik hanya bisa diaktifkan setelah pengiriman toko siap");
  await evidence(page, info, "t117-physical-activation-blocked");

  // The owner accepts the seller terms through the payments screen.
  await page.goto("/seller/payments#syarat-penjual");
  await page.getByLabel(/Saya membaca dan menyetujui syarat penjual/).check();
  await page.getByRole("button", { name: "Setujui syarat penjual" }).click();
  await expect(page.getByTestId("terms-accepted-info")).toBeVisible();

  // One bank account is listed (superuser fixture with a consumed step-up proof, as in t113).
  const account = `70${randomBytes(4).readUInt32BE() % 100_000_000}`.padEnd(10, "0");
  addBankAccount(store.slug, store.email, account);

  // The checklist marks terms and the bank account done; digital is now activatable.
  await page.goto("/seller");
  await expect(page.getByTestId("setup-step-terms-status")).toHaveText("Selesai");
  await expect(page.getByTestId("setup-step-bank_account-status")).toHaveText("Selesai");
  await expect(page.getByTestId("setup-step-autolaris-status")).toHaveText("Belum");
  await expect(page.getByTestId("setup-unlocked")).toContainText("produk digital");
  await expect(page.getByTestId("setup-unlocked")).toContainText("transfer bank");
  // Review finding 1: an open step never calls locked what is already activatable.
  await expect(page.getByTestId("setup-step-autolaris-locks")).toHaveText("Yang masih terkunci: QRIS/VA.");
  await evidence(page, info, "t117-checklist-partial");

  // A digital product with an access link activates through the UI.
  await page.goto("/seller/products/new");
  await page.getByLabel("Judul produk").fill("E-Book T117");
  await page.getByLabel("Jenis produk").selectOption("digital");
  await page.getByLabel("Harga (Rp)").fill("65000");
  await page.getByRole("button", { name: "Simpan produk" }).click();
  await page.getByLabel("Label tautan").fill("Unduh E-Book (PDF)");
  await page.getByLabel("Tautan https://").fill("https://drive.google.com/file/d/t117-e2e-canary-112233/view");
  await page.getByRole("button", { name: "Tambah tautan" }).click();
  await expect(page.getByTestId("access-links-list")).toContainText("Unduh E-Book (PDF)");
  await selectStatusActive(page);
  await page.getByRole("button", { name: "Simpan produk" }).click();
  await expect(page.getByRole("main")).toContainText("Aktif");
  await expect(page.getByTestId("product-url")).not.toContainText("belum aktif");
  await evidence(page, info, "t117-digital-activated");
});

test("setup checklist: staff never see the card", async ({ page }) => {
  await login(page, "staff-a@bukalaris.local", "/seller");
  await page.goto("/seller");
  await expect(page.getByRole("heading", { name: "Ringkasan" })).toBeVisible();
  await expect(page.getByTestId("setup-checklist")).toHaveCount(0);
  await expect(page.getByTestId("setup-webhook-note")).toHaveCount(0);
});
