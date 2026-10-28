import { sql } from "drizzle-orm";
import type { Db, Executor } from "../client.ts";
import { registerPlatformHandler } from "../ops/jobs/jobs.ts";
import { registerSchedule } from "../ops/jobs/scheduler.ts";
import { withStore } from "../platform/tenant.ts";
import { LEDGER_RELEASE_BATCH } from "./settings.ts";
import { pgCode } from "../ops/capabilities.ts";
import { ledgerBalance, lockStore } from "./ledger.ts";
import { convertLateObligations } from "./refunds.ts";

// JOB-24 `ledger.release` (ADR-0006 decision 4, D-14). Seller money becomes `available` only for parcels that are DELIVERED and RECONCILED:
//  - a prepaid sale (booked pending at paid) is released when its order is `completed` (basis `delivery`);
//  - a COD sale (booked pending at the courier's DELIVERED) is released only through an item of an APPLIED reconciliation batch (basis `reconciliation`);
//  - nothing is released for an order with a return reversal, at `shipped`, or while in transit.
// The job takes the per-store lock, then the candidate sale rows `FOR UPDATE` in ascending id, and updates only `WHERE status = 'pending' AND NOT EXISTS
// (a return reversal of the order)`; a sale released and a sale reversed race on the same row lock, so exactly one of them wins (the database guards back
// this up). The other pending entries of the order (cashback, its shipping debit) are released together with its sale. A debit whose parcel earned no sale
// (prepaid returned in transit, COD never delivered, OPEN-F6) is netted against the store's available balance at the next release, never below zero.

export const LEDGER_RELEASE = "ledger.release";

type Candidate = { id: number; order_id: number; kind: string; basis: "delivery" | "reconciliation"; item_id: number | null };
export type ReleaseResult = { released: number; netted: number; stores: number };

/** Release everything releasable for ONE store; idempotent. Callers: the periodic job and tests. */
export async function releaseStore(db: Db | Executor, storeId: number): Promise<{ released: number; netted: number }> {
  return withStore(db, storeId, async (tx) => {
    await lockStore(tx, storeId);
    // Sales and cashback of delivered prepaid orders and of reconciled COD orders; rows locked in ascending id.
    const sales = (await tx.execute(sql`
      select e.id, e.order_id, e.kind,
             case when o.payment_method = 'cod' then 'reconciliation' else 'delivery' end as basis,
             i.id as item_id
        from ledger_entry e
        join "order" o on o.store_id = e.store_id and o.id = e.order_id
        left join reconciliation_batch_item i on i.store_id = e.store_id and i.order_id = e.order_id and i.voided_at is null and i.reconciled_at is not null
        left join reconciliation_batch b on b.id = i.batch_id and b.status = 'applied'
       where e.store_id = ${storeId} and e.status = 'pending' and e.kind in ('sale', 'cashback') and o.status = 'completed'
         and (o.payment_method <> 'cod' or b.id is not null)
         and not exists (select 1 from ledger_entry r where r.store_id = e.store_id and r.order_id = e.order_id and r.kind = 'return_reversal')
       order by e.id
         for update of e`)) as unknown as Candidate[];
    let released = 0;
    const done = new Set<number>();
    for (const c of sales) {
      const rows = (await tx.execute(sql`
        update ledger_entry set status = 'available', released_at = now(), release_basis = ${c.basis}, reconciliation_item_id = ${c.item_id}
         where id = ${c.id} and store_id = ${storeId} and status = 'pending'
           and not exists (select 1 from ledger_entry r where r.store_id = ${storeId} and r.order_id = ${c.order_id} and r.kind = 'return_reversal')
        returning id`)) as unknown as { id: number }[];
      if (rows.length === 0) continue; // lost the race to a reversal or an earlier run
      released += 1;
      done.add(c.order_id);
    }
    // The shipping debit (and its reversal) of a released order follows its sale, after every sale of this run is released (credits first). Each order's debit runs in a
    // SAVEPOINT: a debit the available balance cannot cover (the database refuses it) rolls back only itself, stays pending and is netted when it fits (OPEN-F6, `netOrphanDebits`),
    // instead of aborting the whole store's release every minute (T-37 review P3-3).
    for (const c of sales.filter((x) => x.kind === "sale" && done.has(x.order_id))) {
      try {
        released += await tx.transaction(async (sp) => {
          const reversal = await releaseDebitKind(sp, storeId, c, "shipping_debit_reversal");
          return reversal + (await releaseDebitKind(sp, storeId, c, "shipping_debit"));
        });
      } catch (err) {
        if (pgCode(err) !== "23514") throw err;
      }
    }
    return { released, netted: await netOrphanDebits(tx, storeId) };
  });
}

async function releaseDebitKind(tx: Executor, storeId: number, c: Candidate, kind: "shipping_debit" | "shipping_debit_reversal"): Promise<number> {
  const rows = (await tx.execute(sql`
    update ledger_entry set status = 'available', released_at = now(), release_basis = ${c.basis}, reconciliation_item_id = ${c.item_id}
     where store_id = ${storeId} and order_id = ${c.order_id} and status = 'pending' and kind = ${kind}
    returning id`)) as unknown as { id: number }[];
  return rows.length;
}

/**
 * OPEN-F6 (D-22 item 2): the carried debit of a parcel that earned no sale (returned or cancelled before delivery) is netted against the store's available
 * balance, oldest first, only while `available` stays >= 0. What does not fit stays pending for a four-eyes `adjustment`.
 */
