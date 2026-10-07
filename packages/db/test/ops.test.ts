import { desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getSystemLog,
  hasPlatformCap,
  listSystemLogs,
  MODULE_MAP,
  moduleForRoute,
  recordLogEvent,
  requirePlatformCap,
  sanitizeEvent,
  scrubText,
} from "../src/ops.ts";
import { auditLog, operatorGrant, systemLog } from "../src/schema.ts";
import { operatorScope } from "../src/scoped.ts";
import { admin, db, makeOperator, makeStore, platform } from "./helpers.ts";

// helpers.ts truncates the M1 tables; this track owns its own.
beforeEach(async () => {
  await admin.execute("truncate system_log, operator_grant restart identity cascade");
});

async function reader() {
  const op = await makeOperator();
  await platform.insert(operatorGrant).values({ userId: op.userId, capability: "logs.read" });
  return op;
}
const event = (over: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) =>
  recordLogEvent(db, {
    level: "error",
    message: "Checkout gagal",
    module: "checkout",
    environment: "test",
    fields: { request_id: "req-aaaaaaaa", route: "/checkout", ...fields },
    ...over,
  });

describe("Log System sink (PR-11, OBS-5)", () => {
  it("drops forbidden keys and scrubs free text before the sink", async () => {
    const id = await event(
      { message: "Login gagal untuk budi@contoh.id dari postgres://user:pw@db:5432/x, telp 0812-3456-7890 Bearer abc.def" },
      {
        password: "hunter2",
        token: "tok_123",
        cookie: "session=abc",
        authorization: "Bearer xyz",
        shippingAddress: "Jl. Merdeka No. 1, Bandung",
        buyerPhone: "081234567890",
        nested: { secret: "s" },
        code: "ECONNREFUSED",
        store_id: 7,
        status: 500,
      },
    );
    const [row] = await platform.select().from(systemLog).where(eq(systemLog.id, id));
    expect(row!.fields).toEqual({ request_id: "req-aaaaaaaa", route: "/checkout", code: "ECONNREFUSED", store_id: 7, status: 500 });
    expect(row!.storeId).toBe(7);
    expect(row!.code).toBe("ECONNREFUSED");
    expect(row!.message).toBe("Login gagal untuk [email] dari [url] telp [digits] Bearer [redacted]");
    const dump = JSON.stringify(row);
    for (const canary of ["hunter2", "tok_123", "session=abc", "xyz", "Merdeka", "0812", "budi@", ":pw@"]) expect(dump).not.toContain(canary);
  });

  it("keeps structured identifiers verbatim while scrubbing free text", () => {
    const e = sanitizeEvent({
      level: "error",
      message: 'Failed query: select "id" from "store" where slug = $1 params: toko-a,081234567890',
      fields: { request_id: "87f7cc00-6444-468c-b888-f09f29bbe017", digest: "451206162", code: "ECONNREFUSED", route: "/s/[store]" },
    });
    expect(e.requestId).toBe("87f7cc00-6444-468c-b888-f09f29bbe017");
    expect(e.code).toBe("ECONNREFUSED");
    expect(e.fields.digest).toBe("451206162");
    expect(e.message).toBe('Failed query: select "id" from "store" where slug = $1');
  });

  it("caps text, defaults unknown levels/modules and maps routes to modules", () => {
    const e = sanitizeEvent({ level: "bogus" as never, message: "x".repeat(2000), fields: { page_id: "SF-07" } });
    expect(e).toMatchObject({ level: "error", module: "unknown", pageId: "SF-07", environment: "development" });
    expect(e.message).toHaveLength(500);
    expect(scrubText(undefined)).toBe("");
    expect(moduleForRoute("/app/s/[store]/products/[slug]/page")).toBe("storefront.product");
    expect(moduleForRoute("/app/seller/page")).toBe("seller.overview");
    expect(moduleForRoute("/app/seller/inventory/page")).toBe("seller.inventory");
    expect(moduleForRoute("/app/api/storefront/v1/carts/[cartId]/route")).toBe("api.storefront");
    expect(moduleForRoute("/app/checkout/h/invalid/page")).toBe("checkout.handoff.invalid");
    expect(moduleForRoute("/app/checkout/h/[code]/route")).toBe("checkout.handoff");
    expect(moduleForRoute("/app/admin/logs/[id]/page")).toBe("admin.logs.detail");
    expect(moduleForRoute("/admin")).toBe("admin.stores");
    expect(moduleForRoute("/app/whatever/page")).toBe("unknown");
    expect(moduleForRoute(undefined)).toBe("unknown");
  });

  it("denies operators without logs.read and sellers entirely", async () => {
    const plain = await makeOperator();
    expect(await hasPlatformCap(plain, "logs.read")).toBe(false);
    await expect(requirePlatformCap(plain, "logs.read")).rejects.toMatchObject({ code: "forbidden" });
    await expect(listSystemLogs(plain, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(getSystemLog(plain, 1)).rejects.toMatchObject({ code: "forbidden" });
    // A seller (even a store owner) never gets an OperatorScope, so no grant can exist for them.
    const s = await makeStore("toko-a");
    expect(await operatorScope(platform, s.ownerId)).toBeNull();
    await expect(platform.insert(operatorGrant).values({ userId: s.ownerId, capability: "logs.read" })).rejects.toThrow();
    // Denied reads leave no access-audit row and no diagnostic row.
    expect((await platform.select().from(auditLog)).filter((a) => a.action.startsWith("logs."))).toHaveLength(0);
    expect(await platform.select().from(systemLog)).toHaveLength(0);
  });

  it("lists with filters, pages by cursor, and audits every read", async () => {
    const op = await reader();
    const t0 = new Date("2026-10-06T10:00:00Z");
    const at = (m: number) => new Date(t0.getTime() + m * 60_000);
    await event({ time: at(0), level: "warn", module: "auth", message: "rate limited" }, { request_id: "req-bbbbbbbb", store_id: 1 });
    await event({ time: at(1) }, { store_id: 2 });
    await event({ time: at(2), module: "storefront.catalog" }, { store_id: 2 });
    const old = await event({ time: new Date(t0.getTime() - 2 * 60 * 60_000) });

    const base = { from: at(-5).toISOString(), to: at(5).toISOString() };
    const all = await listSystemLogs(op, base);
    expect(all.items.map((e) => e.module)).toEqual(["storefront.catalog", "checkout", "auth"]);
    expect(all.items.map((e) => e.id)).not.toContain(old);
    expect(all.nextCursor).toBeNull();

    expect((await listSystemLogs(op, { ...base, level: "warn" })).items.map((e) => e.module)).toEqual(["auth"]);
    expect((await listSystemLogs(op, { ...base, module: "checkout" })).items).toHaveLength(1);
    expect((await listSystemLogs(op, { ...base, requestId: "req-aaaaaaaa" })).items).toHaveLength(2);
    expect((await listSystemLogs(op, { ...base, storeId: "2" })).items).toHaveLength(2);
    expect((await listSystemLogs(op, { ...base, storeId: 99 })).items).toEqual([]);

    const page1 = await listSystemLogs(op, { ...base, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe(String(page1.items[1]!.id));
    const page2 = await listSystemLogs(op, { ...base, limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((e) => e.module)).toEqual(["auth"]);
    expect(page2.nextCursor).toBeNull();

    // Default range is the last hour; bounded to 24 h; from must precede to; filters are allowlisted.
    expect((await listSystemLogs(op, {})).items).toEqual([]);
    await expect(listSystemLogs(op, { from: at(5).toISOString(), to: at(0).toISOString() })).rejects.toMatchObject({ code: "invalid_range" });
    await expect(listSystemLogs(op, { from: "2026-10-01T00:00:00Z", to: "2026-10-03T00:00:00Z" })).rejects.toMatchObject({ code: "range_too_wide" });
    await expect(listSystemLogs(op, { requestId: "x; drop table" })).rejects.toMatchObject({ name: "ZodError" });

    const audits = await platform.select().from(auditLog).where(eq(auditLog.action, "logs.list")).orderBy(desc(auditLog.id));
    expect(audits).toHaveLength(9);
    expect(audits.every((a) => a.actorUserId === op.userId)).toBe(true);
    expect(JSON.parse(audits.at(-1)!.reason!)).toMatchObject({ from: base.from, to: base.to });
    // The diagnostic stream never contains the audit of its own reads.
    expect((await listSystemLogs(op, base)).items.some((e) => e.message.includes("logs.list"))).toBe(false);
  });

  it("detail returns correlated events and the page/module mapping, or null when unknown", async () => {
    const op = await reader();
    const a = await event({ module: "checkout" }, { request_id: "req-cccccccc" });
    const b = await event({ module: "storefront.cart", level: "warn" }, { request_id: "req-cccccccc" });
    await event({ module: "auth" }, { request_id: "req-other000" });
    const unmapped = await event({ module: "mystery" }, { request_id: undefined });

    const d = (await getSystemLog(op, a))!;
    expect(d.event.id).toBe(a);
    expect(d.related.map((e) => e.id)).toEqual([b]);
    expect(d.mapping).toEqual({ pageId: "SF-07", label: "Checkout" });

    const u = (await getSystemLog(op, unmapped))!;
    expect(u.related).toEqual([]);
    expect(u.mapping).toBeNull();

    expect(await getSystemLog(op, 999_999)).toBeNull();
    expect(await getSystemLog(op, -1)).toBeNull();
    const reads = await platform.select().from(auditLog).where(eq(auditLog.action, "logs.read"));
    expect(reads.map((r) => r.reason)).toEqual([`event:${a}`, `event:${unmapped}`, "event:999999"]);
  });
});

describe("page/module map covers every route (ARCH-5)", () => {
  it("maps each page.tsx/route.ts under apps/web/src/app to a known module", async () => {
    const { readdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../../../apps/web/src/app/", import.meta.url));
    const routes: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(`${dir}${e.name}/`, `${rel}/${e.name}`);
        else if (/^(page|route)\.tsx?$/.test(e.name)) routes.push(`/app${rel}/${e.name.replace(/\.tsx?$/, "")}`);
      }
    };
    walk(root, "");
    // Pages that deliberately have no Log System module: the marketing root and the dev-only outbox viewer.
    const exempt = new Set(["/app/page", "/app/dev/outbox/page"]);
    const unmapped = routes.filter((r) => !exempt.has(r) && moduleForRoute(r) === "unknown");
    expect(routes.length).toBeGreaterThan(40);
    expect(unmapped).toEqual([]);
    for (const r of routes) {
      const m = moduleForRoute(r);
      if (m !== "unknown") expect(MODULE_MAP[m], `${r} → ${m}`).toBeDefined();
    }
  });
});
