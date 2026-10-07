import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { platformDb, type Db, type Executor } from "./client.ts";
import { enqueue, MAX_ATTEMPTS, registerHandler, sanitizeError } from "./jobs.ts";
import { mengantarBookingFromEnv, type BookingAdapter, type BookingInput, type BookingResult, type TrackingResult } from "./mengantar/booking.ts";
import { MengantarError } from "./mengantar/client.ts";
import { verifyOrderLink } from "./notify.ts";
import { applyTransition } from "./orders.ts";
import { order, ORDER_STATUS_LABEL, orderLine, shipment, SHIPMENT_STATUS_LABEL, type OrderStatus, type ShipmentStatus, type TrackingEvent } from "./schema.ts";
import { DomainError, requireCap, type SellerScope } from "./scoped.ts";
import { inStore, withStore } from "./tenant.ts";
export { SHIPMENT_STATUS_LABEL, SHIPMENT_STATUSES, type ShipmentStatus, type TrackingEvent } from "./schema.ts";
export { CREATE_ORDER_COURIER, mengantarBooking, mengantarBookingFromEnv, type BookingAdapter, type BookingInput, type BookingResult, type TrackingResult } from "./mengantar/booking.ts";

// Shipment booking and tracking through the outbox (T-39, PR-5, Q-2, Q-17). The seller
// action only writes a `shipment` row and a `shipment.book` job in the order's transaction;
// the worker calls the provider (fake unless the platform credentials AND the write lock
// are present), stores the provider reference + resi, and moves the order to `shipped`
// through the one order transition in orders.ts. A read-only `shipment.track` job then
// polls the provider on a bounded schedule and completes the order on delivery.
//
// Exactly-once: `shipment_order_uq` + the `(kind, key)` outbox key give one booking job per
// request (a job whose attempt is not the shipment's current attempt is ignored); the handler
// never calls `createOrder` twice for one shipment: a lost worker leaves the row in `booking`,
// and a write whose outcome is unknown (timeout, network, 5xx) fails closed instead of being
// retried — only 409/429, which the provider rejects before creating anything, retry. Provider
// writes are serialised per platform account with a transaction-scoped advisory lock (409 rule).

export const SHIPMENT_BOOK = "shipment.book";
export const SHIPMENT_TRACK = "shipment.track";
/** Automatic polls per shipment: 15 min doubling to a 6 h ceiling ≈ two weeks of tracking. */
export const MAX_TRACK_POLLS = 60;
/** Seller-triggered refreshes per shipment (each is one provider read). */
export const MAX_MANUAL_POLLS = 50;
export const TRACK_HISTORY_MAX = 50;
/** Orders a seller may book: confirmed (`placed`) or being prepared. */
export const BOOKABLE: readonly OrderStatus[] = ["placed", "processing"];
/** Nothing left to poll in these states; `awaiting_balance` and `failed` accept a seller retry. */
export const TERMINAL: readonly ShipmentStatus[] = ["delivered", "returned", "cancelled", "failed"];
export const RETRYABLE: readonly ShipmentStatus[] = ["awaiting_balance", "failed"];

/** Q-17 (COD remittance) is open: COD bookings stay refused unless the owner sets ALLOW_COD_BOOKING=1. */
export const codBookingAllowed = (env: NodeJS.ProcessEnv = process.env) => env.ALLOW_COD_BOOKING === "1";
export const COD_BOOKING_MESSAGE = "Booking COD lewat Mengantar belum dibuka: kebijakan remitansi COD (Q-17) masih menunggu keputusan pemilik. Kirim dengan resi manual, atau tunggu kebijakan terbit.";

/** Delay before automatic poll `poll` (0-based): 15 min, 30 min, 1 h, 2 h, 4 h, then 6 h. */
export const trackDelayMs = (poll: number) => Math.min(15 * 60_000 * 2 ** Math.max(0, Math.min(poll, 5)), 6 * 3_600_000);

// ── Provider status mapping (docs 01 §11.3 status categories; UNVERIFIED for `GET /order`) ──

