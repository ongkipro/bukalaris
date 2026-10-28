import { createHash } from "node:crypto";
import { and, asc, count, eq, gte, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../../client.ts";
import "../../payments/jobs.ts"; // registers the payment.* handlers, reconcilers and schedules (T-49)
import { MengantarError } from "../../shipping/mengantar/client.ts";
import { enqueueOrderNotifications } from "../../ops/jobs/notify.ts";
import { type PaymentAdapter, type Providers, type ShippingAdapter } from "../../payments/providers.ts";
import { createOrderPaymentAttempt } from "../../payments/attempts.ts";
import { isPricedChannel, paymentFee, type PaymentChannel } from "../../payments/contract.ts";
import { orderPaymentView } from "../../payments/view.ts";
import { buyerFingerprint } from "../../buyer/fingerprint.ts";
import { enqueueBuyerResolve } from "../../buyer/jobs.ts"; // registers the buyer.resolve handler and policy (T-57)
import { phoneLookupKey } from "../../buyer/normalize.ts";
import { checkoutPromotions, recordPromotionRedemptions, VOUCHER_REDEEM_LIMITS } from "../../promotions/checkout.ts";
import { writeOrderFinancials } from "../../ledger/ledger.ts";
import { CLICK_ID_RE } from "../../affiliate/code.ts";
import { planAffiliateCommission, recordAffiliateAttribution, usableTypedCode } from "../../affiliate/referral.ts";
import { CLICK_COOKIE_MAX_IDS } from "../../affiliate/settings.ts";
import { recordOrderSignals, type RequestSignalContext } from "../../storefront/signals.ts";
import { cart, cartLine, checkoutSession, order, orderLine, product, rateLimit, store, storePickupArea, variant } from "../../schema.ts";
import { resolveCartStore } from "../../platform/resolvers.ts";
import { hit, type LimitRule } from "../../platform/rate-limit.ts";
import { DomainError, storefrontScope, type StorefrontScope } from "../../platform/scoped.ts";
import { defaultProviders, defaultShippingAdapter, shippingOptions, type CartForShipping } from "../../shipping/shipping.ts";
import { withStore } from "../../platform/tenant.ts";

// Hosted checkout (SF-07/SF-08). The client sends only contact, destination area,
// courier choice, payment method and an idempotency key; price, stock, fee and
// totals are derived from the database and the server-side shipping quote
// (provider cost + platform margin, T-34/Q-12). The store is derived from the
// cart (the buyer's capability), never from the request: `cartStore` resolves it through
// the platform pool (ADR-0005 §4) and everything else runs in that store's RLS context.

const areaId = z.string().regex(/^[a-f0-9]{24}$/, "Pilih area tujuan dari hasil pencarian.");

export const checkoutInput = z.strictObject({
  idempotencyKey: z.uuid(),
  buyerName: z.string().trim().min(2, "Nama wajib diisi.").max(120),
  buyerPhone: z.string().trim().regex(/^\+?[0-9]{8,15}$/, "Nomor HP 8–15 digit."),
  // Optional (T-36): an empty form field counts as "not given"; never required for COD.
  buyerEmail: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().toLowerCase().email("Alamat email tidak valid.").max(254).optional()),
  shippingAddress: z.string().trim().min(10, "Alamat terlalu pendek.").max(500),
  destinationAreaId: areaId,
  destinationAreaLabel: z.string().trim().min(3, "Pilih area tujuan dari hasil pencarian.").max(200),
  courier: z.string().min(1, "Pilih kurir.").max(40),
  paymentMethod: z.enum(["cod", "manual_transfer"]),
  // Prepaid orders pay through one channel of the provider's own list; COD has none. Validated against that list in `placeOrder`.
  paymentChannel: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().regex(/^[A-Z0-9_-]{1,40}$/, "Pilih metode pembayaran.").optional()),
  voucherCode: z.string().trim().max(64).optional(),
  // T-52: an affiliate code typed by the buyer. A selector only: unknown, expired, blocked or malformed codes never fail the order (ADR-0009 section 4).
  affiliateCode: z.string().trim().max(64).optional(),
});
export type CheckoutInput = z.input<typeof checkoutInput>;

class Replay extends Error {}

// ── Abuse controls (T-30, SEC-16) ──────────────────────────────────────────
// Fixed-window counters in Postgres (one upsert per key, no extra service). The
// IP comes from the trusted proxy header (apps/web `clientIp()`); when none is
// present (dev, tests, misconfigured proxy) the IP dimension is skipped and the
// per-cart and per-phone keys carry the protection — a shared "unknown" bucket
// would throttle every buyer at once.

