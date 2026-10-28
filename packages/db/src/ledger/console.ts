import { and, desc, eq, isNull, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { consumeApproval, payloadHash, requestApproval } from "../ops/capabilities-approvals.ts";
import { pgCode, requirePlatformCap } from "../ops/capabilities.ts";
import { auditLog, ledgerEntry, reconciliationBatch, reconciliationBatchItem } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { withStore } from "../platform/tenant.ts";
import { CONSOLE_QUEUE_LIMIT, STATEMENT_PAGE } from "./settings.ts";
import { ledgerBalance, lockStore, type LedgerRow } from "./ledger.ts";
import { CLAIM_NOTE } from "../seller/commerce/orders.ts";
import { staleBatchReason } from "./reconciliation.ts";

// Owner console services of the money screens (SA-08 payouts and refunds, SA-26 money position, SA-53 COD reconciliation). Every function takes the OperatorScope and
// checks its capability first; personal data (bank values) is never selected here except as the last four digits (see `payouts.ts`).

type Raw = Record<string, string | null>;
const exec = async (op: OperatorScope, q: SQL): Promise<Raw[]> => (await op.exec.execute(q)) as unknown as Raw[];

/** SA-26: the platform money position by liability class, from the read-only view (not a second ledger). `finance.read`. */
export async function consoleMoneyPosition(op: OperatorScope): Promise<{ class: string; amountIdr: number }[]> {
  await requirePlatformCap(op, "finance.read");
  return (await exec(op, sql`select class, amount_idr from platform_money_position`)).map((r) => ({ class: r.class!, amountIdr: Number(r.amount_idr) }));
}

export type BatchListItem = { id: number; status: string; shippingAccountId: number | null; evidenceRef: string; itemCount: number; evidenceTotalIdr: number; preparedBy: string | null; approvedBy: string | null; approvalRequestId: number | null; createdAt: string; appliedAt: string | null };
/** SA-53: reconciliation batches, newest first. `payouts.reconcile`. */
export async function reconciliationBatches(op: OperatorScope): Promise<BatchListItem[]> {
  await requirePlatformCap(op, "payouts.reconcile");
  const rows = await exec(op, sql`select id, status, shipping_account_id, evidence_ref, item_count, evidence_total_idr, prepared_by_user_id, approved_by_user_id, approval_request_id, created_at, applied_at from reconciliation_batch order by id desc limit ${CONSOLE_QUEUE_LIMIT}`);
  return rows.map((r) => ({ id: Number(r.id), status: r.status!, shippingAccountId: r.shipping_account_id == null ? null : Number(r.shipping_account_id), evidenceRef: r.evidence_ref!, itemCount: Number(r.item_count), evidenceTotalIdr: Number(r.evidence_total_idr), preparedBy: r.prepared_by_user_id, approvedBy: r.approved_by_user_id, approvalRequestId: r.approval_request_id == null ? null : Number(r.approval_request_id), createdAt: r.created_at!, appliedAt: r.applied_at }));
}

export type BatchItemView = { id: number; orderId: number; storeId: number; codAmountIdr: number; evidenceLineRef: string; evidenceAmountIdr: number; evidenceDate: string; reconciledAt: string | null; voided: boolean; brk: boolean };
export async function reconciliationBatchDetail(op: OperatorScope, batchId: number): Promise<{ batch: BatchListItem; items: BatchItemView[]; stale: "no_account" | "hash_changed" | null } | null> {
  await requirePlatformCap(op, "payouts.reconcile");
  const [b] = (await reconciliationBatches(op)).filter((x) => x.id === batchId);
  if (!b) return null;
  const [header] = await op.exec.select().from(reconciliationBatch).where(eq(reconciliationBatch.id, batchId));
  const live = await op.exec.select().from(reconciliationBatchItem).where(and(eq(reconciliationBatchItem.batchId, batchId), isNull(reconciliationBatchItem.voidedAt)));
  const stale = header ? staleBatchReason(header, live) : null; // a batch that can never be applied as it stands: the console offers the void-and-re-prepare action
  const items = await exec(op, sql`select id, order_id, store_id, cod_amount_idr, evidence_line_ref, evidence_amount_idr, evidence_date, reconciled_at, voided_at from reconciliation_batch_item where batch_id = ${batchId} order by order_id`);
  return { stale, batch: b, items: items.map((r) => ({ id: Number(r.id), orderId: Number(r.order_id), storeId: Number(r.store_id), codAmountIdr: Number(r.cod_amount_idr), evidenceLineRef: r.evidence_line_ref!, evidenceAmountIdr: Number(r.evidence_amount_idr), evidenceDate: String(r.evidence_date), reconciledAt: r.reconciled_at, voided: r.voided_at !== null, brk: r.cod_amount_idr !== r.evidence_amount_idr })) };
}

export type AwaitingReconciliation = { orderId: number; storeId: number; storeName: string; payableIdr: number; deliveredAt: string; inBatch: number | null };
/** COD parcels delivered but not reconciled: the pending COD sales waiting for an applied batch. */
export async function codAwaitingReconciliation(op: OperatorScope): Promise<AwaitingReconciliation[]> {
  await requirePlatformCap(op, "payouts.reconcile");
  const rows = await exec(op, sql`
    select o.id, o.store_id, s.name as store_name, f.payable_idr, o.updated_at,
           (select i.batch_id from reconciliation_batch_item i where i.order_id = o.id and i.voided_at is null limit 1) as in_batch
      from ledger_entry e join "order" o on o.store_id = e.store_id and o.id = e.order_id join order_financials f on f.store_id = o.store_id and f.order_id = o.id join store s on s.id = o.store_id
     where e.kind = 'sale' and e.status = 'pending' and o.payment_method = 'cod' and o.status = 'completed'
     order by o.id limit ${CONSOLE_QUEUE_LIMIT}`);
  return rows.map((r) => ({ orderId: Number(r.id), storeId: Number(r.store_id), storeName: r.store_name!, payableIdr: Number(r.payable_idr), deliveredAt: r.updated_at!, inBatch: r.in_batch == null ? null : Number(r.in_batch) }));
}

export type ManualCompletionCandidate = { orderId: number; storeId: number; storeName: string; method: string; claimedAt: string };
/** Orders in transit whose seller claimed delivery; the Owner console can complete them only through the four-eyes `cod.manual_complete`. */
export async function manualCompletionCandidates(op: OperatorScope): Promise<ManualCompletionCandidate[]> {
  await requirePlatformCap(op, "payouts.process");
  const rows = await exec(op, sql`
    select o.id, o.store_id, s.name as store_name, o.payment_method, h.created_at
      from "order" o join store s on s.id = o.store_id join order_status_history h on h.store_id = o.store_id and h.order_id = o.id and h.note = ${CLAIM_NOTE}
     where o.status = 'shipped' order by h.id limit ${CONSOLE_QUEUE_LIMIT}`);
  return rows.map((r) => ({ orderId: Number(r.id), storeId: Number(r.store_id), storeName: r.store_name!, method: r.payment_method!, claimedAt: r.created_at! }));
}

// ── Manual adjustment (`ledger.adjust`, four-eyes, unique business reference) ───────────────────────────────────────

const adjustmentInput = z.strictObject({
  storeId: z.number().int().positive(),
  amountIdr: z.number().int().refine((v) => v !== 0, "Jumlah tidak boleh nol."),
  businessRef: z.string().trim().min(4, "Referensi bisnis minimal 4 karakter.").max(80),
  reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500),
});
const adjustmentTarget = (i: { storeId: number; businessRef: string }) => `${i.storeId}:${i.businessRef}`;
const adjustmentPayload = (i: { storeId: number; amountIdr: number; businessRef: string; reason: string }) => ({ storeId: i.storeId, amountIdr: i.amountIdr, businessRef: i.businessRef, reason: i.reason });

