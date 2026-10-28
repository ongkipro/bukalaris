import { eq, notInArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getBuyerOrder, placeOrder } from "../src/seller/commerce/checkout.ts";
import {
  backoffMs,
  claimBatch,
  completeJob,
  enqueue,
  failJob,
  getHandler,
  type JobOutcome,
  MAX_ATTEMPTS,
  registerHandler,
  runOnce,
  sanitizeError,
} from "../src/ops/jobs/jobs.ts";
import { BUYER_RESOLVE } from "../src/buyer/jobs.ts";
import { MAIL_DELIVER } from "../src/ops/jobs/mail.ts";
import { reconcileUnknownJobs } from "../src/ops/jobs/manage.ts";
import { ORDER_NOTIFY } from "../src/ops/jobs/notify.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import { PAYMENT_INSTRUCTION } from "../src/payments/attempts.ts";
import { FakeAutoLaris } from "../src/payments/fake.ts";
import { setPaymentAdapter } from "../src/payments/jobs.ts";
import { fakeProviders, type Providers } from "../src/payments/providers.ts";
import { job, order } from "../src/schema.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { buyer, db, makeStore, platform } from "./helpers.ts";

// Orders also enqueue e-mail notifications, their delivery intents (T-36, T-73) and the buyer association (T-57); this file is about the outbox and the payment job.
const DERIVED = [ORDER_NOTIFY, MAIL_DELIVER, BUYER_RESOLVE];
const jobs = () => platform.select().from(job).where(notInArray(job.kind, DERIVED)).orderBy(job.id);
const payments = (out: JobOutcome[]) => out.filter((o) => !DERIVED.includes(o.kind));
const jobById = async (id: number) => (await platform.select().from(job).where(eq(job.id, id)))[0]!;
/** Time travel: make a job due (and its lease stale) without waiting. */
const makeDue = (id: number) =>
  platform
    .update(job)
    .set({ nextAttemptAt: sql`now() - interval '1 second'`, lockedUntil: sql`case when ${job.lockedUntil} is null then null else now() - interval '1 second' end` })
    .where(eq(job.id, id));
const secondsFromNow = (d: Date) => (d.getTime() - Date.now()) / 1000;

registerHandler("test.fail", async () => {
  throw new Error("boom");
});
registerHandler("test.ok", async () => {});

