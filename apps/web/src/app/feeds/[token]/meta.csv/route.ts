import { renderMetaCsv } from "@bukalaris/db";
import type { NextRequest } from "next/server";
import { feedResponse } from "../../_response";

/** Meta Commerce Manager data feed (CSV, one row per sellable variant). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/feeds/[token]/meta.csv">) {
  const { token } = await ctx.params;
  return feedResponse(token, "text/csv; charset=utf-8", (items) => renderMetaCsv(items));
}
