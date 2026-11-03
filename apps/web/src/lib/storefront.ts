import "server-only";
import { db, resolveClientIp, storefrontScope } from "@bukalaris/db";
import { surfaceCookieNames } from "@bukalaris/db/host";
import { headers } from "next/headers";
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
