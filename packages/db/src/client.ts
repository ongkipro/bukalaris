import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export function createDb(url: string | undefined, name = "DATABASE_URL") {
  if (!url) throw new Error(`${name} is not set`);
  const client = postgres(url, { max: Number(process.env.DATABASE_POOL_MAX ?? 10), onnotice: () => {} });
  return Object.assign(drizzle(client, { schema }), { $client: client });
}

export type Db = ReturnType<typeof createDb>;
/** A Db or an open transaction; every service accepts either. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

let shared: Db | undefined;
/**
 * Request pool of the web app: role `bukalaris_app` (NOBYPASSRLS). Store-owned tables are
 * only readable inside a store context (tenant.ts), so a forgotten predicate yields nothing.
 * Lazy so `next build` needs no database.
 */
export function db(): Db {
  return (shared ??= createDb(process.env.DATABASE_URL));
}

let platform: Db | undefined;
/**
 * Privileged pool: role `bukalaris_platform` (BYPASSRLS). Only for OperatorScope (Super
 * Admin), the worker/cleanup processes and the cross-store resolvers inside this package
 * (ADR-0005 §4). Storefront, checkout and seller code never import it (rls.test.ts guards
 * the apps/web import boundary).
 */
export function platformDb(): Db {
  return (platform ??= createDb(process.env.PLATFORM_DATABASE_URL, "PLATFORM_DATABASE_URL"));
}