export { hit, type LimitRule };
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

/** Count every key, then refuse with one retryable Indonesian message if any exceeded its limit. */
export async function enforceLimits(exec: Executor, hits: Hit[]): Promise<void> {
  const results = await Promise.all(hits.map((h) => hit(exec, h.key, h.rule)));
  const over = results.filter((r, i) => r.count > hits[i]!.rule.limit);
  if (over.length === 0) return;
  const wait = Math.max(...over.map((r) => r.retryAfterSec));
  throw new DomainError("rate_limited", `Terlalu banyak percobaan. Coba lagi dalam ${wait} detik.`);
}

export type ClientContext = {
  clientIp?: string | undefined;
  signal?: RequestSignalContext | undefined;
  /** T-52: the click ids of the `__Host-bl_click` continuity cookie (selectors; the database decides whether any is eligible for this store). */
  referral?: { clickIds?: readonly string[] | undefined } | undefined;
};
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
 * older than a day. Carts carry no activity timestamp yet, so "idle" means "old" (ceiling). A cart that a checkout session (T-45) still references stays until
 * the 30-day session purge removes the session (the resume link and the abandonment counts depend on it).
 */
export async function cleanupIdleCarts(exec: Executor, opts: { idleHours: number }): Promise<{ carts: number; counters: number }> {
  if (!Number.isFinite(opts.idleHours) || opts.idleHours < 1) throw new DomainError("idle_hours", "idleHours must be >= 1");
  const carts = await exec
    .delete(cart)
    .where(
      and(
        lt(cart.createdAt, sql`now() - ${opts.idleHours} * interval '1 hour'`),
        sql`not exists (select 1 from ${order} where ${order.cartId} = ${cart.id})`,
        sql`not exists (select 1 from ${checkoutSession} where ${checkoutSession.cartId} = ${cart.id})`,
      ),
    )
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

/**
 * Channels the buyer may pay with: exactly the provider's own `list_payment` answer (absence = disabled, never probed
 * through `create_payment`), narrowed to those the platform fee schedule can price; COD is a separate payment method.
 */
export async function checkoutPaymentChannels(adapter: PaymentAdapter = defaultProviders().payment): Promise<PaymentChannel[]> {
  let channels: PaymentChannel[];
  try {
    channels = await adapter.listChannels();
  } catch (err) {
    const e = new DomainError("provider", "Metode pembayaran sedang tidak tersedia. Coba lagi sebentar.");
    e.cause = err;
    throw e;
  }
  return channels.filter((c) => isPricedChannel(c.code));
}

async function pickPaymentChannel(adapter: PaymentAdapter, code: string | undefined): Promise<PaymentChannel> {
  const channel = (await checkoutPaymentChannels(adapter)).find((c) => c.code === code);
  if (!channel) throw new DomainError("payment_channel", "Metode pembayaran tidak tersedia. Pilih metode lain.");
  return channel;
}

/**
 * Cross-store resolver (ADR-0005 §4): the store a cart belongs to, checked out or not, through the
 * `resolve_cart_store` function on the caller's own pool. The only thing it returns is the store id; the
 * caller then continues inside that store's context.
 */
export async function cartStore(exec: Executor, cartId: string | undefined): Promise<number | null> {
  if (!cartId || !z.uuid().safeParse(cartId).success) return null;
  return resolveCartStore(exec, cartId);
}

/** Cart id → store id, only for a cart that has not been checked out yet. In a store context it also answers "is this cart ours". */
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
      productId: product.id,
      variantCatalogId: variant.catalogId, // snapshot on order_line (T-14)
      productTitle: product.title,
      productStatus: product.status,
      variantTitle: variant.title,
      price: variant.price,
      weightGrams: variant.weightGrams,
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
  const storeId = await cartStore(exec, cartId);
  if (!storeId) return null;
  return withStore(exec, storeId, async (tx) => {
    if (!(await openCartStore(tx, cartId))) return null;
    const [s] = await tx
      .select({ name: store.name, slug: store.slug, status: store.status, pickupAreaId: storePickupArea.areaId })
      .from(store)
      .leftJoin(storePickupArea, eq(storePickupArea.storeId, store.id))
      .where(eq(store.id, storeId));
    const lines = await cartLines(tx, storeId, cartId!);
    if (lines.length === 0) return null;
    const { pickupAreaId, ...info } = s!;
    return { storeId, store: info, canShip: pickupAreaId !== null, lines, subtotal: sumOf(lines) };
  });
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
  const storeId = await cartStore(exec, cartId);
  if (!cartId || !storeId) throw new DomainError("no_cart", "Keranjang tidak ditemukan.");
  const { idempotencyKey, ...fields } = input;
  const requestHash = createHash("sha256").update(JSON.stringify({ cartId, ...fields })).digest("hex");

  // Runs inside the store context (`tx`): the idempotency key is unique per store.
  const existing = async (tx: Executor) => {
    const [o] = await tx
      .select({ id: order.id, requestHash: order.requestHash })
      .from(order)
      .where(and(eq(order.storeId, storeId), eq(order.idempotencyKey, idempotencyKey)));
    if (!o) return null;
    if (o.requestHash !== requestHash) throw new DomainError("idempotency_conflict", "Permintaan checkout bentrok. Muat ulang halaman.");
    return { orderId: o.id, replayed: true };
  };
  const replay = await withStore(exec, storeId, existing);
  if (replay) return replay;
  // Abuse controls before any quote or lock (T-30): per client IP, per cart, per buyer phone.
  // An idempotent replay above costs nothing, so it is not counted.
  await enforceLimits(exec, [
    ...ipHit("order", ctx, LIMITS.orderIp),
    { key: `order:cart:${cartId}`, rule: LIMITS.orderCart },
    // Keyed fingerprint of the comparison key: the counter row never holds the phone number, and every spelling of one number shares a bucket (T-57).
    { key: `order:phone:${buyerFingerprint("rate.order_phone", "phone", phoneLookupKey(input.buyerPhone) ?? input.buyerPhone.replace(/^\+/, ""))}`, rule: LIMITS.orderPhone },
  ]);
  if (input.voucherCode) await limitVoucherRedemption(exec, storeId, input.buyerPhone, ctx);
  // T-52 RL-CODE: a typed affiliate code is validated and its invalid guesses are counted outside the order transaction; the transaction rechecks everything itself.
  const typedCode = await usableTypedCode(exec, storeId, cartId, input.affiliateCode);
  const clickIds = (ctx.referral?.clickIds ?? []).filter((id) => CLICK_ID_RE.test(id)).slice(0, CLICK_COOKIE_MAX_IDS);

  // External quote before the write transaction (no remote I/O while holding locks).
  const { preview, late, slug } = await withStore(exec, storeId, async (tx) => {
    const preview = await cartLines(tx, storeId, cartId);
    // A concurrent duplicate may have committed (and emptied the cart) after our first check.
    const late = preview.length === 0 ? await existing(tx) : null;
    const [s] = await tx.select({ slug: store.slug, status: store.status }).from(store).where(eq(store.id, storeId));
    return { preview, late, slug: s?.status === "active" ? s.slug : null };
  });
  if (late) return late;
  if (preview.length === 0) throw new DomainError("empty", "Keranjang kosong.");
  const scope = slug ? await storefrontScope(exec, slug) : null;
  if (!scope) throw new DomainError("store_unavailable", "Toko sedang tidak menerima pesanan.");
  const quote = await checkoutShippingOptions(scope, input.destinationAreaId, { lines: preview, subtotal: sumOf(preview) }, providers.shipping);
  const option = quote.options.find((o) => o.courier === input.courier);
  if (!option) throw new DomainError("courier", "Pilihan kurir tidak tersedia untuk area tujuan ini.");
  const fee = input.paymentMethod === "cod" ? option.cod : option.prepaid;
  if (!fee) throw new DomainError("courier_cod", `${option.label} tidak melayani COD ke area tujuan ini. Pilih kurir lain atau bayar transfer.`);
  const channel = input.paymentMethod === "manual_transfer" ? await pickPaymentChannel(providers.payment, input.paymentChannel) : null;

  let orderId: number;
  try {
    orderId = await withStore(exec, storeId, async (tx) => {
      // Shared lock: a concurrent suspension waits for, or blocks, this checkout.
      const [st] = await tx.select({ status: store.status }).from(store).where(eq(store.id, storeId)).for("share");
      if (st?.status !== "active") throw new DomainError("store_unavailable", "Toko sedang tidak menerima pesanan.");

      const lines = await cartLines(tx, storeId, cartId);
      if (lines.length !== preview.length) throw new DomainError("cart_changed", "Keranjang berubah. Silakan ulangi.");
      const gone = lines.find((l) => l.productStatus !== "active");
      if (gone) throw new DomainError("unavailable", `${gone.productTitle} tidak lagi dijual.`);

      const subtotal = sumOf(lines);
      const promotion = await checkoutPromotions(tx, storeId, lines, fee, input.voucherCode, input.buyerPhone, true);
      const finance = promotion.finance;
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
          buyerEmail: input.buyerEmail ?? null,
          shippingAddress: input.shippingAddress,
          courierCode: option.courier,
          shippingAccountId: quote.shippingAccountId,
          shippingAccountKind: quote.shippingAccountKind,
          courier: option.label,
          originAreaId: quote.originAreaId,
          destinationAreaId: quote.destinationAreaId,
          destinationAreaLabel: input.destinationAreaLabel,
          weightKg: quote.weightKg,
          shippingProviderCost: fee.providerCost,
          shippingMargin: fee.margin,
          subtotal,
          shippingFee: finance.shippingCharged,
          goodsDiscount: finance.goodsDiscount,
          shippingDiscount: finance.shippingDiscount,
          total: finance.payable,
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
      // T-46 / BILL-4: the one allocation engine freezes goods and shipping discounts separately, including each line's exact share.
      // T-52 / BILL-8: attribute the order (typed code, else the latest eligible click of this store) and deduct the single-floor commission from the seller's sale. The
      // buyer's payable and every allocation line are untouched; a bad or ineligible selector earns nothing and never fails the order.
      const referral = { code: typedCode, clickIds };
      const plan = await planAffiliateCommission(tx, { storeId, orderId: o.id, productIds: lines.map((l) => l.productId), finance, referral });
      await writeOrderFinancials(tx, {
        storeId,
        orderId: o.id,
        finance: plan?.finance ?? finance,
        platformShippingDiscountIdr: fee.platformDiscount,
        variantIds: lines.map((l) => l.variantId),
        expectedGatewayFeeIdr: channel ? paymentFee(channel.code, subtotal - finance.goodsDiscount, finance.payable) : 0,
        affiliate: plan ? { affiliateId: plan.affiliateId, ratesBps: plan.ratesBps } : undefined,
      });
      if (plan) await recordAffiliateAttribution(tx, { storeId, orderId: o.id, referral });
      await recordPromotionRedemptions(tx, storeId, o.id, promotion);
      await tx.delete(cartLine).where(and(eq(cartLine.storeId, storeId), eq(cartLine.cartId, cartId)));
      // T-45: an order from this cart completes its checkout session. `recovered_at` is stamped by the guard and `abandoned_at` is never cleared, so a
      // session that had been swept is a rescue and a straight-through one is not. The buyer's contact now lives on the order (T-43), so the session drops its copy.
      await tx
        .update(checkoutSession)
        .set({ status: "recovered", buyerName: null, buyerPhone: null, buyerEmail: null, shippingAddress: null })
        .where(and(eq(checkoutSession.storeId, storeId), eq(checkoutSession.cartId, cartId), ne(checkoutSession.status, "recovered")));
      // Prepaid: the payment attempt (stable reff_id, immutable amounts) and the instruction job commit with the order, as
      // durable intent before any provider call (SEC-18, BILL-2); until the worker stores the instruction the order shows
      // an explicit pending state (D-5). The provider's own list decided the channel; the fee schedule prices it.
      if (channel) {
        const total = finance.payable;
        await createOrderPaymentAttempt(
          { exec: tx, storeId },
          { orderId: o.id, requestKey: idempotencyKey, channelCode: channel.code, customer: { id: String(o.id), name: input.buyerName, phone: input.buyerPhone, email: input.buyerEmail ?? null }, amountIdr: total, adminFeeIdr: paymentFee(channel.code, subtotal - finance.goodsDiscount, total) },
        );
      }
      await enqueueOrderNotifications(tx, storeId, o.id, "created"); // T-36: buyer (if e-mail) + owners, after commit
      await enqueueBuyerResolve(tx, storeId, o.id); // T-57 (JOB-10): ID-only association intent, committed with the order; the worker resolves the global buyer after commit
      // Ad signals (T-38): click context with the order; COD Purchase enqueued now, prepaid at settlement.
      await recordOrderSignals(tx, { storeId, orderId: o.id, paymentMethod: input.paymentMethod, request: ctx.signal });
      return o.id;
    });
  } catch (err) {
    const raced = err instanceof Replay || (err instanceof DomainError && err.code === "cart_changed");
    // Wave 4 review: a concurrent duplicate of the SAME request (one idempotency key, a double click) waits on the first one's voucher or flash counter
    // and then finds it spent. That loser must get the existing order back, not a refusal; a real second buyer has no order of this cart/key and still gets the refusal.
    const counterLoser = err instanceof DomainError && (err.code === "voucher_unavailable" || err.code === "flash_stock");
    if (!raced && !counterLoser) throw err;
    // Lost a race on (store_id, idempotency_key) or cart_id, or the cart was emptied
    // by a committed duplicate: return that order if it is ours.
    const r = await withStore(exec, storeId, existing);
    if (r) return r;
    if (err instanceof Replay) throw new DomainError("cart_checked_out", "Keranjang ini sudah di-checkout.");
    throw err;
  }

  return { orderId, replayed: false };
}

