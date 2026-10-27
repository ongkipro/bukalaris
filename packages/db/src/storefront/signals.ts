import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../client.ts";
import { enqueue, MAX_ATTEMPTS, registerHandler } from "../ops/jobs/jobs.ts";
import {
  order,
  orderLine,
  orderSignalContext,
  SIGNAL_PROVIDERS,
  signalDestination,
  signalEvent,
  variant,
  type SignalProvider,
  type SignalStatus,
} from "../schema.ts";
import { DomainError, requireCap, type SellerScope, type StorefrontScope } from "../platform/scoped.ts";
import { inStore, withStore } from "../platform/tenant.ts";
export { SIGNAL_PROVIDERS, SIGNAL_STATUSES, type SignalProvider, type SignalStatus } from "../schema.ts";

// Ad conversion signals (T-38, PR-20 "signal contract"). Per store × destination
// (meta, tiktok, google): pixel id, server token sealed with AES-256-GCM, test-event
// code, enabled flag. Browser and server legs share one `event_id`; the server leg is a
// `signal_event` row per destination plus one outbox job (T-32) delivered by the worker.
// Purchase: COD at order creation, prepaid when the payment settles (`pay`). Value is
// the goods subtotal in IDR (shipping margin is not ad revenue); content ids are the
// immutable variant catalog ids (D-8) with the product catalog id as group.
//
// Provider contracts below follow the official documentation read on 2026-10-07 and are
// UNVERIFIED until the owner approves a test-event call (docs/tracks/signals.md).

export const SIGNAL_EVENTS = ["ViewContent", "AddToCart", "InitiateCheckout", "Purchase"] as const;
export type SignalEventName = (typeof SIGNAL_EVENTS)[number];
/** Funnel events the browser may report to `/api/signals`; Purchase is server-issued only. */
export const FUNNEL_EVENTS = ["ViewContent", "AddToCart", "InitiateCheckout"] as const;
export const SIGNAL_DELIVER = "signal.deliver";
export const CURRENCY = "IDR";
/** First-party cookie written by the pixel runtime on landing (click ids + utm, last ad click wins). */
export const CLICK_COOKIE = "bl_click";
export const CONTEXT_RETENTION_DAYS = 30;
export const purchaseEventId = (orderId: number) => `purchase:${orderId}`;

// Pinned provider API versions. Verified against the vendor changelogs on 2026-10-07; a bump is a one-line change.
export const META_GRAPH_API_VERSION = "v26.0"; // https://developers.facebook.com/docs/graph-api/changelog (v26.0 released 2026-07-29)
export const TIKTOK_MARKETING_API_VERSION = "v1.3"; // Events API 2.0 docs URL still carries v1.3 (skill provenance 2026-10-02)
const META_EVENTS_URL = (pixelId: string) => `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pixelId}/events`;
const TIKTOK_EVENTS_URL = `https://business-api.tiktok.com/open_api/${TIKTOK_MARKETING_API_VERSION}/event/track/`;
/** Meta rejects any event older than 7 days; such a row is a permanent failure, not a retry. */
const MAX_EVENT_AGE_S = 7 * 24 * 3600;

// ── Token sealing (SEC-11) ──────────────────────────────────────────────────
// AES-256-GCM, key from INTEGRATION_TOKEN_KEY (32 bytes, base64 or hex). The AAD binds a
// ciphertext to its store+provider row, so a token copied onto another row cannot be opened.

export const TOKEN_KEY_ENV = "INTEGRATION_TOKEN_KEY";
export function tokenKey(raw = process.env[TOKEN_KEY_ENV]): Buffer {
  if (!raw) throw new DomainError("no_token_key", `${TOKEN_KEY_ENV} belum diatur di server.`);
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new DomainError("bad_token_key", `${TOKEN_KEY_ENV} harus 32 byte (base64 atau hex).`);
  return key;
}
const aad = (storeId: number, provider: string) => Buffer.from(`${storeId}:${provider}`);

