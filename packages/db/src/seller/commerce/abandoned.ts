import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../../client.ts";
import { normalizeEmail, normalizePhone, phoneLookupKey } from "../../buyer/normalize.ts";
import { cartLine, checkoutSession, order, product, store, variant } from "../../schema.ts";
import { resolveCartStore } from "../../platform/resolvers.ts";
import { DomainError, requireCap, type SellerScope } from "../../platform/scoped.ts";
import { inStore, withStore } from "../../platform/tenant.ts";
import { enforceLimits, type LimitRule } from "./checkout.ts";

// Abandoned checkout capture and 1-click WhatsApp recovery (T-45, PR-25, DATA-8, UX-15, PRIV-1).
// Hosted checkout reports what the buyer has typed so far (debounced by the page, nothing before a field has a value) into one
// `checkout_session` row per cart, store-scoped under FORCE RLS. `cleanup.ts` sweeps idle sessions to `abandoned` and purges old
// ones; the order transaction marks a matching session `recovered`; Seller Admin ranks the queue and opens `wa.me` with a signed
// resume link. The row holds personal data and is therefore in BUYER_DATA_INVENTORY (export + redaction, T-43).

/** Idle time (since the last capture) after which an `active` session is swept to `abandoned`. Task text; the same literal guards the trigger. */
export const CHECKOUT_SESSION_IDLE_MINUTES = 60;
/** Sessions older than this (since `created_at`) are deleted by the cleanup command. Task text. */
export const CHECKOUT_SESSION_PURGE_DAYS = 30;
/** Window of the Abandon Rate and the Recovery Rate: sessions created, and orders placed, in the last 30 days (the purge age, so no counted row is ever purged early). */
export const ABANDON_WINDOW_DAYS = 30;
/** Validity of the signed resume link. Task text. */
export const RESUME_LINK_DAYS = 7;
/** Rows shown in the Seller Admin queue (the best-ranked ones). */
export const QUEUE_LIMIT = 100;
/** Hosted-checkout capture budget: per cart and per client IP. A refused capture is dropped silently; checkout itself never depends on it. */
export const CAPTURE_LIMITS = {
  cart: { limit: 60, windowSec: 600 },
  ip: { limit: 300, windowSec: 600 },
} as const satisfies Record<string, LimitRule>;
/** Resume link redemptions per client IP. */
export const RESUME_LIMIT: LimitRule = { limit: 60, windowSec: 600 };

// ── Pure math (table-driven tests) ─────────────────────────────────────────────────────

export type RateInputs = {
  /** Sessions in the window that are `abandoned` right now (not recovered, not active again). */
  abandoned: number;
  /** Sessions in the window with `abandoned_at IS NOT NULL AND recovered_at IS NOT NULL`. */
  rescued: number;
  /** Orders placed in the store in the window (every order, straight-through or rescued). */
  orders: number;
};
/** Basis points (10000 = 100 %) or null when the denominator is zero: "no data" is never shown as 0 %. */
export type Rates = { abandonBps: number | null; recoveryBps: number | null };
const bps = (n: number, d: number) => (d === 0 ? null : Math.round((n * 10_000) / d));

/**
 * UX-15: Abandon Rate = abandoned / (abandoned + orders); Recovery Rate = rescued / (rescued + abandoned). Active sessions are in neither
 * count, and a straight-through checkout (never abandoned) is never `rescued`, so ordinary orders cannot inflate the Recovery Rate.
 */
export function abandonRates(c: RateInputs): Rates {
  return { abandonBps: bps(c.abandoned, c.abandoned + c.orders), recoveryBps: bps(c.rescued, c.rescued + c.abandoned) };
}

/** UX-15: `subtotal / (1 + minutes_ago / 1440)`; a future timestamp counts as just now. */
export const decayedValue = (subtotalIdr: number, minutesAgo: number): number => subtotalIdr / (1 + Math.max(0, minutesAgo) / 1440);

/** Whether a stored contact can open WhatsApp: the T-57 comparison key (`628…`), never a guess from the raw text. */
export const recoveryPhoneKey = (buyerPhone: string | null): string | null => (buyerPhone ? normalizePhone(buyerPhone) : null); // `628…` only: a number typed without a country or trunk prefix is never a WhatsApp target (wave 5 review)

