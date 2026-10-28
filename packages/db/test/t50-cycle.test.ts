import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { paySubscription, recordSubscriptionInquiry } from "../src/billing/attempts.ts";
import { BILLING_CYCLE } from "../src/billing/jobs.ts";
import { runBillingCycle } from "../src/billing/cycle.ts";
import { dunningMessage } from "../src/billing/dunning.ts";
import { jakartaMidnight } from "../src/billing/period.ts";
import { setBillingControls } from "../src/billing/console.ts";
import { FakeAutoLaris } from "../src/payments/fake.ts";
import { setPaymentAdapter } from "../src/payments/jobs.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { registeredSchedules, schedulerTick } from "../src/ops/jobs/scheduler.ts";
import { FakeMailTransport, setMailTransport } from "../src/platform/mail-transport.ts";
import { job } from "../src/schema.ts";
import { admin, makeUser, platform } from "./helpers.ts";
import { attemptsOf, billingStore, billingTestSetup, drain, eventsOf, invoicesOf, operatorWith, providersOf, setSubscription, subscriptionOf } from "./t50-fixtures.ts";

// T-50 JOB-09: the hourly cycle (T-74 schedule), its idempotent replay, the no-back-billing rule, and the dunning schedule and message
// intents over mail_enqueue. Delivery itself is a fake transport here; real delivery is DEFERRED (Q-16): nothing below claims a mail was sent.

billingTestSetup();
const DAY = 86_400_000;
const mails = () => platform.execute(sql`select id, to_email, subject, text_body, delivery_status from mail_outbox order by id`) as unknown as Promise<{ id: number; to_email: string; subject: string; text_body: string; delivery_status: string }[]>;
const notices = async (storeId: number) => (await platform.execute(sql`select kind, ref, recipients from subscription_notice where store_id = ${storeId} order by id`)) as unknown as { kind: string; ref: string; recipients: number }[];
afterEach(() => {
  vi.unstubAllEnvs();
  setMailTransport(null);
});

describe("the periodic enqueuer (T-74) schedules the cycle once per hour, whatever number of workers tick", () => {
  it("registers billing.cycle as an hourly schedule with a platform handler; two schedulers and a repeat tick make one job per hour; replaying the job changes nothing", async () => {
    const s = await billingStore("toko-a");
    const sched = registeredSchedules().filter((x) => x.kind === BILLING_CYCLE);
    expect(sched).toEqual([{ kind: BILLING_CYCLE, period: "hour", catchUp: 0 }]);
    const now = new Date("2026-10-28T02:10:00Z");
    const ticks = await Promise.all([schedulerTick(platform, { now, tickIntervalMs: 30_000, schedules: sched }), schedulerTick(platform, { now, tickIntervalMs: 30_000, schedules: sched })]);
    expect(ticks.flatMap((t) => t.enqueued)).toHaveLength(1);
    expect((await schedulerTick(platform, { now: new Date(now.getTime() + 600_000), tickIntervalMs: 30_000, schedules: sched })).enqueued).toHaveLength(0); // same hour
    expect((await schedulerTick(platform, { now: new Date(now.getTime() + 3_600_000), tickIntervalMs: 30_000, schedules: sched })).enqueued).toHaveLength(1); // next hour
    const jobs = await platform.select().from(job).where(eq(job.kind, BILLING_CYCLE));
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.storeId === null)).toBe(true);
    const out = await runOnce(platform, { workerId: "t50", batch: 5 });
    expect(out.filter((o) => o.kind === BILLING_CYCLE).map((o) => o.status)).toEqual(["done", "done"]);
    expect(await invoicesOf(s.storeId)).toHaveLength(1); // two jobs, one invoice
    expect(await eventsOf(s.storeId, "invoice_created")).toHaveLength(1);
  });
});

