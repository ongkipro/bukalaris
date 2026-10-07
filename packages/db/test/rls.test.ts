import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.ts";
import { createDb } from "../src/client.ts";
import { localRoleUrl } from "../src/local-roles.ts";
import { product, store } from "../src/schema.ts";
import { setCartLine } from "../src/storefront.ts";
import { withStore } from "../src/tenant.ts";
import { buyer, db, makeStore, platform } from "./helpers.ts";

// Database-enforced tenant isolation (T-27, ADR-0005, TEN-3/TEN-6). The rest of the suite
// is the main proof: every service runs on `db` = role bukalaris_app with RLS applied.
// This file checks the policy surface itself and the fail-closed behaviour around it.

/** Tables deliberately outside the tenant policy; the reason for each is in docs/tracks/rls.md. */
const STORELESS = ["user", "session", "account", "verification", "two_factor", "platform_operator", "operator_grant", "system_log", "rate_limit", "mail_outbox", "shipping_margin_rule"];
/** Exactly what bukalaris_app may do per table (docs/tracks/rls.md). A new table starts with nothing. */
const APP_GRANTS: Record<string, string> = {
  user: "SELECT,INSERT,UPDATE,DELETE",
  session: "SELECT,INSERT,UPDATE,DELETE",
  account: "SELECT,INSERT,UPDATE,DELETE",
  verification: "SELECT,INSERT,UPDATE,DELETE",
  two_factor: "SELECT,INSERT,UPDATE,DELETE",
  store: "SELECT,UPDATE",
  membership: "SELECT,INSERT,UPDATE,DELETE",
  store_invitation: "SELECT,INSERT,UPDATE",
  product: "SELECT,INSERT,UPDATE",
  variant: "SELECT,INSERT,UPDATE",
  collection: "SELECT,INSERT,UPDATE",
  page: "SELECT,INSERT,UPDATE",
  store_pickup_area: "SELECT,INSERT,UPDATE",
  product_slug_alias: "SELECT,INSERT,DELETE",
  collection_product: "SELECT,INSERT,DELETE",
  media: "SELECT,INSERT,UPDATE,DELETE",
  catalog_audit: "SELECT,INSERT",
  cart: "SELECT,INSERT",
  cart_line: "SELECT,INSERT,UPDATE,DELETE",
  order: "SELECT,INSERT,UPDATE",
  order_line: "SELECT,INSERT",
  order_status_history: "SELECT,INSERT",
  stock_adjustment: "SELECT,INSERT",
  storefront_channel: "SELECT,INSERT,UPDATE",
  checkout_handoff: "SELECT,INSERT,UPDATE",
  job: "SELECT,INSERT",
  signal_destination: "SELECT,INSERT,UPDATE",
  signal_event: "SELECT,INSERT",
  order_signal_context: "SELECT,INSERT",
  feed_token: "SELECT,INSERT,UPDATE",
  shipment: "SELECT,INSERT,UPDATE", // T-39 (fulfillment): requests and counters; results come from the worker
  landing_page: "SELECT,INSERT,UPDATE", // T-42: pages are created and re-pointed by the app
  landing_page_revision: "SELECT,INSERT", // T-42: revisions are immutable snapshots
  audit_log: "INSERT",
  rate_limit: "SELECT,INSERT,UPDATE",
  shipping_margin_rule: "SELECT",
  mail_outbox: "SELECT,INSERT",
  system_log: "INSERT", // plus SELECT on the id column only (RETURNING)
};

type Rel = { name: string; rls: boolean; forced: boolean; policy: number; storeId: boolean };
async function relations(): Promise<Rel[]> {
  const rows = (await platform.execute(sql`
    select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      (select count(*)::int from pg_policy p where p.polrelid = c.oid and p.polname = 'tenant_isolation') as policy,
      exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'store_id' and not a.attisdropped) as store_id
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' order by 1`)) as unknown as (Omit<Rel, "storeId"> & { store_id: boolean })[];
  return rows.map(({ store_id, ...r }) => ({ ...r, storeId: store_id }));
}