/** Queue order: a row with a usable phone number first, then by time-decayed basket value, newest id last tie-break. */
export function rankAbandoned<T extends { id: number; buyerPhone: string | null; subtotalIdr: number; updatedAt: Date }>(rows: readonly T[], now: Date): (T & { hasPhone: boolean; score: number })[] {
  return rows
    .map((r) => ({ ...r, hasPhone: recoveryPhoneKey(r.buyerPhone) !== null, score: decayedValue(r.subtotalIdr, (now.getTime() - r.updatedAt.getTime()) / 60_000) }))
    .sort((a, b) => Number(b.hasPhone) - Number(a.hasPhone) || b.score - a.score || b.id - a.id);
}

// ── Signed resume link ─────────────────────────────────────────────────────────────────

export const RESUME_KEYRING_ENV = "KEYRING_CHECKOUT_RESUME";
const RESUME_PURPOSE = "checkout.resume.v1";
const KEY_BYTES = 32;
type ResumeKey = { keyId: string; key: Buffer };

/**
 * `<key_id>:<base64 of 32 bytes>[,<key_id>:<base64>...]`, the first entry signs, every entry verifies (rotation). Missing, malformed or duplicate ids fail
 * closed; a key shared with another purpose (buyer fingerprints, integration tokens, shipping credentials) is refused, so one leaked secret never opens a second purpose.
 */
export function resumeKeyring(env: NodeJS.ProcessEnv = process.env): ResumeKey[] {
  const raw = env[RESUME_KEYRING_ENV];
  if (!raw) throw new DomainError("resume_key_unavailable", "Tautan pemulihan belum bisa dibuat: kunci penandatangan belum dikonfigurasi.");
  const ring = raw.split(",").map((entry) => {
    const split = entry.indexOf(":");
    const keyId = entry.slice(0, split);
    const key = Buffer.from(entry.slice(split + 1), "base64");
    if (split <= 0 || !/^[a-zA-Z0-9_-]+$/.test(keyId) || key.length !== KEY_BYTES) throw new DomainError("resume_key_unavailable", "Kunci penandatangan tautan pemulihan tidak valid.");
    return { keyId, key };
  });
  if (new Set(ring.map((k) => k.keyId)).size !== ring.length) throw new DomainError("resume_key_unavailable", "Kunci penandatangan tautan pemulihan tidak valid.");
  const others: Buffer[] = [];
  const token = env.INTEGRATION_TOKEN_KEY;
  if (token) others.push(/^[0-9a-f]{64}$/i.test(token) ? Buffer.from(token, "hex") : Buffer.from(token, "base64"));
  for (const entry of [...(env.KEYRING_BUYER_FINGERPRINT?.split(",") ?? []), ...(env.KEYRING_SHIPPING_CREDENTIALS?.split(",") ?? [])]) others.push(Buffer.from(entry.slice(entry.indexOf(":") + 1), "base64"));
  if (ring.some((k) => others.some((o) => o.length === k.key.length && timingSafeEqual(o, k.key)))) throw new DomainError("resume_key_unavailable", "Kunci penandatangan tautan pemulihan tidak boleh sama dengan kunci lain.");
  return ring;
}

const signature = (key: ResumeKey, storeId: number, publicId: string, exp: number) =>
  createHmac("sha256", key.key).update(`${RESUME_PURPOSE}\0${key.keyId}\0${storeId}\0${publicId}\0${exp}`).digest("base64url");

/** `v1.<key_id>.<store_id>.<public_id>.<expiry, unix seconds>.<HMAC>`: bound to the store and the one session, never carrying the session's primary key or any buyer data. */
export function signResumeToken(storeId: number, publicId: string, now: Date, env: NodeJS.ProcessEnv = process.env): { token: string; expiresAt: Date } {
  const key = resumeKeyring(env)[0]!;
  const exp = Math.floor(now.getTime() / 1000) + RESUME_LINK_DAYS * 86_400;
  return { token: `v1.${key.keyId}.${storeId}.${publicId}.${exp}.${signature(key, storeId, publicId, exp)}`, expiresAt: new Date(exp * 1000) };
}

