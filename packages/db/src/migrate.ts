import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.ts";

const db = createDb(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL);
await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
await db.$client.end();
console.log("migrations applied");
