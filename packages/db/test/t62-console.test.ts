import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { revokeCapability } from "../src/ops/capabilities-grants.ts";
import { authorizeConsole, consoleDashboard, consoleJobHealth, consoleMutation, consoleProviderHealth, consoleSettings } from "../src/ops/console.ts";
import { enqueue } from "../src/ops/jobs/jobs.ts";
import { job } from "../src/ops/jobs/schema-jobs.ts";
import { requestApproval } from "../src/ops/capabilities-approvals.ts";
import { recordLogEvent } from "../src/ops/ops.ts";
import { auditLog, operatorGrant, platformOperator, store } from "../src/schema.ts";
import { issueReport } from "../src/ops/schema-console.ts";
import { operatorScope } from "../src/platform/scoped.ts";
import { setStoreStatus } from "../src/platform/platform.ts";
import { admin, db, makeOperator, makeStore, makeUser, platform } from "./helpers.ts";

const denials = (userId: string) => admin.select().from(auditLog).where(eq(auditLog.actorUserId, userId));
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);

beforeEach(async () => {
  await admin.execute(sql`truncate personal_data_access_event, system_log, job, issue_report cascade`);
});

describe("console gate (authorizeConsole): the database decides on every request", () => {
  it("a signed-in identity that is not an operator (seller, store owner) is refused with a denial row and no scope", async () => {
    const s = await makeStore("toko-a");
    expect(await code(authorizeConsole(platform, s.ownerId, "/admin"))).toBe("operator_inactive");
    expect((await denials(s.ownerId)).map((r) => [r.action, r.outcome, r.subjectId])).toEqual([["console.denied", "denied", "/admin"]]);
  });

  it("no grant and a wrong capability are refused with a denial row each; the right capability opens the page", async () => {
    const none = await makeOperator([]);
    expect(await code(authorizeConsole(platform, none.userId, "/admin/stores"))).toBe("forbidden");
    const wrong = await makeOperator(["logs.read"]);
    expect(await code(authorizeConsole(platform, wrong.userId, "/admin/stores"))).toBe("forbidden");
    expect((await denials(wrong.userId)).map((r) => [r.action, r.actorCapability, r.outcome])).toEqual([["operator.denied", "tenants.read", "denied"]]);
    const ok = await makeOperator(["tenants.read"]);
    await expect(authorizeConsole(platform, ok.userId, "/admin/stores")).resolves.toMatchObject({ route: { pageId: "SA-02" } });
    expect(await denials(ok.userId)).toEqual([]);
  });

  it("revocation takes effect on the very next request, an expired grant never counts", async () => {
    const boss = await makeOperator(["staff.manage"]);
    const target = await makeOperator(["tenants.read"]);
    await authorizeConsole(platform, target.userId, "/admin/stores");
    await revokeCapability(boss, { userId: target.userId, capability: "tenants.read", reason: "uji pencabutan" });
    expect(await code(authorizeConsole(platform, target.userId, "/admin/stores"))).toBe("forbidden");
    const timed = await makeOperator([]);
    await admin.insert(operatorGrant).values({ userId: timed.userId, capability: "tenants.read", expiresAt: new Date(Date.now() - 1000) });
    expect(await code(authorizeConsole(platform, timed.userId, "/admin/stores"))).toBe("forbidden");
  });

  it("an unlisted route and a dormant (P2, P1.5) route fail closed even for an operator who holds every related capability", async () => {
    const op = await makeOperator(["tenants.manage", "tenants.read", "updates.write", "dashboard.read"]);
    expect(await code(authorizeConsole(platform, op.userId, "/admin/not-listed"))).toBe("not_found");
    expect(await code(authorizeConsole(platform, op.userId, "/admin/domains"))).toBe("not_found"); // P2
    expect(await code(authorizeConsole(platform, op.userId, "/admin/updates"))).toBe("not_found"); // P1.5
    expect((await denials(op.userId)).map((r) => r.reason)).toEqual(["unlisted_or_dormant_route", "unlisted_or_dormant_route", "unlisted_or_dormant_route"]);
  });

  it("a deleted operator row (a valid cookie of a dead account) is refused, not served", async () => {
    const op = await makeOperator(["dashboard.read"]);
    await admin.delete(platformOperator).where(eq(platformOperator.userId, op.userId));
    expect(await code(authorizeConsole(platform, op.userId, "/admin"))).toBe("operator_inactive");
  });
});

