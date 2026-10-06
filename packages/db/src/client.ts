import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: Number(process.env.DATABASE_POOL_MAX ?? 10), onnotice: () => {} });
  return Object.assign(drizzle(client, { schema }), { $client: client });
}

export type Db = ReturnType<typeof createDb>;
/** A Db or an open transaction; every service accepts either. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

let shared: Db | undefined;
/** Process-wide pool for the web app (lazy so `next build` needs no database). */
export function db(): Db {
  return (shared ??= createDb());
}