export const PROVIDER_STATUS: Record<string, { status: ShipmentStatus; label: string }> = {
  "PENDING PICKUP": { status: "booked", label: "Menunggu pickup kurir" },
  "ACTIVE/WAITING NEXT PROCESS": { status: "booked", label: "Diproses Mengantar" },
  "PICKED UP": { status: "in_transit", label: "Sudah diambil kurir" },
  "ON DELIVERY": { status: "in_transit", label: "Dalam pengantaran" },
  DELIVERED: { status: "delivered", label: "Terkirim ke pembeli" },
  UNDELIVERED: { status: "problem", label: "Gagal diantar, kurir akan mencoba lagi" },
  "PICKUP FAILED": { status: "problem", label: "Pickup gagal" },
  RTS: { status: "returned", label: "Dikembalikan ke pengirim (RTS)" },
  CANCELED: { status: "cancelled", label: "Dibatalkan di Mengantar" },
  CANCELLED: { status: "cancelled", label: "Dibatalkan di Mengantar" },
  ERROR: { status: "problem", label: "Bermasalah di Mengantar" },
};
export const mapProviderStatus = (raw: string | null | undefined) => (raw ? (PROVIDER_STATUS[raw.trim().toUpperCase()] ?? null) : null);
/** Indonesian label for a raw provider status; unknown values are shown verbatim so nothing is hidden. */
export const providerStatusLabel = (raw: string | null | undefined) => mapProviderStatus(raw)?.label ?? raw ?? null;

// ── Adapter (fake unless MENGANTAR_API_KEY + MENGANTAR_PICKUP_ADDRESS_ID are in the process env) ──

