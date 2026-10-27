import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import {
  BOOKABLE,
  bookShipment,
  COD_BOOKING_MESSAGE,
  getShipment,
  getShipmentForLink,
  isRetryableBookingError,
  mapProviderStatus,
  MAX_TRACK_POLLS,
  providerStatusLabel,
  refreshTracking,
  setBookingAdapter,
  SHIPMENT_BOOK,
  SHIPMENT_TRACK,
  shipmentTimeline,
  trackDelayMs,
  PAID_WAITING_MESSAGE,
  UNCERTAIN_MESSAGE,
  UNPAID_MESSAGE,
  WRITE_DISABLED_MESSAGE,
  type BookingAdapter,
  type BookingInput,
  type TrackingResult,
} from "../src/shipping/fulfillment.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { firstOrder, mengantarBooking, toBookingResult, toCreateOrderCourier, toTrackingResult } from "../src/shipping/mengantar/booking.ts";
import { MengantarClient, MengantarError } from "../src/shipping/mengantar/client.ts";
import { ORDER_NOTIFY, signOrderLink } from "../src/ops/jobs/notify.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import { job, order, orderStatusHistory, shipment } from "../src/schema.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { withStore } from "../src/platform/tenant.ts";
import { buyer, db, makeStore, makeUser, platform, seller } from "./helpers.ts";

// Shipment booking + tracking through the outbox (T-39). Every provider call goes to a
// scripted adapter injected with `setBookingAdapter`; nothing reaches the network.

type Store = Awaited<ReturnType<typeof makeStore>>;
const KINDS = [SHIPMENT_BOOK, SHIPMENT_TRACK];
const shipmentJobs = (orderId: number) =>
  platform
    .select({ kind: job.kind, key: job.key, status: job.status, attempts: job.attempts, nextAttemptAt: job.nextAttemptAt, lastError: job.lastError })
    .from(job)
    .where(and(inArray(job.kind, KINDS), like(job.key, `%:${orderId}:%`)))
    .orderBy(job.id);
const run = async (workerId = "W") => (await runOnce(platform, { workerId })).filter((o) => KINDS.includes(o.kind));
/** Time travel: make every shipment job of the order due (and any lease stale). */
const makeDue = (orderId: number) =>
  platform
    .update(job)
    .set({ nextAttemptAt: sql`now() - interval '1 second'`, lockedUntil: sql`case when ${job.lockedUntil} is null then null else now() - interval '1 second' end` })
    .where(and(inArray(job.kind, KINDS), like(job.key, `%:${orderId}:%`)));
const row = async (orderId: number) => (await platform.select().from(shipment).where(eq(shipment.orderId, orderId)))[0] ?? null;
const orderRow = async (orderId: number) => (await platform.select({ status: order.status, trackingNumber: order.trackingNumber }).from(order).where(eq(order.id, orderId)))[0]!;
const history = async (orderId: number) =>
  (await platform.select({ from: orderStatusHistory.fromStatus, to: orderStatusHistory.toStatus, actor: orderStatusHistory.actorUserId, note: orderStatusHistory.note }).from(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId)).orderBy(orderStatusHistory.id));
const minutesFromNow = (d: Date) => (d.getTime() - Date.now()) / 60_000;

/** A confirmed order: transfer paid by the seller (`placed`), or COD confirmed. */
async function placed(s: Store, over: Record<string, unknown> = {}) {
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
  const { orderId } = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer", buyerEmail: "budi@example.com", ...over }));
  await runOnce(platform, { workerId: "setup" }); // payment instruction + created mails
  await transitionOrder(s.owner, orderId, over.paymentMethod === "cod" ? "confirm" : "pay");
  return orderId;
}

