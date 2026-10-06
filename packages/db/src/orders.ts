import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { order, orderLine, ORDER_STATUSES, orderStatusHistory, product, stockAdjustment, user, variant, type OrderStatus } from "./schema.ts";
import { DomainError, requireCap, type SellerScope } from "./scoped.ts";
export { ORDER_STATUSES, type OrderStatus } from "./schema.ts";

// Seller orders (SC-12/SC-13) and inventory (SC-04). Q-10 is still open; the
// defaults taken here are recorded in docs/tracks/orders.md.
//
// Lifecycle: awaiting_payment --(mark paid)--> placed --> processing --> shipped --> completed
//            awaiting_payment | placed | processing --> cancelled (restocks every line exactly once)
// Every transition locks the order row (`FOR UPDATE`), re-checks the current
// status and writes a history row in the same transaction, so a double cancel
// or a cancel racing another transition is rejected instead of restocking twice.

/** Seller actions and the statuses they are allowed from. */
export const TRANSITIONS = {
  pay: { from: ["awaiting_payment"], to: "placed" },
  process: { from: ["placed"], to: "processing" },
  ship: { from: ["processing"], to: "shipped" },
  complete: { from: ["shipped"], to: "completed" },
  cancel: { from: ["awaiting_payment", "placed", "processing"], to: "cancelled" },
} as const satisfies Record<string, { from: readonly OrderStatus[]; to: OrderStatus }>;
export type OrderAction = keyof typeof TRANSITIONS;

export const orderStatusInput = z.enum(ORDER_STATUSES);
const PAGE = 20;

