"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { sellerScope } from "@/lib/context";
import { bookShipment, refreshTracking } from "@bukalaris/db";
import { run } from "../run";

/** "Kirim lewat Mengantar" / "Coba lagi": enqueue the booking (T-39); the worker does the provider call. */
export async function bookShipmentAction(orderId: number, f: FormData) {
  await requirePortalCsrf(f, `/seller/orders/${orderId}`);
  const scope = await sellerScope();
  const back = `/seller/orders/${orderId}`;
  await run(back, () => `${back}?saved=booking`, () => bookShipment(scope, orderId));
}

/** "Perbarui status": one bounded, read-only tracking poll through the outbox. */
export async function refreshTrackingAction(orderId: number, f: FormData) {
  await requirePortalCsrf(f, `/seller/orders/${orderId}`);
  const scope = await sellerScope();
  const back = `/seller/orders/${orderId}`;
  await run(back, () => `${back}?saved=tracking`, () => refreshTracking(scope, orderId));
}