describe("idempotent cron replay and no back-billing", () => {
  it("a cycle replayed (same instant, later instant in the same period, two at once) creates no second invoice, transition or event", async () => {
    const s = await billingStore("toko-a");
    const t0 = new Date();
    await runBillingCycle(platform, { now: t0 });
    const snapshot = async () => ({ invoices: await invoicesOf(s.storeId), events: (await eventsOf(s.storeId)).length, sub: await subscriptionOf(s.storeId) });
    const before = await snapshot();
    await Promise.all([runBillingCycle(platform, { now: t0 }), runBillingCycle(platform, { now: new Date(t0.getTime() + 60_000) }), runBillingCycle(platform, { now: new Date(t0.getTime() + 120_000) })]);
    expect(await snapshot()).toEqual(before);
  });

  it("a store unpaid for months is billed for the CURRENT period only: elapsed unpaid periods are void 'lapsed', never back-billed, and the anchor is kept", async () => {
    const s = await billingStore("toko-a");
    const trialEndsAt = new Date(Date.now() - 100 * DAY);
    await setSubscription(s.storeId, { trialEndsAt });
    const anchor = (await subscriptionOf(s.storeId)).billingAnchorDate;
    // an invoice the store never paid for period 0, created while it was current
    await platform.execute(sql`insert into subscription_invoice (store_id, number, period_index, period_start, period_end, plan_id, dpp_idr, total_idr, due_at, source, created_by)
      select ${s.storeId}, 'SUB-000000000AAB', 0, ${anchor}::date, (${anchor}::date + interval '1 month')::date, id, 175000, 175000, now(), 'cron', 'raw' from subscription_plan limit 1`);
    const summary = await runBillingCycle(platform);
    expect(summary).toMatchObject({ lapsed: 1, invoicesCreated: 1, errors: [] });
    const rows = await invoicesOf(s.storeId);
    expect(rows.filter((r) => r.status === "void").map((r) => [r.periodIndex, r.voidReason])).toEqual([[0, "lapsed"]]);
    const current = rows.find((r) => r.status === "pending")!;
    expect(jakartaMidnight(current.periodEnd).getTime()).toBeGreaterThan(Date.now()); // the first period whose end is in the future
    expect(jakartaMidnight(current.periodStart).getTime()).toBeLessThanOrEqual(Date.now());
    expect(rows).toHaveLength(2); // periods 1 and 2 (elapsed, never invoiced) are not back-billed
    expect((await subscriptionOf(s.storeId)).billingAnchorDate).toBe(anchor);
    // paying it covers exactly that period and restores writes
    const p = new FakeAutoLaris();
    setPaymentAdapter(p);
    const r = await paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p));
    expect(r.invoice.id).toBe(current.id);
    await drain(p);
    const a = (await attemptsOf(r.invoice.id))[0]!;
    await recordSubscriptionInquiry({ exec: platform, storeId: s.storeId }, a.id, { rc: "00", data: { status: "PAID", amount: a.totalIdr } }, { source: "callback", mode: "fake" });
    const sub = await subscriptionOf(s.storeId);
    expect(sub.status).toBe("active");
    expect(sub.currentPeriodEnd!.getTime()).toBe(jakartaMidnight(current.periodEnd).getTime());
  });

  it("the next period's invoice appears one lead before the covered period ends, so renewal can be paid before access lapses; the paid period is never re-invoiced", async () => {
    const s = await billingStore("toko-a");
    await runBillingCycle(platform);
    const [first] = await invoicesOf(s.storeId);
    const p = new FakeAutoLaris();
    setPaymentAdapter(p);
    await paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(p));
    await drain(p);
    const a = (await attemptsOf(first!.id))[0]!;
    await recordSubscriptionInquiry({ exec: platform, storeId: s.storeId }, a.id, { rc: "00", data: { status: "PAID", amount: a.totalIdr } }, { source: "callback", mode: "fake" });
    const end = jakartaMidnight(first!.periodEnd).getTime();
    expect((await runBillingCycle(platform, { now: new Date(end - 10 * DAY) })).invoicesCreated).toBe(0); // outside the lead window, period 0 covered
    expect((await runBillingCycle(platform, { now: new Date(end - 3 * DAY) })).invoicesCreated).toBe(1); // window opens exactly one lead before the end
    expect((await runBillingCycle(platform, { now: new Date(end - 2 * DAY) })).invoicesCreated).toBe(0); // and only once
    expect((await invoicesOf(s.storeId)).map((i) => [i.periodIndex, i.status])).toEqual([[0, "paid"], [1, "pending"]]);
  });
});

