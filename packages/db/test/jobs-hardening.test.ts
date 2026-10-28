import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimBatch,
  completeJob,
  enqueue,
  enqueuePlatform,
  failJob,
  heartbeatJobs,
  type Job,
  kindPolicy,
  LeaseLostError,
  markDispatched,
  MAX_ATTEMPTS,
  rebuildableProjections,
  rebuildProjection,
  reconcileUnknownJobs,
  registerHandler,
  registerPlatformHandler,
  registerProjection,
  registerReconciler,
  requeueDeadJob,
  resolveUnknownJob,
  runOnce,
} from "../src/index.ts";
import { deadLetters, jobLagByKind, REPLAY_AUDIT_ACTIONS, replayAudit } from "../src/ops/jobs/observability.ts";
import { auditLog, job, JOB_PRIORITIES } from "../src/schema.ts";
import { admin, makeOperator, makeStore, makeUser, platform } from "./helpers.ts";

// Job hardening (JOB-22, OBS-7, D-21, T-74): per-kind lease + heartbeat, priority classes, first-class `dead` and
// `unknown` states with the dispatch fence, audited requeue/reconcile, rebuildable projections, observability.

// Real delays on purpose: the lease clock is the database's now(), so the heartbeat tests need genuine elapsed time.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jobById = async (id: number) => (await platform.select().from(job).where(eq(job.id, id)))[0]!;
// Store creation audits too; only the actions this file is about.
const audits = () => platform.select().from(auditLog).where(inArray(auditLog.action, [...REPLAY_AUDIT_ACTIONS])).orderBy(auditLog.id);
/** Time travel: make a job due and its lease stale without waiting. */
const makeDue = (id: number) =>
  platform
    .update(job)
    .set({ nextAttemptAt: sql`now() - interval '1 second'`, lockedUntil: sql`case when ${job.lockedUntil} is null then null else now() - interval '1 second' end` })
    .where(eq(job.id, id));

const effects: string[] = []; // every "external call" the fake handlers make
registerHandler("test.long", async (_c, j) => {
  await sleep(j.key === "slow" ? 1_500 : 0);
}, { leaseMs: 600 });
registerHandler("test.dispatching", async ({ db }, j) => {
  await markDispatched(db, j);
  effects.push(`dispatch:${j.key}`);
}, { replaySafe: false });
registerHandler("test.dispatch-then-throw", async ({ db }, j) => {
  await markDispatched(db, j);
  effects.push(`dispatch:${j.key}`);
  throw new Error("provider timeout");
});
registerHandler("test.fail", async () => {
  throw new Error("boom");
});
registerHandler("test.replayable", async () => {}, { replaySafe: true });
registerPlatformHandler("test.platform", async (_c, j) => {
  effects.push(`platform:${j.storeId}`);
});
registerHandler("test.store-only", async () => {});

beforeAll(async () => {
  await admin.execute(sql`insert into platform_job_kind (kind) values ('test.platform'), ('test.store-only') on conflict do nothing`);
});
afterAll(async () => {
  await admin.execute(sql`delete from platform_job_kind where kind in ('test.platform', 'test.store-only')`);
  await admin.execute(sql`drop table if exists t74_fixture_projection, t74_fixture_source`);
});
beforeEach(() => {
  effects.length = 0;
});

async function newJob(kind: string, key: string) {
  const s = await makeStore(`s-${Math.random().toString(36).slice(2, 8)}`);
  const { id } = await enqueue(platform, { kind, storeId: s.storeId, key });
  return { id: id!, storeId: s.storeId };
}

