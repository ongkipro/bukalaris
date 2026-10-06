import "server-only";
import { db, storefrontScope } from "@bukalaris/db";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { HOST_STORE_HEADER } from "./host-header";

/** One cart cookie per store, so carts in different stores (path mode) never replace each other. */
export const cartCookie = (storeId: number) => `bl_cart_${storeId}`;
export const ORDER_COOKIE = "bl_order_cart";

/** Active store for /s/[store]/*; unknown and suspended stores are a plain 404 (PR-1, PR-3). */
export const storeOr404 = cache(async (slug: string) => {
  const scope = await storefrontScope(db(), slug);
  if (!scope) notFound();
  const viaHost = (await headers()).get(HOST_STORE_HEADER) === slug;
  return { scope, base: viaHost ? "" : `/s/${slug}` };
});

const IP_RE = /^[0-9a-fA-F.:]{3,45}$/;
/**
 * Client IP for abuse counters (T-30): the entry the nearest proxy appended to
 * `x-forwarded-for` (last hop; the deployment runs behind exactly one trusted proxy),
 * else `x-real-ip`; undefined when neither is present or malformed, in which case the
 * services skip the IP dimension (per-cart/per-phone limits still apply). Never
 * identity or authorization.
 */
export async function clientIp(): Promise<string | undefined> {
  const h = await headers();
  const hop = h.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean).at(-1) ?? h.get("x-real-ip")?.trim();
  return hop && IP_RE.test(hop) ? hop : undefined;
}

export const cookieOpts = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};
