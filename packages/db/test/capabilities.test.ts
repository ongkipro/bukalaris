import { existsSync, readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BREAK_GLASS_ALLOWLIST,
  FOUR_EYES_MATRIX,
  PLATFORM_CAPABILITIES,
  SENSITIVE_CAPABILITIES,
  hasPlatformCap,
  holdsCapability,
  requireNonStaffTarget,
  type PlatformCapability,
} from "../src/ops/capabilities.ts";
import { requestApproval, decideApproval } from "../src/ops/capabilities-approvals.ts";
import { grantAsSystem } from "../src/ops/capabilities-grants.ts";
import { LOCAL_SEED_OPERATOR_CAPABILITIES } from "../src/ops/capabilities-bootstrap.ts";
import { getSystemLog, listSystemLogs } from "../src/ops/ops.ts";
import { createStore, listStores, setStoreStatus, storeAudit } from "../src/platform/platform.ts";
import { createStoreForOwnerEmail, getStoreDetail } from "../src/storefront/content.ts";
import { marginRuleAudit } from "../src/shipping/shipping.ts";
import { setMargin } from "./t48-fixtures.ts";
import { operatorScope, type OperatorScope } from "../src/platform/scoped.ts";
import { auditLog, breakGlassGrant, operatorGrant, operatorGrantEvent, platformOperator, shippingMarginRule, store, systemLog, user } from "../src/schema.ts";
import { admin, db, makeOperator, makeStore, makeUser, platform } from "./helpers.ts";

const iam = readFileSync(new URL("../../../docs/07-IAM-RBAC-ABAC.md", import.meta.url), "utf8");
const tableRows = (from: string, to: string) =>
  iam
    .slice(iam.indexOf(from), iam.indexOf(to))
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .slice(2) // header and separator
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
/** A database error by its message: drizzle wraps the driver error and keeps it in `cause`. */
const dbError = (re: RegExp) => ({ cause: { message: expect.stringMatching(re) } });
const ticks = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