describe("console mutation wrapper: capability, reason, change and audit row are one transaction", () => {
  const input = (storeId: number) => ({ capability: "tenants.manage" as const, action: "store.rename", targetKind: "store", targetId: String(storeId), reason: "alasan uji", reasonCode: "test_reason" });

  it("writes the change and the audit row (actor, capability, target, reason code, outcome) together", async () => {
    const s = await makeStore("toko-a");
    const op = await makeOperator(["tenants.manage"]);
    await consoleMutation(op, input(s.storeId), (tx) => tx.update(store).set({ name: "Baru" }).where(eq(store.id, s.storeId)));
    expect((await admin.select({ n: store.name }).from(store).where(eq(store.id, s.storeId)))[0]!.n).toBe("Baru");
    const [row] = (await denials(op.userId)).filter((r) => r.action === "store.rename");
    expect(row).toMatchObject({ actorCapability: "tenants.manage", subjectKind: "store", subjectId: String(s.storeId), purposeCode: "test_reason", outcome: "allowed", accessLevel: "write" });
  });

  it("refuses without the capability, with no side effect and a denial row; a missing reason code is refused before any change", async () => {
    const s = await makeStore("toko-a");
    const op = await makeOperator(["logs.read"]);
    let ran = false;
    expect(await code(consoleMutation(op, input(s.storeId), async () => void (ran = true)))).toBe("forbidden");
    expect(ran).toBe(false);
    expect((await denials(op.userId)).map((r) => r.action)).toEqual(["operator.denied"]);
    const ok = await makeOperator(["tenants.manage"]);
    expect(await code(consoleMutation(ok, { ...input(s.storeId), reasonCode: "Bad Code" }, async () => void (ran = true)))).toBe("reason_required");
    expect(ran).toBe(false);
  });

  it("an audit row that cannot be written aborts the whole mutation", async () => {
    const s = await makeStore("toko-a");
    const op = await makeOperator(["tenants.manage"]);
    await admin.execute(sql`create or replace function t62_audit_fail() returns trigger language plpgsql as $$ begin if new.action = 'store.rename' then raise exception 'audit down' using errcode = '53100'; end if; return new; end $$`);
    await admin.execute(sql`create trigger t62_audit_fail before insert on audit_log for each row execute function t62_audit_fail()`);
    try {
      await expect(consoleMutation(op, input(s.storeId), (tx) => tx.update(store).set({ name: "Nope" }).where(eq(store.id, s.storeId)))).rejects.toThrow();
      expect((await admin.select({ n: store.name }).from(store).where(eq(store.id, s.storeId)))[0]!.n).toBe("Toko toko-a");
    } finally {
      await admin.execute(sql`drop trigger if exists t62_audit_fail on audit_log`);
      await admin.execute(sql`drop function if exists t62_audit_fail()`);
    }
  });

  it("a grant revoked while the change is in flight (committed by another request) aborts the mutation and leaves nothing behind", async () => {
    const s = await makeStore("toko-a");
    const op = await makeOperator(["tenants.manage"]);
    expect(
      await code(
        consoleMutation(op, input(s.storeId), async (tx) => {
          await tx.update(store).set({ name: "Setengah" }).where(eq(store.id, s.storeId));
          await admin.delete(operatorGrant).where(eq(operatorGrant.userId, op.userId)); // committed on another connection
        }),
      ),
    ).toBe("forbidden");
    expect((await admin.select({ n: store.name }).from(store).where(eq(store.id, s.storeId)))[0]!.n).toBe("Toko toko-a");
    expect((await denials(op.userId)).filter((r) => r.action === "store.rename")).toEqual([]);
  });
});

