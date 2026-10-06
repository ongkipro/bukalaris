import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.ts";

// Owner role only (ADR-0005): the app role may not alter the schema, so there is no DATABASE_URL fallback.
const db = createDb(process.env.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL");
await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
await db.$client.end();
console.log("migrations applied");