describe("per-kind lease and heartbeat", () => {
  it("a kind's lease length is applied at claim, and a long job keeps its lease through the heartbeat", async () => {
    const s = await makeStore("toko-a");
    const slow = (await enqueue(platform, { kind: "test.long", storeId: s.storeId, key: "slow" })).id!;
    const fast = (await enqueue(platform, { kind: "test.long", storeId: s.storeId, key: "fast" })).id!;
    expect(kindPolicy("test.long").leaseMs).toBe(600);
    expect(await jobById(slow)).toMatchObject({ leaseMs: 600 });

    // The batch is [slow, fast]; the 600 ms lease of `fast` would expire while `slow` runs for 1.5 s, and so would
    // `slow`'s own. A second worker polling throughout must never get either.
    let finished = false;
    const worker = runOnce(platform, { workerId: "A", batch: 5 }).finally(() => (finished = true));
    const stolen: Job[] = [];
    while (!finished) {
      stolen.push(...(await claimBatch(platform, "B", 5)));
      await sleep(100);
    }
    expect(stolen).toEqual([]);
    expect(await worker).toMatchObject([{ id: slow, status: "done", attempts: 1 }, { id: fast, status: "done", attempts: 1 }]);
  });

  it("heartbeatJobs extends only the caller's own running jobs; a lost lease is reported", async () => {
    const a = await newJob("test.long", "k1");
    const [claimed] = await claimBatch(platform, "A", 1);
    expect(claimed!.lockedUntil!.getTime() - Date.now()).toBeLessThanOrEqual(700); // 600 ms lease, not the 60 s default
    expect(await heartbeatJobs(platform, "A", [a.id])).toEqual([a.id]);
    expect(await heartbeatJobs(platform, "B", [a.id])).toEqual([]);
    await makeDue(a.id);
    await claimBatch(platform, "B", 1); // lease expired: B reclaims
    expect(await heartbeatJobs(platform, "A", [a.id])).toEqual([]);
    expect(await heartbeatJobs(platform, "B", [a.id])).toEqual([a.id]);
  });
});

describe("priority classes (money before identity before bulk)", () => {
  it("enqueue fixes the class from the kind's policy", async () => {
    const s = await makeStore("toko-a");
    const kinds = ["payment.instruction", "shipment.book", "shipment.track", "order.notify", "signal.deliver", "test.unlisted"];
    for (const kind of kinds) await enqueue(platform, { kind, storeId: s.storeId, key: "p" });
    const rows = await platform.select({ kind: job.kind, priority: job.priority }).from(job).orderBy(job.id);
    expect(Object.fromEntries(rows.map((r) => [r.kind, r.priority]))).toEqual({
      "payment.instruction": JOB_PRIORITIES.money,
      "shipment.book": JOB_PRIORITIES.money,
      "shipment.track": JOB_PRIORITIES.money,
      "order.notify": JOB_PRIORITIES.identity,
      "signal.deliver": JOB_PRIORITIES.bulk,
      "test.unlisted": JOB_PRIORITIES.bulk,
    });
  });

  it("a bulk flood queued first cannot starve payment and shipment jobs: they are claimed first, even in every later round", async () => {
    const s = await makeStore("toko-a");
    const bulk = Array.from({ length: 400 }, (_, i) => ({ kind: "signal.deliver", key: `bulk-${i}`, storeId: s.storeId, priority: JOB_PRIORITIES.bulk }));
    await platform.insert(job).values(bulk); // 400 bulk jobs, all due, all older than what follows
    for (let i = 0; i < 3; i++) await enqueue(platform, { kind: "payment.instruction", storeId: s.storeId, key: `pay-${i}` });
    for (let i = 0; i < 2; i++) await enqueue(platform, { kind: "shipment.book", storeId: s.storeId, key: `ship-${i}` });
    for (let i = 0; i < 2; i++) await enqueue(platform, { kind: "order.notify", storeId: s.storeId, key: `mail-${i}` });
    const first = await claimBatch(platform, "W", 10);
    expect(first.map((j) => j.priority)).toEqual([0, 0, 0, 0, 0, 1, 1, 2, 2, 2]);
    expect(first.slice(0, 5).map((j) => j.key).sort()).toEqual(["pay-0", "pay-1", "pay-2", "ship-0", "ship-1"]);

    // Sustained load: each round brings new money jobs and more bulk; money still goes first, bulk is not lost.
    for (let round = 0; round < 5; round++) {
      await enqueue(platform, { kind: "payment.instruction", storeId: s.storeId, key: `late-${round}` });
      await platform.insert(job).values(Array.from({ length: 20 }, (_, i) => ({ kind: "signal.deliver", key: `more-${round}-${i}`, storeId: s.storeId, priority: JOB_PRIORITIES.bulk })));
      const batch = await claimBatch(platform, "W", 5);
      expect(batch[0]).toMatchObject({ key: `late-${round}`, priority: 0 });
    }
    const left = await platform.select({ n: sql<number>`count(*)::int` }).from(job).where(eq(job.status, "pending"));
    expect(left[0]!.n).toBeGreaterThan(300); // bulk is still queued, not dropped
  });
});

