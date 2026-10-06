import { sql } from "drizzle-orm";
import type { Executor, Tx } from "./client.ts";

/**
 * Store context for PostgreSQL row-level security (ADR-0005, T-27). Every policy reads
 * `app_store_id()` = `nullif(current_setting('app.store_id', true), '')::bigint`; the
 * setting is written with `set_config(…, true)`, i.e. transaction-local, so a pooled
 * connection never carries a store into the next request. Outside a context the app
 * role sees zero store-owned rows and cannot write any (fail closed).
 */

/** Transactions that already carry a store context, so nested service calls reuse them instead of opening savepoints. */
const contexts = new WeakMap<object, number>();

/** Run `fn` in a transaction whose row-level-security context is `storeId`. */
export async function withStore<T>(exec: Executor, storeId: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const current = contexts.get(exec);
  if (current === storeId) return fn(exec as Tx);
  // A savepoint cannot narrow `set_config(…, true)` back to the outer store on release, so
  // switching stores inside one transaction is a programming error, never silently allowed.
  if (current !== undefined) throw new Error(`store context mismatch: transaction is bound to store ${current}, requested ${storeId}`);
  return exec.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.store_id', ${String(storeId)}, true)`);
    contexts.set(tx, storeId);
    return fn(tx);
  });
}

/**
 * Run `fn` with a copy of `scope` whose executor is a transaction in the scope's store
 * context. Services wrap their store-owned reads and writes in this; scope objects keep
 * their shape, so `fn` can be the original body with `scope.exec` now meaning the transaction.
 */
export function inStore<S extends { exec: Executor; storeId: number }, T>(scope: S, fn: (scope: S) => Promise<T>): Promise<T> {
  return withStore(scope.exec, scope.storeId, (tx) => fn({ ...scope, exec: tx }));
}
