import { renderGoogleRss } from "@bukalaris/db";
import type { NextRequest } from "next/server";
import { feedResponse } from "../../_response";

/** Google Merchant Center product data source (RSS 2.0 with the `g:` namespace). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/feeds/[token]/google.xml">) {
  const { token } = await ctx.params;
  return feedResponse(token, "application/xml; charset=utf-8", (items, scope) => renderGoogleRss(items, scope));
}
