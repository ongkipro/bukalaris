import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { login } from "./helpers";

// T-60 (IAM-15, D-21): the Owner console shows only what the operator's capabilities allow, a direct URL still ends in the
// denied state, and a session without its own verified second-factor record is sent back to sign in.
const DB_CWD = resolve(process.cwd(), "../../packages/db");
const LOGS_ONLY = "logs-only@bukalaris.local";
const NO_GRANT = "no-grant@bukalaris.local";

/** Two extra staff accounts (idempotent): one with `logs.read` only, one with no capability at all. */
function seedStaff() {
  const script = `
    import { randomUUID } from "node:crypto";
    import { hashPassword } from "better-auth/crypto";
    import { eq } from "drizzle-orm";
    import { createDb } from "./src/client.ts";
    import { account, platformOperator, user } from "./src/schema.ts";
    import { grantAsSystem } from "./src/ops/capabilities-grants.ts";
    const db = createDb(process.env.E2E_PLATFORM_DATABASE_URL);
    const hash = await hashPassword("bukalaris-dev-123");
    for (const [email, caps] of [[${JSON.stringify(LOGS_ONLY)}, ["logs.read"]], [${JSON.stringify(NO_GRANT)}, []]]) {
      if ((await db.select().from(user).where(eq(user.email, email))).length) continue;
      const id = randomUUID();
      await db.insert(user).values({ id, email, name: email.split("@")[0], emailVerified: true });
      await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash });
      await db.insert(platformOperator).values({ userId: id });
      await grantAsSystem(db, { userId: id, capabilities: caps, source: "system_bootstrap", reason: "e2e fixture" });
    }
    await db.$client.end();
  `;
  execFileSync("node", ["--input-type=module", "-e", script], { cwd: DB_CWD, env: process.env, stdio: "inherit" });
}

/** Drop the second-factor records of an account's sessions (the account keeps `two_factor_enabled`). */
function forgetMfaRecords(email: string) {
  const stmt = `delete from session_mfa where user_id = (select id from "user" where email = '${email}')`;
  const script = `
    import { createDb } from "./src/client.ts";
    const db = createDb(process.env.E2E_DATABASE_URL);
    await db.$client.unsafe(${JSON.stringify(stmt)});
    await db.$client.end();
  `;
  execFileSync("node", ["--input-type=module", "-e", script], { cwd: DB_CWD, env: process.env, stdio: "inherit" });
}

test.beforeAll(() => seedStaff());

test("an operator with only logs.read sees only the Operasional group with Log System and every other direct URL is denied", async ({ page }) => {
  await login(page, LOGS_ONLY, "/admin");
  // The landing page (dashboard) is denied, and the navigation shows exactly the permitted group.
  await expect(page.getByRole("heading", { name: "Akses ditolak." })).toBeVisible();
  const menu = page.getByRole("navigation", { name: "Owner console" });
  await expect(menu.getByRole("link")).toHaveText(["Operasional"]);
  await expect(page.getByRole("link", { name: "Ongkir" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Toko", exact: true })).toHaveCount(0);

  for (const [path, capability] of [
    ["/admin/shipping", "shipping.manage"],
    ["/admin/stores", "tenants.read"],
    ["/admin/stores/new", "tenants.manage"],
    ["/admin/stores/1", "tenants.read"],
    ["/admin/approvals", "staff.manage"],
    ["/admin/ops", "ops.read"],
    ["/admin/audit", "audit.read"],
    ["/admin/issues", "ops.issues.manage"],
    ["/admin/settings", "settings.manage"],
    ["/admin/settings/providers", "providers.read"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Akses ditolak." }), path).toBeVisible();
    await expect(page.getByRole("main").getByText(capability).first(), path).toBeVisible();
  }
  await menu.getByRole("link", { name: "Operasional" }).click();
  await expect(page.getByRole("heading", { name: "Log System" })).toBeVisible();
  await expect(menu.getByRole("list", { name: "Menu Operasional" }).getByRole("link")).toHaveText(["Log System"]);
});

test("a staff member with no capability sees no navigation and no data", async ({ page }) => {
  await login(page, NO_GRANT, "/admin");
  await expect(page.getByRole("heading", { name: "Akses ditolak." })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Owner console" })).toHaveCount(0); // a group with no permitted child is never rendered
  for (const name of ["Ringkasan", "Toko", "Keuangan", "Platform", "Operasional", "Ongkir", "Log System"]) await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
  await page.goto("/admin/logs");
  await expect(page.getByText("Akses ditolak")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("MFA is bound to the session: without its own verified record the account flag does not open the console", async ({ page }) => {
  await login(page, LOGS_ONLY, "/admin");
  await page.goto("/admin/logs");
  await expect(page.getByRole("heading", { name: "Log System" })).toBeVisible();
  forgetMfaRecords(LOGS_ONLY);
  await page.goto("/admin/logs");
  await expect(page).toHaveURL(/\/login\?next=\/admin$/);
  // Signing in again (password + code) writes a new record and the console opens.
  await login(page, LOGS_ONLY, "/admin");
  await page.goto("/admin/logs");
  await expect(page.getByRole("heading", { name: "Log System" })).toBeVisible();
});
