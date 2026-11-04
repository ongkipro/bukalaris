"use server";

import { requireCartCsrf } from "@/lib/auth-csrf";

import { userError, withError } from "@/lib/errors";
import { HOST_STORE_HEADER } from "@/lib/host-header";
import { cartCookie, clientIp, cookieOpts } from "@/lib/storefront";
import { db, limitCartMutation, setCartLine, storefrontScope } from "@bukalaris/db";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

/**
 * LP order section → store cart → hosted checkout (PR-16). Same cart row and per-store cookie
 * as the storefront (D-6), so the LP never creates separate commerce state; the only
 * difference from the product page is the destination: straight to `/checkout?store=`.
 */
export async function orderFromLanding(storeSlug: string, lpSlug: string, f: FormData) {
  const scope = await storefrontScope(db(), storeSlug);
  if (!scope) notFound();
  const base = (await headers()).get(HOST_STORE_HEADER) === storeSlug ? "" : `/s/${storeSlug}`;
  const jar = await cookies();
  let error: string | undefined;
  try {
    const current = jar.get(cartCookie(scope.storeId))?.value;
    await requireCartCsrf(scope, f);
    await limitCartMutation(db(), { clientIp: await clientIp(), cartId: current }); // T-30
    const cartId = await setCartLine(scope, current, { variantId: f.get("variantId"), quantity: f.get("quantity") }, "add");
    jar.set(cartCookie(scope.storeId), cartId, cookieOpts);
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? `${withError(`${base}/lp/${lpSlug}`, error)}#order` : `/checkout?store=${encodeURIComponent(scope.storeSlug)}`);
}
