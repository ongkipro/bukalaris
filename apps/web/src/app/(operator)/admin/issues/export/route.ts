import { consoleGate } from "@/lib/console-gate";
import { DomainError, exportIssues } from "@bukalaris/db";
import { ZodError } from "zod";
export async function GET(request: Request) {
  const g = await consoleGate("/admin/issues/export");
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (!g.ok) return Response.json({ error: "forbidden" }, { status: 403, headers });
  const params = Object.fromEntries(new URL(request.url).searchParams);
  if (params.format !== "json" && params.format !== "csv") return Response.json({ error: "format_invalid" }, { status: 400, headers });
  try {
    const body = await exportIssues(g.op, params, params.format);
    return new Response(body, { headers: { ...headers, "Content-Type": params.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="issue-reports.${params.format}"` } });
  } catch (err) {
    if (err instanceof ZodError || err instanceof DomainError) return Response.json({ error: err instanceof DomainError ? err.code : "filter_invalid" }, { status: err instanceof DomainError && err.code === "forbidden" ? 403 : 400, headers });
    throw err;
  }
}
