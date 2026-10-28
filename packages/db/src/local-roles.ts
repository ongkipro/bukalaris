// LOCAL DEVELOPMENT AND TESTS ONLY. The compose superuser URL (TEST_DATABASE_URL,
// E2E_DATABASE_URL) is the admin connection; the owner/app/platform URLs for the same
// database follow the docker/05-roles.sql placeholder convention: password = role name.
// Production never derives credentials: DATABASE_URL, PLATFORM_DATABASE_URL and
// MIGRATION_DATABASE_URL are three independent secrets (docs/DEPLOY-COOLIFY.md).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

if (process.env.NODE_ENV === "production") throw new Error("local-roles.ts is for local development and tests only");

export type LocalRole = "bukalaris_owner" | "bukalaris_app" | "bukalaris_platform";

/** Same host/port/database as `adminUrl`, connecting as `role` with the local placeholder password. */
export function localRoleUrl(adminUrl: string, role: LocalRole): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = role;
  return u.toString();
}

const ROLES_SQL = fileURLToPath(new URL("../docker/05-roles.sql", import.meta.url));

/**
 * Make a local database ready for the role setup: create the five roles (three login roles and the
 * no-login `bukalaris_restricted` and `bukalaris_resolver`, docker/05-roles.sql) if the volume
 * predates them, create the database if missing, and hand it to `bukalaris_owner` so the
 * migrator owns the schema. Returns the URLs for the three login roles.
 */
export async function prepareLocalDatabase(adminUrl: string) {
  const name = new URL(adminUrl).pathname.slice(1);
  const admin = postgres(adminUrl.replace(/\/[^/]+$/, "/postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(readFileSync(ROLES_SQL, "utf8"));
    if ((await admin`select 1 from pg_database where datname = ${name}`).length === 0) await admin.unsafe(`create database "${name}" owner bukalaris_owner`);
    else await admin.unsafe(`alter database "${name}" owner to bukalaris_owner`);
  } finally {
    await admin.end();
  }
  return {
    owner: localRoleUrl(adminUrl, "bukalaris_owner"),
    app: localRoleUrl(adminUrl, "bukalaris_app"),
    platform: localRoleUrl(adminUrl, "bukalaris_platform"),
  };
}

/** Drop everything in a disposable database so migrations rebuild it; the new public schema belongs to the owner. */
export async function wipeLocalDatabase(adminUrl: string) {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    // Playwright starts the web server and the outbox worker BEFORE its global setup, so the worker's scheduler transaction can
    // run while the schema is dropped: PostgreSQL then aborts one side with a deadlock (40P01). The drop is idempotent: retry it.
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public authorization bukalaris_owner;");
        return;
      } catch (err) {
        const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
        if (code !== "40P01" || attempt >= 8) throw err;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  } finally {
    await admin.end();
  }
}

const PENDING_DIR = fileURLToPath(new URL("../drizzle-pending/", import.meta.url));

/** Run one hand-written SQL file as `ownerUrl`, statement by statement (`--> statement-breakpoint`). */
export async function applySqlFile(ownerUrl: string, file: string) {
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
      if (statement.replace(/--[^\n]*/g, "").trim()) await owner.unsafe(statement);
    }
  } finally {
    await owner.end();
  }
}

/** `drizzle-pending/<name>`; the contract file is read by rls-contract.test.ts only. */
export const pendingFile = (name: string) => PENDING_DIR + name;

// CLI for the Playwright global setup (which cannot import this ESM file through Playwright's CJS transform):
//   `node src/local-roles.ts <admin url>` prepares and wipes that database.
if (process.argv[1]?.endsWith("local-roles.ts")) {
  const url = process.argv[2];
  if (!url || !/_(test|e2e)\b/.test(url)) throw new Error("usage: node src/local-roles.ts <admin url of a *_test or *_e2e database>");
  await prepareLocalDatabase(url);
  await wipeLocalDatabase(url);
}
