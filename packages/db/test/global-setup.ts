import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "../src/client.ts";
import { seedFakeCourierPolicy } from "../src/ledger/fixtures.ts";
import { prepareLocalDatabase, wipeLocalDatabase } from "../src/local-roles.ts";

/**
 * Disposable test database: roles + database if missing (owned by bukalaris_owner), wipe,
 * migrate as the owner (so branch migrations never drift and grants/policies are exercised
 * exactly as in production).
 */
export async function setup() {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
  } catch {}
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  if (!/_test\b/.test(url)) throw new Error("TEST_DATABASE_URL must point at a *_test database");
  const roles = await prepareLocalDatabase(url);
  await wipeLocalDatabase(url);
  const db = createDb(roles.owner);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  await seedFakeCourierPolicy(db); // the fake courier JNE is a COD-capable fixture (the migration seeds SPX only)
  await db.$client.end();
}
