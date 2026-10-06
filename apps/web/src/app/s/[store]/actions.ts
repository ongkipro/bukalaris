"use server";

import { db, limitCartMutation, setCartLine, storefrontScope } from "@bukalaris/db";
import { userError, withError } from "@/lib/errors";
import { HOST_STORE_HEADER } from "@/lib/host-header";
import { cartCookie, clientIp, cookieOpts } from "@/lib/storefront";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

async function cartMutation(storeSlug: string, back: string, f: FormData, mode: "add" | "set") {
  const scope = await storefrontScope(db(), storeSlug);
  if (!scope) notFound();
  const base = (await headers()).get(HOST_STORE_HEADER) === storeSlug ? "" : `/s/${storeSlug}`;
  const jar = await cookies();
  let error: string | undefined;
  try {
    const current = jar.get(cartCookie(scope.storeId))?.value;
    await limitCartMutation(db(), { clientIp: await clientIp(), cartId: current }); // T-30
    const cartId = await setCartLine(scope, current, { variantId: f.get("variantId"), quantity: f.get("quantity") }, mode);
    jar.set(cartCookie(scope.storeId), cartId, cookieOpts);
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(`${base}${back}`, error) : `${base}/cart`);
}

export async function addToCart(storeSlug: string, productPath: string, f: FormData) {
  await cartMutation(storeSlug, productPath, f, "add");
}

export async function updateCart(storeSlug: string, f: FormData) {
  await cartMutation(storeSlug, "/cart", f, "set");
}