describe("dunning: the schedule and the message intents over the durable mail outbox (real delivery is DEFERRED)", () => {
  async function ownerAndStaff(s: { storeId: number }) {
    const staffId = await makeUser("staff");
    await platform.execute(sql`insert into membership (store_id, user_id, role) values (${s.storeId}, ${staffId}, 'staff')`);
  }

  it("is OFF by default: a full lifecycle queues no mail until an operator switches dunning on", async () => {
    const s = await billingStore("toko-a");
    const t = (await subscriptionOf(s.storeId)).trialEndsAt.getTime();
    for (const at of [t - 3600_000, t + 1000, t + 3 * DAY + 1000]) await runBillingCycle(platform, { now: new Date(at) });
    expect(await mails()).toEqual([]);
    expect(await notices(s.storeId)).toEqual([]);
  });

  it("queues each notice once, to the store owners only, at the right states, and a replayed or repeated cycle queues nothing more", async () => {
    const s = await billingStore("toko-a");
    await ownerAndStaff(s);
    await admin.execute(sql`update billing_control set dunning_enabled = true`);
    const t = (await subscriptionOf(s.storeId)).trialEndsAt.getTime();
    const run = (at: number) => runBillingCycle(platform, { now: new Date(at) });
    await run(t - 2 * DAY); // trial running, ending in 2 days: outside the 1-day lead; the invoice for period 0 is due
    expect((await notices(s.storeId)).map((n) => n.kind)).toEqual(["invoice_ready"]);
    await run(t - 3600_000);
    await run(t - 3600_000); // replay
    expect((await notices(s.storeId)).map((n) => n.kind)).toEqual(["invoice_ready", "trial_ending"]);
    await run(t + 1000);
    await run(t + 2 * DAY + 3600_000 * 12); // within the last day of grace
    await run(t + 3 * DAY + 1000);
    await run(t + 3 * DAY + 2000);
    expect((await notices(s.storeId)).map((n) => n.kind)).toEqual(["invoice_ready", "trial_ending", "past_due", "grace_ending", "suspended"]);
    expect((await notices(s.storeId)).every((n) => n.recipients === 1)).toBe(true); // the one owner; the staff member gets nothing
    const out = await mails();
    expect(out).toHaveLength(5);
    expect(new Set(out.map((m) => m.to_email)).size).toBe(1);
    expect(out.every((m) => m.delivery_status === "pending")).toBe(true); // an intent, not a delivery
    // honest wording: reminders are never described as sent, and the data-safety line is present
    for (const m of out) {
      expect(m.text_body).not.toMatch(/terkirim|telah dikirim/i);
      expect(m.text_body).toContain("/seller/billing");
    }
  });

  it("a mail that cannot be queued leaves no notice, so the next run retries (production without a configured provider refuses to queue)", async () => {
    const s = await billingStore("toko-a");
    await admin.execute(sql`update billing_control set dunning_enabled = true`);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAIL_MODE", "provider"); // no MAIL_PROVIDER / MAIL_FROM: the T-73 gate refuses
    const t = (await subscriptionOf(s.storeId)).trialEndsAt.getTime();
    const failed = await runBillingCycle(platform, { now: new Date(t + 1000) });
    expect(failed.errors.map((e) => e.storeId)).toEqual([s.storeId]);
    expect(await notices(s.storeId)).toEqual([]);
    expect(await mails()).toEqual([]);
    vi.unstubAllEnvs();
    await runBillingCycle(platform, { now: new Date(t + 1000) });
    expect((await notices(s.storeId)).map((n) => n.kind)).toContain("past_due");
  });

  it("through the fake transport the intents travel the T-73 delivery path; the database says delivered only because the (fake) transport answered", async () => {
    const s = await billingStore("toko-a");
    await admin.execute(sql`update billing_control set dunning_enabled = true`);
    const fake = new FakeMailTransport("accepted");
    setMailTransport(fake);
    vi.stubEnv("MAIL_MODE", "provider");
    vi.stubEnv("MAIL_PROVIDER", "fake");
    vi.stubEnv("MAIL_FROM", "billing@example.test");
    const t = (await subscriptionOf(s.storeId)).trialEndsAt.getTime();
    await runBillingCycle(platform, { now: new Date(t + 1000) });
    const queued = (await mails()).length;
    expect(queued).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) await runOnce(platform, { workerId: "t50-mail", batch: 20 });
    expect(fake.sent).toHaveLength(queued);
    expect((await mails()).every((m) => m.delivery_status === "accepted")).toBe(true);
    expect(fake.sent.every((m) => m.to.endsWith(".test.local") || m.to.includes("@"))).toBe(true);
  });

  it("message intents state the amount, the period (end exclusive) and never promise delivery or deletion", () => {
    const base = { storeName: "Toko A", trialEndsAt: new Date("2026-10-29T03:00:00Z"), pastDueAt: new Date("2026-10-29T03:00:00Z"), graceEndsAt: new Date("2026-11-01T03:00:00Z"), invoice: { number: "SUB-000000000AAA", totalIdr: 196_595, periodStart: "2026-10-29", periodEnd: "2026-11-29" } };
    const ready = dunningMessage("invoice_ready", base);
    expect(ready.text).toContain("Rp196.595");
    expect(ready.text).toContain("2026-10-29");
    expect(ready.text).toContain("2026-11-29");
    expect(ready.subject).toContain("SUB-000000000AAA");
    for (const kind of ["trial_ending", "invoice_ready", "past_due", "grace_ending", "suspended"] as const) {
      const m = dunningMessage(kind, base);
      expect(m.text).not.toMatch(/dihapus|terhapus|hilang/i);
      expect(m.subject.length).toBeLessThan(120);
    }
    expect(dunningMessage("past_due", base).text).toContain("1 November 2026");
  });

  it("the switch is billing.manage and audited", async () => {
    const op = await operatorWith("billing.manage");
    const row = await setBillingControls(op, { dunningEnabled: true, reason: "penyedia surel sudah punya bukti pengiriman" });
    expect(row).toMatchObject({ dunningEnabled: true, jobsFrozen: false });
  });
});
