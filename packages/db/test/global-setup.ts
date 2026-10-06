import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "../src/client.ts";

export async function setup() {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
  } catch {}
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  if (!/_test\b/.test(url)) throw new Error("TEST_DATABASE_URL must point at a *_test database");
  process.env.DATABASE_URL = url;
  const db = createDb(url);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  await db.$client.end();
}