const fakeHistory = new Map<string, TrackingEvent[]>();
const fakeResi = new Map<string, string>();
const wib = (d = new Date()) => {
  const p = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}-${g("month")}-${g("year")} ${g("hour")}:${g("minute")}`;
};
/**
 * Fake provider for tests, e2e and local dev: books instantly with a deterministic resi, and
 * each tracking call advances one step (ON DELIVERY → DELIVERED). No network, no balance.
 */
export const fakeMengantarBooking: BookingAdapter = {
  async createOrder(input) {
    const providerOrderId = `MGT-FAKE-${input.orderId}`;
    const trackingNumber = `FAKE-${input.courierCode}-${input.orderId}`;
    fakeHistory.set(providerOrderId, [{ at: wib(), desc: "Order dibuat (simulasi)" }]);
    fakeResi.set(providerOrderId, trackingNumber);
    return { providerOrderId, providerBatchId: `BATCH-FAKE-${input.orderId}`, trackingNumber, paid: true, providerStatus: "PENDING PICKUP" };
  },
  async payUnpaid() {},
  async track({ providerOrderId }) {
    const history = fakeHistory.get(providerOrderId ?? "") ?? [{ at: wib(), desc: "Order dibuat (simulasi)" }];
    const step = history.length; // 1 after booking
    const status = step <= 1 ? "ON DELIVERY" : "DELIVERED";
    history.push({ at: wib(), desc: status === "ON DELIVERY" ? "Paket dalam pengantaran (simulasi)" : "Paket diterima pembeli (simulasi)" });
    if (providerOrderId) fakeHistory.set(providerOrderId, history);
    return { trackingNumber: fakeResi.get(providerOrderId ?? "") ?? null, providerStatus: status, paid: true, history: [...history] };
  },
};

let adapterOverride: BookingAdapter | null = null;
/** Tests inject a scripted adapter here; `null` restores the default. */
export function setBookingAdapter(a: BookingAdapter | null): void {
  adapterOverride = a;
}
let defaultAdapter: BookingAdapter | undefined;
export function bookingAdapter(): BookingAdapter {
  return adapterOverride ?? (defaultAdapter ??= mengantarBookingFromEnv() ?? fakeMengantarBooking);
}

// ── Seller actions (store-scoped) ────────────────────────────────────────────

export type BookOutcome = { shipmentId: number; attempt: number; created: boolean };

/**
 * "Kirim lewat Mengantar": create the shipment row and enqueue the booking in one transaction.
 * Idempotent per order: a second click while the booking is queued returns the same shipment
 * (`created: false`); `awaiting_balance`/`failed` shipments get a new attempt (new job key);
 * anything already booked is refused. COD orders are refused while Q-17 is open.
 */
export async function bookShipment(scope: SellerScope, orderId: number): Promise<BookOutcome> {
  requireCap(scope, "orders.fulfill");
  return inStore(scope, async ({ exec: tx }) => {
    const [o] = await tx
      .select({ status: order.status, paymentMethod: order.paymentMethod, courierCode: order.courierCode, originAreaId: order.originAreaId, destinationAreaId: order.destinationAreaId, weightKg: order.weightKg, total: order.total })
      .from(order)
      .where(and(eq(order.storeId, scope.storeId), eq(order.id, orderId)))
      .for("update");
    if (!o) throw new DomainError("not_found", "Pesanan tidak ditemukan.");
    const [existing] = await tx.select().from(shipment).where(and(eq(shipment.storeId, scope.storeId), eq(shipment.orderId, orderId)));
    if (existing && (existing.status === "queued" || existing.status === "booking")) {
      return { shipmentId: existing.id, attempt: existing.bookingAttempts, created: false }; // duplicate click: the job already exists
    }
    if (existing && !RETRYABLE.includes(existing.status)) throw new DomainError("already_booked", `Pesanan ini sudah dibooking (${SHIPMENT_STATUS_LABEL[existing.status].toLowerCase()}).`);
    if (!BOOKABLE.includes(o.status)) throw new DomainError("not_bookable", `Pesanan berstatus "${ORDER_STATUS_LABEL[o.status]}" tidak bisa dibooking; booking hanya untuk pesanan Baru atau Diproses.`);
    if (o.paymentMethod === "cod" && !codBookingAllowed()) throw new DomainError("cod_booking_disabled", COD_BOOKING_MESSAGE);

    let shipmentId: number;
    let attempt = 0;
    if (!existing) {
      const [row] = await tx
        .insert(shipment)
        .values({
          storeId: scope.storeId,
          orderId,
          requestedBy: scope.userId,
          courierCode: o.courierCode,
          originAreaId: o.originAreaId,
          destinationAreaId: o.destinationAreaId,
          weightKg: o.weightKg,
          codAmount: o.paymentMethod === "cod" ? o.total : 0,
        })
        .returning({ id: shipment.id });
      shipmentId = row!.id;
    } else {
      attempt = existing.bookingAttempts + 1;
      // Back to `queued` so a second click returns this attempt; the worker pays an unpaid
      // provider order (providerOrderId set) instead of creating a new one.
      await tx
        .update(shipment)
        .set({ bookingAttempts: attempt, status: "queued", lastError: null, updatedAt: new Date() })
        .where(eq(shipment.id, existing.id));
      shipmentId = existing.id;
    }
    await enqueue(tx, { kind: SHIPMENT_BOOK, storeId: scope.storeId, key: `shipment:${orderId}:${attempt}`, payload: { orderId, attempt } });
    return { shipmentId, attempt, created: true };
  });
}

/** "Perbarui status": one extra provider read, bounded per shipment; the worker applies the result. */
export async function refreshTracking(scope: SellerScope, orderId: number): Promise<void> {
  requireCap(scope, "orders.fulfill");
  return inStore(scope, async ({ exec: tx }) => {
    const [s] = await tx.select().from(shipment).where(and(eq(shipment.storeId, scope.storeId), eq(shipment.orderId, orderId))).for("update");
    if (!s) throw new DomainError("not_found", "Pesanan ini belum dibooking lewat Mengantar.");
    if (!s.providerOrderId) throw new DomainError("not_booked", "Belum ada order Mengantar yang bisa dilacak.");
    if (TERMINAL.includes(s.status)) throw new DomainError("tracking_done", "Pelacakan pengiriman ini sudah selesai.");
    if (s.manualPolls >= MAX_MANUAL_POLLS) throw new DomainError("poll_limit", "Batas pembaruan manual tercapai; status tetap diperbarui otomatis.");
    const n = s.manualPolls + 1;
    await tx.update(shipment).set({ manualPolls: n, updatedAt: new Date() }).where(eq(shipment.id, s.id));
    await enqueue(tx, { kind: SHIPMENT_TRACK, storeId: scope.storeId, key: `track:${orderId}:m:${n}`, payload: { orderId } });
  });
}

export type ShipmentView = typeof shipment.$inferSelect;

export async function getShipment(scope: SellerScope, orderId: number): Promise<ShipmentView | null> {
  requireCap(scope, "orders.read");
  const [s] = await inStore(scope, ({ exec }) => exec.select().from(shipment).where(and(eq(shipment.storeId, scope.storeId), eq(shipment.orderId, orderId))));
  return s ?? null;
}

/** Buyer-facing subset behind the signed order link (T-36): status, resi and the courier timeline only. */
export async function getShipmentForLink(exec: Executor, token: string, now = Date.now()) {
  const orderId = verifyOrderLink(token, now);
  if (!orderId) return null;
  // Cross-store resolver (ADR-0005 §4): the signed order id → its store; then the store context.
  const [owner] = await platformDb().select({ storeId: order.storeId }).from(order).where(eq(order.id, orderId));
  if (!owner) return null;
  const [s] = await withStore(exec, owner.storeId, (tx) =>
    tx
      .select({
        status: shipment.status,
        trackingNumber: shipment.trackingNumber,
        providerStatus: shipment.providerStatus,
        trackingHistory: shipment.trackingHistory,
        createdAt: shipment.createdAt,
        bookedAt: shipment.bookedAt,
        deliveredAt: shipment.deliveredAt,
        lastTrackedAt: shipment.lastTrackedAt,
      })
      .from(shipment)
      .where(and(eq(shipment.storeId, owner.storeId), eq(shipment.orderId, orderId))),
  );
  return s ?? null;
}

export type TimelineItem = { at: Date | string; text: string };
/** Local milestones (requested, booked, delivered) followed by the provider's own history lines (WIB strings as given). */
export function shipmentTimeline(s: { createdAt: Date; bookedAt: Date | null; deliveredAt: Date | null; trackingHistory: TrackingEvent[]; status: ShipmentStatus }): TimelineItem[] {
  const items: TimelineItem[] = [{ at: s.createdAt, text: "Booking diminta" }];
  if (s.bookedAt) items.push({ at: s.bookedAt, text: "Resi terbit dari Mengantar" });
  for (const h of s.trackingHistory) items.push({ at: h.at, text: h.desc });
  if (s.deliveredAt) items.push({ at: s.deliveredAt, text: SHIPMENT_STATUS_LABEL.delivered });
  return items;
}

// ── Worker handlers (platform pool; store context only around the order transition) ──

const bookPayload = z.object({ orderId: z.number().int().positive(), attempt: z.number().int().min(0).default(0) });
const trackPayload = z.object({ orderId: z.number().int().positive(), poll: z.number().int().min(0).optional() });

const ACCOUNT_LOCK = "mengantar:order:write"; // one platform account (Q-2)
/**
 * Serialise provider WRITES across every worker process: the partner docs reject parallel
 * `POST /order` on one account with 409. Transaction-scoped advisory lock in a transaction
 * that performs no business write (remote I/O never runs inside a business transaction).
 */
async function withAccountLock<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ACCOUNT_LOCK}))`);
    return fn();
  });
}

