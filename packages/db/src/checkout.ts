import { createHash } from "node:crypto";
import { and, asc, count, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "./client.ts";
import { enqueue, PAYMENT_INSTRUCTION } from "./jobs.ts";
import { MengantarError } from "./mengantar/client.ts";
import { type Providers, type ShippingAdapter } from "./providers.ts";
import { normalizePhone } from "./orders.ts";
import { recordOrderSignals, type RequestSignalContext } from "./signals.ts";
import { cart, cartLine, order, orderLine, product, rateLimit, store, storePickupArea, variant } from "./schema.ts";
import { DomainError, storefrontScope, type StorefrontScope } from "./scoped.ts";
import { defaultProviders, defaultShippingAdapter, shippingOptions, type CartForShipping } from "./shipping.ts";

// Hosted checkout (SF-07/SF-08). The client sends only contact, destination area,
// courier choice, payment method and an idempotency key; price, stock, fee and
// totals are derived from the database and the server-side shipping quote
// (provider cost + platform margin, T-34/Q-12). The store is derived from the
// cart (the buyer's capability), never from the request.

const areaId = z.string().regex(/^[a-f0-9]{24}$/, "Pilih area tujuan dari hasil pencarian.");

export const checkoutInput = z.strictObject({
  idempotencyKey: z.uuid(),
  buyerName: z.string().trim().min(2, "Nama wajib diisi.").max(120),
  buyerPhone: z.string().trim().regex(/^\+?[0-9]{8,15}$/, "Nomor HP 8–15 digit."),
  shippingAddress: z.string().trim().min(10, "Alamat terlalu pendek.").max(500),
  destinationAreaId: areaId,
  destinationAreaLabel: z.string().trim().min(3, "Pilih area tujuan dari hasil pencarian.").max(200),
  courier: z.string().min(1, "Pilih kurir.").max(40),
  paymentMethod: z.enum(["cod", "manual_transfer"]),
});
export type CheckoutInput = z.input<typeof checkoutInput>;

class Replay extends Error {}

// ── Abuse controls (T-30, SEC-16) ──────────────────────────────────────────
// Fixed-window counters in Postgres (one upsert per key, no extra service). The
// IP comes from the trusted proxy header (apps/web `clientIp()`); when none is
// present (dev, tests, misconfigured proxy) the IP dimension is skipped and the
// per-cart and per-phone keys carry the protection — a shared "unknown" bucket
// would throttle every buyer at once.

export type LimitRule = { limit: number; windowSec: number };
type Hit = { key: string; rule: LimitRule };
export const LIMITS = {
  /** Order submissions (any outcome after input validation). */
  orderIp: { limit: 60, windowSec: 600 },
  orderCart: { limit: 5, windowSec: 60 },
  orderPhone: { limit: 10, windowSec: 600 },
  /** Cart add/update actions. */
  cartIp: { limit: 300, windowSec: 600 },
  cartCart: { limit: 60, windowSec: 600 },
} as const satisfies Record<string, LimitRule>;
/** Distinct variants per cart; quantity per line is capped at 99 by `cart_line_qty_chk`. */
export const CART_MAX_LINES = 30;

/** Count one hit on `key` in its current window; returns the count and seconds until the window ends. */
export async function hit(exec: Executor, key: string, rule: LimitRule): Promise<{ count: number; retryAfterSec: number }> {
  const rows = (await exec.execute(sql`
    insert into ${rateLimit} (key, window_start, count)
    values (${key}, to_timestamp(floor(extract(epoch from now()) / ${rule.windowSec}) * ${rule.windowSec}), 1)
    on conflict (key, window_start) do update set count = ${rateLimit}.count + 1
    returning count, ceil(extract(epoch from (window_start + ${rule.windowSec} * interval '1 second' - now())))::int as retry_after_sec
  `)) as unknown as { count: number; retry_after_sec: number }[];
  return { count: Number(rows[0]!.count), retryAfterSec: Math.max(1, Number(rows[0]!.retry_after_sec)) };
}

/** Count every key, then refuse with one retryable Indonesian message if any exceeded its limit. */
export async function enforceLimits(exec: Executor, hits: Hit[]): Promise<void> {
  const results = await Promise.all(hits.map((h) => hit(exec, h.key, h.rule)));
  const over = results.filter((r, i) => r.count > hits[i]!.rule.limit);
  if (over.length === 0) return;
  const wait = Math.max(...over.map((r) => r.retryAfterSec));
  throw new DomainError("rate_limited", `Terlalu banyak percobaan. Coba lagi dalam ${wait} detik.`);
}

export type ClientContext = { clientIp?: string | undefined; signal?: RequestSignalContext | undefined };
const ipHit = (scope: string, ctx: ClientContext, rule: LimitRule): Hit[] => (ctx.clientIp ? [{ key: `${scope}:ip:${ctx.clientIp}`, rule }] : []);

/** Rate limit for storefront cart add/update (per client IP when known, per existing cart). */
export function limitCartMutation(exec: Executor, ctx: ClientContext & { cartId?: string | undefined }): Promise<void> {
  const keys = ipHit("cart", ctx, LIMITS.cartIp);
  if (ctx.cartId && z.uuid().safeParse(ctx.cartId).success) keys.push({ key: `cart:cart:${ctx.cartId}`, rule: LIMITS.cartCart });
  return enforceLimits(exec, keys);
}

/** Refuse a new line once the cart holds `CART_MAX_LINES` distinct variants (existing lines may still change). */
export async function assertCartHasRoom(exec: Executor, storeId: number, cartId: string, variantId: number): Promise<void> {
  const [row] = await exec
    .select({ n: count(), has: sql<number>`count(*) filter (where ${cartLine.variantId} = ${variantId})`.mapWith(Number) })
    .from(cartLine)
    .where(and(eq(cartLine.storeId, storeId), eq(cartLine.cartId, cartId)));
  if (row!.has === 0 && row!.n >= CART_MAX_LINES) throw new DomainError("cart_full", `Keranjang maksimal ${CART_MAX_LINES} jenis barang.`);
}

/**
 * Maintenance (`node src/cleanup.ts`): delete open carts created more than `idleHours`
 * ago (lines and handoffs cascade; a cart with an order is never touched) and counters
 * older than a day. Carts carry no activity timestamp yet, so "idle" means "old" (ceiling).
 */
export async function cleanupIdleCarts(exec: Executor, opts: { idleHours: number }): Promise<{ carts: number; counters: number }> {
  if (!Number.isFinite(opts.idleHours) || opts.idleHours < 1) throw new DomainError("idle_hours", "idleHours must be >= 1");
  const carts = await exec
    .delete(cart)
    .where(and(lt(cart.createdAt, sql`now() - ${opts.idleHours} * interval '1 hour'`), sql`not exists (select 1 from ${order} where ${order.cartId} = ${cart.id})`))
    .returning({ id: cart.id });
  const counters = await exec
    .delete(rateLimit)
    .where(lt(rateLimit.windowStart, sql`now() - interval '1 day'`))
    .returning({ key: rateLimit.key });
  return { carts: carts.length, counters: counters.length };
}

/** Provider outages surface as one retryable buyer message; the typed error stays as `cause` for logs. */
async function providerGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof MengantarError)) throw err;
    const e = new DomainError("provider", "Layanan ongkir sedang gangguan. Coba lagi sebentar.");
    e.cause = err;
    throw e;
  }
}

