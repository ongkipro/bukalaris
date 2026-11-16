import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor } from "../client.ts";
import { enqueue, MAX_ATTEMPTS, registerHandler, sanitizeError } from "../ops/jobs/jobs.ts";
import { mengantarBookingFromEnv, type BookingAdapter, type BookingInput, type BookingResult, type TrackingResult } from "./mengantar/booking.ts";
import { MengantarError } from "./mengantar/client.ts";
import { verifyOrderLink } from "../ops/jobs/notify.ts";
import { applyProviderTransition, applyTransition, PROVIDER_ACTOR } from "../seller/commerce/orders.ts";
import { requoteOrder, reserveShippingCost, reverseShippingReservation } from "../ledger/booking.ts";
import { codAllowedCouriers } from "./shipping.ts";
import { auditLog, membership, order, ORDER_STATUS_LABEL, orderLine, orderRedaction, shipment, SHIPMENT_STATUS_LABEL, user, type OrderStatus, type ShipmentStatus, type TrackingEvent } from "../schema.ts";
import { shipmentStatusEvent, type ProviderFigures } from "./schema-fulfillment.ts";
import { PICKUP_TYPES } from "./schema-fulfillment.ts";
import { categoryKey, categoryLabel, PARCEL_STATE_MAP, parcelStateOf, shipmentStatusOf } from "./parcel-state.ts";
import { storeCourierRule } from "./schema-shipping.ts";
import { openSellerKeyAsWorker, sellerMengantar } from "./seller.ts";
import { sellerAccount } from "./rules.ts";
import { dbMailer } from "../platform/accounts.ts";
import { PROVIDER_CODE_RE_SOURCE, REDACTED } from "../seller/commerce/privacy.ts";
import { DomainError, requireCap, type SellerScope } from "../platform/scoped.ts";
import { resolveOrderStore } from "../platform/resolvers.ts";
import { inStore, withStore } from "../platform/tenant.ts";
import { hit } from "../platform/rate-limit.ts";
import { orderShippingAccount, type ShippingAccountView } from "./accounts.ts";
import { withShippingDispatch } from "./dispatch.ts";
import { PARTNER_DISPATCH_LOCKED_MESSAGE, scrubProviderText, UNKNOWN_PROVIDER_STATUS_LABEL } from "./copy.ts";
export { SHIPMENT_STATUS_LABEL, SHIPMENT_STATUSES, type ShipmentStatus, type TrackingEvent } from "../schema.ts";
export { PICKUP_TYPES, type PickupType } from "./schema-fulfillment.ts";
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
/** RL-TRACK-REFRESH (doc 16, D-33): a seller's "read now" on its own account, per parcel and per store. */
export const TRACK_REFRESH_LIMITS = { parcel: { limit: 1, windowSec: 300 }, store: { limit: 60, windowSec: 600 } } as const;
/** Seller-triggered refreshes per shipment (each is one provider read). */
export const MAX_MANUAL_POLLS = 50;
export const TRACK_HISTORY_MAX = 50;
/** Orders a seller may book: confirmed (`placed`) or being prepared. */
export const BOOKABLE: readonly OrderStatus[] = ["placed", "processing"];
/** Nothing left to poll in these states; `awaiting_balance` and `failed` accept a seller retry. */
export const TERMINAL: readonly ShipmentStatus[] = ["delivered", "returned", "cancelled", "failed"];
/**
 * A seller retry is accepted only here. `unknown` (T-105, ADR-0013 decision 30) is deliberately absent: after a timeout, a dropped connection,
 * a provider 5xx or a lost worker the provider may hold an order, so the shipment is blocked until a person releases it or links the shipment
 * the provider did accept (`releaseUnknownBooking`, `linkUnknownBooking`). It is never retried blindly.
 */
export const RETRYABLE: readonly ShipmentStatus[] = ["awaiting_account", "awaiting_balance", "failed"];

/** Q-17 (COD remittance) is open: COD bookings stay refused unless the owner sets ALLOW_COD_BOOKING=1. */
export const codBookingAllowed = (env: NodeJS.ProcessEnv = process.env) => env.ALLOW_COD_BOOKING === "1";
export const COD_BOOKING_MESSAGE = "Booking COD lewat Bukalaris Kirim belum dibuka: kebijakan remitansi COD masih menunggu keputusan pemilik platform. Kirim dengan resi manual, atau tunggu kebijakan terbit.";

/** Delay before automatic poll `poll` (0-based): 15 min, 30 min, 1 h, 2 h, 4 h, then 6 h. */
export const trackDelayMs = (poll: number) => Math.min(15 * 60_000 * 2 ** Math.max(0, Math.min(poll, 5)), 6 * 3_600_000);

// ── Provider status mapping: the ONE table of ADR-0013 decision 42 (`parcel-state.ts`), with its default branch ──

