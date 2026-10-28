import { sql } from "drizzle-orm";
import { requirePlatformCap } from "../ops/capabilities.ts";
import type { OperatorScope } from "../platform/scoped.ts";

export interface AccountReconciliationRow {
  accountId: number;
  storeId: number;
  storeName: string;
  kind: "partner_managed" | "platform_master";
  awaitingOrders: number;
  awaitingCodIdr: number;
  openBatches: number;
  appliedBatches: number;
}

/**
 * COD reconciliation by provider account (ADR-0007, SA-53). A batch belongs to exactly one frozen order account (database guard), so these counts can never
 * mix a store's partner account with the platform master account. Reads ids, names and amounts only; capability `payouts.reconcile`.
 */
export async function shippingReconciliationByAccount(op: OperatorScope): Promise<AccountReconciliationRow[]> {
  await requirePlatformCap(op, "payouts.reconcile");
  const rows = (await op.exec.execute(sql`
    select a.id, a.store_id, s.name as store_name, a.kind,
      (select count(*) from public."order" o join public.ledger_entry e on e.store_id = o.store_id and e.order_id = o.id and e.kind = 'sale' and e.status = 'pending'
        where o.store_id = a.store_id and o.shipping_account_id = a.id and o.payment_method = 'cod' and o.status = 'completed')::int as awaiting_orders,
      (select coalesce(sum(f.payable_idr), 0) from public."order" o join public.ledger_entry e on e.store_id = o.store_id and e.order_id = o.id and e.kind = 'sale' and e.status = 'pending'
        join public.order_financials f on f.store_id = o.store_id and f.order_id = o.id
        where o.store_id = a.store_id and o.shipping_account_id = a.id and o.payment_method = 'cod' and o.status = 'completed')::bigint as awaiting_cod,
      (select count(*) from public.reconciliation_batch b where b.shipping_account_id = a.id and b.status in ('draft', 'pending_approval'))::int as open_batches,
      (select count(*) from public.reconciliation_batch b where b.shipping_account_id = a.id and b.status = 'applied')::int as applied_batches
    from public.store_shipping_account a join public.store s on s.id = a.store_id
    where exists (select 1 from public."order" o where o.shipping_account_id = a.id) or exists (select 1 from public.reconciliation_batch b where b.shipping_account_id = a.id)
    order by a.id limit 200`)) as unknown as { id: string; store_id: string; store_name: string; kind: AccountReconciliationRow["kind"]; awaiting_orders: number; awaiting_cod: string; open_batches: number; applied_batches: number }[];
  return rows.map((r) => ({ accountId: Number(r.id), storeId: Number(r.store_id), storeName: r.store_name, kind: r.kind, awaitingOrders: r.awaiting_orders, awaitingCodIdr: Number(r.awaiting_cod), openBatches: r.open_batches, appliedBatches: r.applied_batches }));
}