type Scripted = BookingAdapter & { calls: { createOrder: number; payUnpaid: number; track: number }; inputs: BookingInput[]; tracks: TrackingResult[] };
/** Books instantly with a resi; `track` replays `tracks` in order (last one repeats). */
function scripted(over: Partial<BookingAdapter> = {}, tracks: TrackingResult[] = []): Scripted {
  const a: Scripted = {
    calls: { createOrder: 0, payUnpaid: 0, track: 0 },
    inputs: [],
    tracks,
    async createOrder(input) {
      a.calls.createOrder++;
      a.inputs.push(input);
      return { providerOrderId: `MGT-${input.orderId}`, providerBatchId: `B-${input.orderId}`, trackingNumber: `RESI-${input.orderId}`, paid: true, providerStatus: "PENDING PICKUP" };
    },
    async payUnpaid() {
      a.calls.payUnpaid++;
    },
    async track() {
      const t = a.tracks[Math.min(a.calls.track, a.tracks.length - 1)] ?? { trackingNumber: null, providerStatus: "PENDING PICKUP", paid: null, history: [] };
      a.calls.track++;
      return t;
    },
    ...over,
  };
  return a;
}
const status = (providerStatus: string, desc = providerStatus, trackingNumber: string | null = null): TrackingResult => ({ trackingNumber, providerStatus, paid: trackingNumber ? true : null, history: [{ at: "07-10-2026 10:00", desc }] });

afterEach(() => {
  setBookingAdapter(null);
  delete process.env.ALLOW_COD_BOOKING;
});

