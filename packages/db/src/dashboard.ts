import { and, eq, gte, lt, sql } from "drizzle-orm";
import { order, orderLine, signalDestination, signalEvent, variant } from "./schema.ts";
import { requireCap, type SellerScope } from "./scoped.ts";
import { SIGNAL_EVENTS, type SignalEventName } from "./signals.ts";
import { inStore } from "./tenant.ts";

// Seller performance dashboard (T-41, PR-22, SC-01). Read-only aggregates over this
// store's orders and signal events for a period in Asia/Jakarta. Every number here is
// reconciled against raw order rows in test/dashboard.test.ts.
//
// Definitions (kept in one place so the page and the tests agree):
//   order counted      = created in the period and not cancelled (reject = cancelled)
//   goods revenue      = sum(subtotal) of counted orders — integer IDR
//   shipping collected = sum(shipping_fee) of counted orders: buyer-paid ongkir passed
//                        on to the courier/platform, never the seller's revenue (Q-12)
//   COD confirmation   = COD orders with confirmed_at / COD orders created in the period
//   COD rejected       = cancelled COD orders / COD orders created in the period
//                        (a confirmed order that is cancelled later is in both rates)
//   awaiting           = all COD orders in awaiting_confirmation/on_hold, any period:
//                        a work-queue count, so an old unanswered order never hides

export const PERIODS = ["today", "7d", "30d"] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_DAYS: Record<Period, number> = { today: 1, "7d": 7, "30d": 30 };

/** WIB is UTC+7 without daylight saving, so a fixed offset is exact. */
const WIB_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the current Asia/Jakarta calendar day, as an instant. */
export function startOfJakartaDay(now: Date): Date {
  const shifted = new Date(now.getTime() + WIB_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - WIB_MS);
}

/** `[from, to)`: the last N Jakarta calendar days including today; `to` is tomorrow 00:00 WIB. */
export function periodRange(period: Period, now = new Date()): { from: Date; to: Date } {
  if (!(period in PERIOD_DAYS)) throw new Error(`unknown period: ${String(period)}`);
  const today = startOfJakartaDay(now);
  return { from: new Date(today.getTime() - (PERIOD_DAYS[period] - 1) * DAY_MS), to: new Date(today.getTime() + DAY_MS) };
}

export type DashboardKpi = {
  /** Every order created in the period, cancelled ones included (drives the empty state). */
  total: number;
  orders: number;
  cancelled: number;
  goodsRevenue: number;
  shippingCollected: number;
  /** Rounded integer IDR; null when there is no counted order. */
  averageOrderValue: number | null;
  cod: { total: number; confirmed: number; cancelled: number };
};
export type FunnelStep = { event: SignalEventName; count: number };
export type TopProduct = { productId: number; title: string; units: number; revenue: number };
export type Dashboard = {
  period: Period;
  range: { from: Date; to: Date };
  kpi: DashboardKpi;
  awaiting: number;
  /** `enabled` = at least one ad destination is switched on; without one no event is recorded. */
  funnel: { enabled: boolean; steps: FunnelStep[] };
  /** Top 5 by goods revenue; ties by units. */
  topProducts: TopProduct[];
};

const n = (expr: ReturnType<typeof sql>) => sql<number>`coalesce(${expr}, 0)`.mapWith(Number);
const CANCELLED = sql`${order.status} = 'cancelled'`;

export async function sellerDashboard(scope: SellerScope, period: Period, now = new Date()): Promise<Dashboard> {
  requireCap(scope, "orders.read");
  const range = periodRange(period, now);
  const inPeriod = (col: typeof order.createdAt | typeof signalEvent.createdAt) => and(gte(col, range.from), lt(col, range.to));
  return inStore(scope, async (scope) => {
    const mine = eq(order.storeId, scope.storeId);
    // Four aggregates, one round trip each, no per-row work (NFR-1): the planner uses
    // order_store_status_idx for the store + period scan on seeded volumes (docs/tracks/dashboard.md).
    const [[kpi], [queue], funnelRows, dests, top] = await Promise.all([
      scope.exec
        .select({
          total: n(sql`count(*)`),
          orders: n(sql`count(*) filter (where not ${CANCELLED})`),
          cancelled: n(sql`count(*) filter (where ${CANCELLED})`),
          goodsRevenue: n(sql`sum(${order.subtotal}) filter (where not ${CANCELLED})`),
          shippingCollected: n(sql`sum(${order.shippingFee}) filter (where not ${CANCELLED})`),
          codTotal: n(sql`count(*) filter (where ${order.paymentMethod} = 'cod')`),
          codConfirmed: n(sql`count(*) filter (where ${order.paymentMethod} = 'cod' and ${order.confirmedAt} is not null)`),
          codCancelled: n(sql`count(*) filter (where ${order.paymentMethod} = 'cod' and ${CANCELLED})`),
        })
        .from(order)
        .where(and(mine, inPeriod(order.createdAt))),
      scope.exec
        .select({ awaiting: n(sql`count(*)`) })
        .from(order)
        .where(and(mine, sql`${order.status} in ('awaiting_confirmation', 'on_hold')`)),
      // One row per destination per event: distinct event ids = events the buyer actually triggered.
      scope.exec
        .select({ event: signalEvent.eventName, count: n(sql`count(distinct ${signalEvent.eventId})`) })
        .from(signalEvent)
        .where(and(eq(signalEvent.storeId, scope.storeId), inPeriod(signalEvent.createdAt)))
        .groupBy(signalEvent.eventName),
      scope.exec
        .select({ id: signalDestination.id })
        .from(signalDestination)
        .where(and(eq(signalDestination.storeId, scope.storeId), eq(signalDestination.enabled, true)))
        .limit(1),
      scope.exec
        .select({
          productId: variant.productId,
          title: sql<string>`max(${orderLine.productTitle})`,
          units: n(sql`sum(${orderLine.quantity})`),
          revenue: n(sql`sum(${orderLine.lineTotal})`),
        })
        .from(orderLine)
        .innerJoin(order, and(eq(order.storeId, orderLine.storeId), eq(order.id, orderLine.orderId)))
        .innerJoin(variant, and(eq(variant.storeId, orderLine.storeId), eq(variant.id, orderLine.variantId)))
        .where(and(eq(orderLine.storeId, scope.storeId), mine, inPeriod(order.createdAt), sql`not ${CANCELLED}`))
        .groupBy(variant.productId)
        .orderBy(sql`sum(${orderLine.lineTotal}) desc, sum(${orderLine.quantity}) desc, ${variant.productId}`)
        .limit(5),
    ]);
    const k = kpi!;
    const byEvent = new Map(funnelRows.map((r) => [r.event, r.count]));
    return {
      period,
      range,
      kpi: {
        total: k.total,
        orders: k.orders,
        cancelled: k.cancelled,
        goodsRevenue: k.goodsRevenue,
        shippingCollected: k.shippingCollected,
        averageOrderValue: k.orders ? Math.round(k.goodsRevenue / k.orders) : null,
        cod: { total: k.codTotal, confirmed: k.codConfirmed, cancelled: k.codCancelled },
      },
      awaiting: queue!.awaiting,
      funnel: { enabled: dests.length > 0, steps: SIGNAL_EVENTS.map((event) => ({ event, count: byEvent.get(event) ?? 0 })) },
      topProducts: top,
    };
  });
}