describe("dashboard (SA-14): honest cards", () => {
  it("store slices sum to the total, every card is gated by its own capability, and only existing sources have data", async () => {
    const a = await makeStore("toko-a");
    await makeStore("toko-b");
    const boss = await makeOperator(["tenants.manage"]);
    await setStoreStatus(boss, a.storeId, { status: "suspended", reason: "uji penangguhan" });
    const op = await makeOperator(["dashboard.read", "tenants.read"]);
    const d = await consoleDashboard(op);
    expect(d.stores).toEqual({ state: "ok", data: { total: 2, active: 1, suspended: 1 } });
    expect(d.approvals).toEqual({ state: "hidden" }); // no four-eyes capability
    expect(d.issues).toEqual({ state: "hidden" });
    expect(d.jobs).toEqual({ state: "hidden" });
    const bare = await makeOperator(["dashboard.read"]);
    expect((await consoleDashboard(bare)).stores).toEqual({ state: "hidden" });
    expect(await code(consoleDashboard(await makeOperator([])))).toBe("forbidden");
  });

  it("pending approvals and the oldest age come from the table; open issues are grouped by page id", async () => {
    const requester = await makeOperator(["payouts.process", "dashboard.read"]);
    await requestApproval(requester, { actionKey: "payout.approve_transfer", targetKind: "payout", targetId: "p1", payload: { amount: 1 }, reason: "uji persetujuan" });
    const viewer = await makeOperator(["dashboard.read", "payouts.process", "ops.issues.manage"]);
    for (const [page, status] of [["SA-02", "new"], ["SA-02", "triaged"], ["SA-05", "new"], ["SA-05", "resolved"]] as const) {
      await admin.insert(issueReport).values({ reporterId: viewer.userId, clientRequestId: randomUUID(), pageId: page, route: "/admin", category: "other", severity: "low", description: "uji laporan", scrubbed: false, context: {}, status, dedupeKey: randomUUID(), resolvedAt: status === "resolved" ? new Date() : null });
    }
    const d = await consoleDashboard(viewer);
    expect(d.approvals).toMatchObject({ state: "ok", data: { pending: 1 } });
    expect(d.approvals.state === "ok" && d.approvals.data.oldest).toBeInstanceOf(Date);
    expect(d.issues).toEqual({ state: "ok", data: [{ pageId: "SA-02", open: 2 }, { pageId: "SA-05", open: 1 }] });
  });

  it("a failing source shows as its own error card and does not take the page down; it is never reported as zero", async () => {
    await makeStore("toko-a");
    const op = await makeOperator(["dashboard.read", "tenants.read", "ops.read"]);
    await admin.execute(sql`revoke select on job from bukalaris_platform`);
    try {
      const d = await consoleDashboard(op);
      expect(d.jobs).toEqual({ state: "error" });
      expect(d.stores).toMatchObject({ state: "ok", data: { total: 1 } });
    } finally {
      await admin.execute(sql`grant select, insert, update on job to bukalaris_platform`);
    }
  });
});

describe("system health (SA-36) and provider health (SA-35): sanitized, capability-gated", () => {
  it("dead letters carry a scrubbed error; the replay history needs audit.read in addition to ops.read", async () => {
    const s = await makeStore("toko-a");
    const { id } = await enqueue(platform, { kind: "order.notify", storeId: s.storeId, key: "k1" });
    await platform.update(job).set({ status: "dead", attempts: 10, lastError: "boom Bearer abcdefghijklmnop1234567890 postgres://user:pw@host/db contact budi@example.com" }).where(eq(job.id, id!));
    const reader = await makeOperator(["ops.read"]);
    const h = await consoleJobHealth(reader);
    expect(h.letters.jobs).toHaveLength(1);
    const e = h.letters.jobs[0]!.lastError!;
    expect(e).not.toMatch(/abcdefghijklmnop|user:pw|budi@example/);
    expect(h.letters.jobs[0]!.requeueable).toBe(true);
    expect(h.replay).toBeNull();
    expect((await consoleJobHealth(await makeOperator(["ops.read", "audit.read"]))).replay).toEqual([]);
    expect(await code(consoleJobHealth(await makeOperator(["logs.read"])))).toBe("forbidden");
  });

  it("an unknown provider is 'unknown' (no event), a failing one shows its last failure; no credential value is ever part of the result", async () => {
    await recordLogEvent(db, { level: "error", message: "provider call failed", module: "shipping", fields: { provider: "mengantar", api_key: "sk-live-canary-123456" } });
    const op = await makeOperator(["providers.read"]);
    const h = await consoleProviderHealth(op);
    const by = Object.fromEntries(h.providers.map((p) => [p.provider, p]));
    expect(by.mengantar!.lastFailureAt).toBeInstanceOf(Date);
    expect(by.autolaris).toMatchObject({ lastEventAt: null, lastFailureAt: null });
    expect(JSON.stringify(h)).not.toContain("sk-live-canary");
    expect(Object.keys(h.providers[0]!).sort()).toEqual(["lastEventAt", "lastFailureAt", "provider"]);
    expect(await code(consoleProviderHealth(await makeOperator([])))).toBe("forbidden");
  });

  it("settings need settings.manage and expose policy text, not values from secrets", async () => {
    const s = await consoleSettings(await makeOperator(["settings.manage"]));
    expect(s.rateLimits.map((r) => r.key)).toEqual(["Masuk (Better Auth)", "RL-ISSUE Lapor masalah"]);
    expect(await code(consoleSettings(await makeOperator([])))).toBe("forbidden");
  });
});

describe("a seller session is never an operator scope", () => {
  it("operatorScope of a store owner is null, so no console service can be reached with a seller identity", async () => {
    const s = await makeStore("toko-a");
    expect(await operatorScope(platform, s.ownerId)).toBeNull();
    expect(await operatorScope(platform, await makeUser("buyer-like"))).toBeNull();
  });
});
