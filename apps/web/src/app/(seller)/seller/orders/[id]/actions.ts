"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { sellerScope } from "@/lib/context";
import { bookShipment, linkUnknownBooking, refreshTracking, releaseUnknownBooking } from "@bukalaris/db";
import { run } from "../run";

/** "Kirim lewat Mengantar" / "Coba lagi": enqueue the booking (T-39); the worker does the provider call. */
export async function bookShipmentAction(orderId: number, f: FormData) {
  await requirePortalCsrf(f, `/seller/orders/${orderId}`);
  const scope = await sellerScope();
  const back = `/seller/orders/${orderId}`;
  // T-105: a store on its own courier account chooses drop-off or scheduled pickup; the platform accounts ignore the field.
  const pickupType = f.get("pickupType");
  await run(back, () => `${back}?saved=booking`, () => bookShipment(scope, orderId, typeof pickupType === "string" ? { pickupType } : {}));
}

/** T-105: an unknown booking outcome, checked in the courier account: no order there → release (booking may be repeated). */
export async function releaseUnknownBookingAction(orderId: number, f: FormData) {
  await requirePortalCsrf(f, `/seller/orders/${orderId}`);
  const scope = await sellerScope();
  const back = `/seller/orders/${orderId}`;
  await run(back, () => `${back}?saved=released`, () => releaseUnknownBooking(scope, orderId, { reason: String(f.get("reason") ?? "") }));
}

/** T-105: an unknown booking outcome, checked in the courier account: the order exists → link it (no second booking). */
export async function linkUnknownBookingAction(orderId: number, f: FormData) {
  await requirePortalCsrf(f, `/seller/orders/${orderId}`);
  const scope = await sellerScope();
  const back = `/seller/orders/${orderId}`;
  await run(back, () => `${back}?saved=linked`, () => linkUnknownBooking(scope, orderId, { providerOrderId: String(f.get("providerOrderId") ?? "") }));
}

/** "Perbarui status": one bounded, read-only tracking poll through the outbox. */
export async function refreshTrackingAction(orderId: number, f: FormData) {
  await requirePortalCsrf(f, `/seller/orders/${orderId}`);
  const scope = await sellerScope();
  const back = `/seller/orders/${orderId}`;
  await run(back, () => `${back}?saved=tracking`, () => refreshTracking(scope, orderId));
}
