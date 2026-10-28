import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { canonicalPayload, requestApproval } from "../src/ops/capabilities-approvals.ts";
import { revokeCapability } from "../src/ops/capabilities-grants.ts";
import { claimBatch, enqueue, MAX_ATTEMPTS } from "../src/ops/jobs/jobs.ts";
import { rebuildProjection, registerProjection, requeueDeadJob, resolveUnknownJob } from "../src/ops/jobs/manage.ts";
import { RETENTION_PURGE_FN, setRetentionPeriod } from "../src/ops/jobs/retention.ts";
import { schedulerHealth, schedulerTick } from "../src/ops/jobs/scheduler.ts";
import { approvalRequest, breakGlassGrant, operatorGrant, operatorGrantEvent } from "../src/ops/schema-ops.ts";
import { job, schedulerHeartbeat } from "../src/ops/jobs/schema-jobs.ts";
import { withStore } from "../src/platform/tenant.ts";
import { getStoreDetail } from "../src/storefront/content.ts";
import { admin, makeOperator, makeStore, platform } from "./helpers.ts";

// Independent review of T-59 / T-60 / T-74 (2026-10-28). Every case below is a failure scenario that the review proved
// (or could not exclude) before the fix. Names say what must stay true.

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null) {
    if ("cause" in err && typeof err.cause === "object" && err.cause !== null && "code" in err.cause && typeof err.cause.code === "string") return err.cause.code;
    if ("code" in err && typeof err.code === "string") return err.code;
  }
  return undefined;
}
const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? res : []);
const denied = (p: Promise<unknown>) => p.then(() => "allowed", pgCode);

describe("retention: the platform login cannot choose a period, purge audit history or hide it", () => {
  it("platform cannot write retention_policy or retention_policy_event,", async () => {
    expect(await denied(platform.execute(sql`insert into retention_policy (class, period_days) values ('audit_log', 1)`))).toBe("42501");
    expect(await denied(platform.execute(sql`update retention_policy set period_days = 1`))).toBe("42501");
    expect(await denied(platform.execute(sql`delete from retention_policy`))).toBe("42501");
    expect(await denied(platform.execute(sql`insert into retention_policy_event (class, period_days, actor_user_id, reason) values ('audit_log', 1, 'x', 'y')`))).toBe("42501");
  });

  it("the audit-history attack of the review no longer works: without a period nothing is purged, and the period cannot be set around the setter", async () => {
    const s = await makeStore("toko-a");
    await admin.execute(sql`insert into audit_log (store_id, actor_user_id, action, created_at) values (${s.storeId}, ${s.ownerId}, 'old.row', now() - interval '400 days')`);
    await expect(platform.execute(sql`insert into retention_policy (class, period_days) values ('audit_log', 1) on conflict (class) do update set period_days = 1`)).rejects.toMatchObject({ cause: { code: "42501" } });
    const purged = rowsOf<{ n: number }>(await platform.execute(sql`select ${sql.raw(RETENTION_PURGE_FN.audit_log)}(1000)::int as n`));
    expect(purged[0]?.n).toBe(0);
    expect(rowsOf<{ n: number }>(await admin.execute(sql`select count(*)::int as n from audit_log where action = 'old.row'`))[0]?.n).toBe(1);
  });

  it("the setter needs ops.jobs.manage in the service AND in the database, and every change is an append-only event no purge can delete (UPDATE/DELETE)", async () => {
    const without = await makeOperator([]);
    await expect(setRetentionPeriod(without, { dataClass: "system_log", days: 30, reason: "no capability" })).rejects.toMatchObject({ code: "forbidden" });
    // The database refuses a caller who passes an actor without the grant, even when the service is bypassed.
    expect(await denied(platform.execute(sql`select retention_set_period('system_log', 30, ${without.userId}, 'raw call')`))).toBe("42501");
    expect(await denied(platform.execute(sql`select retention_set_period('system_log', 30, 'not-an-operator', 'raw call')`))).toBe("42501");

    const op = await makeOperator(["ops.jobs.manage"]);
    await setRetentionPeriod(op, { dataClass: "system_log", days: 30, reason: "privacy decision" });
    await setRetentionPeriod(op, { dataClass: "system_log", days: null, reason: "pause" });
    const events = rowsOf<{ class: string; period_days: number | null; actor_user_id: string }>(await admin.execute(sql`select class, period_days, actor_user_id from retention_policy_event where actor_user_id = ${op.userId} order by id`));
    expect(events).toEqual([
      { class: "system_log", period_days: 30, actor_user_id: op.userId },
      { class: "system_log", period_days: null, actor_user_id: op.userId },
    ]);
    // Append-only against the table owner too: UPDATE and DELETE are refused by trigger.
    for (const stmt of [sql`update retention_policy_event set reason = 'x'`, sql`delete from retention_policy_event`]) {
      await expect(admin.execute(stmt)).rejects.toMatchObject({ cause: { code: "42501" } });
    }
  });
});

