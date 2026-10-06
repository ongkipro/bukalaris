"use server";

import { db, placeOrder, storefrontScope } from "@bukalaris/db";
import { userError, withError } from "@/lib/errors";
import { requestSignalContext } from "@/lib/signals";
import { cartCookie, clientIp, cookieOpts, ORDER_COOKIE } from "@/lib/storefront";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const FIELDS = ["idempotencyKey", "buyerName", "buyerPhone", "shippingAddress", "destinationAreaId", "destinationAreaLabel", "courier", "paymentMethod"] as const;

export async function submitCheckout(f: FormData) {
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
    ({ orderId } = await placeOrder(db(), cartId, input, undefined, { clientIp: await clientIp(), signal: await requestSignalContext() }));
  } catch (err) {
    error = userError(err);
  }
  if (error || !orderId) redirect(withError(back, error ?? "Checkout gagal."));
  jar.set(ORDER_COOKIE, cartId!, cookieOpts);
  jar.delete(cart);
  redirect(`/checkout/confirmation?order=${orderId}`);
}