export const PROVIDER_STATUS: Record<string, { status: ShipmentStatus; label: string }> = Object.fromEntries(
  Object.keys(PARCEL_STATE_MAP).map((k) => [k, { status: shipmentStatusOf(k)!, label: categoryLabel(k)! }]),
);
export const mapProviderStatus = (raw: string | null | undefined) => (raw?.trim() ? (PROVIDER_STATUS[categoryKey(raw)] ?? null) : null);
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
const bookInput = z.strictObject({ pickupType: z.enum(PICKUP_TYPES, { error: "Pilih cara serah paket: dijemput kurir atau antar sendiri." }).default("scheduled_pickup") });
export async function bookShipment(scope: SellerScope, orderId: number, raw: unknown = {}): Promise<BookOutcome> {
  requireCap(scope, "orders.fulfill");
  const { pickupType } = bookInput.parse(raw);
  return inStore(scope, async ({ exec: tx }) => {
    const [o] = await tx
      .select({ status: order.status, paymentMethod: order.paymentMethod, courierCode: order.courierCode, originAreaId: order.originAreaId, destinationAreaId: order.destinationAreaId, weightKg: order.weightKg, total: order.total, accountKind: order.shippingAccountKind })
      .from(order)
      .where(and(eq(order.storeId, scope.storeId), eq(order.id, orderId)))
      .for("update");
    if (!o) throw new DomainError("not_found", "Pesanan tidak ditemukan.");
    const [existing] = await tx.select().from(shipment).where(and(eq(shipment.storeId, scope.storeId), eq(shipment.orderId, orderId)));
    if (existing && (existing.status === "queued" || existing.status === "booking")) {
      return { shipmentId: existing.id, attempt: existing.bookingAttempts, created: false }; // duplicate click: the job already exists
    }
    if (existing?.status === "unknown") throw new DomainError("booking_unknown", UNKNOWN_BLOCK_MESSAGE);
    const own = o.accountKind === "seller_owned";
    // T-115 (ADR-0013 decision 44): a parcel cancelled in the store's own courier account released its booking; it may be booked again.
    const released = own && existing?.status === "cancelled";
    if (existing && !RETRYABLE.includes(existing.status) && !released) throw new DomainError("already_booked", `Pesanan ini sudah dibooking (${SHIPMENT_STATUS_LABEL[existing.status].toLowerCase()}).`);
    if (!BOOKABLE.includes(o.status)) throw new DomainError("not_bookable", `Pesanan berstatus "${ORDER_STATUS_LABEL[o.status]}" tidak bisa dibooking; booking hanya untuk pesanan Baru atau Diproses.`);
    // The Q-17 COD gate and the free-return COD list protect the platform-held money of ADR-0006; a store on its own account collects its own COD
    // (ADR-0013 section 8, decision 32): the COD order was already checked against the seller's filters at submit.
    if (!own && o.paymentMethod === "cod" && !codBookingAllowed()) throw new DomainError("cod_booking_disabled", COD_BOOKING_MESSAGE);
    if (!own && o.paymentMethod === "cod" && !(await codAllowedCouriers(tx)).has(o.courierCode.toLowerCase())) throw new DomainError("cod_courier_not_allowed", COD_COURIER_MESSAGE);

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
          pickupType,
        })
        .returning({ id: shipment.id });
      shipmentId = row!.id;
    } else {
      attempt = existing.bookingAttempts + 1;
      // Back to `queued` so a second click returns this attempt; the worker pays an unpaid
      // provider order (providerOrderId set) instead of creating a new one.
      // A released booking starts clean: its cancelled provider order stays in the status history (never mistaken for a foreign parcel), a new one is created.
      const fresh = released ? { providerOrderId: null, providerBatchId: null, trackingNumber: null, providerStatus: null, providerStatusAt: null, paid: false, trackingHistory: [], bookedAt: null, deliveredAt: null, providerFigures: {}, providerFiguresAt: null } : {};
      await tx
        .update(shipment)
        .set({ bookingAttempts: attempt, status: "queued", pickupType, lastError: null, ...fresh, updatedAt: new Date() })
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
    // T-115 RL-TRACK-REFRESH (doc 16, D-33) for a parcel on the store's own account: one read now per parcel per 5 minutes, 60 per store per 10 minutes.
    const [{ kind }] = await tx.select({ kind: order.shippingAccountKind }).from(order).where(and(eq(order.storeId, scope.storeId), eq(order.id, orderId)));
    if (kind === "seller_owned") {
      for (const [key, rule] of [[`track-refresh:parcel:${s.id}`, TRACK_REFRESH_LIMITS.parcel], [`track-refresh:store:${scope.storeId}`, TRACK_REFRESH_LIMITS.store]] as const) {
        const r = await hit(tx, key, rule);
        if (r.count > rule.limit) throw new DomainError("rate_limited", `Status paket baru saja diminta. Status terakhir tetap tampil dan diperbarui otomatis; coba lagi dalam ${r.retryAfterSec} detik.`);
      }
    }
    const n = s.manualPolls + 1;
    await tx.update(shipment).set({ manualPolls: n, updatedAt: new Date() }).where(eq(shipment.id, s.id));
    await enqueue(tx, { kind: SHIPMENT_TRACK, storeId: scope.storeId, key: `track:${orderId}:m:${n}`, payload: { orderId } });
  });
}

