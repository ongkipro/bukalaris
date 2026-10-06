import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getBuyerOrder, placeOrder } from "../src/checkout.ts";
import {
  backoffMs,
  claimBatch,
  completeJob,
  enqueue,
  failJob,
  getHandler,
  MAX_ATTEMPTS,
  PAYMENT_INSTRUCTION,
  registerHandler,
  runOnce,
  sanitizeError,
} from "../src/jobs.ts";
import { transitionOrder } from "../src/orders.ts";
import { fakeProviders, type PaymentAdapter, type Providers } from "../src/providers.ts";
import { job, order } from "../src/schema.ts";
import { setCartLine } from "../src/storefront.ts";
import { buyer, db, makeStore } from "./helpers.ts";

const jobs = () => db.select().from(job).orderBy(job.id);
const jobById = async (id: number) => (await db.select().from(job).where(eq(job.id, id)))[0]!;
/** Time travel: make a job due (and its lease stale) without waiting. */
const makeDue = (id: number) =>
  db
    .update(job)
    .set({ nextAttemptAt: sql`now() - interval '1 second'`, lockedUntil: sql`case when ${job.lockedUntil} is null then null else now() - interval '1 second' end` })
    .where(eq(job.id, id));
const secondsFromNow = (d: Date) => (d.getTime() - Date.now()) / 1000;

/** Payment adapter that counts calls and can be switched off. */
function countingPayment(): PaymentAdapter & { calls: number; down: boolean } {
  return {
    calls: 0,
    down: false,
    async createInstruction(input) {
      this.calls++;
      if (this.down) throw new Error("Error: provider timeout token=abc123 (Authorization: Bearer xyz)");
      return fakeProviders.payment.createInstruction(input);
    },
  };
}

registerHandler("test.fail", async () => {
  throw new Error("boom");
});
registerHandler("test.ok", async () => {});

