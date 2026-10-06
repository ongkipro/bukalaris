import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

/**
 * Recreate the disposable e2e database contents: roles + database if missing, wipe, migrate
 * as the owner, seed through the platform role; the web server and worker then run as
 * bukalaris_app / bukalaris_platform exactly like production (ADR-0005). Uploads go too.
 */
export default async function globalSetup() {
  rmSync(resolve("var/e2e-media"), { recursive: true, force: true });
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
  const { E2E_OWNER_DATABASE_URL: owner, E2E_APP_DATABASE_URL: app, E2E_PLATFORM_DATABASE_URL: platform } = process.env; // set by playwright.config.ts
  if (!owner || !app || !platform) throw new Error("role URLs missing: run through playwright.config.ts");
  const cwd = resolve(process.cwd(), "../../packages/db");
  execFileSync("node", ["src/local-roles.ts", url], { cwd, stdio: "inherit" }); // roles + database + ownership, then wipe
  const env = { ...process.env, DATABASE_URL: app, PLATFORM_DATABASE_URL: platform, MIGRATION_DATABASE_URL: owner };
  execFileSync("node", ["src/migrate.ts"], { cwd, env, stdio: "inherit" });
  execFileSync("node", ["src/seed.ts"], { cwd, env, stdio: "inherit" });
  // The whole suite (both viewports, every spec) buys the seeded "Kaos Katun Basic";
  // its dev-seed stock (20/5) runs out mid-suite and silently changes the default
  // variant. Top it up for e2e only; stock assertions in specs are relative.
  const top = postgres(url, { max: 1, onnotice: () => {} });
  await top`update variant set stock = 1000 where product_id in (select id from product where slug = 'kaos-katun-basic')`;
  await top.end();
}
