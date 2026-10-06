import "server-only";
import { authenticateChannel, db, DomainError, getCart, type ChannelAuth } from "@bukalaris/db";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";

// Storefront API v1 (API-8, IAM-11): server-to-server, authenticated by a private
// channel token. The channel decides the store; JSON errors carry stable codes;
// numeric ids are strings; money is integer IDR. No CORS headers on purpose.

type Live = Extract<ChannelAuth, { ok: true }>;
export const NO_STORE = { "Cache-Control": "no-store" };

export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: NO_STORE });

export function apiError(req: Request, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  const correlation_id = req.headers.get("x-correlation-id") ?? randomUUID();
  return json({ code, message, correlation_id, ...extra }, status);
}

/** Expected service failures → stable HTTP codes; anything else is a 500 (never leaked). */
const DOMAIN_STATUS: Record<string, number> = { not_found: 404, empty: 409, cart_checked_out: 409, store_unavailable: 403 };

export async function withChannel(req: Request, handler: (auth: Live) => Promise<Response>): Promise<Response> {
  const auth = await authenticateChannel(db(), req.headers.get("authorization"));
  if (!auth.ok) {
    return auth.reason === "store_unavailable"
      ? apiError(req, 403, "store_unavailable", "Toko sedang tidak menerima pesanan.")
      : apiError(req, 401, "unauthorized", "Token channel tidak valid, kedaluwarsa atau dicabut.");
  }
  try {
    return await handler(auth);
  } catch (err) {
    if (err instanceof DomainError) return apiError(req, DOMAIN_STATUS[err.code] ?? 409, err.code, err.message);
    if (err instanceof ZodError)
      return apiError(req, 422, "validation", "Data tidak valid.", {
        field_errors: err.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      });
    if (err instanceof SyntaxError) return apiError(req, 400, "invalid_json", "Body harus JSON yang valid.");
    throw err;
  }
}

export const money = (amount: number) => ({ amount, currency: "IDR" as const });
/** Canonical storefront path: readable slug, else the external catalog id (never the database id). */
export const canonicalPath = (storeSlug: string, p: { catalogId: string; slug: string | null }) =>
  `/s/${storeSlug}/products/${p.slug ?? p.catalogId}`;

export function cartJson(c: Awaited<ReturnType<typeof getCart>>) {
  return {
    id: c.id,
    lines: c.lines.map((l) => ({
      variant_id: String(l.variantId),
      product_id: String(l.productId),
      title: `${l.productTitle} · ${l.variantTitle}`,
      quantity: l.quantity,
      unit_price: money(l.price),
      line_total: money(l.price * l.quantity),
    })),
    subtotal: money(c.subtotal),
  };
}

export const cartItemInput = z.strictObject({
  variant_id: z.string().regex(/^[1-9][0-9]*$/, "variant_id harus angka dalam string."),
  quantity: z.number().int().min(1).max(99),
});