describe("audit history cannot be put on a purge schedule by a forged actor (re-review P2)", () => {
  it("the audit_log period has no setter until operator identity is restricted: even a real holder is refused by the database", async () => {
    const op = await makeOperator(["ops.jobs.manage"]);
    await expect(setRetentionPeriod(op, { dataClass: "audit_log", days: 1, reason: "shorten" })).rejects.toMatchObject({ cause: { code: "0A000" } });
    // The platform login cannot name that holder either, and no policy row appeared.
    expect(await denied(platform.execute(sql`select retention_set_period('audit_log', 1, ${op.userId}, 'forged')`))).toBe("0A000");
    expect(rowsOf<{ n: number }>(await admin.execute(sql`select count(*)::int as n from retention_policy where class = 'audit_log'`))[0]?.n).toBe(0);
  });
});

describe("T-74 management services need ops.jobs.manage (TASKS T-74 slice 2: requeue refused without the capability)", () => {
  it("requeue, reconcile and projection rebuild are refused without the capability, and nothing changes", async () => {
    const s = await makeStore("toko-a");
    const without = await makeOperator([]);
    const dead = await jobIn(s.storeId, "k1", { status: "dead", attempts: MAX_ATTEMPTS });
    const unk = await jobIn(s.storeId, "k2", { status: "unknown", attempts: 1, dispatchedAt: new Date() });
    registerProjection("review_fixture", async () => 1);
    await expect(requeueDeadJob(without, { jobId: dead.id, reason: "r" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(resolveUnknownJob(without, { jobId: unk.id, outcome: "effect_absent", evidence: "e" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(rebuildProjection(without, { name: "review_fixture", reason: "r" })).rejects.toMatchObject({ code: "forbidden" });
    const rows = await platform.select({ id: job.id, status: job.status }).from(job).orderBy(job.id);
    expect(rows.map((r) => r.status)).toEqual(["dead", "unknown"]);
  });

  it("an unknown job dispatched on its LAST attempt is claimable again after 'effect absent' (it was stuck pending forever)", async () => {
    const s = await makeStore("toko-a");
    const op = await makeOperator(["ops.jobs.manage"]);
    const j = await jobIn(s.storeId, "last", { status: "unknown", attempts: MAX_ATTEMPTS, dispatchedAt: new Date() });
    await resolveUnknownJob(op, { jobId: j.id, outcome: "effect_absent", evidence: "provider has no such order" });
    const [claimed] = await claimBatch(platform, "W", 5);
    expect(claimed?.id).toBe(j.id);
    expect(claimed?.attempts).toBe(1);
  });
});

describe("scheduler: one worker with a wrong clock cannot hide a dead scheduler", () => {
  it("a heartbeat from the future is reported as skewed, never ok", async () => {
    const now = new Date();
    await schedulerTick(platform, { now: new Date(now.getTime() + 3 * 365 * 86_400_000), tickIntervalMs: 30_000, schedules: [] });
    expect((await schedulerHealth(platform, { now })).state).toBe("skewed");
    await admin.delete(schedulerHeartbeat);
    await schedulerTick(platform, { now, tickIntervalMs: 30_000, schedules: [] });
    expect((await schedulerHealth(platform, { now })).state).toBe("ok");
  });
});

describe("T-60: what the approver sees, who counts as the last holder, and the database guards", () => {
  it("an approval stores the exact canonical payload and the database refuses a stored text that does not hash to it", async () => {
    const requester = await makeOperator(["staff.manage"]);
    const payload = { userId: "someone", capability: "break_glass.approve", expiresAt: null };
    const { id, payloadSha256 } = await requestApproval(requester, { actionKey: "grant.sensitive", targetKind: "operator", targetId: "someone", payload, reason: "approve break glass for someone" });
    const [row] = await platform.select().from(approvalRequest).where(eq(approvalRequest.id, id));
    expect(row!.payloadCanonical).toBe(canonicalPayload(payload));
    expect(row!.payloadCanonical).toContain("break_glass.approve"); // the approver can read WHAT is approved
    expect(row!.payloadSha256).toBe(payloadSha256);
    await expect(admin.execute(sql`update approval_request set payload_canonical = '{}' where id = ${id}`)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      platform.insert(approvalRequest).values({ actionKey: "grant.sensitive", targetKind: "operator", targetId: "x", payloadSha256: "0".repeat(64), payloadCanonical: "{}", requestedBy: requester.userId, reason: "forged hash", expiresAt: sql`now() + interval '1 hour'` as unknown as Date }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("a time-limited holder does not count as the remaining holder of a protected capability", async () => {
    const a = await makeOperator(["staff.manage"]);
    const b = await makeOperator([]);
    const tomorrow = new Date(Date.now() + 86_400_000);
    await admin.insert(operatorGrant).values({ userId: b.userId, capability: "staff.manage", expiresAt: tomorrow }); // an expiring grant, as IAM-15 allows
    // b (expires tomorrow) is the only OTHER holder: revoking a would leave nobody standing tomorrow.
    await expect(revokeCapability(b, { userId: a.userId, capability: "staff.manage", reason: "off-boarding" })).rejects.toMatchObject({ code: "last_holder" });
  });

  it("the approval guard cannot be satisfied with a temporary table named operator_grant", async () => {
    const requester = await makeOperator(["staff.manage"]);
    const outsider = await makeOperator([]); // holds no capability at all
    const { id } = await requestApproval(requester, { actionKey: "grant.sensitive", targetKind: "operator", targetId: "z", payload: { z: 1 }, reason: "spoof attempt test" });
    // A session-local table that shadows the real one for unqualified lookups, as the review described.
    const attempt = platform.transaction(async (tx) => {
      await tx.execute(sql`create temp table operator_grant (user_id text, capability text, expires_at timestamptz) on commit drop`);
      await tx.execute(sql`insert into operator_grant values (${outsider.userId}, 'staff.manage', null)`);
      await tx.execute(sql`update approval_request set status = 'approved', decided_by = ${outsider.userId}, decided_at = now() where id = ${id}`);
    });
    await expect(attempt).rejects.toMatchObject({ cause: { code: "42501" } });
    expect((await platform.select({ s: approvalRequest.status }).from(approvalRequest).where(eq(approvalRequest.id, id)))[0]!.s).toBe("pending");
  });

  it("a break-glass grant can only be inserted with an approver who holds break_glass.approve", async () => {
    const requester = await makeOperator([]);
    const noGrant = await makeOperator([]);
    const approver = await makeOperator(["break_glass.approve"]);
    const row = (approvedBy: string) => ({ requestedBy: requester.userId, approvedBy, capabilities: ["accounts.read"], targetKind: "account", targetId: "a1", caseId: "CASE-1", reason: "support case", startsAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
    await expect(platform.insert(breakGlassGrant).values(row(noGrant.userId) as never)).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(platform.insert(breakGlassGrant).values(row(approver.userId) as never)).resolves.toBeDefined();
  });
});

describe("Owner console store detail keeps working once the platform grants are narrowed (T-59 contract)", () => {
  it("getStoreDetail reads only tables the registry grants to the platform role", async () => {
    const s = await makeStore("toko-a");
    const op = await makeOperator(["tenants.read", "audit.read"]);
    const detail = await getStoreDetail(op, s.storeId);
    expect(detail?.counts).toMatchObject({ products: 1, collections: 0, pages: 0, images: 0 });
  });
});

async function jobIn(storeId: number, key: string, set: Partial<typeof job.$inferInsert>) {
  const { id } = await enqueue(platform, { kind: "review.test", storeId, key });
  await platform.update(job).set(set).where(eq(job.id, id!));
  return { id: id! };
}

describe("tenant context: a nested store context does not leak into the outer transaction", () => {
  it("after withStore() returns inside an outer transaction the store setting is back to what it was", async () => {
    await platform.transaction(async (tx) => {
      const read = async () => rowsOf<{ v: string | null }>(await tx.execute(sql`select nullif(current_setting('app.store_id', true), '') as v`))[0]?.v ?? null;
      expect(await read()).toBeNull();
      await withStore(tx, 41, async (inner) => {
        expect(rowsOf<{ v: string }>(await inner.execute(sql`select current_setting('app.store_id', true) as v`))[0]?.v).toBe("41");
      });
      expect(await read()).toBeNull();
      await withStore(tx, 42, async () => {}); // a different store afterwards is a separate, complete context
      expect(await read()).toBeNull();
    });
  });
});