describe("capability catalogue (IAM-15, single source of truth)", () => {
  it("equals the IAM-15 catalogue table: every documented name exists once and nothing else does", () => {
    const documented = tableRows("### Capability catalogue", "**Sensitive grants**").flatMap((r) => ticks(r[1]!));
    expect(documented.length).toBeGreaterThan(45);
    expect(new Set(documented).size).toBe(documented.length);
    expect([...PLATFORM_CAPABILITIES].sort()).toEqual([...documented].sort());
    expect(new Set(PLATFORM_CAPABILITIES).size).toBe(PLATFORM_CAPABILITIES.length);
    // Names the block text calls out.
    for (const c of ["logs.read", "tenants.manage", "audit.read", "shipping.manage", "billing.manage", "payouts.process", "refunds.process", "payouts.reconcile", "affiliate.accounts.review", "affiliate.payout.process", "tax.manage", "ops.jobs.manage", "ops.issues.attachments"]) {
      expect(PLATFORM_CAPABILITIES).toContain(c);
    }
    // billing.ppn_toggle is a tax.manage action, never a capability.
    expect(PLATFORM_CAPABILITIES).not.toContain("billing.ppn_toggle");
  });

  it("the four_eyes_rule table equals the IAM-15 matrix and the code constant (seeded by migration, ppn_toggle absent)", async () => {
    const rows = (await platform.execute(sql`select action_key as k, capability as c, phase as p, active as a, max_validity > interval '0' as v from four_eyes_rule order by 1`)) as unknown as { k: string; c: string; p: string; a: boolean; v: boolean }[];
    expect(rows.map((r) => r.k)).toEqual(FOUR_EYES_MATRIX.map((r) => r.actionKey).sort());
    expect(Object.fromEntries(rows.map((r) => [r.k, r.c]))).toEqual(Object.fromEntries(FOUR_EYES_MATRIX.map((r) => [r.actionKey, r.capability])));
    expect(rows.every((r) => r.v)).toBe(true);
    // Against the documented matrix itself.
    const star: Record<string, string> = { "tax.approve": "tax.approve", "tax.remit": "tax.remit", "tax.period_reopen": "tax.period.close" };
    const documented: Record<string, string> = {};
    for (const r of tableRows("### Four-eyes matrix (single source)", "### Console bootstrap")) {
      for (const key of ticks(r[0]!)) documented[key] = star[key] ?? ticks(r[1]!)[0]!;
    }
    expect(Object.fromEntries(rows.map((r) => [r.k, r.c]))).toEqual(documented);
    for (const key of ["cod.manual_complete", "cod.reconcile_release", "grant.sensitive", "breakglass.approve"]) expect(documented[key]).toBeDefined();
    expect(documented["cod.reconcile_release"]).toBe("payouts.reconcile");
    expect(rows.map((r) => r.k)).not.toContain("billing.ppn_toggle");
    // Every rule capability is a catalogue name (CHECK) and the P2 or disabled actions stay inactive.
    expect(rows.filter((r) => r.a).every((r) => r.p === "P1")).toBe(true);
    expect(new Set(rows.filter((r) => !r.a).map((r) => r.k))).toEqual(new Set(["merge.execute", "ownership.recover", "privacy.export", "audit.export", "tax.approve", "tax.remit", "tax.period_reopen", "updates.publish"]));
  });

  it("the matrix is not writable at runtime", async () => {
    await expect(platform.execute(sql`insert into four_eyes_rule values ('x.y', 'logs.read', 'P1', interval '1 hour', true)`)).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(platform.execute(sql`update four_eyes_rule set active = false`)).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(platform.execute(sql`delete from four_eyes_rule`)).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(db.execute(sql`select 1 from four_eyes_rule`)).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("operator_grant only stores catalogue names, and the local demo operator set is grantable", async () => {
    const op = await makeOperator([]);
    await expect(platform.insert(operatorGrant).values({ userId: op.userId, capability: "billing.ppn_toggle" as PlatformCapability })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(platform.insert(operatorGrant).values({ userId: op.userId, capability: "payouts.nope" as PlatformCapability })).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await grantAsSystem(platform, { userId: op.userId, capabilities: LOCAL_SEED_OPERATOR_CAPABILITIES, source: "system_bootstrap", reason: "demo set" })).toHaveLength(LOCAL_SEED_OPERATOR_CAPABILITIES.length);
    expect(SENSITIVE_CAPABILITIES).toEqual(expect.arrayContaining(["staff.manage", "break_glass.approve", "payouts.process", "payouts.reconcile", "accounts.reveal", "audit.export", "shipping.manage"]));
  });

  it("the app role cannot read any capability table (platform and restricted classes)", async () => {
    for (const t of ["operator_grant", "operator_grant_event", "four_eyes_rule", "approval_request", "break_glass_grant", "session_mfa", "operator_step_up_proof"]) {
      await expect(db.execute(sql`select 1 from ${sql.identifier(t)}`), t).rejects.toMatchObject({ cause: { code: "42501" } });
    }
  });
});

// ---------------------------------------------------------------------------
// Every Owner console server operation checks its capability (T-60 Done-when).
// ---------------------------------------------------------------------------
type Fixture = { storeId: number; ownerId: string; ownerEmail: string };
async function fixture(): Promise<Fixture> {
  const s = await makeStore("toko-a");
  const [owner] = await platform.select({ email: user.email }).from(user).where(eq(user.id, s.ownerId));
  return { storeId: s.storeId, ownerId: s.ownerId, ownerEmail: owner!.email };
}
let n = 0;
const OPERATIONS: { name: string; cap: PlatformCapability; run: (op: OperatorScope, f: Fixture) => Promise<unknown> }[] = [
  { name: "listStores", cap: "tenants.read", run: (op) => listStores(op) },
  { name: "getStoreDetail", cap: "tenants.read", run: (op, f) => getStoreDetail(op, f.storeId) },
  { name: "storeAudit", cap: "audit.read", run: (op, f) => storeAudit(op, f.storeId) },
  { name: "createStore", cap: "tenants.manage", run: (op, f) => createStore(op, { slug: `baru-${++n}`, name: "Baru", ownerUserId: f.ownerId }) },
  { name: "createStoreForOwnerEmail", cap: "tenants.manage", run: (op, f) => createStoreForOwnerEmail(op, { slug: `lain-${++n}`, name: "Lain", ownerEmail: f.ownerEmail }) },
  { name: "setStoreStatus", cap: "tenants.manage", run: async (op, f) => setStoreStatus(op, f.storeId, { status: ((await platform.select({ s: store.status }).from(store).where(eq(store.id, f.storeId))))[0]!.s === "active" ? "suspended" : "active", reason: "alasan pengujian" }) },
  { name: "setMarginRule", cap: "shipping.manage", run: (op) => setMargin(op, { fixedIdr: 1000, percentBps: 250, roundTo: 500 }) },
  { name: "marginRuleAudit", cap: "shipping.manage", run: (op) => marginRuleAudit(op) },
  { name: "listSystemLogs", cap: "logs.read", run: (op) => listSystemLogs(op, {}) },
  { name: "getSystemLog", cap: "logs.read", run: (op) => getSystemLog(op, 1) },
];
const USED = [...new Set(OPERATIONS.map((o) => o.cap))];

async function snapshot() {
  const count = async (q: ReturnType<typeof sql>) => ((await platform.execute(q)) as unknown as { n: number }[])[0]!.n;
  return {
    stores: await count(sql`select count(*)::int as n from store`),
    status: ((await platform.execute(sql`select string_agg(status, ',' order by id) as s from store`)) as unknown as { s: string }[])[0]!.s,
    members: await count(sql`select count(*)::int as n from membership`),
    margin: await count(sql`select count(*)::int as n from shipping_margin_rule`),
    audit: await count(sql`select count(*)::int as n from audit_log where action <> 'operator.denied'`),
    logs: await count(sql`select count(*)::int as n from system_log`),
  };
}
const denials = async (userId: string) => (await platform.select().from(auditLog).where(eq(auditLog.actorUserId, userId))).filter((a) => a.action === "operator.denied");

describe("every Owner console operation checks its capability (IAM-15)", () => {
  beforeEach(async () => {
    await admin.execute("truncate system_log restart identity cascade");
    await admin.execute("truncate shipping_margin_rule");
  });

  for (const o of OPERATIONS) {
    it(`${o.name}: no grant and the wrong capabilities are refused with no side effect and a denial audit row; the right one works`, async () => {
      const f = await fixture();
      const before = await snapshot();

      const none = await makeOperator([]);
      await expect(o.run(none, f)).rejects.toMatchObject({ code: "forbidden" });
      // Wrong capability: every other capability the console uses, but not this one.
      const wrong = await makeOperator(USED.filter((c) => c !== o.cap));
      await expect(o.run(wrong, f)).rejects.toMatchObject({ code: "forbidden" });
      expect(await snapshot()).toEqual(before);
      expect((await denials(none.userId)).map((d) => d.reason)).toEqual([`capability ${o.cap}`]);
      expect((await denials(wrong.userId)).map((d) => d.reason)).toEqual([`capability ${o.cap}`]);

      const ok = await makeOperator([o.cap]);
      await expect(o.run(ok, f)).resolves.not.toThrow();
      expect(await denials(ok.userId)).toHaveLength(0);
    });

    it(`${o.name}: a revoked or expired grant stops working on the very next call`, async () => {
      const f = await fixture();
      const op = await makeOperator([o.cap]);
      await expect(o.run(op, f)).resolves.not.toThrow();
      await platform.delete(operatorGrant).where(eq(operatorGrant.userId, op.userId));
      await expect(o.run(op, f)).rejects.toMatchObject({ code: "forbidden" });

      const expiring = await makeOperator([]);
      await platform.insert(operatorGrant).values({ userId: expiring.userId, capability: o.cap, expiresAt: new Date(Date.now() + 60_000) });
      await expect(o.run(expiring, f)).resolves.not.toThrow();
      await platform.update(operatorGrant).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(operatorGrant.userId, expiring.userId));
      expect(await hasPlatformCap(expiring, o.cap)).toBe(false);
      await expect(o.run(expiring, f)).rejects.toMatchObject({ code: "forbidden" });
    });
  }

  it("a store-detail audit section needs audit.read on top of tenants.read", async () => {
    const f = await fixture();
    const readerOnly = await makeOperator(["tenants.read"]);
    expect((await getStoreDetail(readerOnly, f.storeId))?.audit).toBeNull();
    const withAudit = await makeOperator(["tenants.read", "audit.read"]);
    expect((await getStoreDetail(withAudit, f.storeId))?.audit?.[0]).toMatchObject({ action: "store.create" });
  });

  it("a seller (store owner, staff) never has an operator scope and cannot be granted a capability", async () => {
    const s = await makeStore("toko-b");
    expect(await operatorScope(platform, s.ownerId)).toBeNull();
    await expect(platform.insert(operatorGrant).values({ userId: s.ownerId, capability: "tenants.manage" })).rejects.toMatchObject({ cause: { code: "23503" } });
    expect(await holdsCapability(platform, s.ownerId, "tenants.manage")).toBe(false);
  });

  it("holding every capability never grants more than listed: grants are explicit rows, never implied", async () => {
    const op = await makeOperator(["tenants.manage"]);
    expect(await hasPlatformCap(op, "tenants.read")).toBe(false);
    expect(await hasPlatformCap(op, "audit.read")).toBe(false);
  });
});

describe("seller-payout and affiliate-payout grants are independent in both directions (IAM-13, IAM-15)", () => {
  const SELLER_SIDE = ["payouts.process", "refunds.process"] as const;
  const SELLER_ACTIONS = ["payout.approve_transfer", "refund.approve_transfer", "cod.manual_complete"] as const;

  it("payouts.process and refunds.process never imply affiliate.payout.process", async () => {
    const seller = await makeOperator([...SELLER_SIDE]);
    const second = await makeOperator([...SELLER_SIDE]);
    expect(await hasPlatformCap(seller, "affiliate.payout.process")).toBe(false);
    // Neither can ask for nor decide an affiliate payout approval.
    await expect(requestApproval(seller, { actionKey: "affiliate_payout.approve_transfer", targetKind: "affiliate_payout", targetId: "1", payload: { a: 1 }, reason: "uji lintas izin" })).rejects.toMatchObject({ code: "forbidden" });
    const affiliate = await makeOperator(["affiliate.payout.process"]);
    const other = await makeOperator(["affiliate.payout.process"]);
    const req = await requestApproval(affiliate, { actionKey: "affiliate_payout.approve_transfer", targetKind: "affiliate_payout", targetId: "1", payload: { a: 1 }, reason: "uji lintas izin" });
    await expect(decideApproval(second, req.id, "approve")).rejects.toMatchObject({ code: "forbidden" });
    await decideApproval(other, req.id, "approve");
  });

  it("affiliate.payout.process never implies payouts.process or refunds.process", async () => {
    const affiliate = await makeOperator(["affiliate.payout.process"]);
    const peer = await makeOperator(["affiliate.payout.process"]);
    for (const c of SELLER_SIDE) expect(await hasPlatformCap(affiliate, c)).toBe(false);
    for (const key of SELLER_ACTIONS) {
      await expect(requestApproval(affiliate, { actionKey: key, targetKind: "x", targetId: "1", payload: { k: key }, reason: "uji lintas izin" })).rejects.toMatchObject({ code: "forbidden" });
    }
    const seller = await makeOperator(["payouts.process"]);
    const req = await requestApproval(seller, { actionKey: "payout.approve_transfer", targetKind: "payout", targetId: "9", payload: { p: 9 }, reason: "uji lintas izin" });
    await expect(decideApproval(affiliate, req.id, "approve")).rejects.toMatchObject({ code: "forbidden" });
    await expect(decideApproval(peer, req.id, "approve")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a grant row grants exactly that capability and the database trigger agrees (no row-level shortcut)", async () => {
    const seller = await makeOperator(["payouts.process"]);
    const affiliate = await makeOperator(["affiliate.payout.process"]);
    const rows = await platform.select({ u: operatorGrant.userId, c: operatorGrant.capability }).from(operatorGrant).where(sql`${operatorGrant.userId} in (${seller.userId}, ${affiliate.userId})`);
    expect(rows.sort((a, b) => a.c.localeCompare(b.c))).toEqual([{ u: affiliate.userId, c: "affiliate.payout.process" }, { u: seller.userId, c: "payouts.process" }].sort((a, b) => a.c.localeCompare(b.c)));
    // Bypassing the service: the approval trigger itself refuses an approver from the other side.
    const req = await requestApproval(seller, { actionKey: "payout.approve_transfer", targetKind: "payout", targetId: "10", payload: { p: 10 }, reason: "uji lintas izin" });
    await expect(platform.execute(sql`update approval_request set status = 'approved', decided_by = ${affiliate.userId}, decided_at = now() where id = ${req.id}`)).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});

describe("break-glass is limited to the allowlist and never satisfies four-eyes (IAM-15, PRIV-9)", () => {
  const grant = (requestedBy: string, approvedBy: string, capabilities: string[]) =>
    platform.execute(sql`insert into break_glass_grant (requested_by, approved_by, capabilities, target_kind, target_id, case_id, reason, starts_at, expires_at)
      values (${requestedBy}, ${approvedBy}, ${sql.raw(`array[${capabilities.map((c) => `'${c}'`).join(",")}]::text[]`)}, 'account', '1', 'CASE-1', 'uji', now(), now() + interval '1 hour')`);

  it("the CHECK admits the allowlist and nothing else", async () => {
    // Both hold break_glass.approve so the insert guard (approver must hold it) passes and the CHECKs are what is under test.
    const a = await makeOperator(["break_glass.approve"]);
    const b = await makeOperator(["break_glass.approve"]);
    expect([...BREAK_GLASS_ALLOWLIST].sort()).toEqual(["accounts.read", "accounts.reveal", "finance.read", "tax.read"]);
    await expect(grant(a.userId, b.userId, [...BREAK_GLASS_ALLOWLIST])).resolves.toBeDefined();
    for (const bad of ["staff.manage", "staff.read", "break_glass.approve", "audit.read", "audit.export", "ledger.adjust", "payouts.process", "tenants.manage", "logs.read"]) {
      await expect(grant(a.userId, b.userId, ["accounts.read", bad]), bad).rejects.toMatchObject({ cause: { code: "23514" } });
    }
    await expect(grant(a.userId, b.userId, [])).rejects.toMatchObject({ cause: { code: "23514" } });
    // Two people, and a window that ends after it starts.
    await expect(grant(a.userId, a.userId, ["accounts.read"])).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(platform.execute(sql`insert into break_glass_grant (requested_by, approved_by, capabilities, target_kind, target_id, case_id, reason, starts_at, expires_at)
      values (${a.userId}, ${b.userId}, array['accounts.read'], 'account', '1', 'C', 'r', now(), now() - interval '1 minute')`)).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("a break-glass row is append-then-revoke only: never deleted, revoked and reviewed once, nothing else changes", async () => {
    const a = await makeOperator([]);
    const b = await makeOperator(["break_glass.approve"]);
    await grant(a.userId, b.userId, ["finance.read"]);
    const [row] = await platform.select({ id: breakGlassGrant.id }).from(breakGlassGrant);
    await expect(platform.execute(sql`delete from break_glass_grant`)).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(admin.execute(sql`delete from break_glass_grant`)).rejects.toMatchObject(dbError(/never deleted/));
    await expect(platform.execute(sql`update break_glass_grant set capabilities = array['accounts.read'] where id = ${row!.id}`)).rejects.toThrow();
    await expect(admin.execute(sql`update break_glass_grant set expires_at = expires_at + interval '1 day' where id = ${row!.id}`)).rejects.toMatchObject(dbError(/only the revoke and review fields/));
    await platform.execute(sql`update break_glass_grant set revoked_at = now() where id = ${row!.id}`);
    await expect(platform.execute(sql`update break_glass_grant set revoked_at = now() + interval '1 hour' where id = ${row!.id}`)).rejects.toMatchObject(dbError(/revoked once/));
    await platform.execute(sql`update break_glass_grant set reviewed_by = ${a.userId}, reviewed_at = now() where id = ${row!.id}`);
    await expect(platform.execute(sql`update break_glass_grant set reviewed_by = ${b.userId} where id = ${row!.id}`)).rejects.toMatchObject(dbError(/reviewed once/));
  });

  it("an active break-glass elevation never counts as holding a capability, so it never approves a four-eyes request", async () => {
    const requester = await makeOperator(["payouts.process"]);
    const elevated = await makeOperator([]);
    const approver = await makeOperator(["break_glass.approve"]);
    await grant(elevated.userId, approver.userId, [...BREAK_GLASS_ALLOWLIST]);
    expect(await hasPlatformCap(elevated, "finance.read")).toBe(false);
    expect(await hasPlatformCap(elevated, "accounts.reveal")).toBe(false);
    const req = await requestApproval(requester, { actionKey: "payout.approve_transfer", targetKind: "payout", targetId: "5", payload: { p: 5 }, reason: "uji break-glass" });
    await expect(decideApproval(elevated, req.id, "approve")).rejects.toMatchObject({ code: "forbidden" });
    // And the database refuses it even if a caller skipped the service.
    await expect(platform.execute(sql`update approval_request set status = 'approved', decided_by = ${elevated.userId}, decided_at = now() where id = ${req.id}`)).rejects.toMatchObject({ cause: { code: "42501" } });
    // break-glass cannot request either.
    await expect(requestApproval(elevated, { actionKey: "payout.approve_transfer", targetKind: "payout", targetId: "6", payload: { p: 6 }, reason: "uji break-glass" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await platform.select({ id: breakGlassGrant.id }).from(breakGlassGrant)).toHaveLength(1);
  });
});

describe("operator history and staff targets (IAM-15)", () => {
  it("operator_grant_event rows obey the source rules and are append-only", async () => {
    const op = await makeOperator([]);
    const ev = (over: Record<string, unknown>) => ({ operatorUserId: op.userId, capability: "logs.read" as const, action: "grant" as const, source: "product" as const, actorUserId: op.userId, reason: "uji", ...over });
    await expect(platform.insert(operatorGrantEvent).values(ev({ actorUserId: null }))).rejects.toMatchObject({ cause: { code: "23514" } }); // product needs an actor
    await expect(platform.insert(operatorGrantEvent).values(ev({ source: "system_bootstrap" }))).rejects.toMatchObject({ cause: { code: "23514" } }); // system has no actor
    await expect(platform.insert(operatorGrantEvent).values(ev({ source: "system_recovery", actorUserId: null, reason: "  " }))).rejects.toMatchObject({ cause: { code: "23514" } }); // reason required
    await expect(platform.insert(operatorGrantEvent).values(ev({ source: "other", actorUserId: null }))).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(platform.insert(operatorGrantEvent).values(ev({ action: "delete" }))).rejects.toMatchObject({ cause: { code: "23514" } });
    await platform.insert(operatorGrantEvent).values(ev({}));
    await platform.insert(operatorGrantEvent).values(ev({ source: "system_recovery", actorUserId: null, reason: "RUNBOOK recovery" }));
    await expect(platform.execute(sql`update operator_grant_event set reason = 'x'`)).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(platform.execute(sql`delete from operator_grant_event`)).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(admin.execute(sql`update operator_grant_event set reason = 'x'`)).rejects.toMatchObject(dbError(/append-only/));
    await expect(admin.execute(sql`delete from operator_grant_event`)).rejects.toMatchObject(dbError(/append-only/));
  });

  it("an identity with a platform_operator row is a staff identity: the guard answers not-found for accounts.* targets", async () => {
    const staff = await makeOperator([]);
    const seller = await makeUser("seller");
    await expect(requireNonStaffTarget(platform, staff.userId)).rejects.toMatchObject({ code: "not_found" });
    await expect(requireNonStaffTarget(platform, seller)).resolves.toBeUndefined();
    expect((await platform.select().from(platformOperator)).map((o) => o.userId)).toContain(staff.userId);
    expect(await platform.select().from(systemLog)).toHaveLength(0);
    expect((await platform.select().from(store)).length).toBe(0);
  });
});