/** Cart id → store id, only for a cart that has not been checked out yet. */
export async function openCartStore(exec: Executor, cartId: string | undefined): Promise<number | null> {
  if (!cartId || !z.uuid().safeParse(cartId).success) return null;
  const [row] = await exec
    .select({ storeId: cart.storeId })
    .from(cart)
    .leftJoin(order, eq(order.cartId, cart.id))
    .where(and(eq(cart.id, cartId), sql`${order.id} is null`));
  return row?.storeId ?? null;
}

const cartLines = (exec: Executor, storeId: number, cartId: string) =>
  exec
    .select({
      variantId: variant.id,
      variantCatalogId: variant.catalogId, // snapshot on order_line (T-14)
      productTitle: product.title,
      productStatus: product.status,
      variantTitle: variant.title,
      price: variant.price,
      quantity: cartLine.quantity,
    })
    .from(cartLine)
    .innerJoin(variant, and(eq(variant.storeId, cartLine.storeId), eq(variant.id, cartLine.variantId)))
    .innerJoin(product, and(eq(product.storeId, variant.storeId), eq(product.id, variant.productId)))
    .where(and(eq(cartLine.storeId, storeId), eq(cartLine.cartId, cartId)))
    .orderBy(asc(variant.id)); // stable lock order for the stock updates in placeOrder

const sumOf = (lines: { price: number; quantity: number }[]) => lines.reduce((sum, l) => sum + l.price * l.quantity, 0);

/** What the hosted checkout page shows: store, current lines, subtotal and whether the store can ship at all. */
export async function checkoutSummary(exec: Executor, cartId: string | undefined) {
  const storeId = await openCartStore(exec, cartId);
  if (!storeId) return null;
  const [s] = await exec
    .select({ name: store.name, slug: store.slug, status: store.status, pickupAreaId: storePickupArea.areaId })
    .from(store)
    .leftJoin(storePickupArea, eq(storePickupArea.storeId, store.id))
    .where(eq(store.id, storeId));
  const lines = await cartLines(exec, storeId, cartId!);
  if (lines.length === 0) return null;
  const { pickupAreaId, ...info } = s!;
  return { storeId, store: info, canShip: pickupAreaId !== null, lines, subtotal: sumOf(lines) };
}

