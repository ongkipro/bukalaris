import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueuePlatform } from "../src/ops/jobs/jobs.ts";
import { dueStarts, periodKey, periodStart, schedulerHealth, schedulerTick, type Schedule } from "../src/ops/jobs/scheduler.ts";
import { withStore } from "../src/platform/tenant.ts";
import { job, schedulerCursor, schedulerHeartbeat } from "../src/schema.ts";
import { admin, db, makeStore, platform } from "./helpers.ts";

// Periodic enqueuer (JOB-21, T-74). Every case injects the clock; nothing sleeps.

const DAILY: Schedule = { kind: "test.daily", period: "day", catchUp: 7 };
const MONTHLY: Schedule = { kind: "test.monthly", period: "month", catchUp: 2 };
const at = (iso: string) => new Date(iso);
// 2026-10-28 09:00 Asia/Jakarta = 02:00Z
const D = (day: number, hourUtc = 2) => at(`2026-10-${String(day).padStart(2, "0")}T${String(hourUtc).padStart(2, "0")}:00:00Z`);
const run = (now: Date, schedules: Schedule[] = [DAILY], tickIntervalMs = 30_000) => schedulerTick(platform, { now, tickIntervalMs, schedules });
const keys = async (kind: string) => (await platform.select({ key: job.key }).from(job).where(eq(job.kind, kind)).orderBy(job.key)).map((r) => r.key);

beforeAll(async () => {
  await admin.execute(sql`insert into platform_job_kind (kind) values ('test.daily'), ('test.monthly') on conflict do nothing`);
});
afterAll(async () => {
  await admin.execute(sql`delete from platform_job_kind where kind in ('test.daily', 'test.monthly')`);
  await admin.execute(sql`truncate scheduler_heartbeat, scheduler_cursor`);
});
beforeEach(async () => {
  await admin.execute(sql`truncate job, scheduler_heartbeat, scheduler_cursor`);
});

describe("period keys are Asia/Jakarta", () => {
  it("day, month, hour and minute keys follow the Jakarta wall clock, including across the UTC date line", () => {
    const now = at("2026-10-28T17:30:00Z"); // 00:30 on the 29th in Jakarta
    expect(periodKey("day", now)).toBe("2026-10-29");
    expect(periodKey("month", at("2026-09-30T17:00:00Z"))).toBe("2026-10");
    expect(periodKey("month", at("2026-09-30T16:59:59Z"))).toBe("2026-09");
    expect(periodKey("hour", now)).toBe("2026-10-29T00");
    expect(periodKey("minute", now)).toBe("2026-10-29T00:30");
    expect(periodStart("day", now).toISOString()).toBe("2026-10-28T17:00:00.000Z");
  });

  it("dueStarts: first run is the current period; missed periods after the cursor are listed oldest first, capped by catchUp", () => {
    const cur = periodStart("day", D(28));
    expect(dueStarts(DAILY, null, D(28)).map((d) => periodKey("day", d))).toEqual(["2026-10-28"]);
    expect(dueStarts(DAILY, cur, D(28, 10))).toEqual([]);
    expect(dueStarts(DAILY, periodStart("day", D(25)), D(28)).map((d) => periodKey("day", d))).toEqual(["2026-10-26", "2026-10-27", "2026-10-28"]);
    expect(dueStarts({ ...DAILY, catchUp: 1 }, periodStart("day", D(20)), D(28)).map((d) => periodKey("day", d))).toEqual(["2026-10-27", "2026-10-28"]);
    expect(dueStarts({ ...DAILY, catchUp: 0 }, periodStart("day", D(20)), D(28)).map((d) => periodKey("day", d))).toEqual(["2026-10-28"]);
    expect(dueStarts(MONTHLY, periodStart("month", at("2026-07-15T00:00:00Z")), at("2026-10-28T02:00:00Z")).map((d) => periodKey("month", d))).toEqual(["2026-08", "2026-09", "2026-10"]);
  });
});