export type ResumeToken = { storeId: number; publicId: string; expiresAt: Date };
export type ResumeTokenFailure = "malformed" | "unknown_key" | "signature" | "expired";
/** Verify format, key id, HMAC (constant time) and expiry, in that order. No database access: a forged or stale link costs nothing. */
export function verifyResumeToken(token: string, now: Date, env: NodeJS.ProcessEnv = process.env): { ok: true; value: ResumeToken } | { ok: false; reason: ResumeTokenFailure } {
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== "v1") return { ok: false, reason: "malformed" };
  const [, keyId, storeRaw, publicId, expRaw, sig] = parts as [string, string, string, string, string, string];
  const storeId = Number(storeRaw);
  const exp = Number(expRaw);
  if (!/^[1-9][0-9]{0,15}$/.test(storeRaw) || !Number.isSafeInteger(storeId) || !/^[1-9][0-9]{0,11}$/.test(expRaw) || !z.uuid().safeParse(publicId).success || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return { ok: false, reason: "malformed" };
  let key: ResumeKey | undefined;
  try {
    key = resumeKeyring(env).find((k) => k.keyId === keyId);
  } catch {
    return { ok: false, reason: "unknown_key" }; // no usable ring: nothing verifies (fail closed)
  }
  if (!key) return { ok: false, reason: "unknown_key" };
  const expected = Buffer.from(signature(key, storeId, publicId, exp));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "signature" };
  if (exp * 1000 <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, value: { storeId, publicId, expiresAt: new Date(exp * 1000) } };
}

// ── Capture (hosted checkout, buyer side) ──────────────────────────────────────────────

const typed = (max: number) => z.string().max(2000).optional().default("").transform((s) => s.trim().slice(0, max));
/** Exactly the four contact fields the checkout form has; nothing else crosses the boundary (price, store and cart never come from the client). */
const captureInput = z.strictObject({ buyerName: typed(120), buyerPhone: typed(40), buyerEmail: typed(254), shippingAddress: typed(500) });

export type CaptureResult = { saved: boolean };

/**
 * Debounced progress from the hosted checkout. The cart is the buyer's capability (its cookie), the store is resolved from it, and the
 * subtotal is recomputed from the cart rows. A phone number or e-mail that is not valid yet (the buyer is still typing) is stored as
 * NULL; a form that is entirely empty creates nothing (only a field the buyer typed is ever stored). A recovered session is never touched,
 * an abandoned one returns to `active` (a returning buyer). Over the rate budget the capture is dropped, never raised.
 */