describe("terminal states: dead and unknown are first-class", () => {
  it("the status set is constrained in the database: dead and unknown are accepted, failed and anything else are refused", async () => {
    const a = await newJob("test.fail", "s");
    await platform.update(job).set({ status: "dead" }).where(eq(job.id, a.id));
    await platform.update(job).set({ status: "unknown" }).where(eq(job.id, a.id));
    for (const bad of ["failed", "bogus"]) {
      await expect(platform.update(job).set({ status: bad as never }).where(eq(job.id, a.id))).rejects.toMatchObject({ cause: { constraint_name: "job_status_chk" } });
    }
  });

  it("a poison job that keeps crashing its worker becomes dead after the attempt ceiling instead of looping forever", async () => {
    const a = await newJob("test.fail", "poison");
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const [c] = await claimBatch(platform, "W", 1);
      expect(c).toMatchObject({ id: a.id, attempts: i });
      await makeDue(a.id); // the worker died: no complete, no fail
    }
    expect(await claimBatch(platform, "W", 1)).toEqual([]);
    expect(await jobById(a.id)).toMatchObject({ status: "dead", attempts: MAX_ATTEMPTS, lockedBy: null, lastError: "lease expired on the last attempt" });
  });

  it("D-21: a crash BEFORE dispatch is requeued and runs once", async () => {
    const a = await newJob("test.dispatching", "before");
    const [c] = await claimBatch(platform, "A", 1);
    expect(c!.id).toBe(a.id); // A claims, then dies before markDispatched
    await makeDue(a.id);
    expect(await runOnce(platform, { workerId: "B" })).toMatchObject([{ id: a.id, status: "done", attempts: 2 }]);
    expect(effects).toEqual(["dispatch:before"]);
  });

  it("D-21: a crash AFTER dispatch makes the job unknown and it is never dispatched again", async () => {
    const a = await newJob("test.dispatching", "after");
    const [c] = await claimBatch(platform, "A", 1);
    await markDispatched(platform, c!);
    effects.push("dispatch:after"); // the external call went out; A dies before completing
    expect(await jobById(a.id)).toMatchObject({ status: "running", dispatchedAt: expect.any(Date) });
    await makeDue(a.id);
    expect(await runOnce(platform, { workerId: "B" })).toEqual([]); // not claimed, not run
    expect(await jobById(a.id)).toMatchObject({ status: "unknown", lockedBy: null, lockedUntil: null, lastError: expect.stringContaining("outcome unknown") });
    await makeDue(a.id);
    expect(await runOnce(platform, { workerId: "C" })).toEqual([]);
    expect(effects).toEqual(["dispatch:after"]);
    // The late original worker cannot complete or fail it either.
    expect(await completeJob(platform, c!)).toBe(false);
    expect(await failJob(platform, c!, new Error("late"))).toBe("lost");
  });

  it("D-21: a handler that throws after dispatching leaves the job unknown, not pending", async () => {
    const a = await newJob("test.dispatch-then-throw", "t");
    expect(await runOnce(platform, { workerId: "A" })).toMatchObject([{ id: a.id, status: "unknown", error: "Error: provider timeout" }]);
    await makeDue(a.id);
    expect(await runOnce(platform, { workerId: "A" })).toEqual([]);
    expect(effects).toEqual(["dispatch:t"]);
  });

  it("D-21: markDispatched refuses without a live lease, and the database refuses a dispatched job as pending", async () => {
    const a = await newJob("test.dispatching", "fence");
    const [c] = await claimBatch(platform, "A", 1);
    await makeDue(a.id);
    const [b] = await claimBatch(platform, "B", 1); // A's lease expired and B took over
    await expect(markDispatched(platform, c!)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await jobById(a.id)).toMatchObject({ lockedBy: "B", dispatchedAt: null });
    await markDispatched(platform, b!);
    await expect(
      platform.update(job).set({ status: "pending", lockedBy: null, lockedUntil: null }).where(eq(job.id, a.id)),
    ).rejects.toMatchObject({ cause: { constraint_name: "job_dispatch_chk" } });
  });

  it("D-21: an unknown job is reconciled, never re-dispatched blindly: confirmed completes it, absent re-queues it once", async () => {
    const op = await makeOperator(["ops.jobs.manage"]);
    const a = await newJob("test.dispatching", "r1");
    const b = await newJob("test.dispatching", "r2");
    for (const x of [a, b]) {
      const [c] = await claimBatch(platform, "A", 1);
      await markDispatched(platform, c!);
      await makeDue(c!.id);
    }
    await claimBatch(platform, "B", 5); // settles both as unknown
    expect(await Promise.all([a, b].map((x) => jobById(x.id).then((j) => j.status)))).toEqual(["unknown", "unknown"]);

    await resolveUnknownJob(op, { jobId: a.id, outcome: "effect_confirmed", evidence: "provider shows order 42" });
    expect(await jobById(a.id)).toMatchObject({ status: "done", lastError: null });
    await resolveUnknownJob(op, { jobId: b.id, outcome: "effect_absent", evidence: "provider has no such order" });
    expect(await jobById(b.id)).toMatchObject({ status: "pending", dispatchedAt: null });
    expect(await runOnce(platform, { workerId: "C" })).toMatchObject([{ id: b.id, status: "done" }]);
    expect(effects).toEqual(["dispatch:r2"]); // only the proven-absent one was dispatched again (the two earlier dispatches were done by markDispatched directly)

    await expect(resolveUnknownJob(op, { jobId: a.id, outcome: "effect_absent", evidence: "x" })).rejects.toMatchObject({ code: "not_unknown" });
    await expect(resolveUnknownJob(op, { jobId: 999_999, outcome: "effect_absent", evidence: "x" })).rejects.toMatchObject({ code: "not_found" });
    expect((await audits()).map((r) => [r.action, r.actorUserId])).toEqual([["jobs.reconcile", op.userId], ["jobs.reconcile", op.userId]]);
  });

  it("D-21: a registered reconciler settles unknown jobs from the system of record and leaves undecided ones alone", async () => {
    const verdicts = new Map<string, "done" | "absent" | "unknown">([["x1", "done"], ["x2", "unknown"], ["x3", "absent"]]);
    registerReconciler("test.dispatching", async (_db, j) => verdicts.get(j.key)!);
    const ids: Record<string, number> = {};
    for (const key of verdicts.keys()) {
      ids[key] = (await newJob("test.dispatching", key)).id;
    }
    for (const key of verdicts.keys()) {
      const [c] = await claimBatch(platform, "A", 1);
      await markDispatched(platform, c!);
      await makeDue(c!.id);
    }
    await claimBatch(platform, "B", 5);
    expect(await reconcileUnknownJobs(platform)).toEqual({ settled: 2, pending: 1 });
    expect(await Promise.all(Object.values(ids).map((id) => jobById(id).then((j) => j.status)))).toEqual(["done", "unknown", "pending"]);
    expect((await audits()).map((r) => r.actorUserId)).toEqual(["system:job-reconciler", "system:job-reconciler"]);
  });
});

