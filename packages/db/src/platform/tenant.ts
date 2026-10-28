import { sql } from "drizzle-orm";
import type { Executor, Tx } from "../client.ts";
import type { AuditWriter } from "./isolation-registry.ts";

/**
 * Transaction-local contexts for PostgreSQL row-level security (ADR-0005, T-27, T-59). Policies
 * read `app_store_id()`, `app_buyer_id()`, `app_affiliate_id()` (`nullif(current_setting(…, true), '')::bigint`)
 * and `app_audit_writer()`; each setting is written with `set_config(…, true)`, i.e. transaction-local,
 * so a pooled connection never carries a store, buyer or affiliate into the next request. Outside a
 * context the app role sees zero rows of the matching class and cannot write any (fail closed).
 * The ids come from server-verified scopes, never from a browser value.
 */

type Setting = "app.store_id" | "app.buyer_id" | "app.affiliate_id" | "app.audit_writer";

/** Contexts a transaction already carries, so nested service calls reuse them instead of opening savepoints. */
const contexts = new WeakMap<object, ReadonlyMap<Setting, string>>();

async function withSetting<T>(exec: Executor, setting: Setting, label: string, value: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const bound = contexts.get(exec);
  const current = bound?.get(setting);
  if (current === value) return fn(exec as Tx);
  // A savepoint cannot narrow `set_config(…, true)` back to the outer value on release, so
  // switching inside one transaction is a programming error, never silently allowed.
  if (current !== undefined) throw new Error(`${label} context mismatch: transaction is bound to ${label} ${current}, requested ${value}`);
  // Inside an outer transaction this is a savepoint, and `set_config(…, true)` survives its release: put the outer value
  // back when `fn` finishes, so the code that continues in the outer transaction is not left in a context it never asked for.
  const nested = "rollback" in exec;
  return exec.transaction(async (tx) => {
    const previous = nested ? (await tx.execute(sql`select current_setting(${setting}, true) as v`))[0]?.v : undefined;
    await tx.execute(sql`select set_config(${setting}, ${value}, true)`);
    contexts.set(tx, new Map(bound).set(setting, value));
    const result = await fn(tx);
    if (nested) await tx.execute(sql`select set_config(${setting}, ${typeof previous === "string" ? previous : ""}, true)`);
    return result;
  });
}

async function idContext<T>(exec: Executor, setting: Setting, label: string, id: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`invalid ${label} id`);
  return withSetting(exec, setting, label, String(id), fn);
}

/** Run `fn` in a transaction whose row-level-security context is `storeId`. */
export const withStore = <T>(exec: Executor, storeId: number, fn: (tx: Tx) => Promise<T>): Promise<T> => idContext(exec, "app.store_id", "store", storeId, fn);

/** Same for the own-buyer policies of the `buyer` class (`app.buyer_id`; the buyer portal, ADR-0010). */
export const withBuyer = <T>(exec: Executor, buyerId: number, fn: (tx: Tx) => Promise<T>): Promise<T> => idContext(exec, "app.buyer_id", "buyer", buyerId, fn);

/** Same for the own-affiliate policies of the `affiliate` class (`app.affiliate_id`; the affiliate portal, ADR-0009). */
export const withAffiliate = <T>(exec: Executor, affiliateId: number, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  idContext(exec, "app.affiliate_id", "affiliate", affiliateId, fn);

/** Name the writer of a store-less `audit_log` row; the policy admits only the writers of `AUDIT_STORELESS_WRITERS`. */
export const withAuditWriter = <T>(exec: Executor, writer: AuditWriter, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withSetting(exec, "app.audit_writer", "audit writer", writer, fn);

/**
 * Run `fn` with a copy of `scope` whose executor is a transaction in the scope's store
 * context. Services wrap their store-owned reads and writes in this; scope objects keep
 * their shape, so `fn` can be the original body with `scope.exec` now meaning the transaction.
 */
export function inStore<S extends { exec: Executor; storeId: number }, T>(scope: S, fn: (scope: S) => Promise<T>): Promise<T> {
  return withStore(scope.exec, scope.storeId, (tx) => fn({ ...scope, exec: tx }));
}