describe("outbox (T-32, SEC-18, ARCH-6)", () => {
  it("enqueue commits or rolls back together with the business write", async () => {
    const s = await makeStore("toko-a");
    await expect(
      db.transaction(async (tx) => {
        await tx.update(order).set({ status: "cancelled" }); // any business write in the same tx
        await enqueue(tx, { kind: "test.ok", storeId: s.storeId, key: "rolled-back" });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await jobs()).toHaveLength(0);

    const r = await db.transaction((tx) => enqueue(tx, { kind: "test.ok", storeId: s.storeId, key: "committed", payload: { n: 1 } }));
    expect(r.created).toBe(true);
    expect(await jobs()).toMatchObject([{ id: r.id, kind: "test.ok", key: "committed", status: "pending", attempts: 0, payload: { n: 1 } }]);
  });

  it("the same (kind, key) is enqueued once; another kind with that key is a separate job", async () => {
    const s = await makeStore("toko-a");
    const a = await enqueue(db, { kind: "test.ok", storeId: s.storeId, key: "k1" });
    const b = await enqueue(db, { kind: "test.ok", storeId: s.storeId, key: "k1", payload: { changed: true } });
    const c = await enqueue(db, { kind: "test.fail", storeId: s.storeId, key: "k1" });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: null, created: false });
    expect(c.created).toBe(true);
    expect(await jobs()).toMatchObject([{ id: a.id, payload: {} }, { id: c.id, kind: "test.fail" }]);
    // Payload is bounded and must not carry blobs of buyer data.
    await expect(enqueue(db, { kind: "test.ok", storeId: s.storeId, key: "big", payload: { x: "x".repeat(5_000) } })).rejects.toMatchObject({
      cause: { constraint_name: "job_payload_chk" },
    });
  });

  it("concurrent claimers never receive the same job; a leased job is invisible to others", async () => {
    const s = await makeStore("toko-a");
    for (let i = 0; i < 20; i++) await enqueue(db, { kind: "test.ok", storeId: s.storeId, key: `j${i}` });
    const [a, b, c] = await Promise.all([claimBatch(db, "A", 8), claimBatch(db, "B", 8), claimBatch(db, "C", 8)]);
    const ids = [...a, ...b, ...c].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(20);
    expect([a, b, c].map((x) => x.length).sort()).toEqual([4, 8, 8]);
    expect(a[0]).toMatchObject({ status: "running", lockedBy: "A", attempts: 1 });
    expect(a[0]!.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 30_000);
    // Everything is leased now: nothing left to claim until a lease expires.
    expect(await claimBatch(db, "D", 8)).toHaveLength(0);
  });

  it("a worker that crashes mid-job loses its lease; the job is reclaimed and its effect happens once", async () => {
    const s = await makeStore("toko-a");
    const payment = countingPayment();
    const providers: Providers = { ...fakeProviders, payment };
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer" }));

    // Worker A claims, runs the handler (provider called, reference stored) and dies before completeJob.
    const [a] = await claimBatch(db, "A", 1);
    expect(a).toMatchObject({ kind: PAYMENT_INSTRUCTION, key: `order:${orderId}`, payload: { orderId } });
    await getHandler(PAYMENT_INSTRUCTION)!({ db, providers }, a!);
    expect(payment.calls).toBe(1);
    expect((await getBuyerOrder(db, orderId, cartId))!.paymentReference).toBe(`FAKE-AL-${orderId}`);
    expect(await jobById(a!.id)).toMatchObject({ status: "running", lockedBy: "A" });

    // Lease still valid: worker B sees nothing. Lease expired: B reclaims and the idempotent handler skips the provider.
    expect(await runOnce(db, { workerId: "B", providers })).toEqual([]);
    await makeDue(a!.id);
    expect(await runOnce(db, { workerId: "B", providers })).toMatchObject([{ id: a!.id, status: "done", attempts: 2 }]);
    expect(payment.calls).toBe(1);
    expect(await jobById(a!.id)).toMatchObject({ status: "done", lockedBy: null, lockedUntil: null });

    // A comes back late: its complete/fail find no lease and change nothing.
    expect(await completeJob(db, a!)).toBe(false);
    expect(await failJob(db, a!, new Error("late"))).toBe("lost");
    expect(await jobById(a!.id)).toMatchObject({ status: "done", lastError: null });
  });

  it("retries with exponential backoff and becomes terminally failed after the attempt ceiling", async () => {
    const s = await makeStore("toko-a");
    const { id } = await enqueue(db, { kind: "test.fail", storeId: s.storeId, key: "f" });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await makeDue(id!);
      const [o] = await runOnce(db, { workerId: "W" });
      const j = await jobById(id!);
      if (attempt < MAX_ATTEMPTS) {
        expect(o).toMatchObject({ id, attempts: attempt, status: "pending", error: "Error: boom" });
        expect(j).toMatchObject({ status: "pending", attempts: attempt, lastError: "Error: boom", lockedBy: null });
        const expected = backoffMs(attempt) / 1000;
        expect(secondsFromNow(j.nextAttemptAt)).toBeGreaterThan(expected - 2);
        expect(secondsFromNow(j.nextAttemptAt)).toBeLessThanOrEqual(expected);
      } else {
        expect(o).toMatchObject({ id, attempts: MAX_ATTEMPTS, status: "failed" });
        expect(j).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, lockedBy: null });
      }
    }
    expect([backoffMs(1), backoffMs(2), backoffMs(3), backoffMs(20)]).toEqual([5_000, 10_000, 20_000, 900_000]);
    // Terminal: not claimable any more even when due; a kind nobody handles fails like any other error.
    await makeDue(id!);
    expect(await runOnce(db, { workerId: "W" })).toEqual([]);
    const u = await enqueue(db, { kind: "test.unknown", storeId: s.storeId, key: "u" });
    expect(await runOnce(db, { workerId: "W" })).toMatchObject([{ id: u.id, status: "pending", error: "Error: no handler for kind test.unknown" }]);
  });

  it("sanitizes stored errors: message only, credentials redacted, truncated", () => {
    expect(sanitizeError(new Error("timeout token=abc123 (Authorization: Bearer xyz)\n  at stack"))).toBe(
      "Error: timeout token=[redacted] (Authorization: [redacted] xyz) at stack",
    );
    expect(sanitizeError("x".repeat(1_000))).toHaveLength(500);
    expect(sanitizeError(42)).toBe("42");
  });

  it("payment instruction end to end: COD enqueues nothing; transfer survives a provider outage and succeeds on retry", async () => {
    const s = await makeStore("toko-a");
    const payment = countingPayment();
    const providers: Providers = { ...fakeProviders, payment };

    const cod = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await placeOrder(db, cod, buyer());
    expect(await jobs()).toHaveLength(0);

    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer" }));
    expect(await getBuyerOrder(db, orderId, cartId)).toMatchObject({ status: "awaiting_payment", paymentReference: null });
    expect(await jobs()).toMatchObject([{ kind: PAYMENT_INSTRUCTION, key: `order:${orderId}`, status: "pending" }]);

    payment.down = true;
    const [first] = await runOnce(db, { workerId: "W", providers });
    expect(first).toMatchObject({ status: "pending", attempts: 1, error: "Error: Error: provider timeout token=[redacted] (Authorization: [redacted] xyz)" });
    expect((await getBuyerOrder(db, orderId, cartId))!.paymentReference).toBeNull(); // explicit pending, no reference (D-5)
    expect(await runOnce(db, { workerId: "W", providers })).toEqual([]); // not due until the backoff elapses

    payment.down = false;
    await makeDue(first!.id);
    expect(await runOnce(db, { workerId: "W", providers })).toMatchObject([{ id: first!.id, status: "done", attempts: 2 }]);
    expect((await getBuyerOrder(db, orderId, cartId))!.paymentReference).toBe(`FAKE-AL-${orderId}`);
    expect(payment.calls).toBe(2);
    // Re-running the worker changes nothing.
    expect(await runOnce(db, { workerId: "W", providers })).toEqual([]);
    expect(await jobById(first!.id)).toMatchObject({ status: "done", lastError: null });
  });

  it("does not request an instruction for an order that stopped awaiting payment before the worker ran", async () => {
    const s = await makeStore("toko-a");
    const payment = countingPayment();
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer" }));
    await transitionOrder(s.owner, orderId, "cancel", { reason: "Pembeli berubah pikiran" });
    expect(await runOnce(db, { workerId: "W", providers: { ...fakeProviders, payment } })).toMatchObject([{ status: "done" }]);
    expect(payment.calls).toBe(0);
    expect((await getBuyerOrder(db, orderId, cartId))!.paymentReference).toBeNull();
  });
});
