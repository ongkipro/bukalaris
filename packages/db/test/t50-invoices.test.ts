import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { closeLapsedInvoices, ensureSubscriptionInvoice, getInvoice, listInvoices, newReference } from "../src/billing/invoices.ts";
import { paySubscription, type PayResult } from "../src/billing/attempts.ts";
import { createInvoiceAsOperator } from "../src/billing/console.ts";
import { runBillingCycle } from "../src/billing/cycle.ts";
import { subscriptionInvoice } from "../src/billing/schema-billing.ts";
import { jakartaMidnight } from "../src/billing/period.ts";
import { FakeAutoLaris } from "../src/payments/fake.ts";
import { job } from "../src/schema.ts";
import { withStore } from "../src/platform/tenant.ts";
import { DomainError } from "../src/platform/scoped.ts";
import { admin, db, makeUser, platform, seller as sellerOf } from "./helpers.ts";
import { attemptsOf, billingStore, billingTestSetup, eventsOf, invoicesOf, operatorWith, providersOf, setSubscription, subscriptionOf } from "./t50-fixtures.ts";

// T-50 DATA-10 / BILL-7: ONE invoice creator behind three entry points, proven against real PostgreSQL concurrency and the unique indexes themselves.

billingTestSetup();
const code = (p: Promise<unknown>) => p.then(() => "allowed", (e: { cause?: { code?: string }; code?: string }) => e.cause?.code ?? e.code);