/** Server-side destination search for the checkout address step (never a provider write). */
export async function searchDestinationAreas(keyword: string, adapter: ShippingAdapter = defaultShippingAdapter()) {
  const k = keyword.trim();
  if (k.length < 3) throw new DomainError("keyword", "Ketik minimal 3 huruf nama kelurahan, kecamatan atau kota.");
  return providerGuard(() => adapter.searchArea(k));
}

/** Courier options for the checkout page; same service `placeOrder` re-quotes with. */
export function checkoutShippingOptions(scope: StorefrontScope, destinationAreaId: string, cart: CartForShipping, adapter: ShippingAdapter = defaultShippingAdapter()) {
  return providerGuard(() => shippingOptions(scope, destinationAreaId, cart, adapter));
}

export async function placeOrder(
  exec: Executor,
  cartId: string | undefined,
  raw: unknown,
  providers: Providers = defaultProviders(),
  ctx: ClientContext = {},
): Promise<{ orderId: number; replayed: boolean }> {
  const input = checkoutInput.parse(raw);
  if (!cartId || !z.uuid().safeParse(cartId).success) throw new DomainError("no_cart", "Keranjang tidak ditemukan.");
  const [c] = await exec.select({ storeId: cart.storeId }).from(cart).where(eq(cart.id, cartId));
  if (!c) throw new DomainError("no_cart", "Keranjang tidak ditemukan.");
  const storeId = c.storeId;
  const { idempotencyKey, ...fields } = input;
  const requestHash = createHash("sha256").update(JSON.stringify({ cartId, ...fields })).digest("hex");

  const existing = async () => {
    const [o] = await exec
      .select({ id: order.id, requestHash: order.requestHash })
      .from(order)
      .where(and(eq(order.storeId, storeId), eq(order.idempotencyKey, idempotencyKey)));
    if (!o) return null;
    if (o.requestHash !== requestHash) throw new DomainError("idempotency_conflict", "Permintaan checkout bentrok. Muat ulang halaman.");
    return { orderId: o.id, replayed: true };
  };
  const replay = await existing();
  if (replay) return replay;
  // Abuse controls before any quote or lock (T-30): per client IP, per cart, per buyer phone.
  // An idempotent replay above costs nothing, so it is not counted.
  await enforceLimits(exec, [
    ...ipHit("order", ctx, LIMITS.orderIp),
    { key: `order:cart:${cartId}`, rule: LIMITS.orderCart },
    { key: `order:phone:${normalizePhone(input.buyerPhone)}`, rule: LIMITS.orderPhone },
  ]);

  // External quote before the transaction (no remote I/O while holding locks).
  const preview = await cartLines(exec, storeId, cartId);
  if (preview.length === 0) {
    // A concurrent duplicate may have committed (and emptied the cart) after our first check.
    const late = await existing();
    if (late) return late;
    throw new DomainError("empty", "Keranjang kosong.");
  }
  const [s] = await exec.select({ slug: store.slug, status: store.status }).from(store).where(eq(store.id, storeId));
  const scope = s?.status === "active" ? await storefrontScope(exec, s.slug) : null;
  if (!scope) throw new DomainError("store_unavailable", "Toko sedang tidak menerima pesanan.");
  const quote = await checkoutShippingOptions(scope, input.destinationAreaId, { items: preview.length, subtotal: sumOf(preview) }, providers.shipping);
  const option = quote.options.find((o) => o.courier === input.courier);
  if (!option) throw new DomainError("courier", "Pilihan kurir tidak tersedia untuk area tujuan ini.");
  const fee = input.paymentMethod === "cod" ? option.cod : option.prepaid;
  if (!fee) throw new DomainError("courier_cod", `${option.label} tidak melayani COD ke area tujuan ini. Pilih kurir lain atau bayar transfer.`);

  let orderId: number;
  try {
    orderId = await exec.transaction(async (tx) => {
      // Shared lock: a concurrent suspension waits for, or blocks, this checkout.
      const [st] = await tx.select({ status: store.status }).from(store).where(eq(store.id, storeId)).for("share");
      if (st?.status !== "active") throw new DomainError("store_unavailable", "Toko sedang tidak menerima pesanan.");

      const lines = await cartLines(tx, storeId, cartId);
      if (lines.length !== preview.length) throw new DomainError("cart_changed", "Keranjang berubah. Silakan ulangi.");
      const gone = lines.find((l) => l.productStatus !== "active");
      if (gone) throw new DomainError("unavailable", `${gone.productTitle} tidak lagi dijual.`);

      const subtotal = sumOf(lines);
      const [o] = await tx
        .insert(order)
        .values({
          storeId,
          cartId,
          idempotencyKey,
          requestHash,
          // COD waits for the seller's confirmation (T-35, PR-19); transfer waits for payment (D-5).
          status: input.paymentMethod === "cod" ? "awaiting_confirmation" : "awaiting_payment",
          paymentMethod: input.paymentMethod,
          buyerName: input.buyerName,
          buyerPhone: input.buyerPhone,
          shippingAddress: input.shippingAddress,
          courierCode: option.courier,
          courier: option.label,
          originAreaId: quote.originAreaId,
          destinationAreaId: quote.destinationAreaId,
          destinationAreaLabel: input.destinationAreaLabel,
          weightKg: quote.weightKg,
          shippingProviderCost: fee.providerCost,
          shippingMargin: fee.margin,
          subtotal,
          shippingFee: fee.buyerFee,
          total: subtotal + fee.buyerFee,
        })
        .onConflictDoNothing()
        .returning({ id: order.id });
      if (!o) throw new Replay();

      for (const l of lines) {
        const ok = await tx
          .update(variant)
          .set({ stock: sql`${variant.stock} - ${l.quantity}` })
          .where(and(eq(variant.storeId, storeId), eq(variant.id, l.variantId), gte(variant.stock, l.quantity)))
          .returning({ id: variant.id });
        if (ok.length === 0) throw new DomainError("out_of_stock", `Stok ${l.productTitle} (${l.variantTitle}) tidak cukup.`);
      }
      await tx.insert(orderLine).values(
        lines.map((l) => ({
          orderId: o.id,
          storeId,
          variantId: l.variantId,
          variantCatalogId: l.variantCatalogId,
          productTitle: l.productTitle,
          variantTitle: l.variantTitle,
          unitPrice: l.price,
          quantity: l.quantity,
          lineTotal: l.price * l.quantity,
        })),
      );
      await tx.delete(cartLine).where(and(eq(cartLine.storeId, storeId), eq(cartLine.cartId, cartId)));
      // Post-commit side effect as durable intent in the same transaction (SEC-18): the
      // worker asks the provider for a payment instruction; until then the order is an
      // explicit pending state with no reference (D-5).
      if (input.paymentMethod === "manual_transfer") {
        await enqueue(tx, { kind: PAYMENT_INSTRUCTION, storeId, key: `order:${o.id}`, payload: { orderId: o.id } });
      }
      // Ad signals (T-38): click context with the order; COD Purchase enqueued now, prepaid at settlement.
      await recordOrderSignals(tx, { storeId, orderId: o.id, paymentMethod: input.paymentMethod, request: ctx.signal });
      return o.id;
    });
  } catch (err) {
    const raced = err instanceof Replay || (err instanceof DomainError && err.code === "cart_changed");
    if (!raced) throw err;
    // Lost a race on (store_id, idempotency_key) or cart_id, or the cart was emptied
    // by a committed duplicate: return that order if it is ours.
    const r = await existing();
    if (r) return r;
    if (err instanceof Replay) throw new DomainError("cart_checked_out", "Keranjang ini sudah di-checkout.");
    throw err;
  }

  return { orderId, replayed: false };
}

