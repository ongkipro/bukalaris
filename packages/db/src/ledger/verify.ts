import { sql, type SQL } from "drizzle-orm";
import type { Db, Executor } from "../client.ts";

// Ledger consistency verification (ADR-0006 decision 9, DATA-7, D-21 item 3). READ-ONLY: it never writes, and `pnpm verify:ledger` runs it inside a
// repeatable-read READ ONLY transaction (one snapshot: a payout or release committing mid-run cannot fake a disagreement). Balances are recomputed per store from `ledger_entry` ALONE by `SUM(amount_idr)`; no balance query joins `order` (a payout
// entry has a NULL order_id by design, so an inner join silently drops every withdrawal). The orphan and booking-condition checks do read `order`, but only
// to test existence or status, never to compute a balance. Invariants proven per store:
//   1. exactly one `sale` per order that met its booking condition (never zero, never two), amount = the frozen `sale_amount_idr`
//   2. at most one `return_reversal` per order, the exact opposite of a sale
//   3. `available` never negative: the final balance AND every point of its history
//   4. every `payout` and `payout_reversal` entry pairs with its payout row and amount; a payout has its debit, and a reversal only when rejected
//   5. every released (`available`) entry carries `released_at` and `release_basis`; a pending entry carries neither
//   6. no COD sale or cashback is released without an applied reconciliation item; a prepaid one only for a completed order
//   7. entries whose order_id references no order; entries without order_id outside payout, payout_reversal and adjustment
//   8. the allocation identity of every order_financials row and its lines; shipment_cost against its debit entry; refund composition; applied batches
// The balance SQL is exported so a test can prove it contains no join.

export const BALANCE_SQL = sql`
  select store_id,
         coalesce(sum(amount_idr) filter (where status = 'available'), 0)::bigint as available_idr,
         coalesce(sum(amount_idr) filter (where status = 'pending'), 0)::bigint as pending_idr,
         coalesce(sum(amount_idr), 0)::bigint as total_idr
    from ledger_entry group by store_id order by store_id`;

export type LedgerViolation = { code: string; storeId: number | null; detail: string };
export type StoreSummary = { storeId: number; availableIdr: number; pendingIdr: number; totalIdr: number; byKind: Record<string, { pending: number; available: number; count: number }> };
export type LedgerVerification = { stores: StoreSummary[]; violations: LedgerViolation[]; entries: number; orders: number; orderLessEntries: number };

type Row = Record<string, string | null>;
const rows = async (exec: Executor, q: SQL) => (await exec.execute(q)) as unknown as Row[];
const n = (v: string | null | undefined) => Number(v ?? 0);

