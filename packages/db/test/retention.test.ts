import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getHandler, runOnce } from "../src/ops/jobs/jobs.ts";
import { PURGE_BATCH, purgeBatch, purgeClass, RETENTION_PURGE_FN, type RetentionClass, setRetentionPeriod } from "../src/ops/jobs/retention.ts";
import { registeredSchedules, schedulerTick } from "../src/ops/jobs/scheduler.ts";
import { localRoleUrl } from "../src/local-roles.ts";
import { replayAudit } from "../src/ops/jobs/observability.ts";
import { admin, db, makeOperator, makeStore, makeUser, platform } from "./helpers.ts";

// Retention framework (JOB-28 to JOB-32, T-74, D-21). All purges are off by default and run only through the
// SECURITY DEFINER functions of the T-74 section of migration 0011.

const CLASSES = Object.keys(RETENTION_PURGE_FN) as RetentionClass[];
const ownerUrl = localRoleUrl(process.env.TEST_DATABASE_URL!, "bukalaris_owner");
const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
const count = async (table: string, where = "true") => Number((await admin.execute(`select count(*) as n from ${table} where ${where}`))[0]!.n);
const ago = (days: number) => sql`now() - make_interval(days => ${days})`;
const fn = async (c: RetentionClass, batch = 1000) => purgeBatch(platform, c, batch);

const addAudit = (n: number, days: number) =>
  admin.execute(sql`insert into audit_log (actor_user_id, action, created_at) select 'u', 'test.old', ${ago(days)} from generate_series(1, ${n})`);
const addLog = (n: number, days: number) =>
  admin.execute(sql`insert into system_log (level, module, message, environment, time) select 'error', 'm', 'msg', 'test', ${ago(days)} from generate_series(1, ${n})`);

beforeAll(async () => {
  await admin.execute(sql`truncate retention_policy, system_log`);
});
afterAll(async () => {
  await owner.unsafe("drop table if exists t74_ref_audit, t74_ref_cascade, t74_ref_job");
  await owner.end();
  await admin.execute(sql`truncate retention_policy, system_log, scheduler_heartbeat, scheduler_cursor`);
});
beforeEach(async () => {
  await admin.execute(sql`truncate retention_policy, system_log, scheduler_heartbeat, scheduler_cursor`);
  await owner.unsafe("truncate t74_ref_audit, t74_ref_cascade, t74_ref_job").catch(() => {});
});

const enable = async (c: RetentionClass, days: number) => {
  // The audit_log period has no product setter until T-59b (the database refuses it): these tests exercise the purge
  // function itself, so they enable that one class the way the owner role would.
  if (c === "audit_log") {
    await admin.execute(sql`insert into retention_policy (class, period_days) values (${c}, ${days}) on conflict (class) do update set period_days = excluded.period_days`);
    return;
  }
  const op = await makeOperator(["ops.jobs.manage"]);
  await setRetentionPeriod(op, { dataClass: c, days, reason: "test period" });
};

