import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../../client.ts";
import { enqueueOrderNotifications } from "../../ops/jobs/notify.ts";
import { auditLog, order, orderLine, ORDER_STATUS_LABEL, ORDER_STATUSES, orderStatusHistory, product, stockAdjustment, user, variant, type OrderStatus } from "../../schema.ts";
import { bookCodSale, settleTerminalOrder } from "../../ledger/ledger.ts";
import { phoneMatches } from "../../buyer/normalize-sql.ts";
import { orderPaymentView } from "../../payments/view.ts";
import { DomainError, requireCap, type SellerScope } from "../../platform/scoped.ts";
import { enqueuePurchase } from "../../storefront/signals.ts";
import { inStore } from "../../platform/tenant.ts";
export { ORDER_STATUS_LABEL, ORDER_STATUSES, type OrderStatus } from "../../schema.ts";

// Seller orders (SC-12/SC-13) and inventory (SC-04). Q-10 is still open; the
// defaults taken here are recorded in docs/tracks/orders.md and checkout2.md.
//
// Lifecycle: COD       awaiting_confirmation --(hold)--> on_hold; awaiting_confirmation | on_hold --(confirm)--> placed
//                      awaiting_confirmation | on_hold --(reject)--> cancelled           (T-35, PR-19)
//            transfer  awaiting_payment --(mark paid)--> placed
//            placed --> processing --> shipped --> completed | returned (RTS, in transit only)
//            awaiting_payment | placed | processing --> cancelled
// `completed` and `returned` are reached only through `applyProviderTransition` (the courier's DELIVERED / RTS, or the four-eyes
// manual completion): a seller can never complete an order for credit (ADR-0006 decision 4), so there is no seller `complete` action;
// `claimDelivery` records the seller's claim and changes nothing else. `completed`, `cancelled` and `returned` are terminal, and the database
// refuses every other move too (`order_status_guard`, migration 0013). Every cancellation or return restocks every line exactly once and
// settles the ledger in the same transaction (reverses the still-pending sale, opens the buyer refund of a verified gateway payment).
// Every transition locks the order row (`FOR UPDATE`), re-checks the current status and
// writes a history row in the same transaction, so a double cancel or a cancel
// racing another transition is rejected instead of restocking twice.

/** Seller actions and the statuses they are allowed from. */
export const TRANSITIONS = {
  confirm: { from: ["awaiting_confirmation", "on_hold"], to: "placed" },
  hold: { from: ["awaiting_confirmation"], to: "on_hold" },
  reject: { from: ["awaiting_confirmation", "on_hold"], to: "cancelled" },
  pay: { from: ["awaiting_payment"], to: "placed" },
  process: { from: ["placed"], to: "processing" },
  ship: { from: ["processing"], to: "shipped" },
  cancel: { from: ["awaiting_payment", "placed", "processing"], to: "cancelled" },
} as const satisfies Record<string, { from: readonly OrderStatus[]; to: OrderStatus }>;
export type OrderAction = keyof typeof TRANSITIONS;
/** Actions that need a seller-written reason (recorded in the history and, for restocks, the adjustment). */
const REASONED: readonly OrderAction[] = ["hold", "reject", "cancel"];
const RESTOCKING: readonly OrderAction[] = ["reject", "cancel"];

export const orderStatusInput = z.enum(ORDER_STATUSES);
const PAGE = 20;