/** Ask a second person to approve one exact adjustment. Never changes the books by itself. */
export async function requestLedgerAdjustment(op: OperatorScope, raw: unknown): Promise<{ approvalId: number }> {
  await requirePlatformCap(op, "ledger.adjust");
  const i = adjustmentInput.parse(raw);
  const req = await requestApproval(op, { actionKey: "ledger.adjust", targetKind: "ledger_adjustment", targetId: adjustmentTarget(i), payload: adjustmentPayload(i), reason: i.reason });
  return { approvalId: req.id };
}

/**
 * Apply the approved adjustment (the requester executes): the approval is consumed in the SAME transaction as the entry, under the store lock. The business reference is
 * unique per store, so a replay changes nothing; a negative adjustment that would take `available` below zero is refused (the database guard backs this).
 */
export async function applyLedgerAdjustment(op: OperatorScope, raw: unknown): Promise<{ entryId: number }> {
  await requirePlatformCap(op, "ledger.adjust");
  const { approvalId, ...rest } = z.looseObject({ approvalId: z.number().int().positive() }).parse(raw);
  const i = adjustmentInput.parse(rest);
  try {
    return await withStore(op.exec, i.storeId, async (tx) => {
      await lockStore(tx, i.storeId);
      await consumeApproval(tx, op, { approvalId, actionKey: "ledger.adjust", targetKind: "ledger_adjustment", targetId: adjustmentTarget(i), payloadSha256: payloadHash(adjustmentPayload(i)) });
      const [e] = await tx
        .insert(ledgerEntry)
        .values({ storeId: i.storeId, kind: "adjustment", status: "available", amountIdr: i.amountIdr, businessRef: i.businessRef, approvalRequestId: approvalId, note: i.reason, releasedAt: sql`now()` as unknown as Date, releaseBasis: "direct" })
        .returning({ id: ledgerEntry.id });
      await tx.insert(auditLog).values({ storeId: i.storeId, actorUserId: op.userId, actorCapability: "ledger.adjust", action: "ledger.adjust", subjectKind: "ledger_entry", subjectId: String(e!.id), outcome: "allowed", reason: i.businessRef });
      return { entryId: e!.id };
    });
  } catch (err) {
    if (pgCode(err) === "23505") throw new DomainError("duplicate_business_ref", "Referensi bisnis ini sudah dipakai untuk penyesuaian lain.");
    if (pgCode(err) === "23514") throw new DomainError("would_go_negative", "Penyesuaian ini akan membuat Saldo Tersedia negatif.");
    throw err;
  }
}