describe("audited requeue (capability ops.jobs.manage, enforced by the service)", () => {
  it("requeues a dead replay-safe job with a fresh attempt budget and writes an audit row naming actor and reason", async () => {
    const op = await makeOperator(["ops.jobs.manage"]);
    const a = await newJob("test.replayable", "dl");
    await platform.update(job).set({ status: "dead", attempts: MAX_ATTEMPTS, lastError: "Error: boom" }).where(eq(job.id, a.id));
    await requeueDeadJob(op, { jobId: a.id, reason: "provider outage over" });
    expect(await jobById(a.id)).toMatchObject({ status: "pending", attempts: 0, lockedBy: null });
    expect(await audits()).toMatchObject([{ actorUserId: op.userId, action: "jobs.requeue", storeId: a.storeId, reason: `job:${a.id} kind:test.replayable provider outage over` }]);
    expect(await runOnce(platform, { workerId: "W" })).toMatchObject([{ id: a.id, status: "done" }]);
  });

  it("refuses a missing reason, a job that is not dead, an unknown job and a kind that is not replay-safe, writing nothing", async () => {
    const op = await makeOperator(["ops.jobs.manage"]);
    const live = await newJob("test.replayable", "live");
    const unsafe = await newJob("test.fail", "unsafe");
    const ship = await newJob("shipment.book", "ship");
    const unk = await newJob("test.replayable", "unk");
    await platform.update(job).set({ status: "dead" }).where(eq(job.id, unsafe.id));
    await platform.update(job).set({ status: "dead" }).where(eq(job.id, ship.id));
    await platform.update(job).set({ status: "unknown" }).where(eq(job.id, unk.id));
    await expect(requeueDeadJob(op, { jobId: unsafe.id, reason: "  " })).rejects.toMatchObject({ code: "reason_required" });
    await expect(requeueDeadJob(op, { jobId: live.id, reason: "r" })).rejects.toMatchObject({ code: "not_dead" });
    await expect(requeueDeadJob(op, { jobId: unk.id, reason: "r" })).rejects.toMatchObject({ code: "not_dead" });
    await expect(requeueDeadJob(op, { jobId: unsafe.id, reason: "r" })).rejects.toMatchObject({ code: "not_replay_safe" });
    await expect(requeueDeadJob(op, { jobId: ship.id, reason: "r" })).rejects.toMatchObject({ code: "not_replay_safe" }); // money kind: reconciled by its owner
    await expect(requeueDeadJob(op, { jobId: 999_999, reason: "r" })).rejects.toMatchObject({ code: "not_found" });
    expect(await audits()).toEqual([]);
    expect(await jobById(unsafe.id)).toMatchObject({ status: "dead" });
  });

  it("two concurrent requeues of one dead job: exactly one succeeds and one audit row is written", async () => {
    const op = await makeOperator(["ops.jobs.manage"]);
    const a = await newJob("test.replayable", "race");
    await platform.update(job).set({ status: "dead" }).where(eq(job.id, a.id));
    const r = await Promise.allSettled([1, 2, 3].map(() => requeueDeadJob(op, { jobId: a.id, reason: "r" })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected").map((x) => (x as PromiseRejectedResult).reason.code)).toEqual(["not_dead", "not_dead"]);
    expect(await audits()).toHaveLength(1);
  });
});

describe("platform handlers", () => {
  it("a platform kind runs with no store; a store-scoped handler is never given a store-less job (and vice versa)", async () => {
    const p = await enqueuePlatform(platform, { kind: "test.platform", key: "2026-10-28" });
    const s = await makeStore("toko-a");
    const mismatched = await enqueuePlatform(platform, { kind: "test.store-only", key: "m" });
    const out = await runOnce(platform, { workerId: "W" });
    expect(out).toMatchObject([
      { id: p.id, status: "done" },
      { id: mismatched.id, status: "pending", error: expect.stringContaining("registered as store-scoped but the job has no store") },
    ]);
    expect(effects).toEqual(["platform:null"]);
    const wrongWay = await enqueue(platform, { kind: "test.platform", storeId: s.storeId, key: "w" });
    expect(await runOnce(platform, { workerId: "W" })).toMatchObject([{ id: wrongWay.id, status: "pending", error: expect.stringContaining("registered as platform-wide but the job has a store") }]);
  });
});

describe("projection rebuild hook (affiliate_catalog, JOB-20/T-52)", () => {
  beforeAll(async () => {
    await admin.execute(sql`create table if not exists t74_fixture_source (id int primary key, name text not null)`);
    await admin.execute(sql`create table if not exists t74_fixture_projection (id int primary key, shout text not null)`);
    await admin.execute(sql`grant all on t74_fixture_source, t74_fixture_projection to bukalaris_platform`);
  });
  beforeEach(async () => {
    await admin.execute(sql`truncate t74_fixture_source, t74_fixture_projection`);
  });
  const log: string[] = [];
  registerProjection("fixture_catalog", async (tx) => {
    log.push("start");
    await tx.execute(sql`delete from t74_fixture_projection`);
    await sleep(50); // widen the window in which a second rebuild would interleave
    await tx.execute(sql`insert into t74_fixture_projection select id, upper(name) from t74_fixture_source`);
    log.push("end");
    return Number((await tx.execute<{ n: string }>(sql`select count(*) as n from t74_fixture_projection`))[0]!.n);
  });
  const state = async () => (await platform.execute<{ id: number; shout: string }>(sql`select id, shout from t74_fixture_projection order by id`)).map((r) => [r.id, r.shout]);

  it("rebuilds from the source, repairs drift, is idempotent, serialises concurrent runs and is audited", async () => {
    const op = await makeOperator(["ops.jobs.manage"]);
    expect(rebuildableProjections()).toContain("fixture_catalog");
    await platform.execute(sql`insert into t74_fixture_source values (1, 'kaos'), (2, 'topi')`);
    await platform.execute(sql`insert into t74_fixture_projection values (9, 'STALE')`); // drift: an offer the source no longer has

    expect(await rebuildProjection(op, { name: "fixture_catalog", reason: "T-52 drill" })).toEqual({ rows: 2 });
    const once = await state();
    expect(once).toEqual([[1, "KAOS"], [2, "TOPI"]]);
    await rebuildProjection(op, { name: "fixture_catalog", reason: "again" });
    expect(await state()).toEqual(once); // idempotent

    log.length = 0;
    await platform.execute(sql`insert into t74_fixture_source values (3, 'sepatu')`);
    await Promise.all([1, 2, 3].map(() => rebuildProjection(op, { name: "fixture_catalog", reason: "race" })));
    expect(log).toEqual(["start", "end", "start", "end", "start", "end"]); // never interleaved
    expect(await state()).toEqual([[1, "KAOS"], [2, "TOPI"], [3, "SEPATU"]]);

    const rows = await audits();
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ actorUserId: op.userId, action: "projection.rebuild", reason: "projection:fixture_catalog rows:2 T-52 drill" });
  });

  it("refuses an unregistered projection and a missing reason", async () => {
    const op = await makeOperator(["ops.jobs.manage"]);
    await expect(rebuildProjection(op, { name: "affiliate_catalog_not_registered", reason: "r" })).rejects.toMatchObject({ code: "unknown_projection" });
    await expect(rebuildProjection(op, { name: "fixture_catalog", reason: "" })).rejects.toMatchObject({ code: "reason_required" });
    expect(await audits()).toEqual([]);
  });

  it("a rebuild that fails rolls back: the projection keeps its previous state and nothing is audited", async () => {
    const op = await makeOperator(["ops.jobs.manage"]);
    registerProjection("fixture_broken", async (tx) => {
      await tx.execute(sql`delete from t74_fixture_projection`);
      throw new Error("source unreadable");
    });
    await platform.execute(sql`insert into t74_fixture_projection values (1, 'KEEP')`);
    await expect(rebuildProjection(op, { name: "fixture_broken", reason: "r" })).rejects.toThrow("source unreadable");
    expect(await state()).toEqual([[1, "KEEP"]]);
    expect(await audits()).toEqual([]);
  });
});

