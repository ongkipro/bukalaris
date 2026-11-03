import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import { createDb } from "../src/client.ts";
import { localRoleUrl } from "../src/local-roles.ts";
import { AUDIT_STORELESS_WRITERS, DEFINER_FUNCTIONS, expectedPolicy, ISOLATION_REGISTRY, registryRows, ROLES, type AuditWriter, type TableEntry } from "../src/platform/isolation-registry.ts";
import { resolveCartStore, resolveChannelStore, resolveFeedStore, resolveHandoffStore, resolveInvitationStore, resolveMemberStores, resolveOrderStore, resolveStoreBySlug } from "../src/platform/resolvers.ts";
import { membership, product, store } from "../src/schema.ts";
import { createChannel } from "../src/storefront/channels.ts";
import { createFeedToken, revokeFeedToken } from "../src/storefront/feeds.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { withAffiliate, withAuditWriter, withBuyer, withStore } from "../src/platform/tenant.ts";
import { buyer, db, makeStore, platform } from "./helpers.ts";
import { completenessProblems, definerProblems, readDefiners, readRelations, resolverProblems, tableProblems, type DefinerRow, type Rel } from "./isolation-catalog.ts";

// Database-enforced isolation (T-27, T-59, ADR-0005 and its amendment, TEN-3/TEN-6, SEC-23). The rest of the
// suite is the main proof: every service runs on `db` = role bukalaris_app with RLS applied. This file checks
// the policy surface itself, driven by the isolation registry (src/platform/isolation-registry.ts), and the
// fail-closed behaviour around it. Each invariant is a named test; the checkers are also fed wrong input so a
// green run cannot be vacuous.

const adminUrl = process.env.TEST_DATABASE_URL!;
/** Owner connection: creates the scratch tables the mechanisms are proven on (no product table exists yet for buyers or affiliates). */
const owner = createDb(localRoleUrl(adminUrl, "bukalaris_owner"));
const rlsViolation = { cause: { code: "42501" } }; // "new row violates row-level security policy" / "permission denied"
/** Raw SQL on any executor; `T` names the columns the caller reads (the driver does not check them). */
const run = async <T extends object = Record<string, unknown>>(exec: { execute: typeof db.execute }, query: string): Promise<T[]> => (await exec.execute(sql.raw(query))) as unknown as T[];
const pgCode = (err: unknown) => (err instanceof Error && err.cause && typeof err.cause === "object" && "code" in err.cause ? String(err.cause.code) : undefined);

/** Exercise the real Docker/restore SQL on this isolated DB, without requiring Docker in CI. */
async function shellRegistryProblems(): Promise<string[]> {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const query = execFileSync("bash", ["-eu", "-c", 'ROOT="$1"; source "$ROOT/scripts/_registry.sh"; psql_in() { cat; }; registry_problems unused', "registry-check", root], {
    encoding: "utf8", env: { ...process.env, STRICT_PLATFORM: "0" },
  });
  return (await run(platform, query)).map((row) => String(Object.values(row)[0]));
}

async function dropScratch() {
  const left = await run<{ relname: string }>(owner, `select relname from pg_class where relname like 'scratch\\_%' and relkind = 'r' and relnamespace = 'public'::regnamespace`);
  for (const t of left) await run(owner, `drop table if exists "${t.relname}" cascade`);
  await run(owner, `drop function if exists scratch_restricted_total(bigint)`);
}
beforeAll(dropScratch);
afterEach(dropScratch); // every test builds the scratch objects it needs
afterAll(async () => {
  await dropScratch();
  await owner.$client.end();
});

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

const tenantTables = () => Object.entries(ISOLATION_REGISTRY).filter(([, e]) => expectedPolicy(e) !== null).map(([t]) => t);

