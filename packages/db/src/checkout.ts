import { createHash } from "node:crypto";
import { and, asc, count, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "./client.ts";
import { enqueue, PAYMENT_INSTRUCTION } from "./jobs.ts";
import { fakeProviders, type Providers } from "./providers.ts";
import { cart, cartLine, order, orderLine, product, store, variant } from "./schema.ts";
import { DomainError } from "./scoped.ts";

// Hosted checkout (SF-07/SF-08). The client sends only contact, courier choice,
// payment method and an idempotency key; price, stock, fee and totals are
// derived from the database and the server-side shipping quote. The store is
// derived from the cart (the buyer's capability), never from the request.

export const checkoutInput = z.strictObject({
  idempotencyKey: z.uuid(),
  buyerName: z.string().trim().min(2, "Nama wajib diisi.").max(120),
  buyerPhone: z.string().trim().regex(/^\+?[0-9]{8,15}$/, "Nomor HP 8–15 digit."),
  shippingAddress: z.string().trim().min(10, "Alamat terlalu pendek.").max(500),
  courier: z.string().min(1).max(40),
  paymentMethod: z.enum(["cod", "manual_transfer"]),
});
export type CheckoutInput = z.input<typeof checkoutInput>;

class Replay extends Error {}

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

/** What the hosted checkout page shows: store, current lines and server-side shipping options. */
export async function checkoutSummary(exec: Executor, cartId: string | undefined, providers: Providers = fakeProviders) {
  const storeId = await openCartStore(exec, cartId);
  if (!storeId) return null;
  const [s] = await exec.select({ name: store.name, slug: store.slug, status: store.status }).from(store).where(eq(store.id, storeId));
  const lines = await exec
    .select({
      variantId: variant.id,
      productTitle: product.title,
      variantTitle: variant.title,
      price: variant.price,
      quantity: cartLine.quantity,
    })
    .from(cartLine)
    .innerJoin(variant, and(eq(variant.storeId, cartLine.storeId), eq(variant.id, cartLine.variantId)))
    .innerJoin(product, and(eq(product.storeId, variant.storeId), eq(product.id, variant.productId)))
    .where(and(eq(cartLine.storeId, storeId), eq(cartLine.cartId, cartId!)))
    .orderBy(asc(variant.id));
  if (lines.length === 0) return null;
  const options = await providers.shipping.quote({ storeId, address: "", items: lines.length });
  return {
    storeId,
    store: s!,
    lines,
    subtotal: lines.reduce((sum, l) => sum + l.price * l.quantity, 0),
    options,
  };
}

export async function placeOrder(
  exec: Executor,
  cartId: string | undefined,
  raw: unknown,
  providers: Providers = fakeProviders,
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

  // External quote before the transaction (no remote I/O while holding locks).
  const [{ n: itemCount }] = (await exec.select({ n: count() }).from(cartLine).where(eq(cartLine.cartId, cartId))) as [{ n: number }];
  if (itemCount === 0) {
    // A concurrent duplicate may have committed (and emptied the cart) after our first check.
    const late = await existing();
    if (late) return late;
    throw new DomainError("empty", "Keranjang kosong.");
  }
  const quotes = await providers.shipping.quote({ storeId, address: input.shippingAddress, items: itemCount });
  const quote = quotes.find((q) => q.courier === input.courier);
  if (!quote) throw new DomainError("courier", "Pilihan kurir tidak tersedia.");

  let orderId: number;
  try {
    orderId = await exec.transaction(async (tx) => {
      // Shared lock: a concurrent suspension waits for, or blocks, this checkout.
      const [s] = await tx.select({ status: store.status }).from(store).where(eq(store.id, storeId)).for("share");
      if (s?.status !== "active") throw new DomainError("store_unavailable", "Toko sedang tidak menerima pesanan.");

      const lines = await tx
        .select({
          variantId: variant.id,
          variantCatalogId: variant.catalogId,
          variantTitle: variant.title,
          price: variant.price,
          productTitle: product.title,
          productStatus: product.status,
          quantity: cartLine.quantity,
        })
        .from(cartLine)
        .innerJoin(variant, and(eq(variant.storeId, cartLine.storeId), eq(variant.id, cartLine.variantId)))
        .innerJoin(product, and(eq(product.storeId, variant.storeId), eq(product.id, variant.productId)))
        .where(and(eq(cartLine.storeId, storeId), eq(cartLine.cartId, cartId)))
        .orderBy(asc(variant.id)); // stable lock order for the stock updates below
      if (lines.length !== itemCount) throw new DomainError("cart_changed", "Keranjang berubah. Silakan ulangi.");
      const gone = lines.find((l) => l.productStatus !== "active");
      if (gone) throw new DomainError("unavailable", `${gone.productTitle} tidak lagi dijual.`);

      const subtotal = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
      const [o] = await tx
        .insert(order)
        .values({
          storeId,
          cartId,
          idempotencyKey,
          requestHash,
          status: input.paymentMethod === "cod" ? "placed" : "awaiting_payment",
          paymentMethod: input.paymentMethod,
          buyerName: input.buyerName,
          buyerPhone: input.buyerPhone,
          shippingAddress: input.shippingAddress,
          courier: quote.label,
          subtotal,
          shippingFee: quote.fee,
          total: subtotal + quote.fee,
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