const loadShipment = async (db: Db, storeId: number, orderId: number) => (await db.select().from(shipment).where(and(eq(shipment.storeId, storeId), eq(shipment.orderId, orderId))))[0] ?? null;
const setShipment = (db: Executor, id: number, patch: Partial<typeof shipment.$inferInsert>) => db.update(shipment).set({ ...patch, updatedAt: new Date() }).where(eq(shipment.id, id));

/**
 * Only 409 (parallel batch on the account) and 429 (rate limit) prove the provider created
 * nothing, so only they retry a WRITE. Timeouts, network errors and 5xx leave the outcome
 * unknown: retrying could create a second provider order, so they fail closed.
 */
export function isRetryableBookingError(err: unknown): boolean {
  return err instanceof MengantarError && err.code === "http" && (err.status === 409 || err.status === 429);
}
/** Outcome unknown: the request may have reached the provider. */
const isUncertainWrite = (err: unknown) => err instanceof MengantarError && (err.code === "timeout" || err.code === "network" || (err.code === "http" && err.status >= 500));
export const WRITE_DISABLED_MESSAGE = "Booking Mengantar dinonaktifkan di server ini (MENGANTAR_WRITE_ENABLED belum diaktifkan; perlu persetujuan pemilik).";
export const UNPAID_MESSAGE = "Saldo akun Mengantar tidak cukup: order dibuat sebagai unpaid tanpa resi. Tambah saldo, lalu klik Coba lagi.";
export const UNCERTAIN_MESSAGE = "Hasil booking tidak pasti (Mengantar tidak menjawab). Periksa dashboard Mengantar sebelum mencoba lagi agar tidak terbit dua order.";
export const PAID_WAITING_MESSAGE = "Pembayaran order Mengantar terkirim; resi diambil otomatis saat terbit.";
const bookingErrorMessage = (err: unknown) =>
  err instanceof MengantarError && err.code === "write_disabled" ? WRITE_DISABLED_MESSAGE : isUncertainWrite(err) ? `${UNCERTAIN_MESSAGE} (${sanitizeError(err)})` : sanitizeError(err);

