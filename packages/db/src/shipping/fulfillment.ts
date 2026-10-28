import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor } from "../client.ts";
import { enqueue, MAX_ATTEMPTS, registerHandler, sanitizeError } from "../ops/jobs/jobs.ts";
import { mengantarBookingFromEnv, type BookingAdapter, type BookingInput, type BookingResult, type TrackingResult } from "./mengantar/booking.ts";
import { MengantarError } from "./mengantar/client.ts";
import { verifyOrderLink } from "../ops/jobs/notify.ts";
import { applyProviderTransition, applyTransition } from "../seller/commerce/orders.ts";
import { requoteOrder, reserveShippingCost, reverseShippingReservation } from "../ledger/booking.ts";
import { codAllowedCouriers } from "./shipping.ts";
import { order, ORDER_STATUS_LABEL, orderLine, orderRedaction, shipment, SHIPMENT_STATUS_LABEL, type OrderStatus, type ShipmentStatus, type TrackingEvent } from "../schema.ts";
import { PROVIDER_CODE_RE_SOURCE, REDACTED } from "../seller/commerce/privacy.ts";
import { DomainError, requireCap, type SellerScope } from "../platform/scoped.ts";
import { resolveOrderStore } from "../platform/resolvers.ts";
import { inStore, withStore } from "../platform/tenant.ts";
import { orderShippingAccount, type ShippingAccountView } from "./accounts.ts";
import { withShippingDispatch } from "./dispatch.ts";
import { PARTNER_DISPATCH_LOCKED_MESSAGE, scrubProviderText, UNKNOWN_PROVIDER_STATUS_LABEL } from "./copy.ts";
export { SHIPMENT_STATUS_LABEL, SHIPMENT_STATUSES, type ShipmentStatus, type TrackingEvent } from "../schema.ts";
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
export const RETRYABLE: readonly ShipmentStatus[] = ["awaiting_account", "awaiting_balance", "failed"];

/** Q-17 (COD remittance) is open: COD bookings stay refused unless the owner sets ALLOW_COD_BOOKING=1. */
export const codBookingAllowed = (env: NodeJS.ProcessEnv = process.env) => env.ALLOW_COD_BOOKING === "1";
export const COD_BOOKING_MESSAGE = "Booking COD lewat Bukalaris Kirim belum dibuka: kebijakan remitansi COD masih menunggu keputusan pemilik platform. Kirim dengan resi manual, atau tunggu kebijakan terbit.";

/** Delay before automatic poll `poll` (0-based): 15 min, 30 min, 1 h, 2 h, 4 h, then 6 h. */
export const trackDelayMs = (poll: number) => Math.min(15 * 60_000 * 2 ** Math.max(0, Math.min(poll, 5)), 6 * 3_600_000);

// ── Provider status mapping (docs 01 §11.3 status categories; UNVERIFIED for `GET /order`) ──

