import { sellerScope } from "@/lib/context";
import { DomainError, exportBuyerData } from "@bukalaris/db";
import type { NextRequest } from "next/server";

// T-43: one buyer's data in the signed-in owner's store as a downloaded JSON file. Generated
// per request, never stored or cached; the lookup is audited by the service (`privacy.export`).
export async function GET(req: NextRequest) {
  const scope = await sellerScope(); // redirects to /login or /seller when there is no active membership
  try {
    const data = await exportBuyerData(scope, req.nextUrl.searchParams.get("q") ?? "");
    const stamp = data.exportedAt.slice(0, 19).replace(/[:T]/g, "-");
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="pembeli-${scope.storeSlug}-${stamp}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    const status = err.code === "forbidden" ? 403 : 400;
    return Response.json({ error: err.code, message: err.message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
