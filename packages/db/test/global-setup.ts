import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createDb } from "../src/client.ts";

/** Disposable test database: create if missing, wipe, migrate (so branch migrations never drift). */
export async function setup() {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
  } catch {}
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  if (!/_test\b/.test(url)) throw new Error("TEST_DATABASE_URL must point at a *_test database");
  const name = new URL(url).pathname.slice(1);
  const admin = postgres(url.replace(/\/[^/]+$/, "/postgres"), { max: 1, onnotice: () => {} });
  if ((await admin`select 1 from pg_database where datname = ${name}`).length === 0) await admin.unsafe(`create database "${name}"`);
  await admin.end();
  const db = createDb(url);
  await db.execute("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  await db.$client.end();
}