async function netOrphanDebits(tx: Executor, storeId: number): Promise<number> {
  // The order is joined only to read its STATUS; the amounts are summed in code from the entries themselves (no balance query touches `order`).
  const rows = (await tx.execute(sql`
    select e.id, e.order_id, e.amount_idr
      from ledger_entry e join "order" o on o.store_id = e.store_id and o.id = e.order_id
     where e.store_id = ${storeId} and e.status = 'pending' and e.kind in ('shipping_debit', 'shipping_debit_reversal') and (
         (o.status in ('cancelled', 'returned')
          and (not exists (select 1 from ledger_entry s where s.store_id = e.store_id and s.order_id = e.order_id and s.kind = 'sale')
               or exists (select 1 from ledger_entry r where r.store_id = e.store_id and r.order_id = e.order_id and r.kind = 'return_reversal')))
         or (o.status = 'completed' and exists (select 1 from ledger_entry s where s.store_id = e.store_id and s.order_id = e.order_id and s.kind = 'sale' and s.status = 'available'))
       )
     order by e.order_id, e.amount_idr desc, e.id`)) as unknown as { id: number; order_id: string; amount_idr: string }[];
  const byOrder = new Map<string, { id: number; amount: number }[]>();
  for (const r of rows) byOrder.set(r.order_id, [...(byOrder.get(r.order_id) ?? []), { id: r.id, amount: Number(r.amount_idr) }]);
  let netted = 0;
  for (const entries of [...byOrder.values()].sort((a, b) => a[0]!.id - b[0]!.id)) {
    const total = entries.reduce((s, e) => s + e.amount, 0);
    if ((await ledgerBalance(tx, storeId)).availableIdr + total < 0) continue; // does not fit: stays pending
    for (const e of entries) {
      await tx.execute(sql`update ledger_entry set status = 'available', released_at = now(), release_basis = 'netting' where id = ${e.id} and store_id = ${storeId} and status = 'pending'`);
      netted += 1;
    }
  }
  return netted;
}

/**
 * One page of stores (ascending id, after `after`) that have something RELEASABLE now: the same conditions `releaseStore` uses. A pending row that can never release (a reversed
 * sale and its reversal, the cashback of a reversed order, a debit with its reversal) does not make its store a candidate, and the run pages with a cursor, so no store
 * starves behind stuck ones (T-37 review P1-1).
 */
async function candidateStores(db: Db, limit: number, after: number): Promise<number[]> {
  const rows = (await db.execute(sql`
    select distinct e.store_id
      from ledger_entry e join "order" o on o.store_id = e.store_id and o.id = e.order_id
     where e.status = 'pending' and e.store_id > ${after}
       and (
         (e.kind in ('sale', 'cashback') and o.status = 'completed'
          and (o.payment_method <> 'cod' or exists (select 1 from reconciliation_batch_item i join reconciliation_batch b on b.id = i.batch_id and b.status = 'applied'
                                                      where i.store_id = e.store_id and i.order_id = e.order_id and i.voided_at is null and i.reconciled_at is not null))
          and not exists (select 1 from ledger_entry r where r.store_id = e.store_id and r.order_id = e.order_id and r.kind = 'return_reversal'))
         or (e.kind in ('shipping_debit', 'shipping_debit_reversal')
             and ((o.status in ('cancelled', 'returned')
                   and (not exists (select 1 from ledger_entry s where s.store_id = e.store_id and s.order_id = e.order_id and s.kind = 'sale')
                        or exists (select 1 from ledger_entry r where r.store_id = e.store_id and r.order_id = e.order_id and r.kind = 'return_reversal')))
                  or (o.status = 'completed' and exists (select 1 from ledger_entry s where s.store_id = e.store_id and s.order_id = e.order_id and s.kind = 'sale' and s.status = 'available'))))
       )
     order by e.store_id limit ${limit}`)) as unknown as { store_id: string }[];
  return rows.map((r) => Number(r.store_id));
}

/** One run of the job over every store with pending entries. One failing store never blocks the others (reported, not swallowed). */
export async function releaseAll(db: Db, limit = LEDGER_RELEASE_BATCH): Promise<ReleaseResult & { failures: { storeId: number; error: string }[] }> {
  const out = { released: 0, netted: 0, stores: 0, failures: [] as { storeId: number; error: string }[] };
  let after = 0;
  for (;;) {
    const page = await candidateStores(db, limit, after);
    if (page.length === 0) break;
    for (const storeId of page) {
      try {
        const r = await releaseStore(db, storeId);
        out.released += r.released;
        out.netted += r.netted;
        out.stores += 1;
      } catch (err) {
        out.failures.push({ storeId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    after = page[page.length - 1]!;
  }
  return out;
}

registerSchedule({ kind: LEDGER_RELEASE, period: "minute", catchUp: 0 });
registerPlatformHandler(LEDGER_RELEASE, async ({ db }) => {
  await convertLateObligations(db); // refunds for obligations opened before the payment path created them itself (idempotent)
  const r = await releaseAll(db);
  if (r.failures.length > 0) throw new Error(`ledger.release failed for ${r.failures.length} store(s): ${r.failures.map((f) => `${f.storeId}: ${f.error}`).join("; ").slice(0, 400)}`);
});