export const PROVIDER_STATUS: Record<string, { status: ShipmentStatus; label: string }> = {
  "PENDING PICKUP": { status: "booked", label: "Menunggu pickup kurir" },
  "ACTIVE/WAITING NEXT PROCESS": { status: "booked", label: "Diproses Bukalaris Kirim" },
  "PICKED UP": { status: "in_transit", label: "Sudah diambil kurir" },
  "ON DELIVERY": { status: "in_transit", label: "Dalam pengantaran" },
  DELIVERED: { status: "delivered", label: "Terkirim ke pembeli" },
  UNDELIVERED: { status: "problem", label: "Gagal diantar, kurir akan mencoba lagi" },
  "PICKUP FAILED": { status: "problem", label: "Pickup gagal" },
  RTS: { status: "returned", label: "Dikembalikan ke pengirim (RTS)" },
  CANCELED: { status: "cancelled", label: "Dibatalkan di Bukalaris Kirim" },
  CANCELLED: { status: "cancelled", label: "Dibatalkan di Bukalaris Kirim" },
  ERROR: { status: "problem", label: "Bermasalah di Bukalaris Kirim" },
};
export const mapProviderStatus = (raw: string | null | undefined) => (raw ? (PROVIDER_STATUS[raw.trim().toUpperCase()] ?? null) : null);
/** Indonesian label for a raw provider status. A status this product does not know is NEVER echoed (it is provider text): a neutral label stands in, the raw value stays on the shipment row for the operator. */
export const providerStatusLabel = (raw: string | null | undefined) => (raw?.trim() ? (mapProviderStatus(raw)?.label ?? UNKNOWN_PROVIDER_STATUS_LABEL) : null);

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
    if (o.paymentMethod === "cod" && !(await codAllowedCouriers(tx)).has(o.courierCode.toLowerCase())) throw new DomainError("cod_courier_not_allowed", COD_COURIER_MESSAGE);

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
    if (!s) throw new DomainError("not_found", "Pesanan ini belum dibooking lewat Bukalaris Kirim.");
    if (!s.providerOrderId) throw new DomainError("not_booked", "Belum ada order Bukalaris Kirim yang bisa dilacak.");
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
  // Cross-store resolver (ADR-0005 §4): the signed order id → its store through `resolve_order_store` on the
  // caller's own pool; then the store context.
  const storeId = await resolveOrderStore(exec, orderId);
  if (!storeId) return null;
  const [s] = await withStore(exec, storeId, (tx) =>
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
      .where(and(eq(shipment.storeId, storeId), eq(shipment.orderId, orderId))),
  );
  return s ?? null;
}

export type TimelineItem = { at: Date | string; text: string };
/** Local milestones (requested, booked, delivered) followed by the provider's own history lines (WIB strings as given). */
export function shipmentTimeline(s: { createdAt: Date; bookedAt: Date | null; deliveredAt: Date | null; trackingHistory: TrackingEvent[]; status: ShipmentStatus }): TimelineItem[] {
  const items: TimelineItem[] = [{ at: s.createdAt, text: "Booking diminta" }];
  if (s.bookedAt) items.push({ at: s.bookedAt, text: "Resi terbit dari Bukalaris Kirim" });
  for (const h of s.trackingHistory) items.push({ at: h.at, text: mapProviderStatus(h.desc)?.label ?? scrubProviderText(h.desc) });
  if (s.deliveredAt) items.push({ at: s.deliveredAt, text: SHIPMENT_STATUS_LABEL.delivered });
  return items;
}

// ── Worker handlers (platform pool; store context only around the order transition) ──

const bookPayload = z.object({ orderId: z.number().int().positive(), attempt: z.number().int().min(0).default(0) });
const trackPayload = z.object({ orderId: z.number().int().positive(), poll: z.number().int().min(0).optional() });

