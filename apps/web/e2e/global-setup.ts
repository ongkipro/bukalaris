import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

/** Recreate the disposable e2e database contents: create if missing, wipe, migrate, seed. Uploads go too. */
export default async function globalSetup() {
  rmSync(resolve("var/e2e-media"), { recursive: true, force: true });
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
  const name = new URL(url).pathname.slice(1);
  const admin = postgres(url.replace(/\/[^/]+$/, "/postgres"), { max: 1, onnotice: () => {} });
  if ((await admin`select 1 from pg_database where datname = ${name}`).length === 0) await admin.unsafe(`create database "${name}"`);
  await admin.end();
  const db = postgres(url, { max: 1, onnotice: () => {} });
  await db.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await db.end();
  const env = { ...process.env, DATABASE_URL: url };
  const cwd = resolve(process.cwd(), "../../packages/db");
  execFileSync("node", ["src/migrate.ts"], { cwd, env, stdio: "inherit" });
  execFileSync("node", ["src/seed.ts"], { cwd, env, stdio: "inherit" });
  // The whole suite (both viewports, every spec) buys the seeded "Kaos Katun Basic";
  // its dev-seed stock (20/5) runs out mid-suite and silently changes the default
  // variant. Top it up for e2e only; stock assertions in specs are relative.
  const top = postgres(url, { max: 1, onnotice: () => {} });
  await top`update variant set stock = 1000 where product_id in (select id from product where slug = 'kaos-katun-basic')`;
  await top.end();
}