export async function verifyLedger(db: Db): Promise<LedgerVerification> {
  return db.transaction(async (tx) => {
    const violations: LedgerViolation[] = [];
    const add = (code: string, storeId: string | number | null, detail: string) => violations.push({ code, storeId: storeId == null ? null : Number(storeId), detail });

    // ── balances, recomputed from ledger_entry alone, two independent ways ──
    const stores = new Map<number, StoreSummary>();
    for (const r of await rows(tx, BALANCE_SQL)) stores.set(n(r.store_id), { storeId: n(r.store_id), availableIdr: n(r.available_idr), pendingIdr: n(r.pending_idr), totalIdr: n(r.total_idr), byKind: {} });
    for (const r of await rows(tx, sql`select store_id, kind, count(*)::int as c, coalesce(sum(amount_idr) filter (where status = 'pending'), 0)::bigint as p, coalesce(sum(amount_idr) filter (where status = 'available'), 0)::bigint as a from ledger_entry group by store_id, kind`)) {
      const s = stores.get(n(r.store_id));
      if (s) s.byKind[r.kind!] = { pending: n(r.p), available: n(r.a), count: n(r.c) };
    }
    for (const s of stores.values()) {
      const parts = Object.values(s.byKind).reduce((acc, k) => ({ p: acc.p + k.pending, a: acc.a + k.available }), { p: 0, a: 0 });
      if (parts.p !== s.pendingIdr || parts.a !== s.availableIdr || s.availableIdr + s.pendingIdr !== s.totalIdr) add("balance_disagrees_with_entries", s.storeId, `pending ${s.pendingIdr}/${parts.p}, available ${s.availableIdr}/${parts.a}`);
      if (s.availableIdr < 0) add("available_negative", s.storeId, `available balance ${s.availableIdr}`);
    }
    // The platform view of the seller classes must equal the ledger total (SA-26 fixture rule).
    const [pm] = await rows(tx, sql`select coalesce(sum(amount_idr) filter (where class in ('seller_pending', 'seller_available')), 0)::bigint as seller from platform_money_position`);
    const ledgerTotal = [...stores.values()].reduce((a, s) => a + s.totalIdr, 0);
    if (n(pm?.seller) !== ledgerTotal) add("money_position_disagrees", null, `platform_money_position seller classes ${n(pm?.seller)} vs ledger ${ledgerTotal}`);

    // ── history of `available`: the running balance never dips below zero ──
    // Entries released in the SAME transaction share one `released_at` (now() is the transaction time) and are ONE step: a COD debit with a lower id than its sale at the same instant
    // is not "first" (T-37 review P3-4). The ledger guards check the final state of each transaction, so does this.
    for (const r of await rows(tx, sql`
      select store_id, min(running)::bigint as low from (
        select store_id, sum(step) over (partition by store_id order by released_at) as running
          from (select store_id, released_at, sum(amount_idr) as step from ledger_entry where status = 'available' and released_at is not null group by store_id, released_at) g
      ) h group by store_id having min(running) < 0`)) add("available_dipped_negative", r.store_id, `lowest running available balance ${r.low}`);

    // ── entry shape: released entries carry when and why; pending entries carry neither ──
    for (const r of await rows(tx, sql`select id, store_id from ledger_entry where status = 'available' and (released_at is null or release_basis is null)`)) add("released_without_basis", r.store_id, `entry ${r.id} is available without released_at or release_basis`);
    for (const r of await rows(tx, sql`select id, store_id from ledger_entry where status = 'pending' and (released_at is not null or release_basis is not null or reconciliation_item_id is not null)`)) add("pending_with_release_fields", r.store_id, `entry ${r.id}`);

    // ── orphans, counted separately from the balance ──
    for (const r of await rows(tx, sql`select e.id, e.store_id from ledger_entry e where e.order_id is not null and not exists (select 1 from "order" o where o.store_id = e.store_id and o.id = e.order_id)`)) add("orphan_entry", r.store_id, `entry ${r.id} references no order`);
    for (const r of await rows(tx, sql`select id, store_id, kind from ledger_entry where order_id is null and kind not in ('payout', 'payout_reversal', 'adjustment')`)) add("order_kind_without_order", r.store_id, `entry ${r.id} (${r.kind}) has no order_id`);
    const [orderLess] = await rows(tx, sql`select count(*)::int as c from ledger_entry where order_id is null`);

    // ── sale: one per order that met the booking condition, the frozen amount ──
    for (const r of await rows(tx, sql`select order_id, store_id, count(*)::int as c from ledger_entry where kind = 'sale' group by order_id, store_id having count(*) > 1`)) add("duplicate_sale", r.store_id, `order ${r.order_id} has ${r.c} sales`);
    for (const r of await rows(tx, sql`
      select o.id, o.store_id from "order" o join order_financials f on f.store_id = o.store_id and f.order_id = o.id
       where f.sale_amount_idr > 0 and not exists (select 1 from ledger_entry e where e.store_id = o.store_id and e.order_id = o.id and e.kind = 'sale')
         and ((o.payment_method = 'cod' and o.status = 'completed')
           or (o.payment_method <> 'cod' and o.status in ('placed', 'processing', 'shipped', 'completed')
               and exists (select 1 from payment_attempt a where a.store_id = o.store_id and a.order_id = o.id and a.status = 'paid')))`)) add("missing_sale", r.store_id, `order ${r.id} met its booking condition but has no sale`);
    for (const r of await rows(tx, sql`
      select o.id, o.store_id from "order" o join ledger_entry e on e.store_id = o.store_id and e.order_id = o.id and e.kind = 'sale'
       where (o.payment_method = 'cod' and o.status not in ('completed')) or (o.status in ('cancelled', 'returned') and not exists (select 1 from ledger_entry r where r.store_id = o.store_id and r.order_id = o.id and r.kind = 'return_reversal'))`)) add("sale_for_unbooked_order", r.store_id, `order ${r.id} has a sale it should not have`);
    for (const r of await rows(tx, sql`select e.id, e.store_id from ledger_entry e join order_financials f on f.store_id = e.store_id and f.order_id = e.order_id where e.kind = 'sale' and e.amount_idr <> f.sale_amount_idr`)) add("sale_amount_differs", r.store_id, `entry ${r.id} differs from the frozen sale_amount`);

    // ── returns ──
    for (const r of await rows(tx, sql`select order_id, store_id, count(*)::int as c from ledger_entry where kind = 'return_reversal' group by order_id, store_id having count(*) > 1`)) add("duplicate_return_reversal", r.store_id, `order ${r.order_id} has ${r.c} return reversals`);
    for (const r of await rows(tx, sql`select e.id, e.store_id from ledger_entry e left join ledger_entry s on s.store_id = e.store_id and s.order_id = e.order_id and s.kind = 'sale' where e.kind = 'return_reversal' and (s.id is null or e.amount_idr <> -s.amount_idr)`)) add("return_reversal_without_sale", r.store_id, `entry ${r.id} is not the exact opposite of a sale`);

    // ── payouts: paired both ways ──
    for (const r of await rows(tx, sql`select e.id, e.store_id, e.kind from ledger_entry e left join payout p on p.store_id = e.store_id and p.id = e.payout_id where e.kind in ('payout', 'payout_reversal') and p.id is null`)) add("payout_entry_without_payout", r.store_id, `entry ${r.id} (${r.kind}) has no payout row`);
    for (const r of await rows(tx, sql`
      select p.id, p.store_id from payout p
       where (select count(*) from ledger_entry e where e.store_id = p.store_id and e.payout_id = p.id and e.kind = 'payout' and e.amount_idr = -p.amount_idr) <> 1
          or (select count(*) from ledger_entry e where e.store_id = p.store_id and e.payout_id = p.id and e.kind = 'payout_reversal' and e.amount_idr = p.amount_idr) <> (case when p.status = 'rejected' then 1 else 0 end)`)) add("payout_without_entries", r.store_id, `payout ${r.id} is not paired with exactly its debit (and its reversal only when rejected)`);

    // ── release rules ──
    for (const r of await rows(tx, sql`
      select e.id, e.store_id from ledger_entry e join "order" o on o.store_id = e.store_id and o.id = e.order_id
       where e.kind in ('sale', 'cashback') and e.status = 'available'
         and not ((o.payment_method = 'cod' and e.release_basis = 'reconciliation' and exists (select 1 from reconciliation_batch_item i join reconciliation_batch b on b.id = i.batch_id where i.id = e.reconciliation_item_id and i.order_id = e.order_id and i.voided_at is null and i.reconciled_at is not null and b.status = 'applied'))
              or (o.payment_method <> 'cod' and e.release_basis = 'delivery' and o.status = 'completed'))`)) add("released_without_delivery_and_reconciliation", r.store_id, `entry ${r.id} is available without its delivery/reconciliation basis`);

    // ── frozen money records ──
    for (const r of await rows(tx, sql`
      select f.order_id, f.store_id from order_financials f
       where f.payable_idr <> f.goods_proceeds_idr + f.included_sales_tax_idr + f.added_sales_tax_idr + f.shipping_charged_idr + f.cod_fee_idr + f.cod_fee_vat_idr
          or f.sale_amount_idr <> f.goods_proceeds_idr + f.included_sales_tax_idr + f.added_sales_tax_idr - f.affiliate_commission_idr
          or f.payable_idr <> (select o.total from "order" o where o.store_id = f.store_id and o.id = f.order_id)
          or f.goods_proceeds_idr <> (select coalesce(sum(l.commission_base_idr), 0) from order_line_financials l where l.store_id = f.store_id and l.order_id = f.order_id)
          or f.subtotal_idr <> (select coalesce(sum(l.line_gross_idr), 0) from order_line_financials l where l.store_id = f.store_id and l.order_id = f.order_id)`)) add("financials_identity", r.store_id, `order ${r.order_id}: allocation identity or line sums do not hold`);
    for (const r of await rows(tx, sql`select o.id, o.store_id from "order" o where not exists (select 1 from order_financials f where f.store_id = o.store_id and f.order_id = o.id)`)) add("order_without_financials", r.store_id, `order ${r.id} has no frozen financial snapshot`);
    for (const r of await rows(tx, sql`
      select c.order_id, c.store_id from shipment_cost c left join ledger_entry e on e.store_id = c.store_id and e.id = c.shipping_debit_entry_id
       where c.seller_shipping_debit_idr > 0 and (e.id is null or e.amount_idr <> -c.seller_shipping_debit_idr or e.kind <> 'shipping_debit')`)) add("shipment_cost_debit_differs", r.store_id, `order ${r.order_id}: the debit entry differs from the booked cost`);
    // BILL-4 funding (T-48 fix 1), recomputed from the frozen snapshot alone: the cost row carries the snapshot's discounts and charge, the identity charged + platform discount + debit = booked + margin
    // holds, and the seller pays the store discount plus only what exceeds charged + store + platform discount (never any part of the platform discount).
    for (const r of await rows(tx, sql`
      select c.order_id, c.store_id from shipment_cost c join order_financials f on f.store_id = c.store_id and f.order_id = c.order_id
       where c.shipping_discount_idr <> f.shipping_discount_idr or c.platform_shipping_discount_idr <> f.platform_shipping_discount_idr or c.shipping_charged_idr <> f.shipping_charged_idr
          or c.shipping_charged_idr + c.platform_shipping_discount_idr + c.seller_shipping_debit_idr <> c.booked_shipping_idr + c.platform_shipping_margin_idr
          or c.seller_shipping_debit_idr <> greatest(c.booked_shipping_idr - (c.shipping_charged_idr + c.shipping_discount_idr + c.platform_shipping_discount_idr), 0) + c.shipping_discount_idr`)) add("shipment_cost_funding_differs", r.store_id, `order ${r.order_id}: the booked cost does not follow the frozen funding (platform discount or seller debit differs)`);
    for (const r of await rows(tx, sql`select r.id, r.store_id from refund r join payment_attempt a on a.store_id = r.store_id and a.id = r.payment_attempt_id where r.amount_idr <> a.total_idr`)) add("refund_not_full_payment", r.store_id, `refund ${r.id} is not the full payment`);
    for (const r of await rows(tx, sql`select b.id from reconciliation_batch b where b.status = 'applied' and exists (select 1 from reconciliation_batch_item i where i.batch_id = b.id and i.voided_at is null and (i.reconciled_at is null or i.evidence_amount_idr <> i.cod_amount_idr))`)) add("applied_batch_unreconciled_item", null, `batch ${r.id}`);

    const [counts] = await rows(tx, sql`select (select count(*) from ledger_entry)::int as e, (select count(*) from "order")::int as o`);
    return { stores: [...stores.values()], violations, entries: n(counts?.e), orders: n(counts?.o), orderLessEntries: n(orderLess?.c) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
