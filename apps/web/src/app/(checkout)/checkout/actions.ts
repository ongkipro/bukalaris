"use server";

import { requireCartCsrf } from "@/lib/auth-csrf";

import { captureCheckoutSession, checkoutPromotionPreview, db, placeOrder, storefrontScope } from "@bukalaris/db";
import { userError, withError } from "@/lib/errors";
import { referralContext } from "@/lib/referral";
import { requestSignalContext } from "@/lib/signals";
import { cartCookie, clientIp, cookieOpts, ORDER_COOKIE } from "@/lib/storefront";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const FIELDS = ["idempotencyKey", "buyerName", "buyerPhone", "buyerEmail", "shippingAddress", "destinationAreaId", "destinationAreaLabel", "courier", "paymentMethod", "paymentChannel", "voucherCode", "affiliateCode"] as const;

export type VoucherPreview = { error: string } | { goodsDiscount: number; shippingDiscount: number; shipping: number; total: number; subtotal: number };
/** Read-only: same rules and quote as submit, no stock or quota reservation, and the cart is never changed. */
export async function previewVoucher(f: FormData): Promise<VoucherPreview> {
  const scope = await storefrontScope(db(), String(f.get("store") ?? ""));
  if (!scope) return { error: "Toko tidak tersedia." };
  const cartId = (await cookies()).get(cartCookie(scope.storeId))?.value;
  try {
    const r = await checkoutPromotionPreview(db(), cartId, Object.fromEntries(["buyerPhone", "voucherCode", "destinationAreaId", "courier", "paymentMethod"].map((k) => [k, String(f.get(k) ?? "")])), { clientIp: await clientIp() });
    return { goodsDiscount: r.goodsDiscount, shippingDiscount: r.shippingDiscount, shipping: r.shippingCharged, total: r.payable, subtotal: r.subtotal };
  } catch (err) {
    return { error: userError(err) };
  }
}

/**
 * T-45: debounced progress of the contact fields (PR-25). Best effort and silent: a refused, limited or failed capture never blocks the buyer,
 * and nothing but the four contact fields is read from the form (price, store and cart come from the server).
 */
export async function captureProgress(f: FormData): Promise<void> {
  if (!(f instanceof FormData)) return;
  try {
    const scope = await storefrontScope(db(), String(f.get("store") ?? ""));
    if (!scope) return;
    const cartId = (await cookies()).get(cartCookie(scope.storeId))?.value;
    await requireCartCsrf(scope, f);
    await captureCheckoutSession(db(), cartId, Object.fromEntries(["buyerName", "buyerPhone", "buyerEmail", "shippingAddress"].map((k) => [k, String(f.get(k) ?? "")])), { clientIp: await clientIp() });
  } catch {
    // Capture is optional; the order flow does not depend on it.
  }
}

export async function submitCheckout(f: FormData) {
  if (!(f instanceof FormData)) redirect("/checkout");
  const jar = await cookies();
  const slug = String(f.get("store") ?? "");
  const scope = await storefrontScope(db(), slug);
  if (!scope) redirect("/checkout");
  // On failure the buyer lands back on the same step: chosen area kept via the search params.
  const params = new URLSearchParams({ store: scope.storeSlug });
  for (const k of ["q", "destinationAreaId"] as const) if (f.get(k)) params.set(k === "destinationAreaId" ? "area" : k, String(f.get(k)));
  const back = `/checkout?${params}`;
  const cart = cartCookie(scope.storeId);
  const cartId = jar.get(cart)?.value;
  // Only the whitelisted fields cross the boundary; any price/total in the form is ignored.
  const input = Object.fromEntries(FIELDS.map((k) => [k, String(f.get(k) ?? "")]));
  let orderId: number | undefined;
  let error: string | undefined;
  try {
    await requireCartCsrf(scope, f);
    ({ orderId } = await placeOrder(db(), cartId, input, undefined, { clientIp: await clientIp(), signal: await requestSignalContext(), referral: await referralContext() }));
  } catch (err) {
    error = userError(err);
  }
  if (error || !orderId) redirect(withError(back, error ?? "Checkout gagal."));
  jar.set(ORDER_COOKIE, cartId!, cookieOpts);
  jar.delete(cart);
  redirect(`/checkout/confirmation?order=${orderId}`);
}