describe("outbox (T-32, SEC-18, ARCH-6)", () => {
  it("enqueue commits or rolls back together with the business write", async () => {
    const s = await makeStore("toko-a");
    await expect(
      platform.transaction(async (tx) => {
        await tx.update(order).set({ status: "cancelled" }); // any business write in the same tx
        await enqueue(tx, { kind: "test.ok", storeId: s.storeId, key: "rolled-back" });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await jobs()).toHaveLength(0);

    const r = await platform.transaction((tx) => enqueue(tx, { kind: "test.ok", storeId: s.storeId, key: "committed", payload: { n: 1 } }));
    expect(r.created).toBe(true);
    expect(await jobs()).toMatchObject([{ id: r.id, kind: "test.ok", key: "committed", status: "pending", attempts: 0, payload: { n: 1 } }]);
  });

  it("the same (kind, key) is enqueued once; another kind with that key is a separate job", async () => {
    const s = await makeStore("toko-a");
    const a = await enqueue(platform, { kind: "test.ok", storeId: s.storeId, key: "k1" });
    const b = await enqueue(platform, { kind: "test.ok", storeId: s.storeId, key: "k1", payload: { changed: true } });
    const c = await enqueue(platform, { kind: "test.fail", storeId: s.storeId, key: "k1" });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: null, created: false });
    expect(c.created).toBe(true);
    expect(await jobs()).toMatchObject([{ id: a.id, payload: {} }, { id: c.id, kind: "test.fail" }]);
    // Payload is bounded and must not carry blobs of buyer data.
    await expect(enqueue(platform, { kind: "test.ok", storeId: s.storeId, key: "big", payload: { x: "x".repeat(5_000) } })).rejects.toMatchObject({
      cause: { constraint_name: "job_payload_chk" },
    });
  });

  it("concurrent claimers never receive the same job; a leased job is invisible to others", async () => {
    const s = await makeStore("toko-a");
    for (let i = 0; i < 20; i++) await enqueue(platform, { kind: "test.ok", storeId: s.storeId, key: `j${i}` });
    const [a, b, c] = await Promise.all([claimBatch(platform, "A", 8), claimBatch(platform, "B", 8), claimBatch(platform, "C", 8)]);
    const ids = [...a, ...b, ...c].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(20);
    expect([a, b, c].map((x) => x.length).sort()).toEqual([4, 8, 8]);
    expect(a[0]).toMatchObject({ status: "running", lockedBy: "A", attempts: 1 });
    expect(a[0]!.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 30_000);
    // Everything is leased now: nothing left to claim until a lease expires.
    expect(await claimBatch(platform, "D", 8)).toHaveLength(0);
  });

  it("a worker that crashes mid-job loses its lease; the job is reclaimed and the provider bill is created once", async () => {
    const s = await makeStore("toko-a");
    const payment = new FakeAutoLaris();
    const providers: Providers = { ...fakeProviders, payment };
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer", paymentChannel: "VABCA" }));

    // Worker A claims, runs the handler (provider called, instruction stored) and dies before completeJob.
    const [a] = await claimBatch(platform, "A", 1);
    expect(a).toMatchObject({ kind: PAYMENT_INSTRUCTION, key: `order:${orderId}`, payload: { orderId } });
    await getHandler(PAYMENT_INSTRUCTION)!({ db: platform, providers }, a!);
    expect(payment.createCalls).toHaveLength(1);
    expect((await getBuyerOrder(db, orderId, cartId))!.payment).toMatchObject({ requestState: "accepted" });
    // The fence was set before the call, so the stale lease makes the job `unknown` for the reconciler, not a re-run.
    expect(await jobById(a!.id)).toMatchObject({ status: "running", lockedBy: "A" });

    // Lease still valid: worker B sees nothing. Lease expired: the job is `unknown`, never re-dispatched.
    expect(payments(await runOnce(platform, { workerId: "B", providers }))).toEqual([]);
    await makeDue(a!.id);
    expect(payments(await runOnce(platform, { workerId: "B", providers }))).toEqual([]);
    expect(await jobById(a!.id)).toMatchObject({ status: "unknown" });
    expect(payment.createCalls).toHaveLength(1);

    // A comes back late: its complete/fail find no lease and change nothing.
    expect(await completeJob(platform, a!)).toBe(false);
    expect(await failJob(platform, a!, new Error("late"))).toBe("lost");
    expect(await jobById(a!.id)).toMatchObject({ status: "unknown" });
  });

  it("retries with exponential backoff and becomes terminally dead after the attempt ceiling", async () => {
    const s = await makeStore("toko-a");
    const { id } = await enqueue(platform, { kind: "test.fail", storeId: s.storeId, key: "f" });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await makeDue(id!);
      const [o] = await runOnce(platform, { workerId: "W" });
      const j = await jobById(id!);
      if (attempt < MAX_ATTEMPTS) {
        expect(o).toMatchObject({ id, attempts: attempt, status: "pending", error: "Error: boom" });
        expect(j).toMatchObject({ status: "pending", attempts: attempt, lastError: "Error: boom", lockedBy: null });
        const expected = backoffMs(attempt) / 1000;
        expect(secondsFromNow(j.nextAttemptAt)).toBeGreaterThan(expected - 2);
        expect(secondsFromNow(j.nextAttemptAt)).toBeLessThanOrEqual(expected);
      } else {
        expect(o).toMatchObject({ id, attempts: MAX_ATTEMPTS, status: "dead" });
        expect(j).toMatchObject({ status: "dead", attempts: MAX_ATTEMPTS, lockedBy: null });
      }
    }
    expect([backoffMs(1), backoffMs(2), backoffMs(3), backoffMs(20)]).toEqual([5_000, 10_000, 20_000, 900_000]);
    // Terminal: not claimable any more even when due; a kind nobody handles fails like any other error.
    await makeDue(id!);
    expect(await runOnce(platform, { workerId: "W" })).toEqual([]);
    const u = await enqueue(platform, { kind: "test.unknown", storeId: s.storeId, key: "u" });
    expect(await runOnce(platform, { workerId: "W" })).toMatchObject([{ id: u.id, status: "pending", error: "Error: no handler for kind test.unknown" }]);
  });

  it("sanitizes stored errors: message only, credentials redacted, truncated", () => {
    expect(sanitizeError(new Error("timeout token=abc123 (Authorization: Bearer xyz)\n  at stack"))).toBe(
      "Error: timeout token=[redacted] (Authorization: [redacted] xyz) at stack",
    );
    expect(sanitizeError("x".repeat(1_000))).toHaveLength(500);
    expect(sanitizeError(42)).toBe("42");
  });

  it("payment instruction end to end: COD enqueues nothing; a transfer attempt survives a provider outage as unknown and is recovered with the same reference", async () => {
    const s = await makeStore("toko-a");
    const payment = new FakeAutoLaris();
    const providers: Providers = { ...fakeProviders, payment };
    setPaymentAdapter(payment);

    const cod = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await placeOrder(db, cod, buyer());
    expect(await jobs()).toHaveLength(0);

    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer", paymentChannel: "VABCA" }));
    expect(await getBuyerOrder(db, orderId, cartId)).toMatchObject({ status: "awaiting_payment", payment: { requestState: "in_progress", instruction: null } });
    expect(await jobs()).toMatchObject([{ kind: PAYMENT_INSTRUCTION, key: `order:${orderId}`, status: "pending" }]);

    payment.down = true;
    const [first] = payments(await runOnce(platform, { workerId: "W", providers }));
    // The provider call was dispatched and the answer is unknown: the job is NOT retried (it could create a second bill).
    expect(first).toMatchObject({ status: "unknown", attempts: 1, error: "Error: simulated provider timeout" });
    expect(await jobById(first!.id)).toMatchObject({ status: "unknown", lastError: "Error: simulated provider timeout" });
    expect((await getBuyerOrder(db, orderId, cartId))!.payment).toMatchObject({ requestState: "unknown", instruction: null });
    await makeDue(first!.id);
    expect(payments(await runOnce(platform, { workerId: "W", providers }))).toEqual([]); // never claimed again
    expect(payment.createCalls).toHaveLength(1);

    // The provider never saw the request: reconciliation proves "no bill" and the job runs again with the SAME reff_id.
    payment.down = false;
    expect(await reconcileUnknownJobs(platform)).toMatchObject({ settled: 1 });
    expect(payments(await runOnce(platform, { workerId: "W", providers }))).toMatchObject([{ id: first!.id, status: "done" }]);
    const done = (await getBuyerOrder(db, orderId, cartId))!.payment!;
    expect(done).toMatchObject({ requestState: "accepted" });
    expect(payment.createCalls.map((c) => c.reffId)).toEqual([payment.createCalls[0]!.reffId, payment.createCalls[0]!.reffId]);
    // Re-running the worker changes nothing.
    expect(await runOnce(platform, { workerId: "W", providers })).toEqual([]);
    setPaymentAdapter(null);
  });

  it("does not request an instruction for an order that stopped awaiting payment before the worker ran", async () => {
    const s = await makeStore("toko-a");
    const payment = new FakeAutoLaris();
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer", paymentChannel: "VABCA" }));
    await transitionOrder(s.owner, orderId, "cancel", { reason: "Pembeli berubah pikiran" });
    expect(payments(await runOnce(platform, { workerId: "W", providers: { ...fakeProviders, payment } }))).toMatchObject([{ status: "done" }]);
    expect(payment.createCalls).toHaveLength(0);
    expect((await getBuyerOrder(db, orderId, cartId))!.payment).toMatchObject({ requestState: "failed", instruction: null });
  });
});