/** Newest first, optional status filter, keyset pagination on the identity id (monotonic, unique). */
export async function listOrders(scope: SellerScope, opts: { status?: string; cursor?: number; limit?: number } = {}) {
  requireCap(scope, "orders.read");
  const status = opts.status ? orderStatusInput.parse(opts.status) : undefined;
  const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 100);
  const rows = await inStore(scope, (scope) =>
    scope.exec
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
      .limit(limit + 1),
  );
  const page = rows.slice(0, limit);
  return { orders: page, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

export async function getOrder(scope: SellerScope, orderId: number) {
  requireCap(scope, "orders.read");
  return inStore(scope, async (scope) => {
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
    const risk = o.paymentMethod === "cod" && (o.status === "awaiting_confirmation" || o.status === "on_hold") ? await codRiskReasons(scope, o) : [];
    return { ...safe, lines, history, payment: await orderPaymentView(scope.exec, scope.storeId, orderId), actions: allowedActions(o.status), risk };
  });
}

// ---------------------------------------------------------------------------
// COD risk signals (T-35, PR-19). Store-scoped only (Q-14 open): nothing here reads
// another store's orders. The provider receiver score is not used (403 for this account).
// ---------------------------------------------------------------------------

export type RiskReason = { code: "repeat_cancelled" | "repeat_unconfirmed" | "address_incomplete" | "high_amount"; message: string };

/** Address needs a house/street number and some length to be deliverable by a courier. */
export const addressIncomplete = (address: string) => {
  const a = address.trim();
  return a.length < 25 || !/[0-9]/.test(a);
};
const HIGH_AMOUNT_MIN_ORDERS = 3;
const HIGH_AMOUNT_FACTOR = 2;
const idr = new Intl.NumberFormat("id-ID");

export async function codRiskReasons(
  scope: SellerScope,
  o: { id: number; buyerPhone: string; shippingAddress: string; total: number },
): Promise<RiskReason[]> {
  const samePhone = and(eq(order.storeId, scope.storeId), sql`${order.id} <> ${o.id}`, phoneMatches(order.buyerPhone, o.buyerPhone));
  const [[phone], [amount]] = await inStore(scope, (scope) => Promise.all([
    scope.exec
      .select({
        cancelled: sql<number>`count(*) filter (where ${order.status} = 'cancelled')`.mapWith(Number),
        unconfirmed: sql<number>`count(*) filter (where ${order.status} in ('awaiting_confirmation', 'on_hold'))`.mapWith(Number),
      })
      .from(order)
      .where(samePhone),
    scope.exec
      .select({
        n: sql<number>`count(*)`.mapWith(Number),
        median: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${order.total}), 0)`.mapWith(Number),
      })
      .from(order)
      .where(and(eq(order.storeId, scope.storeId), eq(order.paymentMethod, "cod"), sql`${order.id} <> ${o.id}`)),
  ]));
  const reasons: RiskReason[] = [];
  if (phone!.cancelled > 0)
    reasons.push({ code: "repeat_cancelled", message: `${phone!.cancelled} pesanan sebelumnya dengan nomor HP ini dibatalkan atau ditolak di toko ini.` });
  if (phone!.unconfirmed > 0)
    reasons.push({ code: "repeat_unconfirmed", message: `${phone!.unconfirmed} pesanan lain dengan nomor HP ini masih menunggu konfirmasi.` });
  if (addressIncomplete(o.shippingAddress))
    reasons.push({ code: "address_incomplete", message: "Alamat terlalu pendek atau tanpa nomor rumah/jalan; pastikan lewat telepon sebelum dikirim." });
  if (amount!.n >= HIGH_AMOUNT_MIN_ORDERS && o.total > HIGH_AMOUNT_FACTOR * amount!.median)
    reasons.push({
      code: "high_amount",
      message: `Nilai COD Rp ${idr.format(o.total)} lebih dari ${HIGH_AMOUNT_FACTOR}× median pesanan COD toko ini (Rp ${idr.format(Math.round(amount!.median))}).`,
    });
  return reasons;
}

export const allowedActions = (status: OrderStatus): OrderAction[] =>
  (Object.keys(TRANSITIONS) as OrderAction[]).filter((a) => (TRANSITIONS[a].from as readonly OrderStatus[]).includes(status));

const shipInput = z.strictObject({ trackingNumber: z.string().trim().min(3, "Nomor resi minimal 3 karakter.").max(80) });
const reasonInput = z.strictObject({ reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500) });

/**
 * Apply one seller action. `raw` carries the action's input (tracking number for
 * `ship`, reason for `hold`/`reject`/`cancel`; ignored otherwise). Invalid transitions
 * throw `invalid_transition`; a foreign or unknown order throws `not_found`.
 */
export async function transitionOrder(scope: SellerScope, orderId: number, action: OrderAction, raw: unknown = {}): Promise<OrderStatus> {
  requireCap(scope, "orders.fulfill");
  if (!Object.hasOwn(TRANSITIONS, action)) throw new DomainError("invalid_action", "Aksi tidak dikenal.");
  const note = action === "ship" ? shipInput.parse(raw).trackingNumber : REASONED.includes(action) ? reasonInput.parse(raw).reason : null;
  return inStore(scope, ({ exec }) => applyTransition(exec, scope.storeId, orderId, action, note, scope.userId));
}

/**
 * The one place an order changes status (used by `transitionOrder` and by the fulfillment
 * worker, T-39). `tx` must already carry the store context (`inStore`/`withStore`): it locks the
 * order row, re-checks the status, writes the history row and enqueues the notification.
 */
export async function applyTransition(tx: Executor, storeId: number, orderId: number, action: OrderAction, note: string | null, actorUserId: string): Promise<OrderStatus> {
  const t = TRANSITIONS[action];
  const [o] = await tx
    .select({ id: order.id, status: order.status, paymentMethod: order.paymentMethod })
    .from(order)
    .where(and(eq(order.storeId, storeId), eq(order.id, orderId)))
    .for("update");
  if (!o) throw new DomainError("not_found", "Pesanan tidak ditemukan.");
  if (!(t.from as readonly OrderStatus[]).includes(o.status)) {
    throw new DomainError("invalid_transition", `Pesanan berstatus "${ORDER_STATUS_LABEL[o.status]}" tidak bisa diproses dengan aksi ini.`);
  }

  await tx
    .update(order)
    .set({
      status: t.to,
      updatedAt: new Date(),
      ...(action === "pay" ? { paidAt: new Date() } : {}),
      ...(action === "confirm" ? { confirmedAt: new Date() } : {}),
      ...(action === "ship" ? { trackingNumber: note } : {}),
    })
    .where(and(eq(order.storeId, storeId), eq(order.id, orderId)));

  if (RESTOCKING.includes(action)) {
    await restockOrder(tx, storeId, orderId, action === "reject" ? "Penolakan pesanan COD" : "Pembatalan pesanan", note, actorUserId);
    await settleTerminalOrder(tx, storeId, orderId, "order_cancelled");
  }

  // Prepaid Purchase signal at settlement (T-38, PR-20); idempotent per destination.
  if (action === "pay") await enqueuePurchase(tx, storeId, orderId);

  await tx.insert(orderStatusHistory).values({
    storeId,
    orderId,
    fromStatus: o.status,
    toStatus: t.to,
    actorUserId,
    note: action === "pay" ? (note ?? "Pembayaran transfer dikonfirmasi manual oleh penjual") : action === "confirm" ? "Pesanan COD dikonfirmasi oleh penjual" : note,
  });
  await enqueueOrderNotifications(tx, storeId, orderId, action); // T-36: no-op for actions without a notification
  return t.to;
}

/** Return every line to stock exactly once (the order row lock held by the caller makes the block run at most once per order). */
async function restockOrder(tx: Executor, storeId: number, orderId: number, label: string, note: string | null, actorUserId: string): Promise<void> {
  const lines = await tx
    .select({ variantId: orderLine.variantId, quantity: orderLine.quantity })
    .from(orderLine)
    .where(and(eq(orderLine.storeId, storeId), eq(orderLine.orderId, orderId)))
    .orderBy(asc(orderLine.variantId)); // same lock order as checkout and adjustStock
  for (const l of lines) {
    await tx
      .update(variant)
      .set({ stock: sql`${variant.stock} + ${l.quantity}` })
      .where(and(eq(variant.storeId, storeId), eq(variant.id, l.variantId)));
  }
  if (lines.length > 0) {
    await tx.insert(stockAdjustment).values(lines.map((l) => ({ storeId, variantId: l.variantId, delta: l.quantity, reason: `${label} #${orderId}: ${note}`, actorUserId, orderId })));
  }
}

export type ProviderTransition = "completed" | "returned" | "cancelled";
export type ProviderTransitionOutcome = { outcome: "applied" | "noop" | "rejected"; status: OrderStatus; reason?: string };
export const PROVIDER_ACTOR = "system:provider-status";

/**
 * The single writer of courier-driven moves (CRMON-02, ADR-0006 decisions 4 and 8). Tracking polls and webhooks may skip steps, so a forward
 * jump (`placed`/`processing` -> `completed`) is accepted; the same status is a no-op; every other move the legal table forbids
 * (`completed -> cancelled`, `completed -> returned`, any move out of a terminal state, `returned` from anywhere but `shipped`) is REJECTED:
 * recorded in the audit log and returned to the caller, never dropped and never thrown into a half-written transaction.
 * Effects, all in the caller's transaction (the order row is locked first):
 *  - `completed`: a COD order books its `sale` as pending (the courier's DELIVERED is the only COD credit, or `source = manual_approved` after the
 *    four-eyes `cod.manual_complete`); a prepaid order's sale already exists and is released by `ledger.release`.
 *  - `returned` / `cancelled` (before delivery): stock returns once, a still-pending prepaid sale is reversed pending-against-pending, the buyer
 *    refund of a verified gateway payment is opened.
 */
export async function applyProviderTransition(
  tx: Executor,
  storeId: number,
  orderId: number,
  target: ProviderTransition,
  ctx: { source: "provider" | "manual_approved"; note?: string; actorUserId?: string },
): Promise<ProviderTransitionOutcome> {
  const actor = ctx.actorUserId ?? PROVIDER_ACTOR;
  const [o] = await tx
    .select({ status: order.status, paymentMethod: order.paymentMethod, trackingNumber: order.trackingNumber })
    .from(order)
    .where(and(eq(order.storeId, storeId), eq(order.id, orderId)))
    .for("update");
  if (!o) throw new DomainError("not_found", "Pesanan tidak ditemukan.");
  if (o.status === target) return { outcome: "noop", status: o.status };
  const legal: Record<ProviderTransition, readonly OrderStatus[]> = {
    completed: ["placed", "processing", "shipped"],
    returned: ["shipped"],
    cancelled: ["awaiting_confirmation", "on_hold", "awaiting_payment", "placed", "processing", "shipped"],
  };
  const reject = async (reason: string): Promise<ProviderTransitionOutcome> => {
    await tx.insert(auditLog).values({ storeId, actorUserId: actor, action: "order.transition_rejected", subjectKind: "order", subjectId: String(orderId), reason: `${o.status} -> ${target}: ${reason}`.slice(0, 400), outcome: "denied" });
    return { outcome: "rejected", status: o.status, reason };
  };
  if (!legal[target].includes(o.status)) return reject("illegal_transition");
  if (target === "completed" && !o.trackingNumber) return reject("missing_tracking_number");
  const now = new Date();
  await tx
    .update(order)
    .set({ status: target, updatedAt: now, ...(target === "completed" && o.paymentMethod === "cod" ? { paidAt: now } : {}) })
    .where(and(eq(order.storeId, storeId), eq(order.id, orderId)));
  if (target === "completed" && o.paymentMethod === "cod") await bookCodSale(tx, storeId, orderId);
  if (target === "returned" || target === "cancelled") {
    await restockOrder(tx, storeId, orderId, target === "returned" ? "Pesanan dikembalikan (RTS)" : "Pembatalan oleh kurir", ctx.note ?? null, actor);
    await settleTerminalOrder(tx, storeId, orderId, target === "returned" ? "order_returned" : "order_cancelled");
  }
  const label = ctx.source === "manual_approved" ? "disetujui dua orang (manual)" : "status kurir";
  await tx.insert(orderStatusHistory).values({ storeId, orderId, fromStatus: o.status, toStatus: target, actorUserId: actor, note: `${ctx.note ?? ORDER_STATUS_LABEL[target]} (${label})`.slice(0, 500) });
  if (target === "cancelled") await enqueueOrderNotifications(tx, storeId, orderId, "cancel");
  return { outcome: "applied", status: target };
}

/**
 * "Laporkan sudah diterima" (seller). Records the claim in the status history and changes nothing else: no status move, no credit.
 * Delivery is the courier's fact (or a four-eyes manual completion in the Owner console); a seller can never complete for credit.
 */
export async function claimDelivery(scope: SellerScope, orderId: number): Promise<void> {
  requireCap(scope, "orders.fulfill");
  await inStore(scope, async ({ exec: tx }) => {
    const [o] = await tx.select({ status: order.status }).from(order).where(and(eq(order.storeId, scope.storeId), eq(order.id, orderId))).for("update");
    if (!o) throw new DomainError("not_found", "Pesanan tidak ditemukan.");
    if (o.status !== "shipped") throw new DomainError("invalid_transition", "Klaim diterima hanya untuk pesanan yang sedang dikirim.");
    const [prior] = await tx.select({ id: orderStatusHistory.id }).from(orderStatusHistory).where(and(eq(orderStatusHistory.storeId, scope.storeId), eq(orderStatusHistory.orderId, orderId), eq(orderStatusHistory.note, CLAIM_NOTE)));
    if (prior) return;
    await tx.insert(orderStatusHistory).values({ storeId: scope.storeId, orderId, fromStatus: "shipped", toStatus: "shipped", actorUserId: scope.userId, note: CLAIM_NOTE });
  });
}
export const CLAIM_NOTE = "Penjual melaporkan paket sudah diterima (menunggu status kurir atau persetujuan Bukalaris)";

// ---------------------------------------------------------------------------
// Inventory (SC-04)
// ---------------------------------------------------------------------------

export async function listInventory(scope: SellerScope) {
  requireCap(scope, "catalog.read");
  return inStore(scope, (scope) =>
    scope.exec
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
      .orderBy(asc(product.title), asc(product.id), asc(variant.id)),
  );
}

export async function listStockAdjustments(scope: SellerScope, limit = 20) {
  requireCap(scope, "catalog.read");
  return inStore(scope, (scope) =>
    scope.exec
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
      .limit(limit),
  );
}

const adjustInput = z.strictObject({
  delta: z.coerce.number().int("Perubahan harus bilangan bulat.").min(-100_000).max(100_000).refine((d) => d !== 0, "Perubahan tidak boleh 0."),
  reason: z.string().trim().min(3, "Alasan wajib diisi (minimal 3 karakter).").max(300),
});

/** Signed stock adjustment; atomic and never negative (`stock + delta >= 0` in the UPDATE itself). Returns the new stock. */
export async function adjustStock(scope: SellerScope, variantId: number, raw: unknown): Promise<number> {
  requireCap(scope, "inventory.write");
  const { delta, reason } = adjustInput.parse(raw);
  return inStore(scope, async ({ exec: tx }) => {
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