describe("purge is off by default", () => {
  it("the shipped SQL seeds no retention period anywhere, and the table is empty on a fresh database", async () => {
    const migration = readFileSync(fileURLToPath(new URL("../drizzle/0011_chain_a_foundation.sql", import.meta.url)), "utf8");
    const sqlText = migration.slice(migration.indexOf("===== T-74"), migration.indexOf("===== T-60"));
    expect(sqlText.length).toBeGreaterThan(1000);
    expect(sqlText).not.toMatch(/insert\s+into\s+"?retention_policy/i);
    expect(sqlText).not.toMatch(/period_days\s*(default|:=|=)\s*\d/i);
    expect(sqlText).not.toMatch(/interval\s+'\d/i);
    expect(await count("retention_policy")).toBe(0);
  });

  it("with no period configured every purge function deletes nothing, however old the rows are", async () => {
    const s = await makeStore("toko-a");
    await addAudit(3, 4000);
    await addLog(3, 4000);
    await admin.execute(sql`insert into signal_event (store_id, provider, event_id, event_name, payload, status, created_at) values (${s.storeId}, 'meta', 'e1', 'Purchase', '{}', 'sent', ${ago(4000)})`);
    await admin.execute(sql`insert into job (kind, key, store_id, status, updated_at) values ('x', 'done', ${s.storeId}, 'done', ${ago(4000)}), ('x', 'dead', ${s.storeId}, 'dead', ${ago(4000)})`);
    for (const c of CLASSES) expect(await fn(c)).toBe(0);
    expect([await count("audit_log", "action = 'test.old'"), await count("system_log"), await count("signal_event"), await count("job")]).toEqual([3, 3, 1, 2]);
  });

  it("clearing a period turns the purge off again", async () => {
    await addAudit(2, 100);
    await enable("audit_log", 30);
    await admin.execute(sql`delete from retention_policy where class = 'audit_log'`);
    expect(await fn("audit_log")).toBe(0);
    expect(await count("audit_log", "action = 'test.old'")).toBe(2);
  });
});

describe("an enabled purge removes only rows older than the configured period", () => {
  it("audit_log and system_log: the boundary is the configured number of days, in bounded batches", async () => {
    await addAudit(2, 31);
    await addAudit(3, 29);
    await addLog(2, 31);
    await addLog(1, 1);
    await enable("audit_log", 30);
    await enable("system_log", 30);
    expect(await fn("audit_log", 1)).toBe(1); // one batch of one
    expect(await purgeClass(platform, "audit_log")).toBe(1);
    expect(await purgeClass(platform, "system_log")).toBe(2);
    expect(await count("audit_log", "action = 'test.old'")).toBe(3); // the 29-day rows (and nothing newer touched)
    expect(await count("system_log")).toBe(1);
    expect(await purgeClass(platform, "audit_log")).toBe(0);
  });

  it("a sweep larger than one batch keeps going until the backlog is gone", async () => {
    await addAudit(PURGE_BATCH + 500, 90);
    await enable("audit_log", 30);
    expect(await purgeClass(platform, "audit_log")).toBe(PURGE_BATCH + 500);
  });

  it("signal_event never loses a pending event; job and job_dead are separate classes and never touch live or unknown jobs", async () => {
    const s = await makeStore("toko-a");
    const ev = (id: string, status: string) =>
      admin.execute(sql`insert into signal_event (store_id, provider, event_id, event_name, payload, status, created_at) values (${s.storeId}, 'meta', ${id}, 'Purchase', '{}', ${status}, ${ago(100)})`);
    await ev("sent", "sent");
    await ev("failed", "failed");
    await ev("pending", "pending");
    const j = (key: string, status: string) =>
      admin.execute(
        status === "running"
          ? sql`insert into job (kind, key, store_id, status, locked_by, locked_until, updated_at) values ('x', ${key}, ${s.storeId}, 'running', 'w', now() + interval '1 hour', ${ago(100)})`
          : sql`insert into job (kind, key, store_id, status, updated_at) values ('x', ${key}, ${s.storeId}, ${status}, ${ago(100)})`,
      );
    for (const st of ["done", "dead", "unknown", "pending", "running"]) await j(st, st);
    await j("fresh-done", "done");
    await admin.execute(sql`update job set updated_at = now() where key = 'fresh-done'`);

    await enable("signal_event", 30);
    expect(await purgeClass(platform, "signal_event")).toBe(2);
    expect(await count("signal_event", "event_id = 'pending'")).toBe(1);

    await enable("job", 30);
    expect(await purgeClass(platform, "job")).toBe(1); // only the old `done`
    expect(await count("job", "key in ('dead', 'unknown', 'pending', 'running', 'fresh-done')")).toBe(5);

    await enable("job_dead", 30);
    expect(await purgeClass(platform, "job_dead")).toBe(1); // only the old `dead`: dead letters go only when the owner sets their own period
    expect(await count("job", "key in ('unknown', 'pending', 'running', 'fresh-done')")).toBe(4);
  });

  it("setRetentionPeriod audits the change and refuses nonsense periods and a missing reason", async () => {
    const op = await makeOperator(["ops.jobs.manage"]);
    await setRetentionPeriod(op, { dataClass: "system_log", days: 45, reason: "privacy decision 2026-11" });
    expect(await count("retention_policy", "class = 'system_log' and period_days = 45")).toBe(1);
    expect((await replayAudit(platform))[0]).toMatchObject({ actorUserId: op.userId, action: "retention.set", reason: "class:system_log days:45 privacy decision 2026-11" });
    for (const days of [0, -3, 1.5, Number.NaN]) await expect(setRetentionPeriod(op, { dataClass: "system_log", days, reason: "r" })).rejects.toThrow("whole number of days");
    await expect(setRetentionPeriod(op, { dataClass: "system_log", days: 5, reason: " " })).rejects.toThrow("reason");
    await expect(admin.execute(sql`insert into retention_policy (class, period_days) values ('audit_log', 0)`)).rejects.toMatchObject({ cause: { constraint_name: "retention_policy_period_chk" } });
    await expect(admin.execute(sql`insert into retention_policy (class, period_days) values ('nope', 5)`)).rejects.toMatchObject({ cause: { code: "23503" } });
  });
});

describe("a row that a foreign key still references is never purged", () => {
  beforeAll(async () => {
    // Owned by the table owner like every real table, so the purge function (running as the owner) can read them.
    await owner.unsafe(`
      create table if not exists t74_ref_audit (id serial primary key, audit_id bigint not null references audit_log(id));
      create table if not exists t74_ref_cascade (id serial primary key, audit_id bigint not null references audit_log(id) on delete cascade);
      create table if not exists t74_ref_job (id serial primary key, kind text not null, key text not null, foreign key (kind, key) references job(kind, key));
    `);
  });

  it("is driven by the catalog: single-column, ON DELETE CASCADE and composite keys all protect their parent row", async () => {
    await addAudit(4, 100);
    const ids = (await admin.execute(sql`select id from audit_log where action = 'test.old' order by id`)).map((r) => Number(r.id));
    await owner.unsafe(`insert into t74_ref_audit (audit_id) values (${ids[0]})`);
    await owner.unsafe(`insert into t74_ref_cascade (audit_id) values (${ids[1]})`);
    await enable("audit_log", 30);
    expect(await purgeClass(platform, "audit_log")).toBe(2); // ids[2], ids[3]
    expect((await admin.execute(sql`select id from audit_log where action = 'test.old' order by id`)).map((r) => Number(r.id))).toEqual([ids[0], ids[1]]);
    expect(await count("t74_ref_cascade")).toBe(1); // the cascade child was not silently removed with its parent

    const s = await makeStore("toko-a");
    await admin.execute(sql`insert into job (kind, key, store_id, status, updated_at) values ('x', 'kept', ${s.storeId}, 'done', ${ago(100)}), ('x', 'gone', ${s.storeId}, 'done', ${ago(100)})`);
    await owner.unsafe(`insert into t74_ref_job (kind, key) values ('x', 'kept')`);
    await enable("job", 30);
    expect(await purgeClass(platform, "job")).toBe(1);
    expect((await admin.execute(sql`select key from job where kind = 'x'`)).map((r) => r.key)).toEqual(["kept"]);
    // Once the reference is gone the row becomes purgeable.
    await owner.unsafe(`delete from t74_ref_job`);
    expect(await purgeClass(platform, "job")).toBe(1);
  });
});

describe("the purge function is pinned to the owner, a fixed search_path and the real catalog", () => {
  it("every purge function is SECURITY DEFINER, owned by the table owner, with search_path pinned and pg_temp last", async () => {
    const rows = await admin.execute(sql`
      select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig::text as config,
             (select pg_get_userbyid(relowner) from pg_class where oid = 'public.audit_log'::regclass) as table_owner
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proname like 'retention_purge%' or p.proname = 'job_platform_kind_guard') order by 1`);
    expect(rows.map((r) => r.proname)).toEqual([
      "job_platform_kind_guard",
      "retention_purge",
      "retention_purge_access_event",
      "retention_purge_affiliate_click",
      "retention_purge_audit_log",
      "retention_purge_issue_report",
      "retention_purge_job",
      "retention_purge_job_dead",
      "retention_purge_signal_event",
      "retention_purge_system_log",
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ prosecdef: true, owner: r.table_owner, config: "{\"search_path=pg_catalog, pg_temp\"}" });
    }
  });

  it("the web app role cannot call any purge function, and the platform role cannot call the generic one", async () => {
    for (const c of CLASSES) {
      await expect(db.execute(`select ${RETENTION_PURGE_FN[c]}(10)`)).rejects.toMatchObject({ cause: { code: "42501" } });
      expect(await fn(c, 10)).toBe(0); // platform may call the named ones
    }
    await expect(db.execute(`select retention_purge('audit_log', 10)`)).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(platform.execute(`select retention_purge('audit_log', 10)`)).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(platform.execute(`select retention_purge_audit_log(0)`)).rejects.toMatchObject({ cause: { message: expect.stringContaining("batch must be between") } });
  });

  it("refuses to run when a temporary relation shadows a system catalog, and still protects referenced rows afterwards", async () => {
    await owner.unsafe(`create table if not exists t74_ref_audit (id serial primary key, audit_id bigint not null references audit_log(id))`);
    await addAudit(2, 100);
    const [keep] = (await admin.execute(sql`select id from audit_log where action = 'test.old' order by id`)).map((r) => Number(r.id));
    await owner.unsafe(`insert into t74_ref_audit (audit_id) values (${keep})`);
    await enable("audit_log", 30);

    const conn = await platform.$client.reserve(); // one dedicated platform-role session, as an attacker would hold
    try {
      // The spoof: an empty look-alike of pg_constraint in the caller's temporary schema, which an unqualified
      // `from pg_constraint` would read first and so find no foreign keys.
      await conn.unsafe(`create temp table pg_constraint (conrelid oid, confrelid oid, contype "char", conkey int2[], confkey int2[])`);
      await expect(conn.unsafe(`select retention_purge_audit_log(100)`)).rejects.toMatchObject({ message: expect.stringContaining("temporary relation shadows a system catalog") });
      expect(await count("audit_log", "action = 'test.old'")).toBe(2); // nothing was deleted
      await conn.unsafe(`drop table pg_temp.pg_constraint`);
      // Spoofing the project's own tables does not work either: they are referenced schema-qualified.
      await conn.unsafe(`create temp table retention_policy (class text, period_days int)`);
      await conn.unsafe(`insert into pg_temp.retention_policy values ('system_log', 1)`);
      await addLog(1, 100);
      expect(Number((await conn.unsafe(`select retention_purge_system_log(100) as n`))[0]!.n)).toBe(0); // the real (absent) policy decides
      expect(await count("system_log")).toBe(1);
      await conn.unsafe(`drop table pg_temp.retention_policy`);
      expect(Number((await conn.unsafe(`select retention_purge_audit_log(100) as n`))[0]!.n)).toBe(1);
    } finally {
      conn.release();
    }
    expect(await count("audit_log", "action = 'test.old'")).toBe(1);
  });
});

describe("sweeps are coordinated through the database", () => {
  it("every registered schedule has a registered platform kind and a platform handler; the four retention sweeps are daily", async () => {
    const kinds = registeredSchedules().map((s) => s.kind).sort();
    expect(kinds).toEqual(["retention.access_event", "retention.affiliate_click", "retention.audit_log", "retention.issue_report", "retention.job", "retention.signal_event", "retention.system_log"]);
    expect(registeredSchedules().every((s) => s.period === "day")).toBe(true);
    const registered = (await platform.execute<{ kind: string }>(sql`select kind from platform_job_kind`)).map((r) => r.kind);
    for (const k of kinds) {
      expect(registered).toContain(k);
      expect(getHandler(k)).toBeTypeOf("function");
    }
  });

  it("two schedulers produce one sweep per kind per day; the sweep purges what the configured period allows and nothing else", async () => {
    await addAudit(1_500, 90);
    await addAudit(2, 5);
    await addLog(4, 90);
    await enable("audit_log", 30); // system_log stays disabled
    const now = new Date("2026-10-28T02:00:00Z");
    const results = await Promise.all([schedulerTick(platform, { now, tickIntervalMs: 30_000 }), schedulerTick(platform, { now, tickIntervalMs: 30_000 })]);
    expect(results.flatMap((r) => r.enqueued).map((e) => e.kind).sort()).toEqual(["retention.access_event", "retention.affiliate_click", "retention.audit_log", "retention.issue_report", "retention.job", "retention.signal_event", "retention.system_log"]);
    expect((await schedulerTick(platform, { now: new Date("2026-10-28T09:00:00Z"), tickIntervalMs: 30_000 })).enqueued).toEqual([]);

    const out = await runOnce(platform, { workerId: "W", batch: 20 });
    expect(out.map((o) => o.status)).toEqual(["done", "done", "done", "done", "done", "done", "done"]);
    expect(await count("audit_log", "action = 'test.old'")).toBe(2);
    expect(await count("system_log")).toBe(4); // no period configured: untouched

    // The next day another sweep is created, once.
    const next = await schedulerTick(platform, { now: new Date("2026-10-29T02:00:00Z"), tickIntervalMs: 30_000 });
    expect(next.enqueued.map((e) => e.key)).toEqual(["2026-10-29", "2026-10-29", "2026-10-29", "2026-10-29", "2026-10-29", "2026-10-29", "2026-10-29"]);
  });
});