export function sealToken(plain: string, storeId: number, provider: string, key = tokenKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(storeId, provider));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${ct.toString("base64")}.${cipher.getAuthTag().toString("base64")}`;
}

/** Throws `token_unreadable` on a wrong key, a tampered ciphertext or a row mismatch (AAD). */
export function openToken(sealed: string, storeId: number, provider: string, key = tokenKey()): string {
  const [v, iv, ct, tag] = sealed.split(".");
  if (v !== "v1" || !iv || !ct || !tag) throw new DomainError("token_unreadable", "Token tersimpan tidak terbaca.");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    d.setAAD(aad(storeId, provider));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new DomainError("token_unreadable", "Token tersimpan tidak terbaca.");
  }
}

// ── Normalization and hashing (PR-20 "Matching") ───────────────────────────

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Indonesian phone → country-code digits `62…` (Meta `ph`); null when it is not a usable number. */
export function phoneDigits62(raw: string): string | null {
  let d = raw.replace(/[^0-9]/g, "");
  if (d.startsWith("0")) d = `62${d.slice(1)}`;
  else if (d.startsWith("620")) d = `62${d.slice(3)}`;
  return /^[1-9][0-9]{7,14}$/.test(d) ? d : null;
}
/** `+62…` E.164 (TikTok `phone`, Google `phone_number`). */
export const phoneE164 = (raw: string) => {
  const d = phoneDigits62(raw);
  return d ? `+${d}` : null;
};
/** Meta/TikTok rule: trim + lowercase. Null unless it looks like a real address. */
export const normalizeEmail = (raw: string) => {
  const e = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};
/** First/last name as lowercase ASCII letters (Meta `fn`/`ln`); a single word is the first name only. */
export function nameParts(full: string): { fn: string | null; ln: string | null } {
  const words = full.trim().split(/\s+/).filter(Boolean);
  const clean = (w: string | undefined) => {
    const c = (w ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z]/g, "");
    return c || null;
  };
  return { fn: clean(words[0]), ln: words.length > 1 ? clean(words[words.length - 1]) : null };
}

// ── Payload shapes ─────────────────────────────────────────────────────────

export type SignalContent = { id: string; quantity: number; item_price: number };
/** Hashed buyer fields + raw click/browser identifiers; stripped by the cleanup command after 30 days. */
export type SignalUser = {
  ph62?: string; // sha256("62…")
  phE164?: string; // sha256("+62…")
  em?: string; // sha256(normalized email) — only when a real email is known (none at checkout today)
  fn?: string;
  ln?: string;
  fbp?: string;
  fbc?: string;
  ttclid?: string;
  ttp?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  ip?: string;
  ua?: string;
};
export type SignalPayload = {
  eventTime: number; // unix seconds
  value: number; // integer IDR, goods subtotal
  currency: typeof CURRENCY;
  contents: SignalContent[];
  contentIds: string[];
  /** Product catalog ids (group ids) for the contents, same order, deduplicated. */
  groupIds: string[];
  numItems: number;
  orderId?: string;
  url?: string;
  user?: SignalUser;
};

/** Strip empty strings/undefined so a provider never receives an empty match key. */
const compact = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<T>;

// ── Click context (first-party, last ad click wins) ────────────────────────

const token = (max: number) => z.string().trim().min(1).max(max).regex(/^[A-Za-z0-9_.:-]+$/);
const clickCookie = z.looseObject({
  fbclid: token(255).optional(),
  ttclid: token(255).optional(),
  gclid: token(255).optional(),
  gbraid: token(255).optional(),
  wbraid: token(255).optional(),
  utm: z.record(z.string().max(20), z.string().max(200)).optional(),
  t: z.number().int().positive().optional(),
});
export type ClickContext = z.infer<typeof clickCookie>;

/** Parse the `bl_click` cookie; anything malformed is ignored (it is browser input). */
export function parseClickCookie(raw: string | undefined): ClickContext | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const r = clickCookie.safeParse(JSON.parse(decodeURIComponent(raw)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Request-boundary facts the server leg needs; built by the web app from cookies/headers. */
export type RequestSignalContext = {
  cookies: Record<string, string | undefined>; // _fbp, _fbc, _ttp, bl_click
  clientIp?: string | undefined;
  userAgent?: string | undefined;
  url?: string | undefined;
};
const metaCookie = /^fb\.[0-2]\.[0-9]{1,16}\.[A-Za-z0-9_.:-]{1,255}$/;
const idCookie = (v: string | undefined, re: RegExp) => (v && re.test(v) ? v : undefined);

/** Raw identifiers from the request: Meta/TikTok cookies first, then the click cookie (with `_fbc` derived from `fbclid`). */
export function requestUser(ctx: RequestSignalContext): SignalUser {
  const click = parseClickCookie(ctx.cookies[CLICK_COOKIE]);
  const fbp = idCookie(ctx.cookies["_fbp"], metaCookie);
  const fbc = idCookie(ctx.cookies["_fbc"], metaCookie) ?? (click?.fbclid ? `fb.1.${click.t ?? Date.now()}.${click.fbclid}` : undefined);
  return compact({
    fbp,
    fbc,
    ttclid: click?.ttclid,
    ttp: idCookie(ctx.cookies["_ttp"], /^[A-Za-z0-9_.-]{1,128}$/),
    gclid: click?.gclid,
    gbraid: click?.gbraid,
    wbraid: click?.wbraid,
    ip: ctx.clientIp,
    ua: ctx.userAgent?.slice(0, 512),
  });
}

// ── Destinations (seller settings) ─────────────────────────────────────────

const PIXEL_ID_RULES: Record<SignalProvider, { re: RegExp; hint: string }> = {
  meta: { re: /^[0-9]{5,20}$/, hint: "Pixel ID Meta berupa 5–20 digit angka." },
  tiktok: { re: /^[A-Z0-9]{10,40}$/, hint: "Pixel Code TikTok berupa 10–40 huruf besar/angka." },
  google: { re: /^AW-[0-9]{6,15}$/, hint: "Google tag ID berformat AW-1234567890." },
};
export const destinationInput = z.strictObject({
  pixelId: z.string().trim().min(1, "Isi pixel/tag ID.").max(40),
  conversionLabel: z.string().trim().max(60).optional(),
  token: z.string().trim().max(512).optional(),
  testEventCode: z.string().trim().max(40).regex(/^[A-Za-z0-9_-]*$/, "Kode test event hanya huruf, angka, - dan _.").optional(),
  enabled: z.boolean(),
});
export type DestinationInput = z.input<typeof destinationInput>;
export const providerInput = z.enum(SIGNAL_PROVIDERS);

export type DestinationView = {
  provider: SignalProvider;
  pixelId: string;
  conversionLabel: string | null;
  hasToken: boolean;
  tokenSetAt: Date | null;
  testEventCode: string | null;
  enabled: boolean;
  updatedAt: Date;
};

/** The store's destinations without any secret (the token is write-only). */
export async function listDestinations(scope: SellerScope): Promise<DestinationView[]> {
  requireCap(scope, "marketing.manage");
  return inStore(scope, async (scope) => {
    const rows = await scope.exec.select().from(signalDestination).where(eq(signalDestination.storeId, scope.storeId));
    return rows.map(({ tokenCiphertext, ...d }) => ({
      provider: d.provider,
      pixelId: d.pixelId,
      conversionLabel: d.conversionLabel,
      hasToken: tokenCiphertext !== null,
      tokenSetAt: d.tokenSetAt,
      testEventCode: d.testEventCode,
      enabled: d.enabled,
      updatedAt: d.updatedAt,
    }));
  });
}

/**
 * Create or update one destination. A blank `token` keeps the stored one; a new token is
 * sealed before it touches the database and is never returned. Google has no server leg
 * here (its offline-conversion upload is an open issue), so its token is ignored.
 */
export async function saveDestination(scope: SellerScope, providerRaw: unknown, raw: unknown): Promise<void> {
  requireCap(scope, "marketing.manage");
  return inStore(scope, async (scope) => {
    const provider = providerInput.parse(providerRaw);
    const input = destinationInput.parse(raw);
    const rule = PIXEL_ID_RULES[provider];
    if (!rule.re.test(input.pixelId)) throw new DomainError("pixel_id", rule.hint);
    const conversionLabel = provider === "google" ? input.conversionLabel || null : null;
    if (provider === "google" && conversionLabel && !/^[A-Za-z0-9_-]{4,60}$/.test(conversionLabel))
      throw new DomainError("conversion_label", "Label konversi Google hanya huruf, angka, - dan _.");
    const token = provider !== "google" && input.token ? input.token : null;
    const sealed = token ? sealToken(token, scope.storeId, provider) : null;
    const base = { pixelId: input.pixelId, conversionLabel, testEventCode: input.testEventCode || null, enabled: input.enabled, updatedAt: sql`now()` };
    await scope.exec
      .insert(signalDestination)
      .values({ storeId: scope.storeId, provider, ...base, updatedAt: undefined, tokenCiphertext: sealed, tokenSetAt: sealed ? sql`now()` : null })
      .onConflictDoUpdate({
        target: [signalDestination.storeId, signalDestination.provider],
        set: sealed ? { ...base, tokenCiphertext: sealed, tokenSetAt: sql`now()` } : base,
      });
  });
}

/** Forget the stored server token (the browser pixel keeps working). */
export async function clearDestinationToken(scope: SellerScope, providerRaw: unknown): Promise<void> {
  requireCap(scope, "marketing.manage");
  return inStore(scope, async (scope) => {
    const provider = providerInput.parse(providerRaw);
    await scope.exec
      .update(signalDestination)
      .set({ tokenCiphertext: null, tokenSetAt: null, updatedAt: sql`now()` })
      .where(and(eq(signalDestination.storeId, scope.storeId), eq(signalDestination.provider, provider)));
  });
}

/** What the browser needs: enabled destinations' public ids only. Never a token or test code. */
export type BrowserSignals = { meta?: { pixelId: string }; tiktok?: { pixelId: string }; google?: { tagId: string; label: string | null } };
export async function browserSignals(exec: Executor, storeId: number): Promise<BrowserSignals | null> {
  // `storeId` is server-derived (a resolved scope or the buyer's own order), never browser input.
  const rows = await withStore(exec, storeId, (tx) =>
    tx
      .select({ provider: signalDestination.provider, pixelId: signalDestination.pixelId, label: signalDestination.conversionLabel })
      .from(signalDestination)
      .where(and(eq(signalDestination.storeId, storeId), eq(signalDestination.enabled, true))),
  );
  if (rows.length === 0) return null;
  const out: BrowserSignals = {};
  for (const r of rows) {
    if (r.provider === "google") out.google = { tagId: r.pixelId, label: r.label };
    else out[r.provider] = { pixelId: r.pixelId };
  }
  return out;
}

// ── Enqueue (same transaction as the business write) ───────────────────────

/** Destinations with a server leg: enabled, with a token, not Google (browser-only here). */
async function serverDestinations(exec: Executor, storeId: number) {
  return exec
    .select({ provider: signalDestination.provider })
    .from(signalDestination)
    .where(and(eq(signalDestination.storeId, storeId), eq(signalDestination.enabled, true), sql`${signalDestination.tokenCiphertext} is not null`, sql`${signalDestination.provider} <> 'google'`));
}

/**
 * One `signal_event` + one outbox job per server destination. The unique
 * (store, provider, event_id) makes a repeat a no-op, so a replayed checkout or a second
 * "mark paid" never yields a second Purchase. Returns the number of rows created.
 */
export async function enqueueSignal(
  tx: Executor,
  input: { storeId: number; eventId: string; eventName: SignalEventName; orderId?: number; payload: SignalPayload },
): Promise<number> {
  const dests = await serverDestinations(tx, input.storeId);
  let created = 0;
  for (const { provider } of dests) {
    const [row] = await tx
      .insert(signalEvent)
      .values({ storeId: input.storeId, provider, eventId: input.eventId, eventName: input.eventName, orderId: input.orderId ?? null, payload: input.payload })
      .onConflictDoNothing({ target: [signalEvent.storeId, signalEvent.provider, signalEvent.eventId] })
      .returning({ id: signalEvent.id });
    if (!row) continue;
    await enqueue(tx, { kind: SIGNAL_DELIVER, storeId: input.storeId, key: `signal_event:${row.id}`, payload: { signalEventId: row.id } });
    created++;
  }
  return created;
}

/** Purchase payload from the order row, its lines and the stored click context. Value = goods subtotal (no shipping). */
export async function purchasePayload(exec: Executor, storeId: number, orderId: number): Promise<SignalPayload | null> {
  const [o] = await exec
    .select({ id: order.id, subtotal: order.subtotal, buyerName: order.buyerName, buyerPhone: order.buyerPhone })
    .from(order)
    .where(and(eq(order.storeId, storeId), eq(order.id, orderId)));
  if (!o) return null;
  const lines = await exec
    .select({ id: orderLine.variantCatalogId, quantity: orderLine.quantity, item_price: orderLine.unitPrice, variantId: orderLine.variantId })
    .from(orderLine)
    .where(and(eq(orderLine.storeId, storeId), eq(orderLine.orderId, orderId)));
  const [ctx] = await exec.select().from(orderSignalContext).where(and(eq(orderSignalContext.storeId, storeId), eq(orderSignalContext.orderId, orderId)));
  const ph62 = phoneDigits62(o.buyerPhone);
  const { fn, ln } = nameParts(o.buyerName);
  const user: SignalUser = compact({
    ph62: ph62 ? sha256(ph62) : undefined,
    phE164: ph62 ? sha256(`+${ph62}`) : undefined,
    fn: fn ? sha256(fn) : undefined,
    ln: ln ? sha256(ln) : undefined,
    fbp: ctx?.fbp ?? undefined,
    fbc: ctx?.fbc ?? undefined,
    ttclid: ctx?.ttclid ?? undefined,
    ttp: ctx?.ttp ?? undefined,
    gclid: ctx?.gclid ?? undefined,
    gbraid: ctx?.gbraid ?? undefined,
    wbraid: ctx?.wbraid ?? undefined,
    ip: ctx?.clientIp ?? undefined,
    ua: ctx?.userAgent ?? undefined,
  });
  const contents = lines.map(({ variantId: _v, ...c }) => c);
  return {
    eventTime: Math.floor(Date.now() / 1000),
    value: o.subtotal,
    currency: CURRENCY,
    contents,
    contentIds: contents.map((c) => c.id),
    groupIds: await groupIdsFor(exec, storeId, lines.map((l) => l.variantId)),
    numItems: contents.reduce((n, c) => n + c.quantity, 0),
    orderId: String(o.id),
    user,
  };
}

/** Variant catalog ids (content ids) for variants of this store, in input order; unknown ids are skipped. */
export async function variantCatalogIds(scope: StorefrontScope, variantIds: number[]): Promise<string[]> {
  return inStore(scope, async (scope) => {
    if (variantIds.length === 0) return [];
    const rows = await scope.exec
      .select({ id: variant.id, catalogId: variant.catalogId })
      .from(variant)
      .where(and(eq(variant.storeId, scope.storeId), inArray(variant.id, variantIds)));
    const by = new Map(rows.map((r) => [r.id, r.catalogId]));
    return variantIds.map((v) => by.get(v)).filter((c): c is string => !!c);
  });
}

/** Product catalog ids (group ids) for variants of this store, deduplicated and ordered by input. */
async function groupIdsFor(exec: Executor, storeId: number, variantIds: number[]): Promise<string[]> {
  if (variantIds.length === 0) return [];
  const rows = await exec
    .select({ variantId: variant.id, groupId: sql<string>`(select p.catalog_id::text from product p where p.id = ${variant.productId})` })
    .from(variant)
    .where(and(eq(variant.storeId, storeId), inArray(variant.id, variantIds)));
  const byVariant = new Map(rows.map((r) => [r.variantId, r.groupId]));
  return [...new Set(variantIds.map((v) => byVariant.get(v)).filter((g): g is string => !!g))];
}

/**
 * Hook for `placeOrder` (same transaction): store the request's click context with the
 * order and, for COD, enqueue the Purchase now (PR-20: COD purchase = order creation).
 * Prepaid orders enqueue in `enqueuePurchase` when the payment settles.
 */
export async function recordOrderSignals(
  tx: Executor,
  input: { storeId: number; orderId: number; paymentMethod: "cod" | "manual_transfer"; request?: RequestSignalContext | undefined },
): Promise<void> {
  if (input.request) {
    const u = requestUser(input.request);
    const click = parseClickCookie(input.request.cookies[CLICK_COOKIE]);
    if (Object.keys(u).length > 0 || click?.utm) {
      await tx
        .insert(orderSignalContext)
        .values({
          storeId: input.storeId,
          orderId: input.orderId,
          fbp: u.fbp ?? null,
          fbc: u.fbc ?? null,
          ttclid: u.ttclid ?? null,
          ttp: u.ttp ?? null,
          gclid: u.gclid ?? null,
          gbraid: u.gbraid ?? null,
          wbraid: u.wbraid ?? null,
          utm: click?.utm ?? null,
          clientIp: u.ip ?? null,
          userAgent: u.ua ?? null,
        })
        .onConflictDoNothing();
    }
  }
  if (input.paymentMethod === "cod") await enqueuePurchase(tx, input.storeId, input.orderId);
}

/** Server Purchase for an order (COD at creation, prepaid at settlement). Idempotent per destination. */
export async function enqueuePurchase(tx: Executor, storeId: number, orderId: number): Promise<number> {
  const payload = await purchasePayload(tx, storeId, orderId);
  if (!payload) return 0;
  return enqueueSignal(tx, { storeId, eventId: purchaseEventId(orderId), eventName: "Purchase", orderId, payload });
}

// ── Funnel events reported by the browser ──────────────────────────────────

export const funnelInput = z.strictObject({
  event: z.enum(FUNNEL_EVENTS),
  // Client-minted uuid, or the server-issued `checkout:<cart uuid>` (one InitiateCheckout per cart).
  eventId: z.string().regex(/^(checkout:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  items: z.array(z.strictObject({ id: z.string().regex(/^[0-9]{5,18}$/), quantity: z.number().int().min(1).max(99) })).min(1).max(30),
  url: z.string().max(2048).optional(),
});
export type FunnelInput = z.input<typeof funnelInput>;

/**
 * Server leg of a browser funnel event: the browser sends the shared `event_id` and the
 * variant catalog ids; price (and therefore value) is re-read from this store's catalog,
 * so a client cannot inflate the value. Unknown ids are dropped; no known id → nothing.
 */
export async function collectFunnelEvent(scope: StorefrontScope, raw: unknown, request: RequestSignalContext): Promise<number> {
  return inStore(scope, async (scope) => {
    const input = funnelInput.parse(raw);
    const ids = [...new Set(input.items.map((i) => i.id))];
    const rows = await scope.exec
      .select({ id: variant.catalogId, price: variant.price, variantId: variant.id })
      .from(variant)
      .where(and(eq(variant.storeId, scope.storeId), inArray(variant.catalogId, ids)));
    const price = new Map(rows.map((r) => [r.id, r]));
    const contents: SignalContent[] = input.items.filter((i) => price.has(i.id)).map((i) => ({ id: i.id, quantity: i.quantity, item_price: price.get(i.id)!.price }));
    if (contents.length === 0) return 0;
    const url = input.url && /^https?:\/\//.test(input.url) ? input.url : request.url;
    const payload: SignalPayload = {
      eventTime: Math.floor(Date.now() / 1000),
      value: contents.reduce((s, c) => s + c.item_price * c.quantity, 0),
      currency: CURRENCY,
      contents,
      contentIds: contents.map((c) => c.id),
      groupIds: await groupIdsFor(scope.exec, scope.storeId, contents.map((c) => price.get(c.id)!.variantId)),
      numItems: contents.reduce((n, c) => n + c.quantity, 0),
      ...(url ? { url } : {}),
      user: requestUser(request),
    };
    return inStore(scope, ({ exec: tx }) => enqueueSignal(tx, { storeId: scope.storeId, eventId: input.eventId, eventName: input.event, payload }));
  });
}

// ── Transport and provider adapters ────────────────────────────────────────

export type SignalRequest = { url: string; headers: Record<string, string>; body: unknown };
export type SignalResponse = { status: number; body: unknown };
export type SignalTransport = (req: SignalRequest) => Promise<SignalResponse>;
export type Outcome = { kind: "ok" } | { kind: "retry"; error: string } | { kind: "permanent"; error: string };
const TRANSPORT_TIMEOUT_MS = 10_000; // well below the 60 s job lease

/** Real HTTP. Only used when SIGNALS_LIVE=1 (owner approval of a test-event call). */
export const fetchTransport: SignalTransport = async (req) => {
  const res = await fetch(req.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...req.headers },
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(TRANSPORT_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
};

/** Status a delivery ends in when it succeeds (live vs simulated). */
export const liveMode = () => process.env.SIGNALS_LIVE === "1";

let transportOverride: SignalTransport | null = null;
/** Tests inject a fake transport here; `null` restores the default. */
export function setSignalTransport(t: SignalTransport | null): void {
  transportOverride = t;
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN);
const field = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);

/**
 * Meta Conversions API — https://developers.facebook.com/docs/marketing-api/conversions-api
 * (read 2026-10-07): POST /{version}/{pixel_id}/events, body `{ data: [event], test_event_code? }`,
 * `access_token` as documented (query parameter; the URL is never logged). `ph`/`fn`/`ln` are
 * SHA-256 of the normalized value; `fbp`/`fbc`/IP/UA are raw.
 */
export function metaRequest(d: { pixelId: string; token: string; testEventCode: string | null }, e: { eventName: string; eventId: string; payload: SignalPayload }): SignalRequest {
  const u = e.payload.user ?? {};
  const event = compact({
    event_name: e.eventName,
    event_time: e.payload.eventTime,
    event_id: e.eventId,
    action_source: "website",
    event_source_url: e.payload.url,
    user_data: compact({
      ph: u.ph62 ? [u.ph62] : undefined,
      em: u.em ? [u.em] : undefined,
      fn: u.fn ? [u.fn] : undefined,
      ln: u.ln ? [u.ln] : undefined,
      fbp: u.fbp,
      fbc: u.fbc,
      client_ip_address: u.ip,
      client_user_agent: u.ua,
    }),
    custom_data: compact({
      value: e.payload.value,
      currency: e.payload.currency,
      content_type: "product",
      content_ids: e.payload.contentIds,
      contents: e.payload.contents.map((c) => ({ id: c.id, quantity: c.quantity, item_price: c.item_price })),
      num_items: e.eventName === "InitiateCheckout" ? e.payload.numItems : undefined,
      order_id: e.payload.orderId,
    }),
  });
  return {
    url: `${META_EVENTS_URL(d.pixelId)}?access_token=${encodeURIComponent(d.token)}`,
    headers: {},
    body: { data: [event], ...(d.testEventCode ? { test_event_code: d.testEventCode } : {}) },
  };
}

/** Meta error codes: 4/17/32/613 = throttling (retry); 190 = token (permanent); other 4xx = permanent. */
export function metaOutcome(res: SignalResponse): Outcome {
  if (res.status >= 200 && res.status < 300) return { kind: "ok" };
  const err = field(res.body, "error");
  const code = num(field(err, "code"));
  const msg = `Meta HTTP ${res.status}${Number.isFinite(code) ? ` code ${code}` : ""}: ${String(field(err, "message") ?? "").slice(0, 200)}`;
  if (res.status >= 500 || res.status === 429 || [4, 17, 32, 613].includes(code)) return { kind: "retry", error: msg };
  return { kind: "permanent", error: msg };
}

/**
 * TikTok Events API 2.0 — https://business-api.tiktok.com/portal/docs/events-api-2.0
 * (JS-rendered; shape taken from the skill reference dated 2026-10-02): POST /open_api/{version}/event/track/,
 * header `Access-Token`, body `{ event_source: "web", event_source_id, test_event_code?, data: [...] }`.
 * `phone` is SHA-256 of `+E.164`; `ttclid`/`ttp`/IP/UA raw. Event names follow the May-2025 rename (Purchase).
 */
export function tiktokRequest(d: { pixelId: string; token: string; testEventCode: string | null }, e: { eventName: string; eventId: string; payload: SignalPayload }): SignalRequest {
  const u = e.payload.user ?? {};
  const event = compact({
    event: e.eventName,
    event_time: e.payload.eventTime,
    event_id: e.eventId,
    user: compact({ ttclid: u.ttclid, ttp: u.ttp, phone: u.phE164 ? [u.phE164] : undefined, email: u.em ? [u.em] : undefined, ip: u.ip, user_agent: u.ua }),
    properties: compact({
      contents: e.payload.contents.map((c) => ({ content_id: c.id, content_type: "product", quantity: c.quantity, price: c.item_price })),
      content_type: "product",
      currency: e.payload.currency,
      value: e.payload.value,
      order_id: e.payload.orderId,
    }),
    page: e.payload.url ? { url: e.payload.url } : undefined,
  });
  return {
    url: TIKTOK_EVENTS_URL,
    headers: { "Access-Token": d.token },
    body: { event_source: "web", event_source_id: d.pixelId, ...(d.testEventCode ? { test_event_code: d.testEventCode } : {}), data: [event] },
  };
}

/** TikTok: `code` 0 = accepted; HTTP 429/5xx retry; any other non-zero code is a request/auth problem (permanent). */
export function tiktokOutcome(res: SignalResponse): Outcome {
  const code = num(field(res.body, "code"));
  if (res.status >= 200 && res.status < 300 && code === 0) return { kind: "ok" };
  const msg = `TikTok HTTP ${res.status}${Number.isFinite(code) ? ` code ${code}` : ""}: ${String(field(res.body, "message") ?? "").slice(0, 200)}`;
  if (res.status >= 500 || res.status === 429) return { kind: "retry", error: msg };
  return { kind: "permanent", error: msg };
}

const ADAPTERS: Record<Exclude<SignalProvider, "google">, { request: typeof metaRequest; outcome: (r: SignalResponse) => Outcome }> = {
  meta: { request: metaRequest, outcome: metaOutcome },
  tiktok: { request: tiktokRequest, outcome: tiktokOutcome },
};

const jobPayload = z.object({ signalEventId: z.number().int().positive() });

async function finish(exec: Executor, id: number, status: SignalStatus, error: string | null) {
  await exec
    .update(signalEvent)
    .set({ status, lastError: error, sentAt: status === "sent" || status === "simulated" ? sql`now()` : null })
    .where(eq(signalEvent.id, id));
}

/**
 * Outbox handler: deliver one `signal_event` to its destination. Permanent failures
 * (disabled destination, unreadable token, provider 4xx, event older than 7 days) mark the
 * row `failed` and complete the job; transient ones record the error and rethrow so the
 * job retries with backoff. Without SIGNALS_LIVE=1 nothing leaves the process: the row is
 * marked `simulated`.
 */
registerHandler(SIGNAL_DELIVER, async ({ db }, j) => {
  const { signalEventId } = jobPayload.parse(j.payload);
  const [ev] = await db.select().from(signalEvent).where(and(eq(signalEvent.storeId, j.storeId), eq(signalEvent.id, signalEventId)));
  if (!ev || ev.status !== "pending") return;
  const [dest] = await db.select().from(signalDestination).where(and(eq(signalDestination.storeId, ev.storeId), eq(signalDestination.provider, ev.provider)));
  if (!dest || !dest.enabled || !dest.tokenCiphertext || ev.provider === "google") return finish(db, ev.id, "failed", "Tujuan dinonaktifkan atau token dihapus sebelum terkirim.");
  const payload = ev.payload as unknown as SignalPayload;
  if (Math.floor(Date.now() / 1000) - payload.eventTime > MAX_EVENT_AGE_S) return finish(db, ev.id, "failed", "Event lebih tua dari 7 hari; penyedia menolak event kedaluwarsa.");
  let token: string;
  try {
    token = openToken(dest.tokenCiphertext, dest.storeId, dest.provider);
  } catch (err) {
    return finish(db, ev.id, "failed", err instanceof Error ? err.message : "Token tidak terbaca.");
  }
  const adapter = ADAPTERS[ev.provider];
  const req = adapter.request({ pixelId: dest.pixelId, token, testEventCode: dest.testEventCode }, { eventName: ev.eventName, eventId: ev.eventId, payload });
  const transport = transportOverride ?? (liveMode() ? fetchTransport : null);
  if (!transport) return finish(db, ev.id, "simulated", null);
  let outcome: Outcome;
  try {
    outcome = adapter.outcome(await transport(req));
  } catch (err) {
    // Network/timeout: never include the request (it carries the token) in the message.
    outcome = { kind: "retry", error: `${ev.provider}: ${err instanceof Error ? err.name : "network error"}` };
  }
  if (outcome.kind === "ok") return finish(db, ev.id, "sent", null);
  if (outcome.kind === "permanent" || j.attempts >= MAX_ATTEMPTS) return finish(db, ev.id, "failed", outcome.error);
  await db.update(signalEvent).set({ lastError: outcome.error }).where(eq(signalEvent.id, ev.id));
  throw new Error(outcome.error);
});

// ── Health and retention ───────────────────────────────────────────────────

export type DestinationHealth = {
  provider: SignalProvider;
  pending: number;
  sent: number;
  simulated: number;
  failed: number;
  lastError: string | null;
  lastSentAt: Date | null;
};

/** Last 7 days per destination: counts by status, the latest error text and the latest acceptance. */
export async function destinationHealth(scope: SellerScope, days = 7): Promise<DestinationHealth[]> {
  requireCap(scope, "marketing.manage");
  return inStore(scope, async (scope) => {
    const since = sql`now() - ${days} * interval '1 day'`;
    const counts = await scope.exec
      .select({
        provider: signalEvent.provider,
        pending: sql<number>`count(*) filter (where ${signalEvent.status} = 'pending')`.mapWith(Number),
        sent: sql<number>`count(*) filter (where ${signalEvent.status} = 'sent')`.mapWith(Number),
        simulated: sql<number>`count(*) filter (where ${signalEvent.status} = 'simulated')`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${signalEvent.status} = 'failed')`.mapWith(Number),
        lastSentAt: sql<Date | null>`max(${signalEvent.sentAt})`,
      })
      .from(signalEvent)
      .where(and(eq(signalEvent.storeId, scope.storeId), gte(signalEvent.createdAt, since)))
      .groupBy(signalEvent.provider);
    const out: DestinationHealth[] = [];
    for (const c of counts) {
      const [err] = await scope.exec
        .select({ lastError: signalEvent.lastError })
        .from(signalEvent)
        .where(and(eq(signalEvent.storeId, scope.storeId), eq(signalEvent.provider, c.provider), gte(signalEvent.createdAt, since), sql`${signalEvent.lastError} is not null`))
        .orderBy(desc(signalEvent.id))
        .limit(1);
      out.push({ ...c, lastSentAt: c.lastSentAt ? new Date(c.lastSentAt) : null, lastError: err?.lastError ?? null });
    }
    return out;
  });
}

/**
 * Retention (PRIV-3, run by the cleanup command): drop click context older than 30 days
 * and strip the `user` block from older signal events. Returns affected row counts.
 */
export async function purgeSignalContext(exec: Executor, opts: { days?: number } = {}): Promise<{ contexts: number; events: number }> {
  const days = opts.days ?? CONTEXT_RETENTION_DAYS;
  if (!Number.isFinite(days) || days < 1) throw new DomainError("days", "days must be >= 1");
  const cutoff = sql`now() - ${days} * interval '1 day'`;
  const contexts = await exec.delete(orderSignalContext).where(lt(orderSignalContext.createdAt, cutoff)).returning({ id: orderSignalContext.orderId });
  const events = await exec
    .update(signalEvent)
    .set({ payload: sql`${signalEvent.payload} - 'user'` })
    .where(and(lt(signalEvent.createdAt, cutoff), sql`${signalEvent.payload} ? 'user'`))
    .returning({ id: signalEvent.id });
  return { contexts: contexts.length, events: events.length };
}
