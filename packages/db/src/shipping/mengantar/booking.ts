import { MengantarClient, MengantarError } from "./client.ts";
import { PARTNER_DISPATCH_LOCKED_MESSAGE } from "../copy.ts";
import { trackingInfoSchema, type CreatedOrder, type TrackingInfo } from "./schemas.ts";

// Shipment booking + tracking over the platform-owned Mengantar account (T-39, PR-5, Q-2).
// `createOrder` and `payUnpaid` are WRITES: the client refuses them unless
// MENGANTAR_WRITE_ENABLED=1 (never set in this repository; owner approval first). The
// request/response shapes follow the partner documentation (~/Projects/mengantar-documentation
// docs/01 §8–9, spec/openapi.yaml) and are UNVERIFIED until an observed, sanitized call is
// recorded in docs/tracks/fulfillment.md.

export type BookingInput = {
  orderId: number;
  storeId: number;
  shippingAccountId?: number;
  shippingAccountKind?: "partner_managed" | "platform_master";
  pickupAreaId?: string;
  pickupAddress?: string;
  courierCode: string;
  destinationAreaId: string;
  weightKg: number;
  /** Integer IDR the courier collects (goods + shipping) — 0 for prepaid shipments. */
  codAmount: number;
  /** Goods value for prepaid shipments (provider `goodsValue`). */
  goodsValue: number;
  quantity: number;
  parcelContent: string;
  buyerName: string;
  buyerPhone: string;
  shippingAddress: string;
};

export type BookingResult = {
  providerOrderId: string;
  providerBatchId: string | null;
  /** Resi; null when the provider created the order unpaid (insufficient balance). */
  trackingNumber: string | null;
  paid: boolean;
  providerStatus: string | null;
};

export type TrackingResult = {
  trackingNumber: string | null;
  providerStatus: string | null;
  paid: boolean | null;
  history: { at: string; desc: string }[];
};

export interface BookingAdapter {
  /** WRITE. Books one shipment; must only be called under the per-account lock (409 rule). */
  createOrder(input: BookingInput): Promise<BookingResult>;
  /** WRITE. Pays an unpaid batch after a top-up; the resi is then fetched with `track`. */
  payUnpaid(batchId: string, courierCode: string): Promise<void>;
  /** READ. Current provider status and history of a booked shipment. */
  track(ref: { providerOrderId: string | null; trackingNumber: string | null; shippingAccountId?: number; shippingAccountKind?: "partner_managed" | "platform_master" }): Promise<TrackingResult>;
}

/**
 * Estimate key (order `courier_code`) → create-order `courier` value and cargo flag (docs 01 §8.1).
 * UNVERIFIED mapping for the cargo/lite keys; unknown keys are passed through unchanged.
 */
export const CREATE_ORDER_COURIER: Record<string, { courier: string; cargo?: boolean }> = {
  JNE: { courier: "JNE" },
  JNECargo: { courier: "JNE", cargo: true },
  SiCepat: { courier: "SiCepat" },
  SiCepatCargo: { courier: "SiCepat", cargo: true },
  SAP: { courier: "Sap" },
  SAPLite: { courier: "Sap" },
  SapCargo: { courier: "Sap", cargo: true },
  iDexpress: { courier: "iDexpress" },
  iDlite: { courier: "iDexpress" },
  iDexpressCargo: { courier: "iDexpress", cargo: true },
  JT: { courier: "JT" },
  lion: { courier: "lion" },
  anteraja: { courier: "anteraja" },
  pos: { courier: "pos" },
  spx: { courier: "spx" },
};
export const toCreateOrderCourier = (code: string) => CREATE_ORDER_COURIER[code] ?? { courier: code };

/** `history[].date` + `desc` → stored event; lines without text are dropped. */
export function toTrackingResult(info: TrackingInfo): TrackingResult {
  return {
    trackingNumber: info.cnote_no ?? null,
    providerStatus: info.statusCategory ?? info.status ?? null,
    paid: info.isPaid ?? null,
    history: (info.history ?? []).flatMap((h) => (h.desc ? [{ at: h.date ?? "", desc: h.desc }] : [])),
  };
}