describe("isolation registry: completeness and shape per class (ADR-0005 amendment 1)", () => {
  it("every table of schema public is registered and every registry entry has a table", async () => {
    const rels = await readRelations(platform);
    expect(rels.length).toBeGreaterThanOrEqual(42);
    expect(completenessProblems(rels.map((r) => r.name))).toEqual([]);
  });

  it("the completeness check reports an unregistered table and an entry without a table", () => {
    expect(completenessProblems(["store", "brand_new_table"], ["store", "ghost_entry"])).toEqual([
      "brand_new_table: table is not in the isolation registry",
      "ghost_entry: registry entry without a table",
    ]);
  });

  it("a table created without a registry entry is caught, and bukalaris_app starts with no privilege on it (fail closed)", async () => {
    await run(owner, `create table scratch_unregistered (id bigint primary key, store_id bigint)`);
    const rels = await readRelations(platform);
    expect(completenessProblems(rels.map((r) => r.name))).toEqual(["scratch_unregistered: table is not in the isolation registry"]);
    expect(await appCount("scratch_unregistered")).toBe("denied");
    await run(owner, `drop table scratch_unregistered`);
  });

  it("every table has the owner, forced row-level security and policy, app grants and platform grants of its class", async () => {
    const rels = await readRelations(platform);
    const problems = rels.flatMap((r) => (ISOLATION_REGISTRY[r.name] ? tableProblems(r, ISOLATION_REGISTRY[r.name]!, "expand") : []));
    expect(problems).toEqual([]);
  });

  it("the Docker/restore registry SQL detects protected and missing column UPDATE grants (T-81)", async () => {
    expect(await shellRegistryProblems()).toEqual([]);
    try {
      await run(owner, "grant update (status) on public.store to bukalaris_app");
      expect(await shellRegistryProblems()).toContain("column store.status: bukalaris_app UPDATE differs from registry");
    } finally {
      await run(owner, "revoke update (status) on public.store from bukalaris_app");
    }
    try {
      await run(owner, "revoke update (name) on public.store from bukalaris_app");
      expect(await shellRegistryProblems()).toContain("column store.name: bukalaris_app UPDATE differs from registry");
    } finally {
      await run(owner, "grant update (name) on public.store to bukalaris_app");
    }
    expect(await shellRegistryProblems()).toEqual([]);
  });

  it("every class in the registry maps to the policy shape of ADR-0005: tenant and buyer and affiliate carry one policy, the other classes none", () => {
    const policies = Object.fromEntries(
      (["tenant", "buyer", "affiliate", "platform", "shared-read", "restricted", "auth"] as const).map((c) => [c, expectedPolicy({ class: c, key: ["tenant", "buyer", "affiliate"].includes(c) ? "k" : undefined, app: "", platform: "" })?.name ?? null]),
    );
    expect(policies).toEqual({ tenant: "tenant_isolation", buyer: "buyer_isolation", affiliate: "affiliate_isolation", platform: null, "shared-read": null, restricted: null, auth: null });
    expect(expectedPolicy(ISOLATION_REGISTRY.audit_log!)!.withCheck).toContain("app_audit_writer()");
    expect(expectedPolicy(ISOLATION_REGISTRY.store!)!.using).toBe("(id = app_store_id())");
  });

  it("the policy count the shell scripts derive (verify:docker, restore rehearsal) equals the policies in the database", async () => {
    const [{ n }] = await run<{ n: number }>(platform, `select count(*)::int as n from pg_policies where schemaname = 'public'`);
    expect(n).toBe(registryRows().filter((r) => r.policy !== "").length);
    expect(n).toBeGreaterThanOrEqual(31);
  });

  it("the shape checker rejects tables that break their class (not vacuous)", () => {
    const good = (name: string, over: Partial<Rel> = {}): Rel => {
      const e = ISOLATION_REGISTRY[name]!;
      const p = expectedPolicy(e);
      return {
        name, owner: "bukalaris_owner", rls: p !== null, forced: p !== null, resolver: "", other: [], app: e.app, platform: e.platform,
        appColumns: Object.entries(e.appColumns ?? {}).flatMap(([c, ps]) => ps.split(",").map((x) => `${c}:${x}`)),
        policies: p ? [{ name: p.name, cmd: "*", allRoles: true, permissive: true, using: p.using, check: p.withCheck }] : [],
        ...over,
      };
    };
    expect(tableProblems(good("product"), ISOLATION_REGISTRY.product!, "expand")).toEqual([]);
    expect(tableProblems(good("store"), ISOLATION_REGISTRY.store!, "expand")).toEqual([]);
    expect(tableProblems(good("store", { appColumns: [] }), ISOLATION_REGISTRY.store!, "expand")[0]).toMatch(/column grants/);
    expect(tableProblems(good("store", { appColumns: [...good("store").appColumns, "status:UPDATE"] }), ISOLATION_REGISTRY.store!, "expand")[0]).toMatch(/column grants/);
    expect(tableProblems(good("product", { forced: false }), ISOLATION_REGISTRY.product!, "expand")).toEqual(["product: row-level security is not FORCEd"]);
    expect(tableProblems(good("product", { policies: [] }), ISOLATION_REGISTRY.product!, "expand")[0]).toMatch(/policies \[\] differ/);
    expect(tableProblems(good("product", { policies: [{ ...good("product").policies[0]!, using: "true", check: "true" }] }), ISOLATION_REGISTRY.product!, "expand")[0]).toMatch(/differ/);
    expect(tableProblems(good("product", { app: "SELECT,INSERT,UPDATE,DELETE" }), ISOLATION_REGISTRY.product!, "expand")).toEqual(['product: bukalaris_app holds "SELECT,INSERT,UPDATE,DELETE", registry says "SELECT,INSERT,UPDATE"']);
    expect(tableProblems(good("operator_grant", { app: "SELECT" }), ISOLATION_REGISTRY.operator_grant!, "expand")).toHaveLength(1);
    expect(tableProblems(good("order", { platform: "SELECT" }), ISOLATION_REGISTRY.order!, "expand")[0]).toMatch(/bukalaris_platform holds "SELECT", registry says "SELECT,UPDATE"/);
    expect(tableProblems(good("order", { platform: "SELECT,UPDATE,DELETE" }), ISOLATION_REGISTRY.order!, "expand")).toEqual([]); // expand: old extra grants may remain
    expect(tableProblems(good("order", { platform: "SELECT,UPDATE,DELETE" }), ISOLATION_REGISTRY.order!, "contract")).toHaveLength(1); // contract: exactly the registry
    expect(tableProblems(good("order", { other: ["TRUNCATE"] }), ISOLATION_REGISTRY.order!, "expand")[0]).toMatch(/TRUNCATE/);
    expect(tableProblems(good("shipping_margin_rule", { owner: "bukalaris_app" }), ISOLATION_REGISTRY.shipping_margin_rule!, "expand")[0]).toMatch(/owner is bukalaris_app/);
    // a restricted table: owned by bukalaris_restricted, no grant to either login role, no policy
    const restricted: TableEntry = { class: "restricted", app: "", platform: "" };
    const r = good("operator_grant", { owner: "bukalaris_restricted", platform: "" });
    expect(tableProblems(r, restricted, "expand")).toEqual([]);
    expect(tableProblems({ ...r, platform: "SELECT" }, restricted, "expand")).toEqual(['operator_grant: bukalaris_platform holds "SELECT" on a restricted table']);
    expect(tableProblems({ ...r, owner: "bukalaris_owner" }, restricted, "expand")[0]).toMatch(/needs bukalaris_restricted/);
  });

  it("bukalaris_app has no default privileges on future tables (a new table is unreachable until its migration grants it)", async () => {
    const rows = await run(platform, `select defaclobjtype, defaclrole::regrole::text as owner, defaclacl::text as acl from pg_default_acl where defaclacl::text like '%bukalaris_app=%' and defaclobjtype = 'r'`);
    expect(rows).toEqual([]);
  });

  it("role attributes: app and restricted cannot bypass RLS, platform, owner and resolver can, none is a superuser, only the three login roles log in", async () => {
    const roles = await run<{ rolname: keyof typeof ROLES; rolbypassrls: boolean; rolcanlogin: boolean; rolsuper: boolean }>(platform, `select rolname, rolbypassrls, rolcanlogin, rolsuper from pg_roles where rolname like 'bukalaris\\_%' order by 1`);
    expect(roles.map((r) => r.rolname).sort()).toEqual(Object.keys(ROLES).sort());
    for (const r of roles) expect({ role: r.rolname, login: r.rolcanlogin, bypassrls: r.rolbypassrls, super: r.rolsuper }).toEqual({ role: r.rolname, login: ROLES[r.rolname].login, bypassrls: ROLES[r.rolname].bypassrls, super: false });
  });
});