describe("periodic enqueuer", () => {
  it("two concurrent enqueuers, a repeated tick and a restart create exactly one job per period", async () => {
    const results = await Promise.all([run(D(28)), run(D(28)), run(D(28))]);
    expect(results.flatMap((r) => r.enqueued)).toEqual([{ kind: "test.daily", key: "2026-10-28" }]);
    expect(await run(D(28, 5))).toEqual({ enqueued: [] }); // same period, later tick
    await admin.execute(sql`truncate scheduler_heartbeat`); // restart with the liveness row lost: the cursor still holds
    expect(await run(D(28, 6))).toEqual({ enqueued: [] });
    expect(await keys("test.daily")).toEqual(["2026-10-28"]);
    expect(await platform.select().from(job).where(eq(job.kind, "test.daily"))).toMatchObject([{ storeId: null, payload: { period: "2026-10-28" }, status: "pending" }]);
    // A new period gives exactly one more.
    expect((await Promise.all([run(D(29)), run(D(29))])).flatMap((r) => r.enqueued)).toEqual([{ kind: "test.daily", key: "2026-10-29" }]);
    expect(await keys("test.daily")).toEqual(["2026-10-28", "2026-10-29"]);
  });

  it("a missed tick is caught up exactly once, oldest period first, and old periods beyond catchUp are skipped", async () => {
    await run(D(20));
    const caught = await run(D(23));
    expect(caught.enqueued.map((e) => e.key)).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(await run(D(23, 9))).toEqual({ enqueued: [] });
    expect(await keys("test.daily")).toEqual(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    // A long outage: only catchUp (2) missed months plus the current one.
    await run(at("2026-01-10T02:00:00Z"), [MONTHLY]);
    expect((await run(at("2026-10-28T02:00:00Z"), [MONTHLY])).enqueued.map((e) => e.key)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(await keys("test.monthly")).toEqual(["2026-01", "2026-08", "2026-09", "2026-10"]);
  });

  it("purging a finished periodic job never re-creates its period (the cursor, not the job table, remembers)", async () => {
    await run(D(28));
    await admin.execute(sql`delete from job where kind = 'test.daily'`); // what retention would do to a done row
    expect(await run(D(28, 8))).toEqual({ enqueued: [] });
    expect(await keys("test.daily")).toEqual([]);
  });

  it("an unregistered platform kind is refused by the database and the whole tick rolls back, heartbeat included", async () => {
    await run(D(28));
    const before = (await platform.select().from(schedulerHeartbeat))[0]!;
    await expect(run(D(29), [DAILY, { kind: "test.not-registered", period: "day", catchUp: 0 }])).rejects.toMatchObject({
      cause: { message: expect.stringContaining("not a registered platform-wide kind") },
    });
    expect(await keys("test.daily")).toEqual(["2026-10-28"]); // the 29th was rolled back with it
    expect((await platform.select().from(schedulerHeartbeat))[0]).toEqual(before);
    expect(await platform.select().from(schedulerCursor)).toMatchObject([{ kind: "test.daily" }]);
  });
});

describe("scheduler liveness", () => {
  it("reports absent, ok, then stale once the heartbeat is older than two intervals; recovers on the next tick", async () => {
    expect(await schedulerHealth(platform, { now: D(28) })).toMatchObject({ state: "absent", lastTickAt: null });
    await run(D(28), [DAILY], 30_000);
    const t0 = D(28).getTime();
    expect(await schedulerHealth(platform, { now: new Date(t0 + 59_000) })).toMatchObject({ state: "ok", ageMs: 59_000, tickIntervalMs: 30_000 });
    expect(await schedulerHealth(platform, { now: new Date(t0 + 61_000) })).toMatchObject({ state: "stale", ageMs: 61_000 });
    expect(await schedulerHealth(platform, { now: new Date(t0 + 61_000), missedTicks: 3 })).toMatchObject({ state: "ok" });
    await run(new Date(t0 + 62_000), [DAILY], 30_000);
    expect(await schedulerHealth(platform, { now: new Date(t0 + 63_000) })).toMatchObject({ state: "ok", ageMs: 1_000 });
  });

  it("a tick never moves the heartbeat backwards and records how many jobs it created", async () => {
    await run(D(29));
    await run(D(28)); // a skewed or late-arriving clock
    const [hb] = await platform.select().from(schedulerHeartbeat);
    expect(hb).toMatchObject({ lastTickAt: D(29), lastEnqueuedCount: 0 });
  });
});

describe("platform-wide jobs and tenant isolation", () => {
  it("only registered platform kinds may omit the store; the app role neither sees nor writes store-less jobs", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    await enqueuePlatform(platform, { kind: "test.daily", key: "2026-10-28" });
    // The database, not the caller, refuses a store-less job of any other kind (even for the BYPASSRLS platform role).
    await expect(enqueuePlatform(platform, { kind: "payment.instruction", key: "no-store" })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(platform.update(job).set({ kind: "payment.instruction" }).where(eq(job.kind, "test.daily"))).rejects.toMatchObject({ cause: { code: "23514" } });
    // The app role in any store context, and outside any, sees no store-less row.
    for (const storeId of [a.storeId, b.storeId]) {
      expect(await withStore(db, storeId, (tx) => tx.select().from(job))).toEqual([]);
    }
    expect(await db.select().from(job)).toEqual([]);
    // ... and cannot create one, registered kind or not (row-level security).
    await expect(withStore(db, a.storeId, (tx) => enqueuePlatform(tx, { kind: "test.daily", key: "2026-10-29" }))).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(withStore(db, a.storeId, (tx) => enqueuePlatform(tx, { kind: "payment.instruction", key: "x" }))).rejects.toThrow();
    expect(await keysAll()).toEqual(["2026-10-28"]);
    // A store-scoped job is still isolated per store.
    await platform.insert(job).values({ kind: "test.ok", key: "own", storeId: a.storeId });
    expect((await withStore(db, a.storeId, (tx) => tx.select({ key: job.key }).from(job))).map((r) => r.key)).toEqual(["own"]);
    expect(await withStore(db, b.storeId, (tx) => tx.select().from(job))).toEqual([]);
  });

  it("the app role has no access at all to the scheduler, registry and retention tables", async () => {
    for (const t of ["scheduler_heartbeat", "scheduler_cursor", "platform_job_kind", "retention_class", "retention_policy"]) {
      await expect(db.execute(`select * from ${t}`)).rejects.toMatchObject({ cause: { code: "42501" } });
      await expect(db.execute(`insert into ${t} default values`)).rejects.toMatchObject({ cause: { code: "42501" } });
    }
    // The platform role reads the registries but cannot rewrite them (they change by migration only).
    expect((await platform.execute(sql`select kind from platform_job_kind where kind = 'test.daily'`)).length).toBe(1);
    await expect(platform.execute(sql`insert into platform_job_kind (kind) values ('test.sneaky')`)).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(platform.execute(sql`update retention_class set row_filter = 'true'`)).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});

const keysAll = async () => (await platform.select({ key: job.key }).from(job).where(eq(job.kind, "test.daily"))).map((r) => r.key);
