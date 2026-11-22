import { log } from "@/lib/log";
import { db, receiveMengantarWebhook, WEBHOOK_BODY_MAX_BYTES } from "@bukalaris/db";
import { NextResponse, type NextRequest } from "next/server";

// HTTP-26 (T-115, ADR-0013 decision 43): the Mengantar webhook of a store's OWN account. The seller sets
// `<platform origin>/api/shipping/mengantar/webhook?h=<store webhook id>` in Mengantar; the id resolves the store (definer resolver), the
// store's sealed Webhook Secret verifies `x-signature` over `{x-timestamp}.{raw body}` in constant time, stale timestamps and sandbox
// deliveries to a production account are refused. A verified delivery is stored once and only enqueues a tracking read on the store's
// key: it never changes a parcel or an order itself. Answers carry a code only; the secret, the body and the signature are never logged.
// Dispatch (DOM-5) allows POST on the apex host only.

async function readBounded(req: NextRequest, max: number): Promise<string | null> {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

export async function POST(req: NextRequest) {
  const answer = (code: string, status: number) => NextResponse.json(status === 200 ? { ok: true, outcome: code } : { error: code }, { status, headers: { "cache-control": "no-store" } });
  if (Number(req.headers.get("content-length") ?? 0) > WEBHOOK_BODY_MAX_BYTES) return answer("too_large", 413);
  const rawBody = await readBounded(req, WEBHOOK_BODY_MAX_BYTES);
  if (rawBody === null) return answer("too_large", 413);
  const r = await receiveMengantarWebhook(db(), {
    hookId: req.nextUrl.searchParams.get("h"),
    rawBody,
    timestamp: req.headers.get("x-timestamp"),
    signature: req.headers.get("x-signature"),
    environment: req.headers.get("x-environment"),
  });
  if (r.status !== 200) void log("warn", "mengantar webhook refused", { module: "api.shipping", operation: "mengantar.webhook", code: r.outcome });
  return answer(r.outcome, r.status);
}
