"use server";

import { db, placeOrder, storefrontScope } from "@bukalaris/db";
import { userError, withError } from "@/lib/errors";
import { cartCookie, cookieOpts, ORDER_COOKIE } from "@/lib/storefront";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const FIELDS = ["idempotencyKey", "buyerName", "buyerPhone", "shippingAddress", "courier", "paymentMethod"] as const;

export async function submitCheckout(f: FormData) {
  const jar = await cookies();
  const slug = String(f.get("store") ?? "");
  const scope = await storefrontScope(db(), slug);
  if (!scope) redirect("/checkout");
  const back = `/checkout?store=${encodeURIComponent(scope.storeSlug)}`;
  const cart = cartCookie(scope.storeId);
  const cartId = jar.get(cart)?.value;
  // Only the whitelisted fields cross the boundary; any price/total in the form is ignored.
  const input = Object.fromEntries(FIELDS.map((k) => [k, String(f.get(k) ?? "")]));
  let orderId: number | undefined;
  let error: string | undefined;
  try {
    ({ orderId } = await placeOrder(db(), cartId, input));
  } catch (err) {
    error = userError(err);
  }
  if (error || !orderId) redirect(withError(back, error ?? "Checkout gagal."));
  jar.set(ORDER_COOKIE, cartId!, cookieOpts);
  jar.delete(cart);
  redirect(`/checkout/confirmation?order=${orderId}`);
}