async function bookingInput(db: Db, storeId: number, orderId: number, s: ShipmentView): Promise<(BookingInput & { status: OrderStatus; paymentMethod: string }) | null> {
  const [o] = await db
    .select({ status: order.status, paymentMethod: order.paymentMethod, buyerName: order.buyerName, buyerPhone: order.buyerPhone, shippingAddress: order.shippingAddress, subtotal: order.subtotal, total: order.total })
    .from(order)
    .where(and(eq(order.storeId, storeId), eq(order.id, orderId)));
  if (!o) return null;
  const lines = await db.select({ title: orderLine.productTitle, quantity: orderLine.quantity }).from(orderLine).where(and(eq(orderLine.storeId, storeId), eq(orderLine.orderId, orderId)));
  return {
    orderId,
    storeId,
    status: o.status,
    paymentMethod: o.paymentMethod,
    courierCode: s.courierCode,
    destinationAreaId: s.destinationAreaId,
    weightKg: s.weightKg,
    codAmount: s.codAmount,
    goodsValue: o.subtotal,
    quantity: lines.reduce((n, l) => n + l.quantity, 0) || 1,
    parcelContent: lines.map((l) => l.title).join(", ").slice(0, 200) || `Pesanan #${orderId}`,
    buyerName: o.buyerName,
    buyerPhone: o.buyerPhone,
    shippingAddress: o.shippingAddress,
  };
}

/** `placed` → `processing` → `shipped` with the provider resi; an order already shipped by hand keeps its own resi. */
async function shipOrder(tx: Executor, storeId: number, orderId: number, resi: string, actorUserId: string): Promise<void> {
  const [o] = await tx.select({ status: order.status }).from(order).where(and(eq(order.storeId, storeId), eq(order.id, orderId)));
  if (!o) return;
  let status = o.status;
  if (status === "placed") status = await applyTransition(tx, storeId, orderId, "process", null, actorUserId);
  if (status === "processing") await applyTransition(tx, storeId, orderId, "ship", resi, actorUserId);
}

/** Store a booking result: resi → `booked` + order shipped + first poll scheduled; no resi → `awaiting_balance`. */
async function recordBooking(db: Db, s: ShipmentView, r: BookingResult): Promise<void> {
  await withStore(db, s.storeId, async (tx) => {
    if (!r.trackingNumber) {
      await setShipment(tx, s.id, { status: "awaiting_balance", providerOrderId: r.providerOrderId, providerBatchId: r.providerBatchId, providerStatus: r.providerStatus, paid: false, lastError: UNPAID_MESSAGE, lastTrackedAt: new Date() });
      return;
    }
    const mapped = mapProviderStatus(r.providerStatus)?.status;
    await setShipment(tx, s.id, {
      status: mapped === "in_transit" ? "in_transit" : "booked",
      providerOrderId: r.providerOrderId,
      providerBatchId: r.providerBatchId,
      trackingNumber: r.trackingNumber,
      providerStatus: r.providerStatus,
      paid: true,
      bookedAt: s.bookedAt ?? new Date(),
      lastTrackedAt: new Date(),
      lastError: null,
    });
    await shipOrder(tx, s.storeId, s.orderId, r.trackingNumber, s.requestedBy);
    await enqueue(tx, { kind: SHIPMENT_TRACK, storeId: s.storeId, key: `track:${s.orderId}:0`, payload: { orderId: s.orderId, poll: 0 }, runAt: new Date(Date.now() + trackDelayMs(0)) });
  });
}

