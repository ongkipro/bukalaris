import "server-only";
import { cartStore, channelReturnTarget, db, resolveClientIp, storefrontScope, type StorefrontScope } from "@bukalaris/db";
import { hostRootsFromEnv, resolveHostSurface, surfaceCookieNames } from "@bukalaris/db/host";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { HOST_STORE_HEADER } from "./host-header";

/** One cart cookie per store, so carts in different stores (path mode) never replace each other. `__Host-bl_cart_<storeId>` in production (DOM-6). */
export const cartCookie = (storeId: number) => surfaceCookieNames().storeCart(storeId);
export const ORDER_COOKIE = surfaceCookieNames().orderCart;

/** Active store for /s/[store]/*; unknown and suspended stores are a plain 404 (PR-1, PR-3). */
export const storeOr404 = cache(async (slug: string) => {
  const scope = await storefrontScope(db(), slug);
  if (!scope) notFound();
  const viaHost = (await headers()).get(HOST_STORE_HEADER) === slug;
  return { scope, base: viaHost ? "" : `/s/${slug}` };
});

/**
 * T-103 own-store gate (ADR-0014 decision 5). On a store host the proxy names the host's store in `x-bl-host-store` (overwritten on
 * every request, so a client cannot set it); the buyer paths `/checkout`, `/o` and `/r` then serve that store and nothing else.
 * `undefined` off a store host (one-host path mode, the checkout host), `null` when the host names no active store.
 */
export const hostStoreScope = cache(async (): Promise<StorefrontScope | null | undefined> => {
  const slug = (await headers()).get(HOST_STORE_HEADER);
  return slug ? storefrontScope(db(), slug) : undefined;
});

/**
 * May this request show an existing order of the store `slug` (confirmation, signed order-status page and its refund form)? Any store
 * off a store host; on a store host only its own, compared with the proxy-set slug and WITHOUT requiring an active store, so a
 * suspended store's buyers keep their order-status page and refund form (review finding 1). A foreign link is refused, never served.
 */
export async function servesStore(slug: string): Promise<boolean> {
  const host = (await headers()).get(HOST_STORE_HEADER);
  return host === null || host === slug;
}

/**
 * The store and cart a checkout request acts for. `requested` is the `?store=` or form value. On a store host it may only name
 * that host's store (absent means the host's store); another slug is refused. On the hosted checkout host (PR-16) only a cart that
 * arrived through the one-use hand-off of a live channel is read; a cart copied or recovered onto that host is not.
 */
export async function checkoutCart(requested: unknown): Promise<{ scope: StorefrontScope; cartId: string | undefined; home: string } | null> {
  const own = await hostStoreScope();
  const slug = typeof requested === "string" ? requested : "";
  const scope = own !== undefined ? (own && (!slug || slug === own.storeSlug) ? own : null) : slug ? await storefrontScope(db(), slug) : null;
  if (!scope) return null;
  let cartId = (await cookies()).get(cartCookie(scope.storeId))?.value;
  // The cart row must belong to this store (open or already checked out, for the T-97 replay): another store's cart id placed in this
  // store's cookie is never checked out through this host (review finding 3).
  if (cartId && (await cartStore(db(), cartId)) !== scope.storeId) cartId = undefined;
  if (cartId && own === undefined && resolveHostSurface((await headers()).get("host"), hostRootsFromEnv()).kind === "checkout" && !(await channelReturnTarget(db(), cartId))) {
    cartId = undefined;
  }
  return { scope, cartId, home: own ? "/" : `/s/${encodeURIComponent(scope.storeSlug)}` };
}

/**
 * Client IP for abuse counters (T-30): ONE trusted header chosen by the hosting topology (`CLIENT_IP_HEADER`, D-23): the last `x-forwarded-for` hop (default),
 * or `cf-connecting-ip` behind Cloudflare with a Cloudflare-only origin firewall. Undefined when absent or malformed, in which case the services skip the IP
 * dimension (per-cart/per-phone limits still apply). Never identity or authorization.
 */
export async function clientIp(): Promise<string | undefined> {
  const h = await headers();
  return resolveClientIp((name) => h.get(name));
}

export const cookieOpts = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};