/** `GET /order` data may be a list, a `{ docs | data | orders: [] }` page or one order: pick the first order-like object. */
export function firstOrder(data: unknown): TrackingInfo | null {
  const candidates: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? (["docs", "data", "orders"].map((k) => (data as Record<string, unknown>)[k]).find(Array.isArray) as unknown[] | undefined) ?? [data]
      : [];
  for (const c of candidates) {
    const parsed = trackingInfoSchema.safeParse(c);
    if (parsed.success && (parsed.data.ORDER_ID || parsed.data.cnote_no)) return parsed.data;
  }
  return null;
}

export function toBookingResult(created: CreatedOrder, batchId: string | undefined): BookingResult {
  if (created.error) throw new MengantarError("provider", `Mengantar: ${typeof created.error === "string" ? created.error : JSON.stringify(created.error)}`, 200, created);
  if (!created.ORDER_ID) throw new MengantarError("invalid_shape", "Mengantar create-order response has no ORDER_ID", 200, created);
  const trackingNumber = created.cnote_no ?? null;
  return {
    providerOrderId: created.ORDER_ID,
    providerBatchId: created.batch_id ?? batchId ?? null,
    trackingNumber,
    // Unpaid orders come back with isPaid=false and no resi (docs 01 §8.3); a resi implies paid.
    paid: created.isPaid ?? trackingNumber !== null,
    providerStatus: created.statusCategory ?? created.status ?? null,
  };
}

export type BookingEnv = { pickupAddressId: string; pickupTimeId?: string | undefined };

export function mengantarBooking(client: MengantarClient, env: BookingEnv): BookingAdapter {
  return {
    async createOrder(input) {
      if (input.shippingAccountKind === "partner_managed") throw new MengantarError("write_disabled", PARTNER_DISPATCH_LOCKED_MESSAGE);
      const { courier, cargo } = toCreateOrderCourier(input.courierCode);
      const res = await client.createOrder({
        courier,
        // Pickup from the platform's registered address (docs 01 §3.3/§4); a seller-specific origin
        // would need `upsertOrigin` (write) — see docs/tracks/shipping.md "Pickup origin at the provider".
        pickup: { type: "scheduledPickup", address_id: env.pickupAddressId, ...(env.pickupTimeId && { time_id: env.pickupTimeId }) },
        orders: [
          {
            customerAddressDataId: input.destinationAreaId,
            customerAddress: input.shippingAddress,
            customerName: input.buyerName,
            customerPhone: input.buyerPhone,
            parcelContent: input.parcelContent,
            weight: input.weightKg,
            quantity: input.quantity,
            isDangerousGoods: false,
            cargo: cargo === true,
            ...(input.codAmount > 0 ? { COD: input.codAmount } : { goodsValue: input.goodsValue }),
          },
        ],
      });
      const [created] = res.data ?? [];
      if (!created) {
        const err = res.errors?.[0];
        throw new MengantarError("provider", `Mengantar: ${err ? (typeof err === "string" ? err : JSON.stringify(err)) : "create-order returned no order"}`, 200, res);
      }
      return toBookingResult(created, res.batch_id);
    },
    async payUnpaid(batchId, courierCode) {
      await client.payUnpaid(batchId, toCreateOrderCourier(courierCode).courier);
    },
    async track(ref) {
      const info = firstOrder(await client.getOrder(ref));
      if (!info) throw new MengantarError("invalid_shape", "Mengantar: order not found in tracking response", 200);
      return toTrackingResult(info);
    },
  };
}

/** Real booking adapter when the platform credentials are in the process env; otherwise null (fake). */
export function mengantarBookingFromEnv(env: NodeJS.ProcessEnv = process.env): BookingAdapter | null {
  if (!env.MENGANTAR_API_KEY || !env.MENGANTAR_PICKUP_ADDRESS_ID) return null;
  return mengantarBooking(new MengantarClient({ apiKey: env.MENGANTAR_API_KEY, baseUrl: env.MENGANTAR_BASE_URL }), {
    pickupAddressId: env.MENGANTAR_PICKUP_ADDRESS_ID,
    pickupTimeId: env.MENGANTAR_PICKUP_TIME_ID,
  });
}