describe("booking through the outbox (T-39, PR-5)", () => {
  it("concurrent requests and duplicate clicks create one shipment and one job; the worker books once; a re-run after a lost lease books nothing more", async () => {
    const s = await makeStore("toko-a");
    const adapter = scripted();
    setBookingAdapter(adapter);
    const orderId = await placed(s);

    const outcomes = await Promise.all([bookShipment(s.owner, orderId), bookShipment(s.owner, orderId), bookShipment(s.owner, orderId)]);
    expect(outcomes.filter((o) => o.created)).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.shipmentId)).size).toBe(1);
    expect(await shipmentJobs(orderId)).toMatchObject([{ kind: SHIPMENT_BOOK, key: `shipment:${orderId}:0`, status: "pending" }]);
    expect(await row(orderId)).toMatchObject({ status: "queued", courierCode: "JNE", weightKg: 1, codAmount: 0, requestedBy: s.ownerId, trackingNumber: null });
    expect(await orderRow(orderId)).toMatchObject({ status: "placed" });

    expect(await run()).toMatchObject([{ kind: SHIPMENT_BOOK, status: "done" }]);
    expect(adapter.calls.createOrder).toBe(1);
    expect(adapter.inputs[0]).toMatchObject({ orderId, courierCode: "JNE", destinationAreaId: "b1b1b1b1b1b1b1b1b1b1b1b1", codAmount: 0, goodsValue: 100_000, quantity: 1, buyerName: "Budi Santoso", parcelContent: "Kaos toko-a" });
    const booked = (await row(orderId))!;
    expect(booked).toMatchObject({ status: "booked", providerOrderId: `MGT-${orderId}`, providerBatchId: `B-${orderId}`, trackingNumber: `RESI-${orderId}`, paid: true, providerStatus: "PENDING PICKUP", lastError: null });
    expect(booked.bookedAt).toBeInstanceOf(Date);
    // The order moved placed → processing → shipped through the one transition, actor = requester, resi stored.
    expect(await orderRow(orderId)).toEqual({ status: "shipped", trackingNumber: `RESI-${orderId}` });
    expect(await history(orderId)).toMatchObject([
      { from: "awaiting_payment", to: "placed" },
      { from: "placed", to: "processing", actor: s.ownerId },
      { from: "processing", to: "shipped", actor: s.ownerId, note: `RESI-${orderId}` },
    ]);
    // Exactly one "shipped" mail intent (T-36), and the first tracking poll is scheduled ~15 min out.
    const shipped = await platform.select({ key: job.key }).from(job).where(and(eq(job.kind, ORDER_NOTIFY), like(job.key, `notify:${orderId}:shipped:%`)));
    expect(shipped).toEqual([{ key: `notify:${orderId}:shipped:buyer` }]);
    const [, track] = await shipmentJobs(orderId);
    expect(track).toMatchObject({ kind: SHIPMENT_TRACK, key: `track:${orderId}:0`, status: "pending" });
    expect(minutesFromNow(track!.nextAttemptAt)).toBeGreaterThan(14);

    // Lost lease: the booking job is claimed again — the handler sees `booked` and does nothing.
    await platform.update(job).set({ status: "running", lockedBy: "dead", lockedUntil: sql`now() - interval '1 second'`, nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(job.key, `shipment:${orderId}:0`));
    expect(await run("B")).toMatchObject([{ kind: SHIPMENT_BOOK, status: "done", attempts: 2 }]);
    expect(adapter.calls.createOrder).toBe(1);
    await expect(bookShipment(s.owner, orderId)).rejects.toMatchObject({ code: "already_booked" });
    // Seller view carries the same record.
    expect(await getShipment(s.owner, orderId)).toMatchObject({ status: "booked", trackingNumber: `RESI-${orderId}` });
  });

  it("a worker lost mid-booking fails closed (no blind second provider order); the seller can retry", async () => {
    const s = await makeStore("toko-a");
    const adapter = scripted();
    setBookingAdapter(adapter);
    const orderId = await placed(s);
    await bookShipment(s.owner, orderId);
    await platform.update(shipment).set({ status: "booking" }).where(eq(shipment.orderId, orderId)); // as left by a crashed worker
    expect(await run()).toMatchObject([{ status: "done" }]);
    expect(adapter.calls.createOrder).toBe(0);
    expect(await row(orderId)).toMatchObject({ status: "failed", lastError: expect.stringContaining("Booking terputus") });
    expect(await orderRow(orderId)).toMatchObject({ status: "placed" });

    expect(await bookShipment(s.owner, orderId)).toMatchObject({ attempt: 1, created: true });
    expect(await row(orderId)).toMatchObject({ status: "queued", bookingAttempts: 1, lastError: null });
    expect(await run()).toMatchObject([{ kind: SHIPMENT_BOOK, status: "done" }]);
    expect(adapter.calls.createOrder).toBe(1);
    expect(await row(orderId)).toMatchObject({ status: "booked" });
    expect(await orderRow(orderId)).toMatchObject({ status: "shipped" });
  });

  it("insufficient balance → awaiting_balance with an explicit message; retry pays the batch once and a tracking read fetches the resi", async () => {
    const s = await makeStore("toko-a");
    const adapter = scripted({
      async createOrder(input) {
        adapter.calls.createOrder++;
        return { providerOrderId: `MGT-${input.orderId}`, providerBatchId: `B-${input.orderId}`, trackingNumber: null, paid: false, providerStatus: null };
      },
    });
    setBookingAdapter(adapter);
    const orderId = await placed(s);
    await bookShipment(s.owner, orderId);
    expect(await run()).toMatchObject([{ status: "done" }]); // not a retry: a human must top up first
    expect(await row(orderId)).toMatchObject({ status: "awaiting_balance", providerOrderId: `MGT-${orderId}`, trackingNumber: null, paid: false, lastError: UNPAID_MESSAGE });
    expect(await orderRow(orderId)).toMatchObject({ status: "placed", trackingNumber: null });
    expect(await shipmentJobs(orderId)).toHaveLength(1); // no tracking poll without a resi

    // Topped up: the retry pays the unpaid batch, then tracking returns the resi.
    adapter.tracks.push(status("PENDING PICKUP", "Order dibayar", `RESI-${orderId}`));
    expect(await bookShipment(s.owner, orderId)).toMatchObject({ attempt: 1, created: true });
    expect(await bookShipment(s.owner, orderId)).toMatchObject({ attempt: 1, created: false }); // duplicate click
    expect(await row(orderId)).toMatchObject({ status: "queued", bookingAttempts: 1 });
    // A stale attempt-0 job re-run (lost lease) is ignored: only the current attempt acts.
    await platform.update(job).set({ status: "pending", nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(job.key, `shipment:${orderId}:0`));
    expect(await run()).toMatchObject([{ kind: SHIPMENT_BOOK, status: "done" }, { kind: SHIPMENT_BOOK, status: "done" }]);
    expect(adapter.calls).toEqual({ createOrder: 1, payUnpaid: 1, track: 0 });
    expect(await row(orderId)).toMatchObject({ status: "awaiting_balance", lastError: PAID_WAITING_MESSAGE });
    expect(await run()).toMatchObject([{ kind: SHIPMENT_TRACK, status: "done" }]);
    expect(adapter.calls).toEqual({ createOrder: 1, payUnpaid: 1, track: 1 });
    expect(await row(orderId)).toMatchObject({ status: "booked", trackingNumber: `RESI-${orderId}`, paid: true, lastError: null, trackingHistory: [{ at: "07-10-2026 10:00", desc: "Order dibayar" }] });
    expect(await orderRow(orderId)).toEqual({ status: "shipped", trackingNumber: `RESI-${orderId}` });
    expect((await shipmentJobs(orderId)).map((j) => j.key)).toEqual([`shipment:${orderId}:0`, `shipment:${orderId}:1`, `track:${orderId}:pay:1`, `track:${orderId}:1`]);
  });

  it("409 (concurrent batch) retries with backoff and books exactly one provider order; a timeout fails closed instead of risking a second order", async () => {
    const s = await makeStore("toko-a");
    let fail: unknown = new MengantarError("http", "Mengantar: Sedang ada proses pembuatan order", 409);
    const base = scripted();
    const adapter = scripted({
      async createOrder(input) {
        if (fail) {
          const err = fail;
          fail = null;
          throw err;
        }
        return base.createOrder(input);
      },
    });
    setBookingAdapter(adapter);
    const orderId = await placed(s);
    await bookShipment(s.owner, orderId);
    expect(await run()).toMatchObject([{ status: "pending", attempts: 1, error: expect.stringContaining("Sedang ada proses") }]);
    expect(await row(orderId)).toMatchObject({ status: "queued", providerOrderId: null, lastError: expect.stringContaining("Sedang ada proses") });
    const [j] = await shipmentJobs(orderId);
    expect(j!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 3_000); // backoff, not immediately due
    expect(await run()).toEqual([]);
    await makeDue(orderId);
    expect(await run()).toMatchObject([{ kind: SHIPMENT_BOOK, status: "done", attempts: 2 }]);
    expect(base.calls.createOrder).toBe(1);
    expect(await row(orderId)).toMatchObject({ status: "booked", lastError: null });

    // Timeout / network / 5xx: the provider may have created the order — never retried.
    for (const err of [new MengantarError("timeout", "Mengantar timed out after 8000 ms"), new MengantarError("http", "Mengantar: HTTP 502", 502)]) {
      fail = err;
      const other = await placed(s);
      await bookShipment(s.owner, other);
      expect(await run()).toMatchObject([{ status: "done", attempts: 1 }]);
      expect(await row(other)).toMatchObject({ status: "failed", providerOrderId: null, lastError: expect.stringContaining(UNCERTAIN_MESSAGE) });
      expect(await orderRow(other)).toMatchObject({ status: "placed" });
    }
    expect(base.calls.createOrder).toBe(1);
  });

  it("permanent provider errors and the write lock mark the shipment failed without retries; the real client never calls fetch without the flag", async () => {
    const s = await makeStore("toko-a");
    const adapter = scripted({
      async createOrder() {
        throw new MengantarError("http", "Mengantar: customerAddressDataId tidak valid", 400, undefined, "X000");
      },
    });
    setBookingAdapter(adapter);
    const orderId = await placed(s);
    await bookShipment(s.owner, orderId);
    expect(await run()).toMatchObject([{ status: "done" }]);
    expect(await row(orderId)).toMatchObject({ status: "failed", lastError: "MengantarError: Mengantar: customerAddressDataId tidak valid" });
    expect(await orderRow(orderId)).toMatchObject({ status: "placed" });

    // Real adapter over a client without MENGANTAR_WRITE_ENABLED: refused before any request.
    const fetchImpl = async () => {
      throw new Error("fetch must not be called");
    };
    const real = mengantarBooking(new MengantarClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch, writeEnabled: false }), { pickupAddressId: "a0a0a0a0a0a0a0a0a0a0a0a0" });
    setBookingAdapter(real);
    const second = await placed(s);
    await bookShipment(s.owner, second);
    expect(await run()).toMatchObject([{ status: "done" }]);
    expect(await row(second)).toMatchObject({ status: "failed", lastError: WRITE_DISABLED_MESSAGE });
    await expect(real.payUnpaid("b", "JNE")).rejects.toMatchObject({ code: "write_disabled" });
  });

  it("COD bookings are refused while Q-17 is open unless ALLOW_COD_BOOKING=1; the worker re-checks the flag", async () => {
    const s = await makeStore("toko-a");
    const adapter = scripted();
    setBookingAdapter(adapter);
    const orderId = await placed(s, { paymentMethod: "cod" });
    await expect(bookShipment(s.owner, orderId)).rejects.toMatchObject({ code: "cod_booking_disabled", message: COD_BOOKING_MESSAGE });
    expect(await row(orderId)).toBeNull();

    process.env.ALLOW_COD_BOOKING = "1";
    await bookShipment(s.owner, orderId);
    expect(await row(orderId)).toMatchObject({ status: "queued", codAmount: 100_000 + 17_500 }); // goods + COD ongkir (fake JNE 15 494 + Rp 2 000 margin, rounded to 500)
    // Flag withdrawn before the worker ran: refused there too, with the same message.
    delete process.env.ALLOW_COD_BOOKING;
    expect(await run()).toMatchObject([{ status: "done" }]);
    expect(adapter.calls.createOrder).toBe(0);
    expect(await row(orderId)).toMatchObject({ status: "failed", lastError: COD_BOOKING_MESSAGE });

    process.env.ALLOW_COD_BOOKING = "1";
    await bookShipment(s.owner, orderId);
    expect(await run()).toMatchObject([{ status: "done" }]);
    expect(adapter.inputs[0]).toMatchObject({ codAmount: 117_500, goodsValue: 100_000 });
    expect(await row(orderId)).toMatchObject({ status: "booked" });
  });

  it("only confirmed/processing orders of the seller's own store can be booked; an order cancelled before the worker ran is not booked", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const adapter = scripted();
    setBookingAdapter(adapter);
    const cartId = await setCartLine(a.sf, undefined, { variantId: a.variantId, quantity: 1 }, "add");
    const { orderId: unpaid } = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer" }));
    await expect(bookShipment(a.owner, unpaid)).rejects.toMatchObject({ code: "not_bookable" });
    await expect(bookShipment(b.owner, unpaid)).rejects.toMatchObject({ code: "not_found" });
    expect(BOOKABLE).toEqual(["placed", "processing"]);

    const orderId = await placed(a);
    await transitionOrder(a.owner, orderId, "process");
    await bookShipment(a.owner, orderId);
    await transitionOrder(a.owner, orderId, "cancel", { reason: "pembeli membatalkan" });
    expect(await run()).toMatchObject([{ status: "done" }]);
    expect(adapter.calls.createOrder).toBe(0);
    expect(await row(orderId)).toMatchObject({ status: "failed", lastError: expect.stringContaining('"Dibatalkan"') });
    expect(await getShipment(b.owner, orderId)).toBeNull();
    await expect(refreshTracking(b.owner, orderId)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("tracking (read-only polls)", () => {
  it("maps provider statuses, schedules bounded polls with backoff, and completes the order on delivery through the transition", async () => {
    const s = await makeStore("toko-a");
    const onDelivery = status("ON DELIVERY", "Paket dibawa kurir");
    // The provider returns the whole history on every read; the stored copy is replaced, not appended.
    const adapter = scripted({}, [onDelivery, { ...status("DELIVERED", "Diterima oleh Budi"), history: [...onDelivery.history, { at: "07-10-2026 14:00", desc: "Diterima oleh Budi" }] }]);
    setBookingAdapter(adapter);
    const orderId = await placed(s);
    await bookShipment(s.owner, orderId);
    await run();
    expect(await orderRow(orderId)).toMatchObject({ status: "shipped" });

    await makeDue(orderId); // poll 0 is due
    expect(await run()).toMatchObject([{ kind: SHIPMENT_TRACK, status: "done" }]);
    expect(await row(orderId)).toMatchObject({ status: "in_transit", providerStatus: "ON DELIVERY", trackingHistory: [{ at: "07-10-2026 10:00", desc: "Paket dibawa kurir" }] });
    expect((await row(orderId))!.lastTrackedAt).toBeInstanceOf(Date);
    const polls = (await shipmentJobs(orderId)).filter((j) => j.kind === SHIPMENT_TRACK);
    expect(polls.map((p) => p.key)).toEqual([`track:${orderId}:0`, `track:${orderId}:1`]);
    expect(minutesFromNow(polls[1]!.nextAttemptAt)).toBeGreaterThan(29); // 15 min × 2

    await makeDue(orderId);
    expect(await run()).toMatchObject([{ kind: SHIPMENT_TRACK, status: "done" }]);
    const delivered = (await row(orderId))!;
    expect(delivered).toMatchObject({ status: "delivered", providerStatus: "DELIVERED" });
    expect(delivered.deliveredAt).toBeInstanceOf(Date);
    expect(await orderRow(orderId)).toMatchObject({ status: "completed" });
    expect((await history(orderId)).at(-1)).toMatchObject({ from: "shipped", to: "completed", actor: s.ownerId });
    // Terminal: no further poll, manual refresh refused, nothing happens when a stale poll runs.
    expect((await shipmentJobs(orderId)).filter((j) => j.kind === SHIPMENT_TRACK)).toHaveLength(2);
    await expect(refreshTracking(s.owner, orderId)).rejects.toMatchObject({ code: "tracking_done" });
    expect(adapter.calls.track).toBe(2);
    expect(shipmentTimeline(delivered).map((t) => t.text)).toEqual(["Booking diminta", "Resi terbit dari Mengantar", "Paket dibawa kurir", "Diterima oleh Budi", "Terkirim ke pembeli"]);
  });

  it("RTS, cancellation and unknown statuses; manual refresh enqueues one bounded poll; transient read errors retry", async () => {
    const s = await makeStore("toko-a");
    const adapter = scripted({}, [status("WEIRD NEW STATE"), status("RTS", "Dikembalikan ke pengirim")]);
    setBookingAdapter(adapter);
    const orderId = await placed(s);
    await bookShipment(s.owner, orderId);
    await run();

    await refreshTracking(s.owner, orderId);
    expect(await shipmentJobs(orderId)).toMatchObject([{ kind: SHIPMENT_BOOK }, { kind: SHIPMENT_TRACK, key: `track:${orderId}:0` }, { kind: SHIPMENT_TRACK, key: `track:${orderId}:m:1`, status: "pending" }]);
    expect(await run()).toMatchObject([{ kind: SHIPMENT_TRACK, status: "done" }]); // only the manual poll is due
    // Unknown status: state kept, raw value stored and shown verbatim.
    expect(await row(orderId)).toMatchObject({ status: "booked", providerStatus: "WEIRD NEW STATE", manualPolls: 1 });
    expect(providerStatusLabel("WEIRD NEW STATE")).toBe("WEIRD NEW STATE");
    expect((await shipmentJobs(orderId)).filter((j) => j.kind === SHIPMENT_TRACK)).toHaveLength(2); // manual polls do not chain

    await refreshTracking(s.owner, orderId);
    expect(await run()).toMatchObject([{ status: "done" }]);
    expect(await row(orderId)).toMatchObject({ status: "returned", providerStatus: "RTS" });
    expect(await orderRow(orderId)).toMatchObject({ status: "shipped" }); // an RTS never completes the order

    // Transient read error on another shipment: the job retries; the row is untouched.
    const failing = scripted({
      async track() {
        throw new MengantarError("http", "Mengantar: HTTP 503", 503);
      },
    });
    setBookingAdapter(failing);
    const second = await placed(s);
    await bookShipment(s.owner, second);
    await run();
    await makeDue(second);
    expect(await run()).toMatchObject([{ kind: SHIPMENT_TRACK, status: "pending", attempts: 1 }]);
    expect(await row(second)).toMatchObject({ status: "booked", lastError: null });

    expect(mapProviderStatus("canceled")).toMatchObject({ status: "cancelled" });
    expect(mapProviderStatus(" CANCELLED ")).toMatchObject({ status: "cancelled" });
    expect(mapProviderStatus(null)).toBeNull();
    expect([0, 1, 2, 3, 4, 5, 6, 59].map((k) => trackDelayMs(k) / 60_000)).toEqual([15, 30, 60, 120, 240, 360, 360, 360]);
    expect(MAX_TRACK_POLLS).toBe(60);
  });

  it("the signed buyer link exposes status, resi and the courier timeline only; RLS hides shipments outside the store context", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    setBookingAdapter(scripted({}, [status("PICKED UP", "Diambil kurir", "RESI-X")]));
    const orderId = await placed(a);
    await bookShipment(a.owner, orderId);
    await run();
    await makeDue(orderId);
    await run();

    const view = await getShipmentForLink(db, signOrderLink(orderId));
    expect(view).toMatchObject({ status: "in_transit", trackingNumber: `RESI-${orderId}`, providerStatus: "PICKED UP", trackingHistory: [{ desc: "Diambil kurir" }] });
    expect(Object.keys(view!).sort()).toEqual(["bookedAt", "createdAt", "deliveredAt", "lastTrackedAt", "providerStatus", "status", "trackingHistory", "trackingNumber"]);
    expect(await getShipmentForLink(db, signOrderLink(orderId).replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    expect(await getShipmentForLink(db, signOrderLink(orderId + 1))).toBeNull();

    // App role: zero rows without a context, only A's row in A's context, nothing in B's.
    expect(await db.select({ id: shipment.id }).from(shipment)).toEqual([]);
    expect(await withStore(db, a.storeId, (tx) => tx.select({ orderId: shipment.orderId }).from(shipment))).toEqual([{ orderId }]);
    expect(await withStore(db, b.storeId, (tx) => tx.select({ orderId: shipment.orderId }).from(shipment))).toEqual([]);
    expect(await getShipment(b.owner, orderId)).toBeNull();
    // Staff of A fulfil orders too (orders.fulfill), so they may request and read bookings.
    const staffId = await makeUser("staff");
    await platform.execute(sql`insert into membership (store_id, user_id, role) values (${a.storeId}, ${staffId}, 'staff')`);
    expect(await getShipment(await seller(staffId), orderId)).toMatchObject({ trackingNumber: `RESI-${orderId}` });
  });
});

describe("Mengantar booking adapter (pure mapping, UNVERIFIED provider shapes)", () => {
  it("builds the documented create-order payload and reads the documented response, including the unpaid case", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const respond = (body: unknown) => async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = (body: unknown) => new MengantarClient({ apiKey: "secret-key", fetchImpl: respond(body) as unknown as typeof fetch, writeEnabled: true });
    const input: BookingInput = { orderId: 7, storeId: 1, courierCode: "SAPLite", destinationAreaId: "c2c2c2c2c2c2c2c2c2c2c2c2", weightKg: 2, codAmount: 0, goodsValue: 150_000, quantity: 2, parcelContent: "Kaos", buyerName: "Budi", buyerPhone: "0812", shippingAddress: "Jl. Tebet 45" };
    const paid = await mengantarBooking(client({ success: true, batch_id: "B1", data: [{ ORDER_ID: "ORD-1", cnote_no: "SAP123", isPaid: true, statusCategory: "PENDING PICKUP" }] }), { pickupAddressId: "a0a0a0a0a0a0a0a0a0a0a0a0", pickupTimeId: "t1" }).createOrder(input);
    expect(paid).toEqual({ providerOrderId: "ORD-1", providerBatchId: "B1", trackingNumber: "SAP123", paid: true, providerStatus: "PENDING PICKUP" });
    expect(requests[0]!.url).toBe("https://api-public.mengantar.com/api/public/secret-key/order");
    expect(requests[0]!.body).toEqual({
      courier: "Sap",
      pickup: { type: "scheduledPickup", address_id: "a0a0a0a0a0a0a0a0a0a0a0a0", time_id: "t1" },
      orders: [{ customerAddressDataId: "c2c2c2c2c2c2c2c2c2c2c2c2", customerAddress: "Jl. Tebet 45", customerName: "Budi", customerPhone: "0812", parcelContent: "Kaos", weight: 2, quantity: 2, isDangerousGoods: false, cargo: false, goodsValue: 150_000 }],
    });
    // COD + cargo key, unpaid response (docs 01 §8.3).
    const unpaid = await mengantarBooking(client({ success: true, data: [{ ORDER_ID: "ORD-2", cnote_no: null, isPaid: false, batch_id: "B2" }] }), { pickupAddressId: "p" }).createOrder({ ...input, courierCode: "JNECargo", codAmount: 217_500 });
    expect(unpaid).toEqual({ providerOrderId: "ORD-2", providerBatchId: "B2", trackingNumber: null, paid: false, providerStatus: null });
    expect(requests[1]!.body).toMatchObject({ courier: "JNE", orders: [{ cargo: true, COD: 217_500 }] });
    expect((requests[1]!.body as { orders: Record<string, unknown>[] }).orders[0]).not.toHaveProperty("goodsValue");
    // Per-order error and empty data are provider failures (permanent), never a booked state.
    await expect(mengantarBooking(client({ success: true, data: [{ error: "address invalid" }] }), { pickupAddressId: "p" }).createOrder(input)).rejects.toMatchObject({ code: "provider" });
    await expect(mengantarBooking(client({ success: true, data: [], errors: ["dropshipper invalid"] }), { pickupAddressId: "p" }).createOrder(input)).rejects.toMatchObject({ code: "provider", message: "Mengantar: dropshipper invalid" });
    // Tracking: list, paginated and single-object shapes all normalise to the first order.
    const tracked = await mengantarBooking(client({ success: true, data: [{ ORDER_ID: "ORD-1", cnote_no: "SAP123", statusCategory: "ON DELIVERY", history: [{ date: "07-10-2026 09:00", desc: "Diambil" }, { date: "07-10-2026 10:00" }] }] }), { pickupAddressId: "p" }).track({ providerOrderId: "ORD-1", trackingNumber: null });
    expect(tracked).toEqual({ trackingNumber: "SAP123", providerStatus: "ON DELIVERY", paid: null, history: [{ at: "07-10-2026 09:00", desc: "Diambil" }] });
    expect(requests.at(-1)!.url).toContain("/order?order_id=ORD-1");
    expect(firstOrder({ docs: [{ cnote_no: "X" }] })).toMatchObject({ cnote_no: "X" });
    expect(firstOrder({ ORDER_ID: "Y" })).toMatchObject({ ORDER_ID: "Y" });
    expect(firstOrder({ docs: [{ foo: 1 }] })).toBeNull();
    expect(toTrackingResult({ status: "raw" })).toEqual({ trackingNumber: null, providerStatus: "raw", paid: null, history: [] });
    expect(() => toBookingResult({ cnote_no: "x" }, undefined)).toThrow(/ORDER_ID/);
    expect(toCreateOrderCourier("iDlite")).toEqual({ courier: "iDexpress" });
    expect(toCreateOrderCourier("unknownKey")).toEqual({ courier: "unknownKey" });
  });

  it("classifies booking errors: only 409/429 (nothing created) retry; uncertain and permanent errors do not", () => {
    const http = (status: number) => new MengantarError("http", "x", status);
    expect([409, 429].map(http).map(isRetryableBookingError)).toEqual([true, true]);
    expect([400, 401, 403, 404, 422, 500, 502, 503].map(http).map(isRetryableBookingError)).toEqual(Array(8).fill(false));
    for (const code of ["network", "timeout", "provider", "invalid_shape", "write_disabled"] as const) expect(isRetryableBookingError(new MengantarError(code, "x"))).toBe(false);
    expect(isRetryableBookingError(new Error("ECONNRESET"))).toBe(false);
  });
});