describe("one invoice per store and period, from the cron, seller Pay and the Owner console, concurrently", () => {
  it("cron, seller Pay and Owner console manual-create fired together for one period yield ONE invoice id, ONE payment reference and ONE live instruction", async () => {
    const s = await billingStore("toko-a");
    const seller = await s.sellerAt();
    const op = await operatorWith("billing.read", "billing.manage");
    const p = new FakeAutoLaris();
    const calls = [
      ...Array.from({ length: 5 }, () => ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "cron", actor: "system:billing" })),
      ...Array.from({ length: 5 }, () => paySubscription(seller, { channel: "VABCA" }, providersOf(p))),
      ...Array.from({ length: 5 }, () => createInvoiceAsOperator(op, { storeId: s.storeId, reason: "buat tagihan manual" })),
    ];
    const results = await Promise.all(calls);
    const ids = new Set<string>();
    const numbers = new Set<string>();
    for (const r of results) {
      const invoice = "invoice" in r ? r.invoice : null;
      expect(invoice).not.toBeNull();
      ids.add(invoice!.id);
      numbers.add(invoice!.number);
    }
    expect(ids.size).toBe(1);
    expect(numbers.size).toBe(1); // the stable payment reference of the invoice
    const rows = await invoicesOf(s.storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.periodIndex).toBe(0);
    expect(rows[0]!.status).toBe("pending");
    // exactly one of the creators actually inserted
    const creations = await eventsOf(s.storeId, "invoice_created");
    expect(creations).toHaveLength(1);
    // the five seller Pay calls share one attempt: one provider reference, one live instruction, one job intent
    const pays = results.filter((r): r is PayResult => "attempt" in r);
    expect(new Set(pays.map((r) => r.attempt.id)).size).toBe(1);
    expect(new Set(pays.map((r) => r.attempt.reffId)).size).toBe(1);
    const attempts = await attemptsOf(rows[0]!.id);
    expect(attempts).toHaveLength(1);
    expect(await platform.select().from(job).where(eq(job.kind, "subscription.instruction"))).toHaveLength(1);
    expect(p.createCalls).toHaveLength(0); // nothing remote happened inside the committed intent
  });

  it("the guarantee is the database's: concurrent raw inserts of the same period (no service code) leave exactly one row and the rest fail on a unique index", async () => {
    const s = await billingStore("toko-a");
    const sub = await subscriptionOf(s.storeId);
    const planId = (await platform.execute(sql`select id from subscription_plan limit 1`))[0]!.id as number;
    const attempt = (i: number) =>
      platform.execute(sql`insert into subscription_invoice (store_id, number, period_index, period_start, period_end, kind, status, plan_id, dpp_idr, total_idr, due_at, source, created_by)
        values (${s.storeId}, ${newReference(new Date(Date.now() + i))}, 0, ${sub.billingAnchorDate}::date, (${sub.billingAnchorDate}::date + interval '1 month')::date, 'subscription', 'pending', ${planId}, 175000, 175000, now(), 'cron', 'raw')`);
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) => code(attempt(i))));
    expect(outcomes.filter((o) => o === "allowed")).toHaveLength(1);
    expect(new Set(outcomes.filter((o) => o !== "allowed"))).toEqual(new Set(["23505"]));
    expect(await invoicesOf(s.storeId)).toHaveLength(1);
  });

  it("each partial unique index refuses its own duplicate, and a void invoice frees the period for a corrected re-issue (not the pending/paid ones)", async () => {
    const s = await billingStore("toko-a");
    const op = await operatorWith("billing.manage");
    const first = (await ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "cron", actor: "system:billing" })) as { kind: "invoice"; invoice: typeof subscriptionInvoice.$inferSelect };
    const base = first.invoice;
    const insert = (over: Record<string, unknown>) => {
      const v = { store_id: base.storeId, number: newReference(new Date(Date.now() + Math.floor(Math.random() * 1e6))), period_index: base.periodIndex, period_start: base.periodStart, period_end: base.periodEnd, kind: "subscription", status: "pending", plan_id: base.planId, dpp_idr: base.dppIdr, total_idr: base.totalIdr, due_at: new Date().toISOString(), source: "cron", created_by: "raw", ...over };
      return code(platform.execute(sql`insert into subscription_invoice (${sql.raw(Object.keys(v).join(","))}) values (${sql.join(Object.values(v).map((x) => sql`${x}`), sql`, `)})`));
    };
    expect(await insert({})).toBe("23505"); // same store + period
    expect(await insert({ number: base.number })).toBe("23505"); // same payment reference
    // status paid for the same period still collides: the unique index covers every non-void invoice of the period
    await admin.execute(sql`update subscription_invoice set status = 'paid', paid_at = now(), settlement_source = 'bookkeeping', settlement_ref = 'x' where id = ${base.id}`);
    expect(await insert({})).toBe("23505");
    // a void invoice leaves the index: corrected re-issue of a PENDING one is possible only after the void
    const second = await billingStore("toko-b");
    const created = (await ensureSubscriptionInvoice(platform, { storeId: second.storeId, source: "cron", actor: "system:billing" })) as { kind: "invoice"; invoice: typeof subscriptionInvoice.$inferSelect };
    await platform.update(subscriptionInvoice).set({ status: "void", voidedAt: new Date(), voidReason: "salah nominal" }).where(eq(subscriptionInvoice.id, created.invoice.id));
    const reissued = await ensureSubscriptionInvoice(platform, { storeId: second.storeId, source: "operator", actor: op.userId });
    expect(reissued.kind === "invoice" && reissued.created && reissued.invoice.id !== created.invoice.id).toBe(true);
    expect(await invoicesOf(second.storeId)).toHaveLength(2);
  });

  it("a replay of any entry point after the fact returns the committed invoice and creates nothing (idempotent), and amounts are the plan snapshot, never recomputed", async () => {
    const s = await billingStore("toko-a");
    const a = await ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "cron", actor: "system:billing" });
    const b = await ensureSubscriptionInvoice(db, { storeId: s.storeId, source: "seller", actor: s.ownerId });
    if (a.kind !== "invoice" || b.kind !== "invoice") throw new Error("expected invoices");
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.invoice.id).toBe(a.invoice.id);
    expect([a.invoice.dppIdr, a.invoice.ppnIdr, a.invoice.totalIdr]).toEqual([175000, 0, 175000]);
    expect(a.invoice.ppnEnabled).toBe(false);
  });
});

