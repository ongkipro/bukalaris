"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { sellerScope } from "@/lib/context";
import { bookShipment, confirmBankTransfer, linkUnknownBooking, recordSellerRefund, refreshTracking, rejectPaymentProof, releaseUnknownBooking } from "@bukalaris/db";
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

/** T-107 (ADR-0013 decision 26): the owner records a refund made outside Bukalaris; nothing is paid or moved by this action. */
export async function recordRefundAction(orderId: number, f: FormData) {
  await requirePortalCsrf(f, `/seller/orders/${orderId}`);
  const scope = await sellerScope();
  const back = `/seller/orders/${orderId}`;
  const text = (k: string) => String(f.get(k) ?? "");
  await run(back, () => `${back}?saved=refund`, () =>
    recordSellerRefund(scope, orderId, { amountIdr: text("amountIdr").replace(/[^0-9]/g, ""), refundedOn: text("refundedOn"), method: text("method"), reference: text("reference"), reason: text("reason") }),
  );
}

/** T-113 (decision 38): the seller confirms a bank transfer after checking their own bank statement (reason, the proof looked at or none). */
export async function confirmBankTransferAction(orderId: number, f: FormData) {
  await requirePortalCsrf(f, `/seller/orders/${orderId}`);
  const scope = await sellerScope();
  const back = `/seller/orders/${orderId}`;
  await run(back, () => `${back}?saved=bank_confirmed#bank-transfer`, () => confirmBankTransfer(scope, { orderId, reason: String(f.get("reason") ?? ""), proofId: String(f.get("proofId") ?? "") }));
}

/** T-113: reject a proof with a reason the buyer reads; the buyer may send a new one. */
export async function rejectProofAction(orderId: number, proofId: string, f: FormData) {
  await requirePortalCsrf(f, `/seller/orders/${orderId}`);
  const scope = await sellerScope();
  const back = `/seller/orders/${orderId}`;
  await run(back, () => `${back}?saved=proof_rejected#bank-transfer`, () => rejectPaymentProof(scope, { orderId, proofId, reason: String(f.get("reason") ?? "") }));
}