const releaseInput = z.strictObject({ reason: z.string().trim().min(5, "Tulis alasan minimal 5 karakter (apa yang Anda periksa di akun kurir).").max(300) });
const linkInput = z.strictObject({ providerOrderId: z.string().trim().regex(/^[A-Za-z0-9_-]{3,64}$/, "Isi ID order dari akun kurir (huruf, angka, - atau _).") });
/**
 * The shipment of an unknown outcome, locked. Only an order on the store's OWN account (review M1): the seller can inspect only that account,
 * and a tracking read of a linked id runs on that account's key, so no parcel of another store can be adopted.
 */
async function unknownShipment(tx: Executor, scope: SellerScope, orderId: number) {
  const [row] = await tx
    .select({ s: shipment, kind: order.shippingAccountKind })
    .from(shipment)
    .innerJoin(order, and(eq(order.storeId, shipment.storeId), eq(order.id, shipment.orderId)))
    .where(and(eq(shipment.storeId, scope.storeId), eq(shipment.orderId, orderId)))
    .for("update", { of: shipment });
  if (!row) throw new DomainError("not_found", "Pesanan ini belum dibooking.");
  if (row.kind !== "seller_owned") throw new DomainError("not_own_account", "Booking ini memakai akun pengiriman Bukalaris; pemulihannya dilakukan oleh Bukalaris.");
  if (row.s.status !== "unknown") throw new DomainError("not_unknown", "Hanya booking dengan hasil tidak pasti yang bisa dilepas atau ditautkan.");
  return row.s;
}
const auditShipment = (tx: Executor, scope: SellerScope, orderId: number, action: string, reason: string) =>
  tx.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: "orders.fulfill", action, subjectKind: "order", subjectId: String(orderId), accessLevel: "write", outcome: "allowed", reason: reason.slice(0, 500) });

/**
 * Recovery path 1 of an unknown outcome (ADR-0013 decision 30): the seller checked their courier account and found NO order for this parcel.
 * The shipment becomes `failed` with the reason on record, which lets the seller book again (a new attempt, a new idempotency key).
 */
export async function releaseUnknownBooking(scope: SellerScope, orderId: number, raw: unknown): Promise<void> {
  requireCap(scope, "orders.fulfill");
  const { reason } = releaseInput.parse(raw);
  await inStore(scope, async ({ exec: tx }) => {
    const s = await unknownShipment(tx, scope, orderId);
    await setShipment(tx, s.id, { status: "failed", lastError: `${RELEASED_MESSAGE} Catatan: ${reason}` });
    await auditShipment(tx, scope, orderId, "shipment.unknown.release", `attempt=${s.bookingAttempts}; ${reason}`);
  });
}

/**
 * Recovery path 2: the seller found the order the provider DID create and links its order id. Nothing is booked again and nothing ships yet:
 * an immediate tracking read on the store's own key must find that order, and only the resi it returns ships the order (review nit). One
 * provider order belongs to one shipment of the store (`shipment_provider_order_uq`).
 */
export async function linkUnknownBooking(scope: SellerScope, orderId: number, raw: unknown): Promise<void> {
  requireCap(scope, "orders.fulfill");
  const { providerOrderId } = linkInput.parse(raw);
  // Confirmation review 1: one tracking read on the store's own key BEFORE anything is written. An id the provider does not know (a typo) is
  // refused and the shipment stays `unknown`, so release or another link remain possible; nothing ships here either way.
  await inStore(scope, ({ exec: tx }) => unknownShipment(tx, scope, orderId));
  try {
    await (await sellerTrackingAdapter(scope)).track({ providerOrderId, trackingNumber: null });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    const e = new DomainError("provider_order_unknown", "Akun kurir toko tidak mengenal ID order ini. Periksa lagi ID order di akun kurir; booking tetap terkunci sampai dilepas atau ditautkan.");
    e.cause = err;
    throw e;
  }
  try {
    await inStore(scope, async ({ exec: tx }) => {
      const s = await unknownShipment(tx, scope, orderId);
      await setShipment(tx, s.id, { status: "booked", providerOrderId, trackingNumber: null, paid: false, lastError: LINKED_MESSAGE });
      await enqueue(tx, { kind: SHIPMENT_TRACK, storeId: scope.storeId, key: `track:${orderId}:link:${s.bookingAttempts}`, payload: { orderId, poll: 0 } });
      await auditShipment(tx, scope, orderId, "shipment.unknown.link", `attempt=${s.bookingAttempts}; provider_order=${providerOrderId}`);
    });
  } catch (err) {
    const code = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
    if (code === "23505") throw new DomainError("provider_order_taken", "ID order ini sudah tertaut ke pesanan lain di toko ini. Periksa lagi ID order di akun kurir.");
    throw err;
  }
}