/** Order outcome for the buyer who owns the checked-out cart (an order id alone grants nothing). */
export async function getBuyerOrder(exec: Executor, orderId: number, cartId: string | undefined) {
  if (!cartId || !z.uuid().safeParse(cartId).success) return null;
  const [o] = await exec
    .select({
      id: order.id,
      storeId: order.storeId,
      storeName: store.name,
      storeSlug: store.slug,
      status: order.status,
      paymentMethod: order.paymentMethod,
      paymentReference: order.paymentReference,
      courier: order.courier,
      destinationAreaLabel: order.destinationAreaLabel,
      // Buyer fields feed the hashed advanced-matching block of the confirmation page (T-38); never rendered.
      buyerName: order.buyerName,
      buyerPhone: order.buyerPhone,
      subtotal: order.subtotal,
      shippingFee: order.shippingFee,
      total: order.total,
    })
    .from(order)
    .innerJoin(store, eq(store.id, order.storeId))
    .where(and(eq(order.id, orderId), eq(order.cartId, cartId)));
  if (!o) return null;
  const lines = await exec
    .select()
    .from(orderLine)
    .where(and(eq(orderLine.storeId, o.storeId), eq(orderLine.orderId, o.id)))
    .orderBy(asc(orderLine.variantId));
  return { ...o, lines };
}