/** Order outcome for the buyer who owns the checked-out cart (an order id alone grants nothing). */
export async function getBuyerOrder(exec: Executor, orderId: number, cartId: string | undefined) {
  const storeId = await cartStore(exec, cartId);
  if (!storeId) return null;
  return withStore(exec, storeId, async (tx) => {
    const [o] = await tx
      .select({
        id: order.id,
        storeId: order.storeId,
        storeName: store.name,
        storeSlug: store.slug,
        status: order.status,
        paymentMethod: order.paymentMethod,
        courier: order.courier,
        destinationAreaLabel: order.destinationAreaLabel,
        // Buyer fields feed the hashed advanced-matching block of the confirmation page (T-38); never rendered.
        buyerName: order.buyerName,
        buyerPhone: order.buyerPhone,
        subtotal: order.subtotal,
        shippingFee: order.shippingFee,
        goodsDiscount: order.goodsDiscount,
        shippingDiscount: order.shippingDiscount,
        total: order.total,
      })
      .from(order)
      .innerJoin(store, eq(store.id, order.storeId))
      .where(and(eq(order.id, orderId), eq(order.cartId, cartId!)));
    if (!o) return null;
    const lines = await tx
      .select()
      .from(orderLine)
      .where(and(eq(orderLine.storeId, o.storeId), eq(orderLine.orderId, o.id)))
      .orderBy(asc(orderLine.variantId));
    return { ...o, lines, payment: await orderPaymentView(tx, o.storeId, o.id) };
  });
}