/** The read side of the one seller client for a request (the seller's own key opened through the application role), or the test seam. */
async function sellerTrackingAdapter(scope: SellerScope): Promise<BookingAdapter> {
  if (adapterOverride) return adapterOverride;
  const own = await inStore(scope, ({ exec }) => sellerAccount(exec, scope.storeId));
  if (own?.status !== "active") throw new DomainError("awaiting_account", "Kunci akun kurir toko belum terhubung.");
  const { openProviderKey } = await import("../payments/provider-accounts.ts"); // loaded on use, as in rules.ts
  return (await sellerMengantar(scope.exec, await openProviderKey(scope, "mengantar"), own.environment)).booking(own.pickupAddressId ?? "", fakeMengantarBooking);
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

/**
 * Select a test/fake adapter, or the explicitly gated master transport. A partner snapshot is NEVER sent on a master credential. A `seller_owned`
 * order (T-105) books and tracks on that store's own key through the one seller client (its fake, a live origin, or a refusal: `seller.ts`).
 */
async function accountBookingAdapter(db: Db, account: ShippingAccountView): Promise<{ adapter: BookingAdapter; pickupAddressId: string | null }> {
  if (account.kind === "seller_owned") {
    const { key, account: own } = await openSellerKeyAsWorker(db, account.storeId, account.id);
    if (adapterOverride) return { adapter: adapterOverride, pickupAddressId: own.pickupAddressId };
    const client = await sellerMengantar(db, key, own.environment);
    return { adapter: client.booking(own.pickupAddressId ?? "", fakeMengantarBooking), pickupAddressId: own.pickupAddressId };
  }
  if (!adapterOverride && process.env.MENGANTAR_API_KEY && account.kind === "partner_managed") throw new DomainError("awaiting_account", PARTNER_DISPATCH_LOCKED_MESSAGE);
  return { adapter: bookingAdapter(), pickupAddressId: null };
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
/** An unreadable success: unknown on the store's own account (ADR-0013 decision 30); a platform account keeps the T-39 classification. */
const isUnreadable = (err: unknown) => err instanceof MengantarError && err.code === "invalid_shape";
/**
 * The provider refused COD for this seller on this courier (documented for Pos Indonesia: 403 with status `new_seller`, `insufficient` or
 * `blocked`). Matched on the documented body status, or on a 403 whose message names COD as not available.
 */
export function isCodRefusal(err: unknown): boolean {
  if (!(err instanceof MengantarError) || err.code !== "http" || err.status !== 403) return false;
  const status = (err.body as { status?: unknown } | null | undefined)?.status;
  return ["new_seller", "insufficient", "blocked"].includes(String(status)) || /\bCOD\b[^.]*\bnot available\b/i.test(err.message);
}
/** ADR-0013 section 4, last row: the courier's COD is switched off for the store (only the seller turns it on again) and every owner is told. */
async function refuseCourierCod(db: Db, s: ShipmentView): Promise<void> {
  await withStore(db, s.storeId, async (tx) => {
    await tx.update(storeCourierRule).set({ codEnabled: false, codRefusedAt: new Date(), updatedBy: PROVIDER_ACTOR, updatedAt: new Date() }).where(and(eq(storeCourierRule.storeId, s.storeId), eq(storeCourierRule.courierCode, s.courierCode)));
    await tx.insert(auditLog).values({ storeId: s.storeId, actorUserId: PROVIDER_ACTOR, action: "shipping.courier_cod.refused", subjectKind: "store_courier_rule", subjectId: s.courierCode, accessLevel: "write", outcome: "allowed", reason: `order=${s.orderId}` });
    const owners = await tx.select({ email: user.email }).from(membership).innerJoin(user, eq(user.id, membership.userId)).where(and(eq(membership.storeId, s.storeId), eq(membership.role, "owner")));
    for (const to of new Set(owners.map((o) => o.email))) {
      await dbMailer(tx).send({ to, subject: `COD kurir ${s.courierCode} dimatikan untuk toko Anda`, text: `Penyedia menolak COD untuk akun kurir toko Anda pada layanan ${s.courierCode} (pesanan #${s.orderId}). COD layanan ini sudah dimatikan di pengaturan pengiriman toko agar pembeli tidak lagi memilihnya; Anda dapat menyalakannya lagi kapan saja di Seller Admin, Pengiriman.` });
    }
  });
}

export const WRITE_DISABLED_MESSAGE = "Booking Bukalaris Kirim dinonaktifkan di server ini (perlu persetujuan pemilik).";
export const UNPAID_MESSAGE = "Saldo akun Bukalaris Kirim tidak cukup: order dibuat sebagai unpaid tanpa resi. Tambah saldo, lalu klik Coba lagi.";
export const UNCERTAIN_MESSAGE = "Hasil booking tidak pasti (Bukalaris Kirim tidak menjawab). Hubungi Bukalaris sebelum mencoba lagi agar tidak terbit dua order.";
/** T-105: the same outcome on the store's own account, where the seller can check the account and release or link. */
export const OWN_UNCERTAIN_MESSAGE = "Hasil booking tidak pasti: penyedia tidak menjawab dengan jelas, jadi order mungkin sudah terbit. Periksa daftar order di akun kurir, lalu lepaskan booking ini bila tidak ada order, atau tautkan order yang terbit. Booking ulang dikunci sampai itu dilakukan agar tidak terbit dua order.";
export const PAY_UNCERTAIN_MESSAGE = "Pembayaran order kurir belum pasti terkirim. Periksa saldo dan status order di akun kurir; resi diambil otomatis bila sudah dibayar, atau klik Coba lagi bila order masih belum dibayar (tidak menerbitkan order kedua).";
export const LINKED_MESSAGE = "Order dari akun kurir ditautkan; resi dan status diambil dari akun kurir toko sebelum pesanan dikirim.";
export const UNKNOWN_BLOCK_MESSAGE = "Booking sebelumnya berhasil-tidaknya belum pasti. Periksa akun kurir, lalu lepaskan atau tautkan booking itu sebelum membooking lagi.";
export const RELEASED_BY_PROVIDER_MESSAGE = "Paket ini dibatalkan di akun kurir toko, jadi booking-nya dilepas: pesanan kembali ke Diproses dan bisa dibooking lagi.";
export const RELEASED_MESSAGE = "Booking dilepas penjual setelah memeriksa akun kurir: tidak ada order yang terbit. Booking boleh diulang.";
export const COD_REFUSED_MESSAGE = "Penyedia menolak COD untuk akun Anda pada kurir ini. COD kurir ini sudah dimatikan di pengaturan pengiriman toko; hanya Anda yang bisa menyalakannya lagi. Kirim pesanan ini dengan resi manual atau hubungi pembeli.";
export const NO_PICKUP_MESSAGE = "Alamat pickup toko belum terdaftar di akun kurir toko. Simpan alamat pickup di halaman Pengiriman, lalu coba lagi.";
export const PAID_WAITING_MESSAGE = "Pembayaran order Bukalaris Kirim terkirim; resi diambil otomatis saat terbit.";
export const COD_COURIER_MESSAGE = "Layanan kurir ini tidak masuk daftar COD Bukalaris Kirim (COD hanya untuk layanan dengan retur gratis). Pilih kurir lain atau bayar transfer.";
export const RESERVE_MESSAGES = {
  insufficient_balance: "Saldo tersedia toko tidak cukup menutup selisih ongkir kurir. Booking dibatalkan sebelum dikirim ke kurir; tunggu dana pesanan lain cair, lalu coba lagi.",
  reservation_reversed: "Pemesanan kurir untuk pesanan ini sudah pernah ditolak dan potongannya dikembalikan; booking ulang belum didukung. Hubungi Bukalaris.",
  not_bookable: "Pesanan tidak bisa dibooking dalam status ini.",
  cod_amount_mismatch: "Nilai COD yang dikirim berbeda dari total pesanan (cod_amount_mismatch). Booking dibatalkan sebelum ke kurir.",
  quote_unavailable: "Kurir tidak lagi melayani rute ini; booking dibatalkan sebelum ke penyedia.",
} as const;
const bookingErrorMessage = (err: unknown, own = false) =>
  err instanceof MengantarError && err.code === "write_disabled" ? WRITE_DISABLED_MESSAGE : isUncertainWrite(err) || (own && isUnreadable(err)) ? `${own ? OWN_UNCERTAIN_MESSAGE : UNCERTAIN_MESSAGE} (${sanitizeError(err)})` : sanitizeError(err);

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

/** T-115 (ADR-0013 decision 42): one observed Mengantar status category of a parcel, as received (append-only), with its mapped state or none. */
async function recordStatusEvent(tx: Executor, s: { id: number; storeId: number }, providerOrderId: string, category: string, source: "booking" | "read", providerChangedAt: Date | null): Promise<void> {
  const raw = category.trim().slice(0, 60);
  if (!raw) return;
  await tx.insert(shipmentStatusEvent).values({ storeId: s.storeId, shipmentId: s.id, providerOrderId, category: raw, parcelState: parcelStateOf(raw), source, providerChangedAt });
}
const ownOrder = async (tx: Executor, storeId: number, orderId: number) =>
  (await tx.select({ kind: order.shippingAccountKind }).from(order).where(and(eq(order.storeId, storeId), eq(order.id, orderId))))[0]?.kind === "seller_owned";
/** T-115 (decision 45): Mengantar's documented per-parcel figures of a store on its own account, merged over what was read before. */
const figuresPatch = (own: boolean, current: ProviderFigures, read: ProviderFigures | undefined, now: Date) =>
  own && read && Object.keys(read).length > 0 ? { providerFigures: { ...current, ...read }, providerFiguresAt: now } : {};
/** An ISO instant from the provider, or null. */
const instant = (v: string | null | undefined) => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : new Date(t);
};

/** Store a booking result: resi → `booked` + order shipped + first poll scheduled; no resi → `awaiting_balance`. */
async function recordBooking(db: Db, s: ShipmentView, r: BookingResult): Promise<void> {
  await withStore(db, s.storeId, async (tx) => {
    const own = await ownOrder(tx, s.storeId, s.orderId);
    if (r.providerStatus) await recordStatusEvent(tx, s, r.providerOrderId, r.providerStatus, "booking", null);
    const figures = figuresPatch(own, {}, r.figures, new Date());
    if (!r.trackingNumber) {
      await setShipment(tx, s.id, { status: "awaiting_balance", providerOrderId: r.providerOrderId, providerBatchId: r.providerBatchId, providerStatus: r.providerStatus, paid: false, lastError: UNPAID_MESSAGE, lastTrackedAt: new Date(), ...figures });
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
      ...figures,
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
  const kind = input.shippingAccountKind;
  if (kind === undefined || kind === "seller_owned") return null; // the platform reserves nothing for a store on its own account (ADR-0013 C-P7)
  let requote;
  try {
    requote = await requoteOrder({ originAreaId: s.originAreaId, destinationAreaId: s.destinationAreaId, weightKg: s.weightKg, courierCode: s.courierCode, cod, payableIdr: input.codAmount, shippingAccountId: input.shippingAccountId!, shippingAccountKind: kind });
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
    // A worker died between the provider call and the write: the provider may hold an order. Never book again blindly. On the store's own
    // account (ADR-0013 decision 30) the shipment is blocked as an unknown outcome until the seller releases it or links the order; a platform
    // account keeps the T-39 rule (failed, the seller asks Bukalaris before retrying), since the seller cannot inspect that account (review M1).
    const [o] = await db.select({ kind: order.shippingAccountKind }).from(order).where(and(eq(order.storeId, s.storeId), eq(order.id, s.orderId)));
    if (o?.kind === "seller_owned") await setShipment(db, s.id, { status: "unknown", lastError: `Booking terputus sebelum hasilnya tersimpan. ${OWN_UNCERTAIN_MESSAGE}` });
    else await setShipment(db, s.id, { status: "failed", lastError: "Booking terputus sebelum hasil tersimpan; hubungi Bukalaris sebelum mencoba lagi." });
    return;
  }
  if (s.status !== "queued") return; // already handled (re-run after a lost lease)
  const input = await bookingInput(db, j.storeId, orderId, s);
  if (!input) return;
  if (!BOOKABLE.includes(input.status)) {
    await setShipment(db, s.id, { status: s.providerOrderId ? "awaiting_balance" : "failed", lastError: `Pesanan berstatus "${ORDER_STATUS_LABEL[input.status]}" saat booking dijalankan; tidak dibooking.` });
    return;
  }
  // T-105: the Q-17 gate and the free-return COD list guard platform-held money only; a store on its own account collects its own COD.
  const own = input.shippingAccountKind === "seller_owned";
  if (!own && input.paymentMethod === "cod" && !codBookingAllowed()) {
    await setShipment(db, s.id, { status: s.providerOrderId ? "awaiting_balance" : "failed", lastError: COD_BOOKING_MESSAGE });
    return;
  }
  if (!own && input.paymentMethod === "cod" && !(await codAllowedCouriers(db)).has(s.courierCode.toLowerCase())) {
    await setShipment(db, s.id, { status: s.providerOrderId ? "awaiting_balance" : "failed", lastError: COD_COURIER_MESSAGE });
    return;
  }
  let account: ShippingAccountView;
  let adapter: BookingAdapter;
  try {
    account = await orderShippingAccount(db, s.storeId, orderId);
    const chosen = await accountBookingAdapter(db, account);
    adapter = chosen.adapter;
    if (own && !chosen.pickupAddressId) {
      await setShipment(db, s.id, { status: s.providerOrderId ? "awaiting_balance" : "failed", lastError: NO_PICKUP_MESSAGE });
      return;
    }
  } catch (err) {
    if (!(err instanceof DomainError) || !["awaiting_account", "provider_unavailable", "provider_off"].includes(err.code)) throw err;
    await setShipment(db, s.id, { status: "awaiting_account", lastError: err.message });
    return;
  }
  if (!s.providerOrderId && !own) {
    // ADR-0006 decision 7: live re-quote outside any lock, then ONE transaction reserves the cost and the seller's debit, and refuses before the provider
    // call when it cannot be covered. The provider is called only after this commits. A store on its own account pays its courier itself (ADR-0013 C-P7).
    const failure = await reserveBooking(db, s, input);
    if (failure) {
      await setShipment(db, s.id, { status: "failed", lastError: failure });
      return;
    }
  }

  // account and adapter above are derived from the order snapshot, not current store routing.
  const fallback: ShipmentStatus = s.providerOrderId ? "awaiting_balance" : "failed";
  const request: BookingInput = { ...input, pickupType: own ? s.pickupType : undefined, idempotencyKey: `bk-${s.storeId}-${orderId}-${attempt}` };
  let result: BookingResult | null = null;
  try {
    if (!s.providerOrderId) {
      await setShipment(db, s.id, { status: "booking" });
      result = await withShippingDispatch(db, account, () => adapter.createOrder(request));
    } else {
      // Unpaid order from an earlier attempt (seller topped up and retried): pay the batch.
      await withShippingDispatch(db, account, () => adapter.payUnpaid(s.providerBatchId ?? s.providerOrderId!, s.courierCode));
    }
  } catch (err) {
    if (!isRetryableBookingError(err) || j.attempts >= MAX_ATTEMPTS) {
      if (own && !s.providerOrderId && (isUncertainWrite(err) || isUnreadable(err))) {
        // ADR-0013 decision 30: the provider may have created the order; blocked until the seller releases or links it.
        await setShipment(db, s.id, { status: "unknown", lastError: bookingErrorMessage(err, true) });
        return;
      }
      const codRefused = own && input.paymentMethod === "cod" && isCodRefusal(err);
      // Confirmation review 3: an uncertain pay-unpaid on the store's own account stays `awaiting_balance` (retrying it cannot create a second
      // order) and says so; the release/link wording belongs to `unknown` only.
      const payUncertain = own && s.providerOrderId && isUncertainWrite(err);
      await setShipment(db, s.id, { status: fallback, lastError: codRefused ? COD_REFUSED_MESSAGE : payUncertain ? `${PAY_UNCERTAIN_MESSAGE} (${sanitizeError(err)})` : bookingErrorMessage(err, own && !s.providerOrderId) });
      if (codRefused) await refuseCourierCod(db, s);
      // A definite rejection created nothing, so the reserved debit is returned; an unknown outcome keeps it until the outcome is proven (T-48 kinds).
      if (!s.providerOrderId && !own && !isUncertainWrite(err)) await reverseShippingReservation(db, s.storeId, orderId);
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

/**
 * Apply one tracking read: the SINGLE writer of parcel state (ADR-0013 decision 43; a webhook only enqueues this read). History, provider
 * status, state mapping through the one table of decision 42 (an unknown category keeps the state), late resi, and the order effects of
 * decision 44. T-115: the shipment row is re-read under lock, so two racing reads (a webhook-triggered one and the sweep) cannot move a parcel
 * back: a terminal parcel never moves again, a parcel booked again in the meantime ignores the old answer, and an answer whose
 * `lastStatusChange` is older than the state already applied changes nothing but the read time.
 */
async function applyTracking(db: Db, s0: ShipmentView, t: TrackingResult, nextPoll: number | undefined): Promise<void> {
  await withStore(db, s0.storeId, async (tx) => {
    const now = new Date();
    // T-47: an order redacted with an override may still be polled; its provider text stays stripped (timestamps and status codes are kept).
    // Wave 5 review: take the order row first (the same row `redactOrders` locks FOR UPDATE), so a poll that started before a redaction cannot write its provider text back after it.
    const [o] = await tx.select({ kind: order.shippingAccountKind }).from(order).where(and(eq(order.storeId, s0.storeId), eq(order.id, s0.orderId))).for("share");
    const [s] = await tx.select().from(shipment).where(eq(shipment.id, s0.id)).for("update");
    if (!o || !s) return;
    const own = o.kind === "seller_owned";
    const changedAt = instant(t.statusChangedAt);
    const chain = async (status: ShipmentStatus) => {
      if (nextPoll !== undefined && !TERMINAL.includes(status) && nextPoll < MAX_TRACK_POLLS) {
        await enqueue(tx, { kind: SHIPMENT_TRACK, storeId: s.storeId, key: `track:${s.orderId}:${nextPoll}`, payload: { orderId: s.orderId, poll: nextPoll }, runAt: new Date(Date.now() + trackDelayMs(nextPoll)) });
      }
    };
    if (TERMINAL.includes(s.status) || s.providerOrderId !== s0.providerOrderId) return;
    if (changedAt && s.providerStatusAt && changedAt < s.providerStatusAt) {
      await setShipment(tx, s.id, { lastTrackedAt: now });
      await chain(s.status);
      return;
    }
    const gotResi = !s.trackingNumber && t.trackingNumber;
    const resi = s.trackingNumber ?? t.trackingNumber;
    const mapped = mapProviderStatus(t.providerStatus)?.status;
    // Tracking states need a resi; an unpaid order stays `awaiting_balance` until one appears.
    const status: ShipmentStatus = !resi ? s.status : (mapped ?? (gotResi ? "booked" : s.status));
    const delivered = status === "delivered";
    const [redacted] = await tx.select({ id: orderRedaction.orderId }).from(orderRedaction).where(and(eq(orderRedaction.storeId, s.storeId), eq(orderRedaction.orderId, s.orderId)));
    const history = (t.history.length ? t.history : s.trackingHistory).slice(-TRACK_HISTORY_MAX);
    // A redacted order keeps only a status CODE (provider free text such as "Diterima oleh <nama>" is replaced); `PROVIDER_CODE_RE` is the rule redaction itself uses.
    const providerStatus = redacted ? scrubProviderStatus(t.providerStatus ?? s.providerStatus) : (t.providerStatus ?? s.providerStatus);
    if (t.providerStatus && providerStatus && providerStatus !== s.providerStatus) await recordStatusEvent(tx, s, s.providerOrderId!, providerStatus, "read", changedAt);
    await setShipment(tx, s.id, {
      status,
      trackingNumber: resi,
      paid: s.paid || resi !== null,
      bookedAt: s.bookedAt ?? (resi ? now : null),
      providerStatus,
      providerStatusAt: changedAt ?? s.providerStatusAt,
      trackingHistory: redacted ? history.map((h) => ({ ...h, desc: REDACTED })) : history,
      deliveredAt: s.deliveredAt ?? (delivered ? now : null),
      lastTrackedAt: now,
      lastError: null,
      ...figuresPatch(own, s.providerFigures, t.figures, now),
    });
    if (resi && gotResi) await shipOrder(tx, s.storeId, s.orderId, resi, s.requestedBy);
    // Courier-driven moves go through the one writer: DELIVERED -> completed (a COD order becomes paid there, C-P1), RTS -> returned (in transit only),
    // a courier cancellation -> cancelled, except on the store's OWN account where it releases the booking (ADR-0013 decision 44: the order goes back to
    // `processing` and may be booked again). A move the writer refuses is recorded on the shipment (and the audit log), never dropped.
    const target = status === "delivered" ? "completed" : status === "returned" ? "returned" : status === "cancelled" ? (own ? "released" : "cancelled") : null;
    if (target) {
      const r = await applyProviderTransition(tx, s.storeId, s.orderId, target, { source: "provider", note: providerStatusLabel(t.providerStatus) ?? undefined });
      if (r.outcome === "rejected") await setShipment(tx, s.id, { lastError: `Pembaruan status dari kurir ditolak penulis status pesanan; pesanan tetap "${ORDER_STATUS_LABEL[r.status]}". Hubungi Bukalaris bila status ini tidak sesuai.` });
      else if (target === "released" && r.outcome === "applied") await setShipment(tx, s.id, { lastError: RELEASED_BY_PROVIDER_MESSAGE });
    }
    await chain(status);
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
  let adapter: BookingAdapter | undefined;
  try {
    account = await orderShippingAccount(db, s.storeId, orderId);
    // Confirmation review 4: only a `seller_owned` account's adapter refusals (key removed, live transport closed by the production switch) wait
    // with the fixed re-queue; a platform kind's adapter error keeps the T-48 behaviour (it fails the job, outside this catch).
    if (account.kind === "seller_owned") adapter = (await accountBookingAdapter(db, account)).adapter;
  } catch (err) {
    if (!(err instanceof DomainError) || !["awaiting_account", "provider_unavailable", "provider_off"].includes(err.code)) throw err;
    // Wave 4 review: a parcel that is already booked keeps its real status (the buyer page must not say "awaiting account" for a parcel in transit) and tracking is
    // re-queued with a fixed delay, so it resumes by itself once the account is usable again; before this the chain ended here and DELIVERED -> completed waited for a manual refresh.
    await setShipment(db, s.id, { lastError: err.message });
    const bucket = Math.floor(Date.now() / ACCOUNT_RETRY_MS);
    await enqueue(db, { kind: SHIPMENT_TRACK, storeId: s.storeId, key: `track:${s.orderId}:${poll ?? 0}:acct:${bucket}`, payload: { orderId: s.orderId, poll: poll ?? 0 }, runAt: new Date((bucket + 1) * ACCOUNT_RETRY_MS) });
    return;
  }
  adapter ??= (await accountBookingAdapter(db, account)).adapter;
  const t = await adapter.track({ providerOrderId: s.providerOrderId, trackingNumber: s.trackingNumber, shippingAccountId: account.id, shippingAccountKind: account.kind });
  await applyTracking(db, s, t, poll === undefined ? undefined : poll + 1);
});