/** Select a test/fake adapter, or the explicitly gated master transport. A partner snapshot is NEVER sent on a master credential. */
function accountBookingAdapter(account: ShippingAccountView): BookingAdapter {
  if (!adapterOverride && process.env.MENGANTAR_API_KEY && account.kind === "partner_managed") throw new DomainError("awaiting_account", PARTNER_DISPATCH_LOCKED_MESSAGE);
  return bookingAdapter();
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
export const WRITE_DISABLED_MESSAGE = "Booking Bukalaris Kirim dinonaktifkan di server ini (perlu persetujuan pemilik).";
export const UNPAID_MESSAGE = "Saldo akun Bukalaris Kirim tidak cukup: order dibuat sebagai unpaid tanpa resi. Tambah saldo, lalu klik Coba lagi.";
export const UNCERTAIN_MESSAGE = "Hasil booking tidak pasti (Bukalaris Kirim tidak menjawab). Hubungi Bukalaris sebelum mencoba lagi agar tidak terbit dua order.";
export const PAID_WAITING_MESSAGE = "Pembayaran order Bukalaris Kirim terkirim; resi diambil otomatis saat terbit.";
export const COD_COURIER_MESSAGE = "Layanan kurir ini tidak masuk daftar COD Bukalaris Kirim (COD hanya untuk layanan dengan retur gratis). Pilih kurir lain atau bayar transfer.";
export const RESERVE_MESSAGES = {
  insufficient_balance: "Saldo tersedia toko tidak cukup menutup selisih ongkir kurir. Booking dibatalkan sebelum dikirim ke kurir; tunggu dana pesanan lain cair, lalu coba lagi.",
  reservation_reversed: "Pemesanan kurir untuk pesanan ini sudah pernah ditolak dan potongannya dikembalikan; booking ulang belum didukung. Hubungi Bukalaris.",
  not_bookable: "Pesanan tidak bisa dibooking dalam status ini.",
  cod_amount_mismatch: "Nilai COD yang dikirim berbeda dari total pesanan (cod_amount_mismatch). Booking dibatalkan sebelum ke kurir.",
  quote_unavailable: "Kurir tidak lagi melayani rute ini; booking dibatalkan sebelum ke penyedia.",
} as const;
const bookingErrorMessage = (err: unknown) =>
  err instanceof MengantarError && err.code === "write_disabled" ? WRITE_DISABLED_MESSAGE : isUncertainWrite(err) ? `${UNCERTAIN_MESSAGE} (${sanitizeError(err)})` : sanitizeError(err);

async function bookingInput(db: Db, storeId: number, orderId: number, s: ShipmentView): Promise<(BookingInput & { status: OrderStatus; paymentMethod: string }) | null> {
  const [o] = await db
    .select({ status: order.status, paymentMethod: order.paymentMethod, buyerName: order.buyerName, buyerPhone: order.buyerPhone, shippingAddress: order.shippingAddress, subtotal: order.subtotal, total: order.total, shippingAccountId: order.shippingAccountId, shippingAccountKind: order.shippingAccountKind })
    .from(order)
    .where(and(eq(order.storeId, storeId), eq(order.id, orderId)));
  if (!o) return null;
  const lines = await db.select({ title: orderLine.productTitle, quantity: orderLine.quantity }).from(orderLine).where(and(eq(orderLine.storeId, storeId), eq(orderLine.orderId, orderId)));
  return {
    orderId,
    storeId,
    shippingAccountId: o.shippingAccountId,
    shippingAccountKind: o.shippingAccountKind,
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

/**
 * Steps 1 and 2 of the booking reconciliation (ADR-0006 decision 7): a live re-quote outside any lock, then one transaction that records the
 * append-once cost and reserves the seller's debit. Returns the seller-facing failure when the provider must NOT be called, or null.
 * A provider outage while re-quoting throws (nothing was reserved), so the outbox retries the read.
 */
async function reserveBooking(db: Db, s: ShipmentView, input: BookingInput & { paymentMethod: string }): Promise<string | null> {
  const cod = input.paymentMethod === "cod";
  let requote;
  try {
    requote = await requoteOrder({ originAreaId: s.originAreaId, destinationAreaId: s.destinationAreaId, weightKg: s.weightKg, courierCode: s.courierCode, cod, payableIdr: input.codAmount, shippingAccountId: input.shippingAccountId!, shippingAccountKind: input.shippingAccountKind! });
  } catch (err) {
    if (err instanceof DomainError) return RESERVE_MESSAGES.quote_unavailable;
    throw err;
  }
  const r = await reserveShippingCost(db, { storeId: s.storeId, orderId: s.orderId, requote, codAmountSentIdr: cod ? s.codAmount : null });
  return r.outcome === "refused" ? RESERVE_MESSAGES[r.reason] : null;
}

registerHandler(SHIPMENT_BOOK, async ({ db }, j) => {
  const { orderId, attempt } = bookPayload.parse(j.payload);
  const s = await loadShipment(db, j.storeId, orderId);
  if (!s || attempt !== s.bookingAttempts) return; // superseded attempt (stale job): never acts
  if (s.status === "booking") {
    // lazy: a worker died between the provider call and the write. `createOrder` carries no client
    // reference we could look the order up by, so never book again blindly: fail closed and let the
    // seller retry after checking the Mengantar dashboard. Upgrade path: GET /order?keyword=<ref>.
    await setShipment(db, s.id, { status: "failed", lastError: "Booking terputus sebelum hasil tersimpan; hubungi Bukalaris sebelum mencoba lagi." });
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
  if (input.paymentMethod === "cod" && !(await codAllowedCouriers(db)).has(s.courierCode.toLowerCase())) {
    await setShipment(db, s.id, { status: s.providerOrderId ? "awaiting_balance" : "failed", lastError: COD_COURIER_MESSAGE });
    return;
  }
  let account: ShippingAccountView;
  let adapter: BookingAdapter;
  try {
    account = await orderShippingAccount(db, s.storeId, orderId);
    adapter = accountBookingAdapter(account);
  } catch (err) {
    if (!(err instanceof DomainError) || err.code !== "awaiting_account") throw err;
    await setShipment(db, s.id, { status: "awaiting_account", lastError: err.message });
    return;
  }
  if (!s.providerOrderId) {
    // ADR-0006 decision 7: live re-quote outside any lock, then ONE transaction reserves the cost and the seller's debit, and refuses before the provider
    // call when it cannot be covered. The provider is called only after this commits.
    const failure = await reserveBooking(db, s, input);
    if (failure) {
      await setShipment(db, s.id, { status: "failed", lastError: failure });
      return;
    }
  }

  // account and adapter above are derived from the order snapshot, not current store routing.
  const fallback: ShipmentStatus = s.providerOrderId ? "awaiting_balance" : "failed";
  let result: BookingResult | null = null;
  try {
    if (!s.providerOrderId) {
      await setShipment(db, s.id, { status: "booking" });
      result = await withShippingDispatch(db, account, () => adapter.createOrder(input));
    } else {
      // Unpaid order from an earlier attempt (seller topped up and retried): pay the batch.
      await withShippingDispatch(db, account, () => adapter.payUnpaid(s.providerBatchId ?? s.providerOrderId!, s.courierCode));
    }
  } catch (err) {
    if (!isRetryableBookingError(err) || j.attempts >= MAX_ATTEMPTS) {
      await setShipment(db, s.id, { status: fallback, lastError: bookingErrorMessage(err) });
      // A definite rejection created nothing, so the reserved debit is returned; an unknown outcome keeps it until the outcome is proven.
      if (!s.providerOrderId && !isUncertainWrite(err)) await reverseShippingReservation(db, s.storeId, orderId);
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

const scrubProviderStatus = (status: string | null): string | null => (status === null || (status.length <= 40 && new RegExp(PROVIDER_CODE_RE_SOURCE).test(status)) ? status : REDACTED);

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
    // T-47: an order redacted with an override may still be polled; its provider text stays stripped (timestamps and status codes are kept).
    // Wave 5 review: take the order row first (the same row `redactOrders` locks FOR UPDATE), so a poll that started before a redaction cannot write its provider text back after it.
    await tx.select({ id: order.id }).from(order).where(and(eq(order.storeId, s.storeId), eq(order.id, s.orderId))).for("share");
    const [redacted] = await tx.select({ id: orderRedaction.orderId }).from(orderRedaction).where(and(eq(orderRedaction.storeId, s.storeId), eq(orderRedaction.orderId, s.orderId)));
    const history = (t.history.length ? t.history : s.trackingHistory).slice(-TRACK_HISTORY_MAX);
    await setShipment(tx, s.id, {
      status,
      trackingNumber: resi,
      paid: s.paid || resi !== null,
      bookedAt: s.bookedAt ?? (resi ? now : null),
      // A redacted order keeps only a status CODE (provider free text such as "Diterima oleh <nama>" is replaced); `PROVIDER_CODE_RE` is the rule redaction itself uses.
      providerStatus: redacted ? scrubProviderStatus(t.providerStatus ?? s.providerStatus) : (t.providerStatus ?? s.providerStatus),
      trackingHistory: redacted ? history.map((h) => ({ ...h, desc: REDACTED })) : history,
      deliveredAt: s.deliveredAt ?? (delivered ? now : null),
      lastTrackedAt: now,
      lastError: null,
    });
    if (resi && gotResi) await shipOrder(tx, s.storeId, s.orderId, resi, s.requestedBy);
    // Courier-driven moves go through the one writer: DELIVERED -> completed (a COD sale is booked pending only here, ADR-0006 decision 4), RTS -> returned
    // (in transit only), a courier cancellation -> cancelled. A move the writer refuses is recorded on the shipment (and the audit log), never dropped.
    const target = status === "delivered" ? "completed" : status === "returned" ? "returned" : status === "cancelled" ? "cancelled" : null;
    if (target) {
      const r = await applyProviderTransition(tx, s.storeId, s.orderId, target, { source: "provider", note: providerStatusLabel(t.providerStatus) ?? undefined });
      if (r.outcome === "rejected") await setShipment(tx, s.id, { lastError: `Pembaruan status dari kurir ditolak penulis status pesanan; pesanan tetap "${ORDER_STATUS_LABEL[r.status]}". Hubungi Bukalaris bila status ini tidak sesuai.` });
    }
    if (nextPoll !== undefined && !TERMINAL.includes(status) && nextPoll < MAX_TRACK_POLLS) {
      await enqueue(tx, { kind: SHIPMENT_TRACK, storeId: s.storeId, key: `track:${s.orderId}:${nextPoll}`, payload: { orderId: s.orderId, poll: nextPoll }, runAt: new Date(Date.now() + trackDelayMs(nextPoll)) });
    }
  });
}

/** Delay before tracking is retried for a shipment whose Partner account is not usable (needs_key or disabled). */
const ACCOUNT_RETRY_MS = 15 * 60_000;

registerHandler(SHIPMENT_TRACK, async ({ db }, j) => {
  const { orderId, poll } = trackPayload.parse(j.payload);
  const s = await loadShipment(db, j.storeId, orderId);
  if (!s || !s.providerOrderId || TERMINAL.includes(s.status)) return;
  // Read-only provider call outside any transaction; a failure retries through the outbox backoff.
  let account: ShippingAccountView;
  try { account = await orderShippingAccount(db, s.storeId, orderId); }
  catch (err) {
    if (!(err instanceof DomainError) || err.code !== "awaiting_account") throw err;
    // Wave 4 review: a parcel that is already booked keeps its real status (the buyer page must not say "awaiting account" for a parcel in transit) and tracking is
    // re-queued with a fixed delay, so it resumes by itself once the account is usable again; before this the chain ended here and DELIVERED -> completed waited for a manual refresh.
    await setShipment(db, s.id, { lastError: err.message });
    const bucket = Math.floor(Date.now() / ACCOUNT_RETRY_MS);
    await enqueue(db, { kind: SHIPMENT_TRACK, storeId: s.storeId, key: `track:${s.orderId}:${poll ?? 0}:acct:${bucket}`, payload: { orderId: s.orderId, poll: poll ?? 0 }, runAt: new Date((bucket + 1) * ACCOUNT_RETRY_MS) });
    return;
  }
  const t = await accountBookingAdapter(account).track({ providerOrderId: s.providerOrderId, trackingNumber: s.trackingNumber, shippingAccountId: account.id, shippingAccountKind: account.kind });
  await applyTracking(db, s, t, poll === undefined ? undefined : poll + 1);
});