export async function captureCheckoutSession(exec: Executor, cartId: string | undefined, raw: unknown, ctx: { clientIp?: string | undefined } = {}): Promise<CaptureResult> {
  const input = captureInput.parse(raw);
  if (!cartId || !z.uuid().safeParse(cartId).success) return { saved: false };
  const storeId = await resolveCartStore(exec, cartId);
  if (!storeId) return { saved: false };
  try {
    await enforceLimits(exec, [{ key: `capture:cart:${cartId}`, rule: CAPTURE_LIMITS.cart }, ...(ctx.clientIp ? [{ key: `capture:ip:${ctx.clientIp}`, rule: CAPTURE_LIMITS.ip }] : [])]);
  } catch (err) {
    if (err instanceof DomainError && err.code === "rate_limited") return { saved: false };
    throw err;
  }
  const contact = {
    buyerName: input.buyerName || null,
    buyerPhone: phoneLookupKey(input.buyerPhone) !== null ? input.buyerPhone : null,
    buyerEmail: normalizeEmail(input.buyerEmail),
    shippingAddress: input.shippingAddress || null,
  };
  const empty = Object.values(contact).every((v) => v === null);
  return withStore(exec, storeId, async (tx) => {
    const [s] = await tx.select({ status: store.status }).from(store).where(eq(store.id, storeId));
    if (s?.status !== "active") return { saved: false };
    // A checked-out cart (an order references it) has no lines left and is the recovered session's business, not a capture's.
    const [taken] = await tx.select({ id: order.id }).from(order).where(and(eq(order.storeId, storeId), eq(order.cartId, cartId))).limit(1);
    if (taken) return { saved: false };
    const [{ subtotal, lines } = { subtotal: 0, lines: 0 }] = await tx
      .select({ subtotal: sql<number>`coalesce(sum(${variant.price} * ${cartLine.quantity}), 0)::bigint`.mapWith(Number), lines: sql<number>`count(*)`.mapWith(Number) })
      .from(cartLine)
      .innerJoin(variant, and(eq(variant.storeId, cartLine.storeId), eq(variant.id, cartLine.variantId)))
      .where(and(eq(cartLine.storeId, storeId), eq(cartLine.cartId, cartId)));
    if (lines === 0) return { saved: false };
    const [existing] = await tx.select({ id: checkoutSession.id }).from(checkoutSession).where(and(eq(checkoutSession.storeId, storeId), eq(checkoutSession.cartId, cartId)));
    if (!existing && empty) return { saved: false };
    const saved = await tx
      .insert(checkoutSession)
      .values({ storeId, cartId, ...contact, subtotalIdr: subtotal })
      .onConflictDoUpdate({
        target: [checkoutSession.storeId, checkoutSession.cartId],
        set: { ...contact, subtotalIdr: subtotal, updatedAt: sql`clock_timestamp()`, status: sql`case when ${checkoutSession.status} = 'abandoned' then 'active' else ${checkoutSession.status} end` },
        setWhere: sql`${checkoutSession.status} <> 'recovered'`,
      })
      .returning({ id: checkoutSession.id });
    return { saved: saved.length > 0 };
  });
}

// ── Sweep and purge (cleanup.ts, platform pool) ────────────────────────────────────────

/**
 * Cross-store maintenance on the platform pool: `active` sessions idle for 60 minutes become `abandoned` (the trigger stamps `abandoned_at`
 * and refuses an earlier sweep), then sessions created more than 30 days ago are deleted. Idempotent; a second run changes nothing.
 */
export async function sweepCheckoutSessions(exec: Executor): Promise<{ abandoned: number; purged: number }> {
  const abandoned = await exec
    .update(checkoutSession)
    .set({ status: "abandoned" })
    .where(and(eq(checkoutSession.status, "active"), lte(checkoutSession.updatedAt, sql`now() - ${CHECKOUT_SESSION_IDLE_MINUTES} * interval '1 minute'`)))
    .returning({ id: checkoutSession.id });
  const purged = await exec
    .delete(checkoutSession)
    .where(lt(checkoutSession.createdAt, sql`now() - ${CHECKOUT_SESSION_PURGE_DAYS} * interval '1 day'`))
    .returning({ id: checkoutSession.id });
  return { abandoned: abandoned.length, purged: purged.length };
}

// ── Seller Admin (SC-26) ───────────────────────────────────────────────────────────────

export type AbandonedCart = {
  id: number;
  buyerName: string | null;
  buyerPhone: string | null;
  buyerEmail: string | null;
  subtotalIdr: number;
  abandonedAt: Date;
  lastActivityAt: Date;
  waOpenedAt: Date | null;
  hasPhone: boolean;
  score: number;
  items: { title: string; variant: string; quantity: number }[];
};
export type AbandonedCartsView = { counts: RateInputs; rates: Rates; sinceDays: number; queue: AbandonedCart[]; truncated: boolean };

