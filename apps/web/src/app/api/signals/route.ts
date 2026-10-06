import { clientIp } from "@/lib/storefront";
import { CLICK_COOKIE, collectFunnelEvent, db, DomainError, enforceLimits, storefrontScope } from "@bukalaris/db";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

// Server leg of browser funnel events (T-38). The browser posts the event name, the
// `event_id` it just fired on the pixels, and variant catalog ids; value is re-derived
// from the catalog, so nothing here trusts a client amount. Anonymous by design:
// per-IP fixed window limit (T-30 counters), small body, store resolved by slug.

const MAX_BODY = 8 * 1024;
const LIMIT = { limit: 600, windowSec: 600 };
const slug = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function POST(req: NextRequest) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return NextResponse.json({ error: "too_large" }, { status: 413 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.store !== "string" || !slug.test(body.store)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const { store, ...event } = body;
  const scope = await storefrontScope(db(), store);
  if (!scope) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ip = await clientIp();
  try {
    await enforceLimits(db(), ip ? [{ key: `signal:ip:${ip}`, rule: LIMIT }] : []);
    const pick = (name: string) => req.cookies.get(name)?.value;
    await collectFunnelEvent(scope, event, {
      cookies: { _fbp: pick("_fbp"), _fbc: pick("_fbc"), _ttp: pick("_ttp"), [CLICK_COOKIE]: pick(CLICK_COOKIE) },
      clientIp: ip,
      userAgent: req.headers.get("user-agent") ?? undefined,
      url: req.headers.get("referer") ?? undefined,
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === "rate_limited") return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    if (err instanceof ZodError) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    throw err;
  }
  return new NextResponse(null, { status: 204 });
}