describe("invoice creation rules: not due, covered, lapsed, the clamped anchor", () => {
  it("nothing is invoiced before the lead window of the first period, and an explicit future period is created on request", async () => {
    const s = await billingStore("toko-a");
    // the fixture trial is 3 days and the lead is 3 days: move the trial far out so period 0 is not due yet
    await setSubscription(s.storeId, { trialEndsAt: new Date(Date.now() + 20 * 86_400_000) });
    expect((await ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "cron", actor: "system:billing" })).kind).toBe("not_due");
    const explicit = await ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "operator", actor: "op", periodIndex: 0 });
    expect(explicit.kind).toBe("invoice");
    expect(await invoicesOf(s.storeId)).toHaveLength(1);
  });

  it("wave 3 review: an operator cannot create an invoice for a far-future period (it bought years of coverage at the monthly price, a comp without four-eyes)", async () => {
    const s = await billingStore("toko-a");
    await expect(ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "operator", actor: "op", periodIndex: 24 })).rejects.toMatchObject({ code: "period_not_due" });
    await expect(ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "operator", actor: "op", periodIndex: 2 })).rejects.toMatchObject({ code: "period_not_due" });
    expect(await invoicesOf(s.storeId)).toHaveLength(0);
  });

  it("a seller may pay period 0 before the trial ends (BILL-7 'paying early never shortens the trial and never moves the anchor'): Pay is not refused as 'not due'", async () => {
    const s = await billingStore("toko-a");
    await setSubscription(s.storeId, { trialEndsAt: new Date(Date.now() + 20 * 86_400_000) });
    const anchor = (await subscriptionOf(s.storeId)).billingAnchorDate;
    const r = await paySubscription(await s.sellerAt(), { channel: "VABCA" }, providersOf(new FakeAutoLaris()));
    expect(r.invoice).toMatchObject({ periodIndex: 0, periodStart: anchor });
    const sub = await subscriptionOf(s.storeId);
    expect(sub.billingAnchorDate).toBe(anchor);
    expect(sub.status).toBe("trial"); // nothing changed until a verified payment
  });

  it("a period whose end has passed is never invoiced (OPEN-B1, D-20: no back-billing) and an elapsed unpaid invoice is closed void 'lapsed'", async () => {
    const s = await billingStore("toko-a");
    const created = await ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "cron", actor: "system:billing" });
    if (created.kind !== "invoice") throw new Error("expected invoice");
    const later = new Date(jakartaMidnight(created.invoice.periodEnd).getTime() + 60_000); // one minute after period 0 ended
    await expect(ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "operator", actor: "op", periodIndex: 0, now: later })).rejects.toMatchObject({ code: "period_lapsed" });
    const closed = await withStore(platform, s.storeId, (tx) => closeLapsedInvoices(tx, s.storeId, later));
    expect(closed.map((i) => i.voidReason)).toEqual(["lapsed"]);
    // billing resumes at the first period whose end is in the future; the anchor is untouched
    const anchorBefore = (await subscriptionOf(s.storeId)).billingAnchorDate;
    const next = await ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "cron", actor: "system:billing", now: later });
    expect(next.kind === "invoice" && next.invoice.periodIndex).toBe(1);
    expect((await subscriptionOf(s.storeId)).billingAnchorDate).toBe(anchorBefore);
    const rows = await invoicesOf(s.storeId);
    expect(rows.map((r) => [r.periodIndex, r.status])).toEqual([[0, "void"], [1, "pending"]]);
  });

  it("a store whose anchor is the 31st: the invoices of periods 0..4 carry the clamped month ends and the stored dates are what the database formula demands", async () => {
    const s = await billingStore("toko-a");
    await setSubscription(s.storeId, { trialEndsAt: new Date("2026-10-31T03:00:00Z") }); // anchor 31 Oct 2026 (Jakarta)
    const dates: string[][] = [];
    for (let k = 0; k < 5; k++) {
      const r = await ensureSubscriptionInvoice(platform, { storeId: s.storeId, source: "operator", actor: "op", periodIndex: k, now: new Date(Date.UTC(2026, 9 + k, 28)) }); // each period is due (inside the lead window) at its own clock
      if (r.kind !== "invoice") throw new Error("expected invoice");
      dates.push([r.invoice.periodStart, r.invoice.periodEnd]);
    }
    expect(dates).toEqual([["2026-10-31", "2026-11-30"], ["2026-11-30", "2026-12-31"], ["2026-12-31", "2027-01-31"], ["2027-01-31", "2027-02-28"], ["2027-02-28", "2027-03-31"]]);
  });

  it("the database refuses a period that does not follow the anchor formula, a price that is not the plan's and a forged settled start (even from the platform role)", async () => {
    const s = await billingStore("toko-a");
    const sub = await subscriptionOf(s.storeId);
    const planId = (await platform.execute(sql`select id from subscription_plan limit 1`))[0]!.id as number;
    const raw = (over: Record<string, unknown>) => {
      const v = { store_id: s.storeId, number: newReference(new Date(Date.now() + Math.floor(Math.random() * 1e6))), period_index: 0, period_start: sub.billingAnchorDate, period_end: sql`(${sub.billingAnchorDate}::date + interval '1 month')::date`, kind: "subscription", status: "pending", plan_id: planId, dpp_idr: 175000, total_idr: 175000, due_at: sql`now()`, source: "cron", created_by: "raw", ...over };
      return code(platform.execute(sql`insert into subscription_invoice (${sql.raw(Object.keys(v).join(","))}) values (${sql.join(Object.values(v).map((x) => (typeof x === "object" && x !== null ? x : sql`${x}`)) as never[], sql`, `)})`));
    };
    expect(await raw({ period_end: "2099-01-01" })).toBe("23514"); // wrong period end
    expect(await raw({ period_start: "2026-01-01" })).toBe("23514");
    expect(await raw({ dpp_idr: 100, total_idr: 100 })).toBe("23514"); // not the plan's price
    expect(await raw({ status: "paid", paid_at: sql`now()`, settlement_source: "provider" })).toBe("23514"); // a subscription invoice starts pending
    expect(await raw({ period_index: 5 })).toBe("23514"); // index 5 but dates of period 0
  });
});