/** Rates and the ranked queue of this store only (RLS). Read-only: allowed while the subscription is unpaid. */
export async function getAbandonedCarts(scope: SellerScope, now: Date = new Date()): Promise<AbandonedCartsView> {
  requireCap(scope, "carts.read");
  const since = new Date(now.getTime() - ABANDON_WINDOW_DAYS * 86_400_000);
  return inStore(scope, async ({ exec: tx, storeId }) => {
    const [c] = await tx
      .select({
        abandoned: sql<number>`count(*) filter (where ${checkoutSession.status} = 'abandoned')`.mapWith(Number),
        rescued: sql<number>`count(*) filter (where ${checkoutSession.abandonedAt} is not null and ${checkoutSession.recoveredAt} is not null)`.mapWith(Number),
      })
      .from(checkoutSession)
      .where(and(eq(checkoutSession.storeId, storeId), sql`${checkoutSession.createdAt} >= ${since.toISOString()}::timestamptz`));
    const [o] = await tx
      .select({ orders: sql<number>`count(*)`.mapWith(Number) })
      .from(order)
      .where(and(eq(order.storeId, storeId), sql`${order.createdAt} >= ${since.toISOString()}::timestamptz`));
    const counts: RateInputs = { abandoned: c?.abandoned ?? 0, rescued: c?.rescued ?? 0, orders: o?.orders ?? 0 };
    const rows = await tx
      .select({
        id: checkoutSession.id,
        cartId: checkoutSession.cartId,
        buyerName: checkoutSession.buyerName,
        buyerPhone: checkoutSession.buyerPhone,
        buyerEmail: checkoutSession.buyerEmail,
        subtotalIdr: checkoutSession.subtotalIdr,
        abandonedAt: checkoutSession.abandonedAt,
        updatedAt: checkoutSession.updatedAt,
        waOpenedAt: checkoutSession.waOpenedAt,
      })
      .from(checkoutSession)
      .where(and(eq(checkoutSession.storeId, storeId), eq(checkoutSession.status, "abandoned")))
      .orderBy(desc(checkoutSession.updatedAt))
      .limit(500);
    const everyone = rankAbandoned(rows, now);
    const ranked = everyone.slice(0, QUEUE_LIMIT);
    const lines = ranked.length
      ? await tx
          .select({ cartId: cartLine.cartId, title: product.title, variant: variant.title, quantity: cartLine.quantity })
          .from(cartLine)
          .innerJoin(variant, and(eq(variant.storeId, cartLine.storeId), eq(variant.id, cartLine.variantId)))
          .innerJoin(product, and(eq(product.storeId, variant.storeId), eq(product.id, variant.productId)))
          .where(and(eq(cartLine.storeId, storeId), inArray(cartLine.cartId, ranked.map((r) => r.cartId))))
          .orderBy(variant.id)
      : [];
    return {
      counts,
      rates: abandonRates(counts),
      sinceDays: ABANDON_WINDOW_DAYS,
      truncated: everyone.length > QUEUE_LIMIT || rows.length >= 500,
      queue: ranked.map(({ cartId, abandonedAt, updatedAt, ...r }) => ({
        ...r,
        abandonedAt: abandonedAt!,
        lastActivityAt: updatedAt,
        items: lines.filter((l) => l.cartId === cartId).map(({ cartId: _c, ...l }) => l),
      })),
    };
  });
}