/** Rows the app role can read from `table` outside any store context: a count, or "denied" when it has no SELECT at all. */
async function appCount(table: string): Promise<number | "denied"> {
  try {
    const [row] = (await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`)) as unknown as { n: number }[];
    return row!.n;
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code === "42501") return "denied";
    throw err;
  }
}
const rlsViolation = { cause: { code: "42501" } }; // "new row violates row-level security policy"

describe("row-level security surface (ADR-0005 §2)", () => {
  it("every table with a store_id column, and the store table itself, has forced RLS with the tenant_isolation policy; every other table is an explicit decision", async () => {
    const rels = await relations();
    const expectRls = rels.filter((r) => (r.storeId && r.name !== "system_log") || r.name === "store").map((r) => r.name);
    expect(expectRls.length).toBeGreaterThanOrEqual(26);
    for (const r of rels) {
      const should = expectRls.includes(r.name);
      expect({ table: r.name, rls: r.rls, forced: r.forced, policy: r.policy }).toEqual({ table: r.name, rls: should, forced: should, policy: should ? 1 : 0 });
    }
    // Store-less tables are listed by name so a new table forces a documented decision (TEN-6).
    expect(rels.filter((r) => !expectRls.includes(r.name)).map((r) => r.name).sort()).toEqual([...STORELESS].sort());
  });

  it("bukalaris_app holds exactly the per-table privileges of the decision table (nothing by default on new tables)", async () => {
    // pg_catalog, not information_schema: the latter only lists grants involving the current role.
    const rows = (await platform.execute(sql`
      select c.relname as t, string_agg(a.privilege_type, ',' order by array_position(array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], a.privilege_type::text)) as p
      from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
      where n.nspname = 'public' and c.relkind = 'r' and a.grantee = 'bukalaris_app'::regrole group by 1 order by 1`)) as unknown as { t: string; p: string }[];
    expect(Object.fromEntries(rows.map((r) => [r.t, r.p]))).toEqual(APP_GRANTS);
    const cols = (await platform.execute(sql`
      select c.relname as t, att.attname as c, a.privilege_type as p from pg_attribute att join pg_class c on c.oid = att.attrelid, aclexplode(att.attacl) a
      where att.attacl is not null and a.grantee = 'bukalaris_app'::regrole`)) as unknown as { t: string; c: string; p: string }[];
    expect(cols).toEqual([{ t: "system_log", c: "id", p: "SELECT" }]);
    expect(Object.keys(APP_GRANTS).sort()).toEqual((await relations()).filter((r) => !["platform_operator", "operator_grant", "order_notification"].includes(r.name)).map((r) => r.name).sort());
  });

  it("role attributes: app cannot bypass RLS, platform and owner can, none is a superuser", async () => {
    const roles = (await platform.execute(sql`select rolname, rolbypassrls, rolsuper from pg_roles where rolname like 'bukalaris_%' order by 1`)) as unknown as { rolname: string; rolbypassrls: boolean; rolsuper: boolean }[];
    expect(roles).toEqual([
      { rolname: "bukalaris_app", rolbypassrls: false, rolsuper: false },
      { rolname: "bukalaris_owner", rolbypassrls: true, rolsuper: false },
      { rolname: "bukalaris_platform", rolbypassrls: true, rolsuper: false },
    ]);
  });
});

describe("fail closed (TEN-3)", () => {
  it("without a store context the app role sees zero rows in every store-owned table while the platform pool sees them", async () => {
    const a = await makeStore("toko-a");
    await makeStore("toko-b");
    // Populate commerce rows for A: an open cart with a line, and a checked-out order (lines, outbox job).
    await setCartLine(a.sf, undefined, { variantId: a.variantId, quantity: 1 }, "add");
    const cartId = await setCartLine(a.sf, undefined, { variantId: a.variantId, quantity: 2 }, "add");
    await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer" }));

    const rls = (await relations()).filter((r) => r.policy === 1).map((r) => r.name);
    const populated = ["store", "membership", "product", "variant", "catalog_audit", "store_pickup_area", "audit_log", "cart", "cart_line", "order", "order_line", "job"];
    for (const table of rls) {
      expect({ table, app: await appCount(table) }).toMatchObject({ table, app: expect.toSatisfy((v: number | "denied") => v === 0 || v === "denied") });
      const [row] = (await platform.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`)) as unknown as { n: number }[];
      if (populated.includes(table)) expect({ table, platform: row!.n }).toMatchObject({ table, platform: expect.toSatisfy((n: number) => n > 0) });
    }
  });

  it("with store A's context the app role sees only A and cannot insert or move a row into B", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const seen = await withStore(db, a.storeId, (tx) => tx.select({ id: product.id, storeId: product.storeId }).from(product));
    expect(seen).toEqual([{ id: a.productId, storeId: a.storeId }]);
    expect(await withStore(db, a.storeId, (tx) => tx.select({ id: store.id }).from(store))).toEqual([{ id: a.storeId }]);
    // Even with B's real ids in hand, the policy's WITH CHECK rejects the write.
    await expect(withStore(db, a.storeId, (tx) => tx.insert(product).values({ storeId: b.storeId, title: "smuggled" }))).rejects.toMatchObject(rlsViolation);
    await expect(withStore(db, a.storeId, (tx) => tx.update(product).set({ storeId: b.storeId }).where(eq(product.id, a.productId)))).rejects.toMatchObject(rlsViolation);
    // A foreign row is simply not there to update or delete (0 rows, no error).
    expect(await withStore(db, a.storeId, (tx) => tx.update(product).set({ title: "x" }).where(eq(product.id, b.productId)).returning({ id: product.id }))).toEqual([]);
    expect((await platform.select().from(product).where(eq(product.id, b.productId)))[0]!.title).toBe("Kaos toko-b");
    // The platform pool sees both stores.
    expect((await platform.select({ id: store.id }).from(store)).map((s) => s.id).sort()).toEqual([a.storeId, b.storeId].sort());
  });

  it("the context is transaction-local: the same connection sees nothing again right after the transaction", async () => {
    const a = await makeStore("toko-a");
    process.env.DATABASE_POOL_MAX = "1";
    const one = createDb(localRoleUrl(process.env.TEST_DATABASE_URL!, "bukalaris_app"));
    delete process.env.DATABASE_POOL_MAX;
    try {
      expect(await withStore(one, a.storeId, (tx) => tx.select({ id: product.id }).from(product))).toHaveLength(1);
      expect(await one.select({ id: product.id }).from(product)).toEqual([]);
      // Switching stores inside one transaction is refused rather than silently widened.
      await expect(withStore(one, a.storeId, (tx) => withStore(tx, a.storeId + 1, async () => 0))).rejects.toThrow(/store context mismatch/);
    } finally {
      await one.$client.end();
    }
  });

  it("the app role cannot read operator tables at all", async () => {
    expect(await appCount("platform_operator")).toBe("denied");
    expect(await appCount("operator_grant")).toBe("denied");
    expect(await appCount("order_notification")).toBe("denied");
  });
});

describe("import boundary (ADR-0005 §5)", () => {
  it("apps/web uses the platform pool only in lib/context.ts (operators) and lib/auth.ts (account audit)", () => {
    const root = fileURLToPath(new URL("../../../apps/web/src/", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    const users = files.filter((f) => /\bplatformDb\b/.test(readFileSync(f, "utf8"))).map((f) => relative(root, f)).sort();
    expect(users).toEqual(["lib/auth.ts", "lib/context.ts"]);
  });
});