// ── SA-26 lists (money position, unknown transfers, late payments) and SA-17 (one store's statement) ──────────────────
// None of these selects a bank value or a buyer name: they carry ids, amounts, store names and states only, so they need `finance.read` and no personal-data evidence.

export type UnknownTransfer = { kind: "payout" | "refund"; id: number; storeId: number; storeName: string; amountIdr: number; unknownAt: string; claimedBy: string | null; claimExpiresAt: string | null };
/** Transfers an operator reported as "outcome unknown": they stay `processing` and allocated until bank evidence proves the effect. `finance.read`. */
export async function unknownTransfers(op: OperatorScope): Promise<UnknownTransfer[]> {
  await requirePlatformCap(op, "finance.read");
  const rows = await exec(op, sql`
    select 'payout' as kind, p.id, p.store_id, s.name as store_name, p.amount_idr, p.transfer_unknown_at, p.claimed_by_user_id, p.claim_expires_at from payout p join store s on s.id = p.store_id where p.status = 'processing' and p.transfer_unknown_at is not null
    union all
    select 'refund', r.id, r.store_id, s.name, r.amount_idr, r.transfer_unknown_at, r.claimed_by_user_id, r.claim_expires_at from refund r join store s on s.id = r.store_id where r.status = 'processing' and r.transfer_unknown_at is not null
    order by 6 limit ${CONSOLE_QUEUE_LIMIT}`);
  return rows.map((r) => ({ kind: r.kind as "payout" | "refund", id: Number(r.id), storeId: Number(r.store_id), storeName: r.store_name!, amountIdr: Number(r.amount_idr), unknownAt: r.transfer_unknown_at!, claimedBy: r.claimed_by_user_id, claimExpiresAt: r.claim_expires_at }));
}

export type LateObligation = { attemptId: string; storeId: number; storeName: string; orderId: number; amountIdr: number; createdAt: string; refundId: number | null; refundStatus: string | null };
/** Buyer money received after the order was terminal (T-49 obligation) and the refund opened for it. A row without a refund is a break to investigate, never auto-closed. `finance.read`. */
export async function latePaymentObligations(op: OperatorScope): Promise<LateObligation[]> {
  await requirePlatformCap(op, "finance.read");
  const rows = await exec(op, sql`
    select l.attempt_id, l.store_id, s.name as store_name, l.order_id, l.amount_idr, l.created_at, r.id as refund_id, r.status as refund_status
      from late_payment_obligation l join store s on s.id = l.store_id
      left join refund r on r.store_id = l.store_id and r.order_id = l.order_id and r.status <> 'failed'
     where l.status = 'open' order by l.created_at desc limit ${CONSOLE_QUEUE_LIMIT}`);
  return rows.map((r) => ({ attemptId: r.attempt_id!, storeId: Number(r.store_id), storeName: r.store_name!, orderId: Number(r.order_id), amountIdr: Number(r.amount_idr), createdAt: r.created_at!, refundId: r.refund_id == null ? null : Number(r.refund_id), refundStatus: r.refund_status }));
}

export type StoreLedgerView = { store: { id: number; name: string; slug: string }; balance: { availableIdr: number; pendingIdr: number }; rows: LedgerRow[]; next: number | null };
/** SA-17: one store's append-only statement and balances, keyset-paged on the entry id. `finance.read`; a store that does not exist is `null` (not-found), money is never edited here. */
export async function storeLedger(op: OperatorScope, storeId: number, opts: { cursor?: number; limit?: number } = {}): Promise<StoreLedgerView | null> {
  await requirePlatformCap(op, "finance.read");
  const [st] = await exec(op, sql`select id, name, slug from store where id = ${storeId}`);
  if (!st) return null;
  const limit = Math.min(opts.limit ?? STATEMENT_PAGE, 100);
  const rows = await op.exec
    .select()
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.storeId, storeId), opts.cursor ? lt(ledgerEntry.id, opts.cursor) : undefined))
    .orderBy(desc(ledgerEntry.id))
    .limit(limit + 1);
  return { store: { id: Number(st.id), name: st.name!, slug: st.slug! }, balance: await ledgerBalance(op.exec, storeId), rows: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1]!.id : null };
}