registerHandler(SHIPMENT_BOOK, async ({ db }, j) => {
  const { orderId, attempt } = bookPayload.parse(j.payload);
  const s = await loadShipment(db, j.storeId, orderId);
  if (!s || attempt !== s.bookingAttempts) return; // superseded attempt (stale job): never acts
  if (s.status === "booking") {
    // lazy: a worker died between the provider call and the write. `createOrder` carries no client
    // reference we could look the order up by, so never book again blindly: fail closed and let the
    // seller retry after checking the Mengantar dashboard. Upgrade path: GET /order?keyword=<ref>.
    await setShipment(db, s.id, { status: "failed", lastError: "Booking terputus sebelum hasil tersimpan; periksa dashboard Mengantar sebelum mencoba lagi." });
    return;
  }
  if (s.status !== "queued") return; // already handled (re-run after a lost lease)
  const input = await bookingInput(db, j.storeId, orderId, s);
  if (!input) return;
  if (!BOOKABLE.includes(input.status)) {
    await setShipment(db, s.id, { status: s.providerOrderId ? "awaiting_balance" : "failed", lastError: `Pesanan berstatus "${ORDER_STATUS_LABEL[input.status]}" saat booking dijalankan; tidak dibooking.` });
    return;
  }
  if (input.paymentMethod === "cod" && !codBookingAllowed()) {
    await setShipment(db, s.id, { status: s.providerOrderId ? "awaiting_balance" : "failed", lastError: COD_BOOKING_MESSAGE });
    return;
  }

  const adapter = bookingAdapter();
  const fallback: ShipmentStatus = s.providerOrderId ? "awaiting_balance" : "failed";
  let result: BookingResult | null = null;
  try {
    if (!s.providerOrderId) {
      await setShipment(db, s.id, { status: "booking" });
      result = await withAccountLock(db, () => adapter.createOrder(input));
    } else {
      // Unpaid order from an earlier attempt (seller topped up and retried): pay the batch.
      await withAccountLock(db, () => adapter.payUnpaid(s.providerBatchId ?? s.providerOrderId!, s.courierCode));
    }
  } catch (err) {
    if (!isRetryableBookingError(err) || j.attempts >= MAX_ATTEMPTS) {
      await setShipment(db, s.id, { status: fallback, lastError: bookingErrorMessage(err) });
      return;
    }
    await setShipment(db, s.id, { status: "queued", lastError: sanitizeError(err) });
    throw err; // 409 / 429: the provider created nothing; the outbox retries with backoff
  }
  if (!result) {
    // Paid: read the resi back through a tracking poll (a read; retried by the outbox on its own,
    // so a failed read never repeats the payment). `applyTracking` ships the order once the resi appears.
    await withStore(db, s.storeId, async (tx) => {
      await setShipment(tx, s.id, { status: "awaiting_balance", lastError: PAID_WAITING_MESSAGE });
      await enqueue(tx, { kind: SHIPMENT_TRACK, storeId: s.storeId, key: `track:${orderId}:pay:${attempt}`, payload: { orderId, poll: 0 } });
    });
    return;
  }
  await recordBooking(db, s, result);
});

/** Apply one tracking read: history, provider status, state mapping, late resi, delivery → order completed. */
async function applyTracking(db: Db, s: ShipmentView, t: TrackingResult, nextPoll: number | undefined): Promise<void> {
  await withStore(db, s.storeId, async (tx) => {
    const now = new Date();
    const gotResi = !s.trackingNumber && t.trackingNumber;
    const resi = s.trackingNumber ?? t.trackingNumber;
    const mapped = mapProviderStatus(t.providerStatus)?.status;
    // Tracking states need a resi; an unpaid order stays `awaiting_balance` until one appears.
    const status: ShipmentStatus = !resi ? s.status : (mapped ?? (TERMINAL.includes(s.status) ? s.status : gotResi ? "booked" : s.status));
    const delivered = status === "delivered";
    await setShipment(tx, s.id, {
      status,
      trackingNumber: resi,
      paid: s.paid || resi !== null,
      bookedAt: s.bookedAt ?? (resi ? now : null),
      providerStatus: t.providerStatus ?? s.providerStatus,
      trackingHistory: (t.history.length ? t.history : s.trackingHistory).slice(-TRACK_HISTORY_MAX),
      deliveredAt: s.deliveredAt ?? (delivered ? now : null),
      lastTrackedAt: now,
      lastError: null,
    });
    if (resi && gotResi) await shipOrder(tx, s.storeId, s.orderId, resi, s.requestedBy);
    if (delivered) {
      const [o] = await tx.select({ status: order.status }).from(order).where(and(eq(order.storeId, s.storeId), eq(order.id, s.orderId)));
      if (o?.status === "shipped") await applyTransition(tx, s.storeId, s.orderId, "complete", null, s.requestedBy);
    }
    if (nextPoll !== undefined && !TERMINAL.includes(status) && nextPoll < MAX_TRACK_POLLS) {
      await enqueue(tx, { kind: SHIPMENT_TRACK, storeId: s.storeId, key: `track:${s.orderId}:${nextPoll}`, payload: { orderId: s.orderId, poll: nextPoll }, runAt: new Date(Date.now() + trackDelayMs(nextPoll)) });
    }
  });
}

registerHandler(SHIPMENT_TRACK, async ({ db }, j) => {
  const { orderId, poll } = trackPayload.parse(j.payload);
  const s = await loadShipment(db, j.storeId, orderId);
  if (!s || !s.providerOrderId || TERMINAL.includes(s.status)) return;
  // Read-only provider call outside any transaction; a failure retries through the outbox backoff.
  const t = await bookingAdapter().track({ providerOrderId: s.providerOrderId, trackingNumber: s.trackingNumber });
  await applyTracking(db, s, t, poll === undefined ? undefined : poll + 1);
});