/** Newest first, optional status filter, keyset pagination on the identity id (monotonic, unique). */
export async function listOrders(scope: SellerScope, opts: { status?: string; cursor?: number; limit?: number } = {}) {
  requireCap(scope, "orders.read");
  const status = opts.status ? orderStatusInput.parse(opts.status) : undefined;
  const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 100);
  const rows = await scope.exec
    .select({
      id: order.id,
      status: order.status,
      paymentMethod: order.paymentMethod,
      buyerName: order.buyerName,
      total: order.total,
      createdAt: order.createdAt,
    })
    .from(order)
    .where(
      and(
        eq(order.storeId, scope.storeId),
        status ? eq(order.status, status) : undefined,
        opts.cursor ? lt(order.id, opts.cursor) : undefined,
      ),
    )
    .orderBy(desc(order.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { orders: page, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

export async function getOrder(scope: SellerScope, orderId: number) {
  requireCap(scope, "orders.read");
  const [o] = await scope.exec
    .select()
    .from(order)
    .where(and(eq(order.storeId, scope.storeId), eq(order.id, orderId)));
  if (!o) return null;
  const lines = await scope.exec
    .select()
    .from(orderLine)
    .where(and(eq(orderLine.storeId, scope.storeId), eq(orderLine.orderId, orderId)))
    .orderBy(asc(orderLine.variantId));
  const history = await scope.exec
    .select({
      id: orderStatusHistory.id,
      fromStatus: orderStatusHistory.fromStatus,
      toStatus: orderStatusHistory.toStatus,
      note: orderStatusHistory.note,
      actorName: user.name,
      createdAt: orderStatusHistory.createdAt,
    })
    .from(orderStatusHistory)
    .leftJoin(user, eq(user.id, orderStatusHistory.actorUserId))
    .where(and(eq(orderStatusHistory.storeId, scope.storeId), eq(orderStatusHistory.orderId, orderId)))
    .orderBy(asc(orderStatusHistory.id));
  // The checkout row carries no actor, so the history shows transitions only; the
  // order's own created_at is the "placed by buyer" moment.
  const { requestHash: _hash, idempotencyKey: _key, ...safe } = o;
  return { ...safe, lines, history, actions: allowedActions(o.status) };
}

export const allowedActions = (status: OrderStatus): OrderAction[] =>
  (Object.keys(TRANSITIONS) as OrderAction[]).filter((a) => (TRANSITIONS[a].from as readonly OrderStatus[]).includes(status));

const shipInput = z.strictObject({ trackingNumber: z.string().trim().min(3, "Nomor resi minimal 3 karakter.").max(80) });
const cancelInput = z.strictObject({ reason: z.string().trim().min(5, "Alasan pembatalan minimal 5 karakter.").max(500) });

/**
 * Apply one seller action. `raw` carries the action's input (tracking number for
 * `ship`, reason for `cancel`; ignored otherwise). Invalid transitions throw
 * `invalid_transition`; a foreign or unknown order throws `not_found`.
 */
export async function transitionOrder(scope: SellerScope, orderId: number, action: OrderAction, raw: unknown = {}): Promise<OrderStatus> {
  requireCap(scope, "orders.fulfill");
  if (!Object.hasOwn(TRANSITIONS, action)) throw new DomainError("invalid_action", "Aksi tidak dikenal.");
  const t = TRANSITIONS[action];
  const note = action === "ship" ? shipInput.parse(raw).trackingNumber : action === "cancel" ? cancelInput.parse(raw).reason : null;

  return scope.exec.transaction(async (tx) => {
    const [o] = await tx
      .select({ id: order.id, status: order.status, paymentMethod: order.paymentMethod })
      .from(order)
      .where(and(eq(order.storeId, scope.storeId), eq(order.id, orderId)))
      .for("update");
    if (!o) throw new DomainError("not_found", "Pesanan tidak ditemukan.");
    if (!(t.from as readonly OrderStatus[]).includes(o.status)) {
      throw new DomainError("invalid_transition", `Pesanan berstatus "${o.status}" tidak bisa diproses dengan aksi ini.`);
    }

    await tx
      .update(order)
      .set({
        status: t.to,
        updatedAt: new Date(),
        ...(action === "pay" ? { paidAt: new Date() } : {}),
        ...(action === "ship" ? { trackingNumber: note } : {}),
      })
      .where(and(eq(order.storeId, scope.storeId), eq(order.id, orderId)));

    if (action === "cancel") {
      // The row lock above guarantees this block runs at most once per order.
      const lines = await tx
        .select({ variantId: orderLine.variantId, quantity: orderLine.quantity })
        .from(orderLine)
        .where(and(eq(orderLine.storeId, scope.storeId), eq(orderLine.orderId, orderId)))
        .orderBy(asc(orderLine.variantId)); // same lock order as checkout and adjustStock
      for (const l of lines) {
        await tx
          .update(variant)
          .set({ stock: sql`${variant.stock} + ${l.quantity}` })
          .where(and(eq(variant.storeId, scope.storeId), eq(variant.id, l.variantId)));
      }
      if (lines.length > 0) {
        await tx.insert(stockAdjustment).values(
          lines.map((l) => ({
            storeId: scope.storeId,
            variantId: l.variantId,
            delta: l.quantity,
            reason: `Pembatalan pesanan #${orderId}: ${note}`,
            actorUserId: scope.userId,
            orderId,
          })),
        );
      }
    }

    await tx.insert(orderStatusHistory).values({
      storeId: scope.storeId,
      orderId,
      fromStatus: o.status,
      toStatus: t.to,
      actorUserId: scope.userId,
      note: action === "pay" ? "Pembayaran transfer dikonfirmasi manual oleh penjual" : note,
    });
    return t.to;
  });
}

// ---------------------------------------------------------------------------
// Inventory (SC-04)
// ---------------------------------------------------------------------------

export async function listInventory(scope: SellerScope) {
  requireCap(scope, "catalog.read");
  return scope.exec
    .select({
      variantId: variant.id,
      productId: product.id,
      productTitle: product.title,
      productStatus: product.status,
      variantTitle: variant.title,
      sku: variant.sku,
      stock: variant.stock,
    })
    .from(variant)
    .innerJoin(product, and(eq(product.storeId, variant.storeId), eq(product.id, variant.productId)))
    .where(eq(variant.storeId, scope.storeId))
    .orderBy(asc(product.title), asc(product.id), asc(variant.id));
}

export async function listStockAdjustments(scope: SellerScope, limit = 20) {
  requireCap(scope, "catalog.read");
  return scope.exec
    .select({
      id: stockAdjustment.id,
      variantId: stockAdjustment.variantId,
      productTitle: product.title,
      variantTitle: variant.title,
      delta: stockAdjustment.delta,
      reason: stockAdjustment.reason,
      orderId: stockAdjustment.orderId,
      actorName: user.name,
      createdAt: stockAdjustment.createdAt,
    })
    .from(stockAdjustment)
    .innerJoin(variant, and(eq(variant.storeId, stockAdjustment.storeId), eq(variant.id, stockAdjustment.variantId)))
    .innerJoin(product, and(eq(product.storeId, variant.storeId), eq(product.id, variant.productId)))
    .leftJoin(user, eq(user.id, stockAdjustment.actorUserId))
    .where(eq(stockAdjustment.storeId, scope.storeId))
    .orderBy(desc(stockAdjustment.id))
    .limit(limit);
}

const adjustInput = z.strictObject({
  delta: z.coerce.number().int("Perubahan harus bilangan bulat.").min(-100_000).max(100_000).refine((d) => d !== 0, "Perubahan tidak boleh 0."),
  reason: z.string().trim().min(3, "Alasan wajib diisi (minimal 3 karakter).").max(300),
});

/** Signed stock adjustment; atomic and never negative (`stock + delta >= 0` in the UPDATE itself). Returns the new stock. */
export async function adjustStock(scope: SellerScope, variantId: number, raw: unknown): Promise<number> {
  requireCap(scope, "inventory.write");
  const { delta, reason } = adjustInput.parse(raw);
  return scope.exec.transaction(async (tx) => {
    const [row] = await tx
      .update(variant)
      .set({ stock: sql`${variant.stock} + ${delta}` })
      .where(and(eq(variant.storeId, scope.storeId), eq(variant.id, variantId), sql`${variant.stock} + ${delta} >= 0`))
      .returning({ stock: variant.stock });
    if (!row) {
      const [exists] = await tx
        .select({ stock: variant.stock })
        .from(variant)
        .where(and(eq(variant.storeId, scope.storeId), eq(variant.id, variantId)));
      if (!exists) throw new DomainError("not_found", "Varian tidak ditemukan.");
      throw new DomainError("insufficient_stock", `Stok tidak cukup: stok saat ini ${exists.stock}, tidak bisa dikurangi ${-delta}.`);
    }
    await tx.insert(stockAdjustment).values({ storeId: scope.storeId, variantId, delta, reason, actorUserId: scope.userId });
    return row.stock;
  });
}
