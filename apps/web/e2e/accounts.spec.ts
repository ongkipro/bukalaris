import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { DEV_PASSWORD, evidence, login, saveTotpSecret, submitTotp, totp, totpSecrets } from "./helpers";

// The dev Mailer stores mail in `mail_outbox`; the spec reads the links back from the e2e database
// (the /dev/outbox viewer is hidden in production builds, which this suite runs against).
const url = process.env.E2E_DATABASE_URL;
if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
const sql = postgres(url, { max: 1, onnotice: () => {} });
test.afterAll(() => sql.end());

async function lastMailTo(email: string) {
  const [row] = await sql<{ text_body: string }[]>`select text_body from mail_outbox where to_email = ${email} order by id desc limit 1`;
  return row?.text_body ?? null;
}
const linkIn = (body: string) => /https?:\/\/\S+/.exec(body)![0];

/** /request-password-reset allows 3 requests per minute per IP in production; wait a 429 out instead of disabling it. */
async function requestReset(page: Page, email: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto("/account/recovery");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Kirim tautan" }).click();
    const outcome = await Promise.race([
      page.getByRole("status").waitFor().then(() => "ok" as const),
      page.getByText("Terlalu banyak permintaan").waitFor().then(() => "429" as const),
    ]);
    if (outcome === "ok") return (await page.getByRole("status").textContent())!;
    await page.waitForTimeout(61_000);
  }
  throw new Error("password reset kept being rate limited");
}

test("password recovery never reveals whether an account exists and resets through the e-mailed link", async ({ page }, info) => {
  test.setTimeout(240_000);
  const unknown = `nobody-${info.project.name}@example.com`;
  // Dedicated seed user: this test changes its password, so shared users (staff-a) stay intact for other specs.
  const known = "recovery-a@bukalaris.local";
  const newPassword = `Sandi-${info.project.name}-${Date.now()}`;

  const first = await requestReset(page, unknown);
  await evidence(page, info, "30-recovery-sent");
  const second = await requestReset(page, known);
  expect(first).toBe(second);
  expect(await lastMailTo(unknown)).toBeNull();
  const mail = await lastMailTo(known);
  expect(mail).toContain("/api/auth/reset-password/");

  await page.goto(linkIn(mail!));
  await page.waitForURL((u) => u.pathname === "/account/recovery/reset" && u.searchParams.has("token"));
  await page.getByLabel("Kata sandi baru", { exact: true }).fill(newPassword);
  await page.getByLabel("Ulangi kata sandi baru").fill("beda-sekali-12");
  await page.getByRole("button", { name: "Simpan kata sandi" }).click();
  await expect(page.getByText("Konfirmasi kata sandi tidak sama.")).toBeVisible();
  await page.getByLabel("Ulangi kata sandi baru").fill(newPassword);
  await page.getByRole("button", { name: "Simpan kata sandi" }).click();
  await expect(page.getByRole("status")).toContainText("berhasil diubah");
  await evidence(page, info, "31-recovery-done");

  // Single use: the same link is now rejected by Better Auth's callback.
  await page.goto(linkIn(mail!));
  await expect(page.getByText(/tidak valid atau sudah kedaluwarsa/)).toBeVisible();

  await login(page, known, "/seller", newPassword);
  await expect(page.getByRole("heading", { name: "Produk" })).toBeVisible();
});

test("owner invites by e-mail; a new user accepts once, gets the invited role, and revoked links are dead", async ({ page }, info) => {
  const stamp = `${info.project.name}-${Date.now()}`;
  const invitee = `baru-${stamp}@example.com`;
  const revoked = `batal-${stamp}@example.com`;

  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller/members");
  for (const [email, role] of [[invitee, "staff"], [revoked, "owner"]] as const) {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Peran", { exact: true }).selectOption(role);
    await page.getByRole("button", { name: "Kirim undangan" }).click();
    await expect(page.getByRole("status")).toHaveText("Tersimpan.");
    await expect(page.getByRole("cell", { name: email, exact: true })).toBeVisible();
  }
  await evidence(page, info, "40-members-invites");
  await page.getByRole("button", { name: `Batalkan undangan ${revoked}` }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await expect(page.getByRole("cell", { name: revoked, exact: true })).toHaveCount(0);

  const inviteLink = linkIn((await lastMailTo(invitee))!);
  const revokedLink = linkIn((await lastMailTo(revoked))!);
  await page.context().clearCookies();

  await page.goto(revokedLink);
  await expect(page.getByText(/sudah dibatalkan/)).toBeVisible();

  await page.goto(inviteLink);
  await expect(page.getByText("Toko Ayu")).toBeVisible();
  await page.getByLabel("Nama").fill("Nadia Baru");
  await page.getByLabel("Kata sandi", { exact: true }).fill("Sandi-undangan-1");
  await page.getByLabel("Ulangi kata sandi").fill("Sandi-undangan-1");
  await evidence(page, info, "41-invite-accept");
  await page.getByRole("button", { name: "Buat akun dan gabung" }).click();
  // The account is created atomically with the invitation; sign-in goes through the rate-limited route.
  await page.waitForURL((u) => u.pathname === "/seller/products" || u.pathname === "/login");
  if (new URL(page.url()).pathname === "/login") await login(page, invitee, "/seller", "Sandi-undangan-1");
  await expect(page.getByText("Toko Ayu · Staf")).toBeVisible();
  await evidence(page, info, "42-invite-landed");

  // Staff has no member management; the owner's pending list no longer shows the accepted invite.
  await page.goto("/seller/members");
  await expect(page.getByRole("button", { name: "Kirim undangan" })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: invitee, exact: true })).toBeVisible();

  await page.goto(inviteLink);
  await expect(page.getByText(/sudah dipakai/)).toBeVisible();
});