/** Seller-facing copy (Indonesian). No promise of delivery or of stock: the link only reopens the saved cart. */
export function recoveryMessage(input: { storeName: string; buyerName: string | null; resumeUrl: string }): string {
  const first = (input.buyerName ?? "").trim().split(/\s+/)[0] ?? "";
  const who = /^\p{L}[\p{L}'-]{1,29}$/u.test(first) /* no dot: `bit.ly` would become a link in WhatsApp (wave 5 review) */ ? first : "Kak";
  return `Halo ${who}, kami dari ${input.storeName}. Keranjang belanja Anda masih tersimpan. Kalau masih berminat, lanjutkan checkout lewat tautan ini (berlaku ${RESUME_LINK_DAYS} hari): ${input.resumeUrl}`;
}

/**
 * "WA dibuka": stamp the click and return the `wa.me` URL with the prefilled message and a freshly signed resume link. Only an abandoned session
 * of this store with a usable phone number can be opened; the stamp says the seller opened WhatsApp, never that anything was sent or read.
 */
export async function openWhatsAppRecovery(scope: SellerScope, sessionId: number, opts: { origin: string; now?: Date }): Promise<{ url: string; resumeUrl: string; expiresAt: Date }> {
  requireCap(scope, "carts.recover");
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) throw new DomainError("not_found", "Keranjang tidak ditemukan.");
  const now = opts.now ?? new Date();
  return inStore(scope, async ({ exec: tx, storeId, storeName }) => {
    const [row] = await tx
      .select({ publicId: checkoutSession.publicId, status: checkoutSession.status, buyerName: checkoutSession.buyerName, buyerPhone: checkoutSession.buyerPhone })
      .from(checkoutSession)
      .where(and(eq(checkoutSession.storeId, storeId), eq(checkoutSession.id, sessionId)))
      .for("update");
    if (!row) throw new DomainError("not_found", "Keranjang tidak ditemukan.");
    if (row.status !== "abandoned") throw new DomainError("not_actionable", "Pembeli ini sudah kembali ke checkout atau menyelesaikan pesanan. Muat ulang daftar.");
    const phone = recoveryPhoneKey(row.buyerPhone);
    if (!phone) throw new DomainError("no_phone", "Pembeli ini belum mengisi nomor HP yang valid, jadi tidak bisa dihubungi lewat WhatsApp.");
    const { token, expiresAt } = signResumeToken(storeId, row.publicId, now);
    await tx.update(checkoutSession).set({ waOpenedAt: sql`clock_timestamp()` }).where(and(eq(checkoutSession.storeId, storeId), eq(checkoutSession.id, sessionId), eq(checkoutSession.status, "abandoned")));
    const resumeUrl = `${opts.origin.replace(/\/+$/, "")}/checkout/r/${token}`;
    return { url: `https://wa.me/${phone}?text=${encodeURIComponent(recoveryMessage({ storeName, buyerName: row.buyerName, resumeUrl }))}`, resumeUrl, expiresAt };
  });
}

// ── Resume (hosted checkout, buyer side) ───────────────────────────────────────────────

export type ResumeOutcome = { ok: true; storeId: number; storeSlug: string; cartId: string } | { ok: false; reason: ResumeTokenFailure | "unknown_session" | "recovered" | "cart_gone" | "store_unavailable" | "rate_limited" };

/**
 * Redeem a resume link: verify it, find the one session it names inside ITS store (so a session of another store never matches, even with a valid
 * signature over the wrong pair), and return the cart to bind to the buyer's cookie. Repeated redemption is harmless (it only rebinds the cart,
 * and shows no buyer data); a recovered session, an expired or tampered link, a purged session or an emptied cart resolve to the same dead end.
 */
export async function resumeCheckout(exec: Executor, token: string, opts: { now?: Date; clientIp?: string | undefined } = {}): Promise<ResumeOutcome> {
  if (opts.clientIp) {
    try {
      await enforceLimits(exec, [{ key: `resume:ip:${opts.clientIp}`, rule: RESUME_LIMIT }]);
    } catch (err) {
      if (err instanceof DomainError && err.code === "rate_limited") return { ok: false, reason: "rate_limited" };
      throw err;
    }
  }
  const v = verifyResumeToken(token, opts.now ?? new Date());
  if (!v.ok) return v;
  const { storeId, publicId } = v.value;
  return withStore(exec, storeId, async (tx) => {
    const [row] = await tx
      .select({ cartId: checkoutSession.cartId, status: checkoutSession.status, storeSlug: store.slug, storeStatus: store.status })
      .from(checkoutSession)
      .innerJoin(store, eq(store.id, checkoutSession.storeId))
      .where(and(eq(checkoutSession.storeId, storeId), eq(checkoutSession.publicId, publicId)));
    if (!row) return { ok: false, reason: "unknown_session" } as const;
    if (row.status === "recovered") return { ok: false, reason: "recovered" } as const;
    if (row.storeStatus !== "active") return { ok: false, reason: "store_unavailable" } as const;
    const [taken] = await tx.select({ id: order.id }).from(order).where(and(eq(order.storeId, storeId), eq(order.cartId, row.cartId))).limit(1);
    const [line] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(cartLine).where(and(eq(cartLine.storeId, storeId), eq(cartLine.cartId, row.cartId)));
    if (taken || !line || line.n === 0) return { ok: false, reason: "cart_gone" } as const;
    return { ok: true, storeId, storeSlug: row.storeSlug, cartId: row.cartId } as const;
  });
}
