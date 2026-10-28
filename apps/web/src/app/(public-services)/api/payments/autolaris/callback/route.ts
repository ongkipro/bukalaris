import { log } from "@/lib/log";
import { clientIp } from "@/lib/storefront";
import { acceptAutoLarisCallback, AUTOLARIS_CALLBACK_LIMIT, CALLBACK_BODY_MAX_BYTES, db, DomainError, enforceLimits, PaymentContractError, verifyCallbackToken } from "@bukalaris/db";
import { NextResponse, type NextRequest } from "next/server";

// HTTP-17 (T-49, ADR-0006 decision 6, D-21 K). AutoLaris echoes the `callback_url` verbatim and sends no custom header, so the
// only authentication is the domain-tagged HMAC reference in `?cb=<reff>.<hmac128>`, bound to the payment attempt. A valid call
// is a TRIGGER: it records the body digest and enqueues the verification job that calls the provider inquiry; it never changes a
// payment, an order, an invoice or money (an order attempt and a subscription invoice attempt, T-50, share this URL: the signed reference says which). Runs on the app pool (the store comes from the signed reference through a definer resolver).
// Answers carry only a code: no reason text, no echo of the body. Dispatch (DOM-5) allows POST on the apex host only.

const STATUS: Record<PaymentContractError["code"], number> = {
  binding: 403, identity: 400, malformed: 400, rejected: 400, amount: 422, not_found: 404, too_large: 413, configuration: 503,
};

/** The body as text, or null once it exceeds the cap (a chunked request has no trustworthy content-length). */
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
  const refuse = (error: string, status: number) => NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
  if (Number(req.headers.get("content-length") ?? 0) > CALLBACK_BODY_MAX_BYTES) return refuse("too_large", 413);
  try {
    // Signature first (CPU only, no database): unsigned traffic must not be able to fill a shared counter that real provider
    // callbacks also need (wave 2 review). Limits then apply per source address and per signed reference only.
    const reffId = verifyCallbackToken(req.nextUrl.searchParams.get("cb"));
    const ip = await clientIp();
    const { limit, windowSec } = AUTOLARIS_CALLBACK_LIMIT;
    await enforceLimits(db(), [{ key: `autolaris-cb:ref:${reffId}`, rule: { limit: limit * 10, windowSec } }, ...(ip ? [{ key: `autolaris-cb:ip:${ip}`, rule: { limit, windowSec } }] : [])]);
    const rawBody = await readBounded(req, CALLBACK_BODY_MAX_BYTES);
    if (rawBody === null) return refuse("too_large", 413);
    const { outcome } = await acceptAutoLarisCallback(db(), { token: req.nextUrl.searchParams.get("cb"), rawBody });
    return NextResponse.json({ ok: true, outcome }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof DomainError && err.code === "rate_limited") return refuse("rate_limited", 429);
    if (err instanceof PaymentContractError) {
      void log(err.code === "configuration" ? "error" : "warn", err.message, { module: "api.payments", operation: "autolaris.callback", code: err.code });
      return refuse(err.code, STATUS[err.code]);
    }
    throw err;
  }
}