describe("fail closed (TEN-3)", () => {
  it("without a store context the app role sees zero rows in every tenant table while the platform pool sees them", async () => {
    const a = await makeStore("toko-a");
    await makeStore("toko-b");
    // Populate commerce rows for A: an open cart with a line, and a checked-out order (lines, outbox job).
    await setCartLine(a.sf, undefined, { variantId: a.variantId, quantity: 1 }, "add");
    const cartId = await setCartLine(a.sf, undefined, { variantId: a.variantId, quantity: 2 }, "add");
    await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer" }));

    const populated = ["store", "membership", "product", "variant", "catalog_audit", "store_pickup_area", "audit_log", "cart", "cart_line", "order", "order_line", "job"];
    expect(tenantTables().length).toBeGreaterThanOrEqual(31);
    for (const table of tenantTables()) {
      expect({ table, app: await appCount(table) }).toMatchObject({ table, app: expect.toSatisfy((v: number | "denied") => v === 0 || v === "denied") });
      if (ISOLATION_REGISTRY[table]!.class === "buyer") {
        // T-57: the global buyer identity tables are reachable only through the resolver function; the BYPASSRLS platform login holds no table privilege on them.
        await expect(platform.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`), `platform select ${table}`).rejects.toMatchObject(rlsViolation);
        continue;
      }
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

  it.each([
    ["created_at", sql`now()`],
    ["id", sql`default`], // GENERATED ALWAYS rejects id = id before checking column privileges.
    ["slug", sql`'forbidden-rename'`],
    ["status", sql`'suspended'`],
    ["suspended_at", sql`now()`],
  ] as const)("app cannot UPDATE protected store column %s on its own or another store (T-81)", async (column, value) => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const before = await platform.select().from(store).orderBy(store.id);
    for (const target of [a.storeId, b.storeId]) {
      await expect(withStore(db, a.storeId, (tx) => tx.execute(sql`update public.store set ${sql.identifier(column)} = ${value} where id = ${target}`))).rejects.toMatchObject(rlsViolation);
    }
    expect(await platform.select().from(store).orderBy(store.id)).toEqual(before);
  });

  it("store metadata UPDATE grants retain RLS: foreign and missing contexts change nothing (T-81)", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const before = await platform.select().from(store).orderBy(store.id);
    expect(await withStore(db, a.storeId, (tx) => tx.update(store).set({ name: "Foreign edit" }).where(eq(store.id, b.storeId)).returning({ id: store.id }))).toEqual([]);
    expect(await db.update(store).set({ name: "Missing context" }).where(eq(store.id, a.storeId)).returning({ id: store.id })).toEqual([]);
    expect(await platform.select().from(store).orderBy(store.id)).toEqual(before);
  });

  it("the context is transaction-local: the same connection sees nothing again right after the transaction", async () => {
    const a = await makeStore("toko-a");
    process.env.DATABASE_POOL_MAX = "1";
    const one = createDb(localRoleUrl(adminUrl, "bukalaris_app"));
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

  it("the app role cannot read the operator tables at all, and the registry's no-grant platform tables stay denied", async () => {
    expect(await appCount("platform_operator")).toBe("denied");
    expect(await appCount("operator_grant")).toBe("denied");
    for (const [table, e] of Object.entries(ISOLATION_REGISTRY)) if (e.app === "" && !e.appColumns) expect({ table, app: await appCount(table) }).toEqual({ table, app: "denied" }); // column-level grants (tax_identity) make a bare count(*) legal
    expect(await appCount("order_notification")).toBe(0); // T-43: readable for redaction, but only inside a store context
  });
});

// ── buyer and affiliate contexts ─────────────────────────────────────────────────────────────────
// There is no buyer or affiliate table yet (ADR-0009/0010: T-52, T-57, T-72). The mechanism is proven on a scratch
// table created by the owner with exactly the policy the registry prescribes for its class, queried as bukalaris_app.
type OwnerKind = "buyer" | "affiliate";
const WITH_OWNER = { buyer: withBuyer, affiliate: withAffiliate } as const;

async function scratchOwnerTable(kind: OwnerKind) {
  const table = `scratch_${kind}_note`;
  const entry: TableEntry = { class: kind, key: `${kind}_id`, app: "SELECT,INSERT,UPDATE,DELETE", platform: "" };
  const p = expectedPolicy(entry)!;
  await run(owner, `create table ${table} (id bigint generated always as identity primary key, ${kind}_id bigint not null, store_id bigint, body text not null)`);
  await run(owner, `alter table ${table} enable row level security`);
  await run(owner, `alter table ${table} force row level security`);
  await run(owner, `create policy ${p.name} on ${table} using ${p.using} with check ${p.withCheck}`);
  await run(owner, `grant select, insert, update, delete on ${table} to bukalaris_app`);
  await run(owner, `insert into ${table} (${kind}_id, store_id, body) values (1, 10, 'one-a'), (1, 11, 'one-b'), (2, 10, 'two-a')`);
  return { table, entry };
}

describe.each(["buyer", "affiliate"] as const)("%s context: the policy mechanism under bukalaris_app", (kind) => {
  const col = `${kind}_id`;
  const inCtx = <T>(id: number, fn: (q: (text: string) => Promise<Record<string, unknown>[]>) => Promise<T>) =>
    WITH_OWNER[kind](db, id, (tx) => fn((text) => run(tx, text)));

  it("a table created from the registry template has exactly the shape the checker expects", async () => {
    const { table, entry } = await scratchOwnerTable(kind);
    const rel = (await readRelations(platform)).find((r) => r.name === table)!;
    expect(tableProblems(rel, entry, "expand")).toEqual([]);
  });

  it("missing context returns zero rows and writes nothing", async () => {
    const { table } = await scratchOwnerTable(kind);
    expect(await appCount(table)).toBe(0);
    await expect(run(db, `insert into ${table} (${col}, body) values (1, 'no context')`)).rejects.toMatchObject(rlsViolation);
    expect((await run(db, `delete from ${table} returning id`)).length).toBe(0);
    expect(await run(owner, `select count(*)::int as n from ${table}`)).toEqual([{ n: 3 }]);
  });

  it("same-owner reads succeed and show only that owner's rows", async () => {
    const { table } = await scratchOwnerTable(kind);
    expect((await inCtx(1, (q) => q(`select body from ${table} order by id`))).map((r) => r.body)).toEqual(["one-a", "one-b"]);
    expect((await inCtx(2, (q) => q(`select body from ${table}`))).map((r) => r.body)).toEqual(["two-a"]);
    expect(await inCtx(3, (q) => q(`select body from ${table}`))).toEqual([]);
  });

  it("a foreign id is rejected: inserting or moving a row to another owner fails, another owner's row cannot be updated or deleted", async () => {
    const { table } = await scratchOwnerTable(kind);
    await expect(inCtx(1, (q) => q(`insert into ${table} (${col}, body) values (2, 'smuggled')`))).rejects.toMatchObject(rlsViolation);
    await expect(inCtx(1, (q) => q(`update ${table} set ${col} = 2 where body = 'one-a'`))).rejects.toMatchObject(rlsViolation);
    expect(await inCtx(1, (q) => q(`update ${table} set body = 'x' where body = 'two-a' returning id`))).toEqual([]);
    expect(await inCtx(1, (q) => q(`delete from ${table} where body = 'two-a' returning id`))).toEqual([]);
    expect(await run(owner, `select body from ${table} where ${col} = 2`)).toEqual([{ body: "two-a" }]);
    // own insert and own update still work
    await inCtx(1, (q) => q(`insert into ${table} (${col}, body) values (1, 'one-c')`));
    expect(await inCtx(1, (q) => q(`update ${table} set body = 'one-c2' where body = 'one-c' returning id`))).toHaveLength(1);
  });

  it("the store column is provenance, not the tenancy key: a store context alone sees none of the rows", async () => {
    const { table } = await scratchOwnerTable(kind);
    expect(await withStore(db, 10, (tx) => run(tx, `select * from ${table}`))).toEqual([]);
    await expect(withStore(db, 10, (tx) => run(tx, `insert into ${table} (${col}, store_id, body) values (1, 10, 'via store')`))).rejects.toMatchObject(rlsViolation);
  });

  it("the buyer, affiliate and store contexts do not stand in for one another", async () => {
    const { table } = await scratchOwnerTable(kind);
    const other = kind === "buyer" ? withAffiliate : withBuyer;
    expect(await other(db, 1, (tx) => run(tx, `select * from ${table}`))).toEqual([]); // same number, wrong context kind
    expect((await inCtx(1, (q) => q(`select current_setting('app.store_id', true) as s`)))[0]?.s ?? "").toBe("");
  });

  it("the context is transaction-local: the same connection sees nothing again right after the transaction", async () => {
    const { table } = await scratchOwnerTable(kind);
    process.env.DATABASE_POOL_MAX = "1";
    const one = createDb(localRoleUrl(adminUrl, "bukalaris_app"));
    delete process.env.DATABASE_POOL_MAX;
    try {
      expect(await WITH_OWNER[kind](one, 1, (tx) => run(tx, `select id from ${table}`))).toHaveLength(2);
      expect(await run(one, `select id from ${table}`)).toEqual([]);
      await expect(WITH_OWNER[kind](one, 1, (tx) => WITH_OWNER[kind](tx, 2, async () => 0))).rejects.toThrow(new RegExp(`${kind} context mismatch`));
      expect(await WITH_OWNER[kind](one, 1, (tx) => WITH_OWNER[kind](tx, 1, (inner) => run(inner, `select id from ${table}`)))).toHaveLength(2); // same id reuses the transaction
    } finally {
      await one.$client.end();
    }
  });

  it("an invalid id never reaches the database", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) await expect(WITH_OWNER[kind](db, bad, async () => 1)).rejects.toThrow(new RegExp(`invalid ${kind} id`));
  });
});

describe("contexts compose in one transaction", () => {
  it("a store context and a buyer context can both be set, and each only opens its own class", async () => {
    const { table: buyerTable } = await scratchOwnerTable("buyer");
    const a = await makeStore("toko-a");
    const seen = await withStore(db, a.storeId, (tx) => withBuyer(tx, 1, async (inner) => ({ products: (await inner.select({ id: product.id }).from(product)).length, notes: (await run(inner, `select id from ${buyerTable}`)).length })));
    expect(seen).toEqual({ products: 1, notes: 2 });
  });
});

// ── audit_log ───────────────────────────────────────────────────────────────────────────────────
describe("audit_log: store rows stay isolated, store-less rows only from named writers (ADR-0005 amendment 3)", () => {
  const insert = (exec: { execute: typeof db.execute }, storeId: number | null, action = "test.action") =>
    run(exec, `insert into audit_log (actor_user_id, store_id, action) values ('u-1', ${storeId ?? "null"}, '${action}')`);
  const count = async (action: string) => (await run<{ n: number }>(platform, `select count(*)::int as n from audit_log where action = '${action}'`))[0]!.n;

  it("a store row is accepted inside its store context and rejected for a foreign store or without a context", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    await withStore(db, a.storeId, (tx) => insert(tx, a.storeId, "own.store"));
    expect(await count("own.store")).toBe(1);
    await expect(withStore(db, a.storeId, (tx) => insert(tx, b.storeId, "foreign.store"))).rejects.toMatchObject(rlsViolation);
    await expect(insert(db, a.storeId, "no.context")).rejects.toMatchObject(rlsViolation);
  });

  it("a store-less row without a writer is rejected, also when a store context is set", async () => {
    const a = await makeStore("toko-a");
    await expect(insert(db, null, "storeless.nowriter")).rejects.toMatchObject(rlsViolation);
    await expect(withStore(db, a.storeId, (tx) => insert(tx, null, "storeless.store-ctx"))).rejects.toMatchObject(rlsViolation);
    expect(await count("storeless.nowriter")).toBe(0);
  });

  it("every named writer may insert a store-less row; an unknown writer name may not", async () => {
    expect(AUDIT_STORELESS_WRITERS.length).toBeGreaterThan(0);
    for (const writer of AUDIT_STORELESS_WRITERS) {
      await withAuditWriter(db, writer, (tx) => insert(tx, null, `storeless.${writer}`));
      expect(await count(`storeless.${writer}`)).toBe(1);
    }
    await expect(withAuditWriter(db, "made.up" as AuditWriter, (tx) => insert(tx, null, "storeless.unknown"))).rejects.toMatchObject(rlsViolation);
    expect(await count("storeless.unknown")).toBe(0);
  });

  it("a named writer does not widen store isolation: it cannot write a row of a store it has no context for", async () => {
    const a = await makeStore("toko-a");
    await expect(withAuditWriter(db, AUDIT_STORELESS_WRITERS[0], (tx) => insert(tx, a.storeId, "writer.foreign"))).rejects.toMatchObject(rlsViolation);
    await withStore(db, a.storeId, (tx) => withAuditWriter(tx, AUDIT_STORELESS_WRITERS[0], (inner) => insert(inner, a.storeId, "writer.own")));
    expect(await count("writer.own")).toBe(1);
  });

  it("the writer name is transaction-local and a raw setting outside the list is not enough", async () => {
    process.env.DATABASE_POOL_MAX = "1";
    const one = createDb(localRoleUrl(adminUrl, "bukalaris_app"));
    delete process.env.DATABASE_POOL_MAX;
    try {
      await withAuditWriter(one, AUDIT_STORELESS_WRITERS[0], (tx) => insert(tx, null, "local.writer"));
      await expect(insert(one, null, "after.tx")).rejects.toMatchObject(rlsViolation);
      await expect(one.transaction(async (tx) => { await run(tx, `select set_config('app.audit_writer', 'anything', true)`); await insert(tx, null, "raw.setting"); })).rejects.toMatchObject(rlsViolation);
    } finally {
      await one.$client.end();
    }
  });

  it("the app role is append-only on audit_log: it can neither read, update nor delete rows, with or without a store context", async () => {
    const a = await makeStore("toko-a");
    await withStore(db, a.storeId, (tx) => insert(tx, a.storeId, "append.only"));
    await expect(withStore(db, a.storeId, (tx) => run(tx, `select * from audit_log`))).rejects.toMatchObject(rlsViolation);
    await expect(withStore(db, a.storeId, (tx) => run(tx, `update audit_log set reason = 'x'`))).rejects.toMatchObject(rlsViolation);
    await expect(withStore(db, a.storeId, (tx) => run(tx, `delete from audit_log`))).rejects.toMatchObject(rlsViolation);
  });

  it("the SQL writer list equals AUDIT_STORELESS_WRITERS (a writer added in one place only fails here)", async () => {
    const src = (await run<{ prosrc: string }>(platform, `select prosrc from pg_proc where proname = 'app_audit_writer'`))[0]!.prosrc;
    const listed = [...src.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).filter((w) => w !== "app.audit_writer");
    expect(listed.sort()).toEqual([...AUDIT_STORELESS_WRITERS].sort());
  });
});

// ── SECURITY DEFINER functions and the resolver role ─────────────────────────────────────────────
describe("SECURITY DEFINER functions are registered, owned, bounded and executable only by their grantees (ADR-0005 amendment 4)", () => {
  it("every SECURITY DEFINER function in public is registered with the registry's owner and EXECUTE grantees (never PUBLIC), a fixed search_path and no dynamic SQL, and every registered one exists", async () => {
    const rows = await readDefiners(platform);
    expect(rows.length).toBe(Object.keys(DEFINER_FUNCTIONS).length);
    expect(definerProblems(rows)).toEqual([]);
  });

  it("the definer checker rejects an unregistered function, PUBLIC execute, a loose search_path, dynamic SQL and unqualified tables (not vacuous)", () => {
    const row = (over: Partial<DefinerRow>): DefinerRow => ({ identity: "resolve_store_by_slug(text)", owner: "bukalaris_resolver", config: ["search_path=pg_catalog, public"], execute: ["bukalaris_app", "bukalaris_platform"], body: "select s.id from public.store s", ...over });
    const only = { "resolve_store_by_slug(text)": DEFINER_FUNCTIONS["resolve_store_by_slug(text)"]! };
    expect(definerProblems([row({ identity: "rogue()" })], only)).toContain("rogue(): SECURITY DEFINER function is not registered");
    expect(definerProblems([row({ execute: ["bukalaris_app", "bukalaris_platform", "PUBLIC"] })], only)[0]).toMatch(/EXECUTE held by bukalaris_app,bukalaris_platform,PUBLIC/);
    expect(definerProblems([row({ config: [] })], only)[0]).toMatch(/search_path is not fixed/);
    expect(definerProblems([row({ owner: "bukalaris_owner" })], only)[0]).toMatch(/owner is bukalaris_owner/);
    expect(definerProblems([row({ body: "select 1 from store" })], only)[0]).toMatch(/store is not schema-qualified/);
    expect(definerProblems([row({ body: "begin execute 'select 1'; end" })], only)[0]).toMatch(/dynamic SQL/);
    expect(definerProblems([], only)).toEqual(["resolve_store_by_slug(text): registered function does not exist"]);
  });

  it("the retention and guard kinds are checked too: owner, pinned pg_temp path, qualified relations, dynamic SQL only where registered (not vacuous)", () => {
    const reg = { ...DEFINER_FUNCTIONS };
    const only = { "retention_purge_job(integer)": reg["retention_purge_job(integer)"]!, "retention_purge(text,integer)": reg["retention_purge(text,integer)"]! };
    const row = (over: Partial<DefinerRow>): DefinerRow => ({ identity: "retention_purge_job(integer)", owner: "bukalaris_owner", config: ["search_path=pg_catalog, pg_temp"], execute: ["bukalaris_platform"], body: "select public.retention_purge('job', 1)", ...over });
    const generic = (over: Partial<DefinerRow>): DefinerRow => ({ identity: "retention_purge(text,integer)", owner: "bukalaris_owner", config: ["search_path=pg_catalog, pg_temp"], execute: [], body: "select 1 from public.retention_class where true", ...over });
    expect(definerProblems([row({}), generic({})], only)).toEqual([]);
    expect(definerProblems([row({ config: ["search_path=pg_catalog, public"] }), generic({})], only)[0]).toMatch(/search_path is not fixed to pg_catalog, pg_temp/);
    expect(definerProblems([row({ owner: "bukalaris_resolver" }), generic({})], only)[0]).toMatch(/owner is bukalaris_resolver/);
    expect(definerProblems([row({ body: "select 1 from retention_class" }), generic({})], only)[0]).toMatch(/retention_class is not schema-qualified/);
    expect(definerProblems([row({ body: "begin execute 'select 1'; end" }), generic({})], only)[0]).toMatch(/dynamic SQL/);
    expect(definerProblems([row({}), generic({ body: "execute 'select 1'" })], only)).toEqual([]); // the one function registered for dynamic SQL
    expect(definerProblems([row({ execute: ["bukalaris_app", "bukalaris_platform"] }), generic({})], only)[0]).toMatch(/EXECUTE held by/);
  });

  it("bukalaris_resolver holds SELECT on exactly the tables its registered functions read and nothing else", async () => {
    expect(resolverProblems(await readRelations(platform))).toEqual([]);
  });

  it("EXECUTE follows the registry: the app role runs every resolver, the platform role only the three the local seeds need, nobody else (PUBLIC included)", async () => {
    await expect(run(db, `select * from resolve_store_by_slug('x')`)).resolves.toEqual([]);
    await expect(run(platform, `select * from resolve_store_by_slug('x')`)).resolves.toEqual([]);
    await expect(run(platform, `select resolve_order_store(1)`)).rejects.toMatchObject(rlsViolation);
    await expect(run(platform, `select resolve_channel_store('a', 'b')`)).rejects.toMatchObject(rlsViolation);
  });

  it("a restricted table is reachable only through a registered function: no privilege for app or platform, a worker function for platform only (scratch table, real roles)", async () => {
    // The pattern a migration for a restricted table follows (ADR-0005 amendment 4): create as the migrator, hand over to
    // bukalaris_restricted (which needs CREATE on the schema for the move), drop every other grant, expose a definer function.
    await run(owner, `grant create on schema public to bukalaris_restricted`);
    await run(owner, `create table scratch_restricted_payout (id bigint generated always as identity primary key, store_id bigint not null, net_idr bigint not null)`);
    await run(owner, `alter table scratch_restricted_payout owner to bukalaris_restricted`);
    await run(owner, `revoke all on scratch_restricted_payout from public, bukalaris_app, bukalaris_platform`);
    await run(owner, `insert into scratch_restricted_payout (store_id, net_idr) values (1, 500), (1, 700), (2, 900)`); // owner is a member of bukalaris_restricted
    await run(owner, `create function scratch_restricted_total(p_store bigint) returns bigint language sql stable security definer set search_path = pg_catalog, public
      as $$ select coalesce(sum(p.net_idr), 0)::bigint from public.scratch_restricted_payout p where p.store_id = p_store $$`);
    await run(owner, `alter function scratch_restricted_total(bigint) owner to bukalaris_restricted`);
    await run(owner, `revoke create on schema public from bukalaris_restricted`);
    await run(owner, `revoke all on function scratch_restricted_total(bigint) from public`);
    await run(owner, `grant execute on function scratch_restricted_total(bigint) to bukalaris_platform`);

    const entry: TableEntry = { class: "restricted", app: "", platform: "" };
    const rel = (await readRelations(platform)).find((r) => r.name === "scratch_restricted_payout")!;
    expect(tableProblems(rel, entry, "expand")).toEqual([]);
    for (const [who, exec] of [["app", db], ["platform", platform]] as const) {
      for (const stmt of ["select * from scratch_restricted_payout", "insert into scratch_restricted_payout (store_id, net_idr) values (1, 1)", "update scratch_restricted_payout set net_idr = 0", "delete from scratch_restricted_payout"])
        expect({ who, stmt, error: await run(exec, stmt).then(() => "allowed", pgCode) }).toEqual({ who, stmt, error: "42501" });
    }
    expect(await run(platform, `select scratch_restricted_total(1) as total`)).toEqual([{ total: "1200" }]); // the registered worker function works
    await expect(run(db, `select scratch_restricted_total(1)`)).rejects.toMatchObject(rlsViolation); // the app role was not granted it
    const fn = (await readDefiners(platform)).find((f) => f.identity === "scratch_restricted_total(bigint)")!;
    expect(definerProblems([fn], { "scratch_restricted_total(bigint)": { owner: "bukalaris_restricted", execute: ["bukalaris_platform"] } })).toEqual([]);
    expect(definerProblems([fn])).toContain("scratch_restricted_total(bigint): SECURITY DEFINER function is not registered"); // an unregistered access path is caught
    // a platform grant on the restricted table would be caught by the registry check
    await run(owner, `grant select on scratch_restricted_payout to bukalaris_platform`);
    const leaked = (await readRelations(platform)).find((r) => r.name === "scratch_restricted_payout")!;
    expect(tableProblems(leaked, entry, "expand")).toEqual(['scratch_restricted_payout: bukalaris_platform holds "SELECT" on a restricted table']);
  });
});

describe("cross-store resolvers run on the app pool without a store context and leak nothing but the resolved store", () => {
  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

  it("slug → active store: id, name and slug only; unknown, suspended and injection-shaped slugs resolve to nothing", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    expect(await resolveStoreBySlug(db, "toko-a")).toEqual({ id: a.storeId, name: "Toko toko-a", slug: "toko-a" });
    expect(await resolveStoreBySlug(db, "nope")).toBeNull();
    expect(await resolveStoreBySlug(db, "toko-a' or slug like 'toko-%")).toBeNull();
    await platform.update(store).set({ status: "suspended" }).where(eq(store.id, b.storeId));
    expect(await resolveStoreBySlug(db, "toko-b")).toBeNull();
  });

  it("user → member stores: own memberships only, any status, ordered; a stranger gets none", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    await platform.insert(membership).values({ storeId: b.storeId, userId: a.ownerId, role: "staff" });
    await platform.update(store).set({ status: "suspended" }).where(eq(store.id, b.storeId));
    expect(await resolveMemberStores(db, a.ownerId)).toEqual([
      { storeId: a.storeId, name: "Toko toko-a", slug: "toko-a", status: "active", role: "owner" },
      { storeId: b.storeId, name: "Toko toko-b", slug: "toko-b", status: "suspended", role: "staff" },
    ]);
    expect(await resolveMemberStores(db, b.ownerId)).toHaveLength(1);
    expect(await resolveMemberStores(db, "no-such-user")).toEqual([]);
  });

  it("cart, order, channel token, feed token, handoff code and invitation token resolve to the owning store; every wrong input resolves to nothing", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const cartId = await setCartLine(a.sf, undefined, { variantId: a.variantId, quantity: 1 }, "add");
    expect(await resolveCartStore(db, cartId)).toBe(a.storeId);
    expect(await resolveCartStore(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
    const { orderId } = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer" }));
    expect(await resolveOrderStore(db, orderId)).toBe(a.storeId);
    expect(await resolveOrderStore(db, orderId + 1000)).toBeNull();

    const ch = await createChannel(b.owner, { name: "Backend", origin: "https://shop.example.com", returnPath: "/thanks" });
    expect(await resolveChannelStore(db, ch.prefix, sha256(ch.token))).toBe(b.storeId);
    expect(await resolveChannelStore(db, ch.prefix, sha256(`${ch.token}x`))).toBeNull(); // right prefix, wrong secret
    expect(await resolveChannelStore(db, "zzzzzzzz", sha256(ch.token))).toBeNull(); // right secret, wrong prefix

    const feed = await createFeedToken(a.owner);
    expect(await resolveFeedStore(db, feed.prefix, sha256(feed.token))).toBe(a.storeId);
    await revokeFeedToken(a.owner);
    expect(await resolveFeedStore(db, feed.prefix, sha256(feed.token))).toBeNull(); // revoked

    expect(await resolveHandoffStore(db, sha256("unknown-code"))).toBeNull();
    expect(await resolveInvitationStore(db, sha256("unknown-token"))).toBeNull();
  });

  it("the resolvers return no column beyond what they promise", async () => {
    await makeStore("toko-a");
    const cols = async (query: string) => Object.keys((await run(db, query))[0] ?? {}).sort();
    expect(await cols(`select * from resolve_store_by_slug('toko-a')`)).toEqual(["id", "name", "slug"]);
    expect(await cols(`select resolve_cart_store('00000000-0000-4000-8000-000000000000'::uuid)`)).toEqual(["resolve_cart_store"]);
    // Every function owned by bukalaris_resolver is a `resolve_*` lookup returning one scalar (the slug and member lookups are checked above);
    // the retention and guard kinds and the restricted-table access functions (T-62) are different categories, covered by their own invariants.
    const defs = Object.entries(DEFINER_FUNCTIONS).filter(([k, f]) => f.owner === "bukalaris_resolver" && !/slug|member/.test(k)).map(([k]) => k);
    expect(defs.every((k) => k.startsWith("resolve_"))).toBe(true);
  });
});

describe("import boundary (ADR-0005 §5)", () => {
  const walk = (root: string, test: RegExp) => {
    const files: string[] = [];
    const visit = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) visit(p);
        else if (test.test(e.name)) files.push(p);
      }
    };
    visit(root);
    return files;
  };

  it("apps/web uses the platform pool only in lib/context.ts (operators), lib/auth.ts (account audit) and the local-only dev outbox viewer (T-73)", () => {
    const root = fileURLToPath(new URL("../../../apps/web/src/", import.meta.url));
    const files = walk(root, /\.(ts|tsx)$/);
    expect(files.length).toBeGreaterThan(50);
    const users = files.filter((f) => /\bplatformDb\b/.test(readFileSync(f, "utf8"))).map((f) => relative(root, f)).sort();
    expect(users).toEqual(["app/(public-services)/dev/outbox/page.tsx", "lib/auth.ts", "lib/console-gate.ts", "lib/context.ts", "lib/step-up.ts"]); // console-gate: the Owner console gate re-reads operator and grants (T-62); step-up: marks THIS session MFA-verified after the seller's fresh code, like the sign-in hook (T-37)
  });

  it("inside packages/db only the named platform services, the worker, cleanup and the seeds open the platform pool; no storefront, seller or resolver code does", () => {
    const root = fileURLToPath(new URL("../src/", import.meta.url));
    const users = walk(root, /\.ts$/).filter((f) => /\bplatformDb\(/.test(readFileSync(f, "utf8"))).map((f) => relative(root, f)).sort();
    const allowed = [
      "cleanup.ts", // maintenance across stores
      "client.ts", // the factory itself
      "demo/seed-demo.ts", // local seed
      "platform/membership.ts", // IAM-9 post-commit session revocation (named platform operation)
      "seed.ts", // local seed
      "worker.ts", // outbox worker
    ];
    expect(users.filter((f) => !allowed.includes(f))).toEqual([]);
  });
});