/** Submit the operator's credentials and report where the form went (waits out a sign-in 429). */
async function startAdminSignIn(page: Page, email: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto("/login?next=/admin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Kata sandi").fill(DEV_PASSWORD);
    await page.getByRole("button", { name: "Masuk" }).click();
    const outcome = await Promise.race([
      page.waitForURL((u) => u.pathname === "/account/security").then(() => "enrol" as const),
      page.getByLabel("Kode autentikator").waitFor().then(() => "totp" as const),
      page.getByText("Terlalu banyak percobaan").waitFor().then(() => "429" as const),
    ]);
    if (outcome !== "429") return outcome;
    await page.waitForTimeout(11_000);
  }
  throw new Error("sign-in kept being rate limited");
}

test("operator must enrol TOTP before the Owner console opens, then signs in with a code", async ({ page }, info) => {
  const email = "admin@bukalaris.local";
  const outcome = await startAdminSignIn(page, email);
  if (outcome === "enrol") {
    // Not enrolled yet (first project of the run): /admin is gated server-side.
    await page.goto("/admin");
    await page.waitForURL((u) => u.pathname === "/account/security");
    await expect(page.getByText("wajib mengaktifkan")).toBeVisible();
    await evidence(page, info, "50-mfa-required");

    await page.getByLabel("Kata sandi").fill(DEV_PASSWORD);
    await page.getByRole("button", { name: "Mulai aktivasi" }).click();
    const secret = (await page.getByTestId("totp-secret").textContent())!.trim();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    await evidence(page, info, "51-mfa-secret");
    await submitTotp(page, secret);
    await expect(page.getByRole("status")).toContainText("aktif");
    await expect(page.getByRole("list", { name: "Kode cadangan" }).getByRole("listitem")).toHaveCount(10);
    saveTotpSecret(email, secret);
    await evidence(page, info, "52-mfa-backup-codes");
    await page.getByRole("link", { name: "Lanjut ke Owner console" }).click();
    await expect(page.getByRole("heading", { name: "Ringkasan" })).toBeVisible();

    // From now on sign-in needs the code.
    await page.getByRole("button", { name: "Keluar" }).click();
    await page.waitForURL((u) => u.pathname === "/login");
    await login(page, email, "/admin");
  } else {
    const secret = totpSecrets()[email];
    expect(secret, "secret recorded by the first project").toBeTruthy();
    await evidence(page, info, "53-mfa-login-code");
    await submitTotp(page, secret!);
    await page.waitForURL((u) => u.pathname === "/admin");
  }
  await expect(page.getByRole("heading", { name: "Ringkasan" })).toBeVisible();
  await page.goto("/admin/stores");
  await expect(page.getByRole("heading", { name: "Toko", level: 1 })).toBeVisible();
  await expect(page.getByText("/toko-a")).toBeVisible();

  // A wrong code is rejected without a session.
  await page.getByRole("button", { name: "Keluar" }).click();
  await page.waitForURL((u) => u.pathname === "/login");
  expect(await startAdminSignIn(page, email)).toBe("totp");
  await page.getByLabel("Kode autentikator").fill(totp(totpSecrets()[email]!) === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Verifikasi" }).click();
  await expect(page.getByText(/Kode tidak valid|Terlalu banyak/)).toBeVisible();
  expect((await page.request.get("/admin")).url()).toContain("/login");
});

test("a seller cannot reach Super Admin and the dev outbox is hidden in production", async ({ page }) => {
  await login(page, "owner-a@bukalaris.local");
  await page.goto("/admin");
  await expect(page.getByText("Akses ditolak.")).toBeVisible();
  expect((await page.request.get("/dev/outbox")).status()).toBe(404);
});
