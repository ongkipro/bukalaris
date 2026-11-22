import { PROVIDER_CODE_RE_SOURCE, REDACTED } from "../seller/commerce/privacy.ts";
import type { ShipmentStatus } from "./schema-fulfillment.ts";

// T-115 (ADR-0013 decision 42): the parcel states Bukalaris keeps equal to Mengantar's, and the ONE table that maps a Mengantar
// `status_category` onto them. The webhook body and a tracking read carry the same category ("the same status category your orders
// already carry"); the list is open-ended, so every lookup has a default branch: a category this table does not know maps to NOTHING
// (`null`), the shipment keeps its state and the raw category is stored and shown as received. It never falls into a known state by guess.
//
// Sources (official documentation snapshot of 2026-11-14, docs/tracks/t115-mengantar-lock.md "Provider facts"): the webhook section names
// PENDING PICKUP, PICKED UP, ON DELIVERY, DELIVERED, UNDELIVERED, PICKUP FAILED, RTS, the two Mengantar values ACTIVE/WAITING NEXT PROCESS
// and ERROR, and both spellings CANCELED / CANCELLED; the create-order example answers `statusCategory: "active"`; the simulation table
// stores `DELIVERY COURIER` as the ON DELIVERY category of SiCepat, AnterAja and Pos; the delete rule names `PICKUP_FAILED_API`.
// UNVERIFIED: the per-courier Order Status Reference Sheet was not read, so no category is mapped to `in_transit` (between pickup and the
// last mile) or to `returning` (a return on its way back) yet. Those categories arrive raw until a row is added here.

export const PARCEL_STATES = ["created", "waiting_pickup", "pickup_failed", "picked_up", "in_transit", "out_for_delivery", "delivered", "returning", "returned", "cancelled", "error"] as const;
export type ParcelState = (typeof PARCEL_STATES)[number];

export const PARCEL_STATE_LABEL: Record<ParcelState, string> = {
  created: "Order dibuat",
  waiting_pickup: "Menunggu pickup kurir",
  pickup_failed: "Pickup gagal",
  picked_up: "Sudah diambil kurir",
  in_transit: "Dalam perjalanan",
  out_for_delivery: "Dalam pengantaran",
  delivered: "Terkirim ke pembeli",
  returning: "Sedang dikembalikan ke pengirim",
  returned: "Dikembalikan ke pengirim (RTS)",
  cancelled: "Dibatalkan",
  error: "Bermasalah",
};

/** The shipment status each parcel state drives (`problem` asks the seller to look; the order effects of decision 44 follow the status). */
export const PARCEL_SHIPMENT_STATUS: Record<ParcelState, ShipmentStatus> = {
  created: "booked",
  waiting_pickup: "booked",
  pickup_failed: "problem",
  picked_up: "in_transit",
  in_transit: "in_transit",
  out_for_delivery: "in_transit",
  delivered: "delivered",
  returning: "in_transit",
  returned: "returned",
  cancelled: "cancelled",
  error: "problem",
};

type Row = { parcel: ParcelState; label?: string; /** A shipment status other than the parcel default. */ status?: ShipmentStatus };
/** Category (upper case, trimmed) → parcel state. The ONE mapping table of decision 42. */
export const PARCEL_STATE_MAP: Readonly<Record<string, Row>> = {
  ACTIVE: { parcel: "created" },
  "ACTIVE/WAITING NEXT PROCESS": { parcel: "created", label: "Diproses Bukalaris Kirim" },
  "PENDING PICKUP": { parcel: "waiting_pickup" },
  "PICKUP FAILED": { parcel: "pickup_failed" },
  PICKUP_FAILED_API: { parcel: "pickup_failed" },
  "PICKED UP": { parcel: "picked_up" },
  "ON DELIVERY": { parcel: "out_for_delivery" },
  "DELIVERY COURIER": { parcel: "out_for_delivery" },
  // A delivery attempt failed and the courier tries again: still on its way (its own label, no state of its own in decision 42).
  UNDELIVERED: { parcel: "in_transit", label: "Gagal diantar, kurir akan mencoba lagi", status: "problem" },
  DELIVERED: { parcel: "delivered" },
  RTS: { parcel: "returned" },
  CANCELED: { parcel: "cancelled", label: "Dibatalkan di Bukalaris Kirim" },
  CANCELLED: { parcel: "cancelled", label: "Dibatalkan di Bukalaris Kirim" },
  ERROR: { parcel: "error", label: "Bermasalah di Bukalaris Kirim" },
};

/** Normalise a raw category for the lookup only; the stored value stays as received. */
export const categoryKey = (raw: string) => raw.trim().toUpperCase();

/** The parcel state of a raw category, or null for a category this table does not know (default branch: stays raw). */
export function parcelStateOf(raw: string | null | undefined): ParcelState | null {
  if (!raw?.trim()) return null;
  return PARCEL_STATE_MAP[categoryKey(raw)]?.parcel ?? null;
}

/** The shipment status of a raw category, or null (default branch). */
export function shipmentStatusOf(raw: string | null | undefined): ShipmentStatus | null {
  const row = raw?.trim() ? PARCEL_STATE_MAP[categoryKey(raw)] : undefined;
  return row ? (row.status ?? PARCEL_SHIPMENT_STATUS[row.parcel]) : null;
}
/** The Indonesian label of a raw category, or null (default branch). */
export function categoryLabel(raw: string | null | undefined): string | null {
  const row = raw?.trim() ? PARCEL_STATE_MAP[categoryKey(raw)] : undefined;
  return row ? (row.label ?? PARCEL_STATE_LABEL[row.parcel]) : null;
}

/**
 * Review major 2 (T-47 privacy): a provider status may be free text ("Diterima oleh <nama>"). Only a STATUS CODE is ever stored in a T-115 table
 * or shown: a category the one table knows, or an upper-case code by the rule redaction itself uses (`PROVIDER_CODE_RE_SOURCE`, at most 40
 * characters). Anything else is stored as the redaction marker, never as received.
 */
const CODE_RE = new RegExp(PROVIDER_CODE_RE_SOURCE);
export const isStatusCode = (raw: string): boolean => {
  const v = raw.trim();
  return v.length > 0 && v !== REDACTED && (PARCEL_STATE_MAP[categoryKey(v)] !== undefined || (v.length <= 40 && CODE_RE.test(v)));
};
/** The value a T-115 table stores for a provider status: the code as received, the redaction marker for anything else, null for nothing. */
export function storableCategory(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  return isStatusCode(v) ? v : REDACTED;
}
/** A category shown to the seller as received (decision 42): status codes only; anything else is not echoed. */
export const displayableCategory = (raw: string | null | undefined): string | null => (raw && isStatusCode(raw) ? raw.trim() : null);

/**
 * Review minor 5: the forward order of the non-final states, the fallback when an answer carries no `lastStatusChange` (UNVERIFIED on a single
 * read). A read never moves a parcel back to a lower rank; final states are guarded separately (a final parcel never moves) and `error` or an
 * unknown category has no rank. UNDELIVERED is a failed attempt after the last mile started, so it ranks with out for delivery.
 */
const RANK: Partial<Record<ParcelState, number>> = { created: 0, waiting_pickup: 1, pickup_failed: 1, picked_up: 2, in_transit: 3, out_for_delivery: 4, returning: 5 };
export function forwardRank(raw: string | null | undefined): number | null {
  if (!raw?.trim()) return null;
  if (categoryKey(raw) === "UNDELIVERED") return RANK.out_for_delivery!;
  const state = parcelStateOf(raw);
  return state ? (RANK[state] ?? null) : null;
}
