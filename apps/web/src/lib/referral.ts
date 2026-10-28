import "server-only";
import { parseReferralCookie } from "@bukalaris/db";
import { surfaceCookieNames } from "@bukalaris/db/host";
import { cookies } from "next/headers";

/**
 * The referral selectors of this request for `placeOrder` (T-52): the click ids of the `__Host-bl_click` continuity cookie, well-formed ids only. A selector, never authority:
 * the database accepts an id only if it is a captured click of the store being checked out, still inside its window, from an active affiliate that the store has not blocked.
 */
export async function referralContext() {
  return { clickIds: parseReferralCookie((await cookies()).get(surfaceCookieNames().referralClick)?.value) };
}