describe("observability (OBS-6, OBS-7)", () => {
  it("lag per kind and priority uses the injected clock and counts live, dead and unknown jobs", async () => {
    const s = await makeStore("toko-a");
    const now = new Date("2026-10-28T10:00:00Z");
    const mk = (kind: string, key: string, over: Partial<typeof job.$inferInsert>) =>
      platform.insert(job).values({ kind, key, storeId: s.storeId, priority: kindPolicy(kind).priority, ...over });
    await mk("payment.instruction", "p1", { nextAttemptAt: new Date("2026-10-28T09:50:00Z") }); // due 10 min
    await mk("payment.instruction", "p2", { nextAttemptAt: new Date("2026-10-28T09:58:00Z") });
    await mk("payment.instruction", "p3", { nextAttemptAt: new Date("2026-10-28T10:30:00Z") }); // not due yet
    await mk("signal.deliver", "s1", { nextAttemptAt: new Date("2026-10-28T09:00:00Z") });
    await mk("signal.deliver", "s2", { status: "dead", updatedAt: new Date("2026-10-28T08:00:00Z") });
    await mk("shipment.book", "b1", { status: "unknown", updatedAt: new Date("2026-10-28T09:00:00Z") });
    await mk("order.notify", "done", { status: "done" });
    expect(await jobLagByKind(platform, now)).toEqual([
      { kind: "payment.instruction", priority: 0, pending: 3, running: 0, dead: 0, unknown: 0, oldestDueAgeMs: 600_000 },
      { kind: "shipment.book", priority: 0, pending: 0, running: 0, dead: 0, unknown: 1, oldestDueAgeMs: null },
      { kind: "signal.deliver", priority: 2, pending: 1, running: 0, dead: 1, unknown: 0, oldestDueAgeMs: 3_600_000 },
    ]);
  });

  it("dead-letter counts, the list with requeue eligibility, and the replay audit", async () => {
    const op = await makeOperator(["ops.jobs.manage"]);
    const a = await newJob("test.replayable", "d1");
    const b = await newJob("shipment.book", "d2");
    const c = await newJob("test.replayable", "u1");
    await platform.update(job).set({ status: "dead", lastError: "Error: boom" }).where(eq(job.id, a.id));
    await platform.update(job).set({ status: "dead" }).where(eq(job.id, b.id));
    await platform.update(job).set({ status: "unknown" }).where(eq(job.id, c.id));
    const dl = await deadLetters(platform);
    expect(dl.counts).toEqual([
      { kind: "shipment.book", status: "dead", count: 1 },
      { kind: "test.replayable", status: "dead", count: 1 },
      { kind: "test.replayable", status: "unknown", count: 1 },
    ]);
    expect(dl.jobs.map((j) => [j.id, j.status, j.requeueable]).sort()).toEqual([[a.id, "dead", true], [b.id, "dead", false], [c.id, "unknown", false]].sort());

    await requeueDeadJob(op, { jobId: a.id, reason: "replay" });
    await resolveUnknownJob(op, { jobId: c.id, outcome: "effect_confirmed", evidence: "seen at provider" });
    expect((await replayAudit(platform)).map((r) => r.action)).toEqual(["jobs.reconcile", "jobs.requeue"]); // newest first
    expect((await deadLetters(platform)).counts).toEqual([{ kind: "shipment.book", status: "dead", count: 1 }]);
  });
});
