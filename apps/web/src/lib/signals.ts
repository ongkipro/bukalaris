import "server-only";
import { browserSignals, CLICK_COOKIE, db, nameParts, phoneDigits62, sha256, type RequestSignalContext } from "@bukalaris/db";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { clientIp } from "./storefront";

/** Enabled destinations' public ids for the pixel runtime (deduped per request). Never tokens. */
export const signalsFor = cache((storeId: number) => browserSignals(db(), storeId));

/** Request-boundary facts for the server leg: pixel cookies, click cookie, trusted client IP, user agent. */
export async function requestSignalContext(url?: string): Promise<RequestSignalContext> {
  const jar = await cookies();
  const h = await headers();
  const pick = (name: string) => jar.get(name)?.value;
  return {
    cookies: { _fbp: pick("_fbp"), _fbc: pick("_fbc"), _ttp: pick("_ttp"), [CLICK_COOKIE]: pick(CLICK_COOKIE) },
    clientIp: await clientIp(),
    userAgent: h.get("user-agent") ?? undefined,
    url,
  };
}

/** Hashed advanced-matching fields for the browser leg of a buyer's own order (no raw PII in HTML). */
export type BrowserMatch = { ph62?: string; phE164?: string; fn?: string; ln?: string };
export function browserMatch(o: { buyerPhone: string; buyerName: string }): BrowserMatch {
  const d = phoneDigits62(o.buyerPhone);
  const { fn, ln } = nameParts(o.buyerName);
  return {
    ...(d ? { ph62: sha256(d), phE164: sha256(`+${d}`) } : {}),
    ...(fn ? { fn: sha256(fn) } : {}),
    ...(ln ? { ln: sha256(ln) } : {}),
  };
}