describe("an invoice belongs to its store only; wrong roles are refused by the server", () => {
  it("store A cannot list, open or pay store B's invoice, by id or by guessing, and cannot write a row for B even with the app role", async () => {
    const a = await billingStore("toko-a");
    const b = await billingStore("toko-b");
    const p = new FakeAutoLaris();
    const paidB = await paySubscription(await b.sellerAt(), { channel: "VABCA" }, providersOf(p));
    const sellerA = await a.sellerAt();
    expect(await getInvoice(db, a.storeId, paidB.invoice.id)).toBeNull();
    expect(await listInvoices(db, a.storeId)).toEqual([]);
    await expect(paySubscription(sellerA, { channel: "VABCA", invoiceId: paidB.invoice.id }, providersOf(p))).rejects.toMatchObject({ code: "not_found" });
    expect(await attemptsOf(paidB.invoice.id)).toHaveLength(1); // untouched
    // raw SQL under A's context: B's rows are invisible and a write for B is a row-level-security violation
    const seen = await withStore(db, a.storeId, async (tx) => (await tx.select().from(subscriptionInvoice)).length);
    expect(seen).toBe(0);
    const forge = withStore(db, a.storeId, (tx) =>
      tx.execute(sql`insert into subscription_invoice (store_id, number, period_index, period_start, period_end, plan_id, dpp_idr, total_idr, due_at, source, created_by)
        select ${b.storeId}, ${newReference()}, 1, (anchor + interval '1 month')::date, (anchor + interval '2 month')::date, plan_id, 175000, 175000, now(), 'seller', 'x' from (select billing_anchor_date as anchor, plan_id from store_subscription where store_id = ${a.storeId}) q`),
    );
    await expect(code(forge)).resolves.toBeTypeOf("string");
    expect(await code(forge)).not.toBe("allowed");
    expect(await invoicesOf(b.storeId)).toHaveLength(1);
  });

  it("a staff member cannot pay, an operator without billing.manage cannot create an invoice, and nothing is written for either", async () => {
    const a = await billingStore("toko-a");
    const staffId = await makeUser("staff");
    await platform.execute(sql`insert into membership (store_id, user_id, role) values (${a.storeId}, ${staffId}, 'staff')`);
    const staff = await sellerOf(staffId, a.storeId);
    await expect(paySubscription(staff, { channel: "VABCA" }, providersOf(new FakeAutoLaris()))).rejects.toMatchObject({ code: "forbidden" });
    const reader = await operatorWith("billing.read", "tenants.read");
    await expect(createInvoiceAsOperator(reader, { storeId: a.storeId, reason: "tanpa izin" })).rejects.toBeInstanceOf(DomainError);
    await expect(createInvoiceAsOperator(await operatorWith("tenants.manage"), { storeId: a.storeId, reason: "tanpa izin" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await invoicesOf(a.storeId)).toHaveLength(0);
    expect((await platform.execute(sql`select count(*)::int as n from audit_log where action = 'operator.denied'`))[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it("the app role cannot forge what only the platform may write: a comp, a settled invoice, a foreign source, a lower price, or any UPDATE", async () => {
    const a = await billingStore("toko-a");
    const sub = await subscriptionOf(a.storeId);
    const planId = (await platform.execute(sql`select id from subscription_plan limit 1`))[0]!.id as number;
    const asApp = (over: Record<string, unknown>) =>
      code(
        withStore(db, a.storeId, (tx) => {
          const v = { store_id: a.storeId, number: newReference(new Date(Date.now() + Math.floor(Math.random() * 1e6))), period_index: 0, period_start: sub.billingAnchorDate, kind: "subscription", status: "pending", plan_id: planId, dpp_idr: 175000, total_idr: 175000, source: "seller", created_by: "x", ...over };
          return tx.execute(sql`insert into subscription_invoice (${sql.raw(Object.keys(v).join(","))}, period_end, due_at) values (${sql.join(Object.values(v).map((x) => sql`${x}`), sql`, `)}, (${sub.billingAnchorDate}::date + interval '1 month')::date, now())`);
        }),
      );
    expect(await asApp({ kind: "comp", dpp_idr: 0, total_idr: 0, source: "comp", status: "paid", paid_at: new Date().toISOString(), settlement_source: "comp", comp_request_key: "k" })).toBe("42501");
    expect(await asApp({ source: "operator" })).toBe("42501");
    expect(await asApp({ source: "cron" })).toBe("42501");
    expect(await asApp({ dpp_idr: 1, total_idr: 1 })).toBe("23514");
    expect(await asApp({})).toBe("allowed"); // the one thing the seller path may start: a pending seller-sourced invoice at the plan price
    const updates = await Promise.all(["subscription_invoice set store_id = store_id", "subscription_payment_attempt set store_id = store_id", "store_subscription set store_id = store_id", "subscription_plan set version = version"].map((t) => code(withStore(db, a.storeId, (tx) => tx.execute(sql.raw(`update ${t}`))))));
    expect(updates).toEqual(["42501", "42501", "42501", "42501"]);
    expect(await code(withStore(db, a.storeId, (tx) => tx.execute(sql`select * from subscription_event`)))).toBe("42501");
    expect(await code(withStore(db, a.storeId, (tx) => tx.execute(sql`select * from billing_control`)))).toBe("42501");
  });
});

describe("the cycle creates the due invoice once, whatever runs it", () => {
  it("the hourly cycle run twice, and by two workers at once, creates one invoice and changes nothing the second time", async () => {
    const s = await billingStore("toko-a");
    const first = await runBillingCycle(platform, { now: new Date() });
    expect(first).toMatchObject({ invoicesCreated: 1, errors: [] });
    const [again, parallel] = await Promise.all([runBillingCycle(platform, { now: new Date() }), runBillingCycle(platform, { now: new Date() })]);
    expect(again.invoicesCreated + parallel.invoicesCreated).toBe(0);
    expect(await invoicesOf(s.storeId)).toHaveLength(1);
    expect(await eventsOf(s.storeId, "invoice_created")).toHaveLength(1);
  });
});