/** Voucher attempts are counted outside the order transaction, so a failed or rolled-back redemption still consumes the abuse budget. */
async function limitVoucherRedemption(exec: Executor, storeId: number, phone: string, ctx: ClientContext) {
  const canonical = phoneLookupKey(phone);
  if (!canonical) throw new DomainError("voucher_phone", "Isi nomor HP yang valid sebelum memakai voucher.");
  await enforceLimits(exec, [
    ...ipHit(`voucher:${storeId}`, ctx, VOUCHER_REDEEM_LIMITS.ip),
    { key: `voucher:${storeId}:phone:${buyerFingerprint("rate.voucher_phone", "phone", canonical)}`, rule: VOUCHER_REDEEM_LIMITS.phone },
  ]);
}

const promotionPreviewInput = z.object({
  buyerPhone: checkoutInput.shape.buyerPhone, voucherCode: z.string().trim().max(64).default(""), destinationAreaId: areaId,
  courier: z.string().min(1).max(40), paymentMethod: z.enum(["cod", "manual_transfer"]),
});
/** Same rules and quote as submit, but no stock/quota reservation and no cart mutation. Submit always validates again atomically. */
export async function checkoutPromotionPreview(exec: Executor, cartId: string | undefined, raw: unknown, ctx: ClientContext = {}) {
  const input = promotionPreviewInput.parse(raw);
  const summary = await checkoutSummary(exec, cartId);
  if (!summary || summary.store.status !== "active") throw new DomainError("no_cart", "Keranjang tidak ditemukan.");
  await limitVoucherRedemption(exec, summary.storeId, input.buyerPhone, ctx);
  const scope = (await storefrontScope(exec, summary.store.slug))!;
  const quote = await checkoutShippingOptions(scope, input.destinationAreaId, { lines: summary.lines, subtotal: summary.subtotal });
  const option = quote.options.find((o) => o.courier === input.courier);
  const fee = input.paymentMethod === "cod" ? option?.cod : option?.prepaid;
  if (!fee) throw new DomainError("courier", "Pilih kurir yang tersedia.");
  return withStore(exec, summary.storeId, async (tx) => (await checkoutPromotions(tx, summary.storeId, summary.lines, fee, input.voucherCode, input.buyerPhone, false)).finance);
}
