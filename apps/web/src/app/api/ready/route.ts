import { db } from "@bukalaris/db";

export const dynamic = "force-dynamic";
const TIMEOUT_MS = 2000;

/** Readiness: one bounded round trip to the database. No error details leave the process (they go to the log). */
export async function GET() {
  const headers = { "cache-control": "no-store" };
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref());
    await Promise.race([db().execute("select 1"), timeout]);
    return Response.json({ ok: true }, { headers });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers });
  }
}
