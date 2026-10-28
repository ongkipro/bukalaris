import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../client.ts";
import { registerPlatformHandler } from "../ops/jobs/jobs.ts";
import { registerSchedule } from "../ops/jobs/scheduler.ts";
import { consumeApproval, payloadHash, requestApproval } from "../ops/capabilities-approvals.ts";
import { pgCode, requirePlatformCap } from "../ops/capabilities.ts";
import { auditLog, order, orderFinancials, reconciliationBatch, reconciliationBatchItem } from "../schema.ts";
import { applyProviderTransition } from "../seller/commerce/orders.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { withStore } from "../platform/tenant.ts";
import { PROVIDER_RECONCILIATION_ENABLED, RECONCILIATION_BATCH_MAX_ITEMS } from "./settings.ts";
import { consoleMutation } from "../ops/console.ts";
import { assertPayoutsNotFrozen, mapFrozen } from "./control.ts";

// COD reconciliation (ADR-0006 decision 4, BILL-5, D-14, SA-53). A COD sale is booked pending when the courier reports DELIVERED and becomes `available`
// only when its cash is reconciled. Until the provider's `isReconciliated` / `typeReconciliation` signal is observed and accepted (OPEN-F8,
// `PROVIDER_RECONCILIATION_ENABLED` = false) the ONLY release path is an Owner console batch: PREPARED by one staff member from carrier invoice evidence
// (capability `payouts.reconcile`), bound by a payload hash, APPROVED by a different staff member (four-eyes action `cod.reconcile_release`) and applied
// once by the preparer. A line whose evidence amount differs from the order's COD amount is a break: it blocks submission and is never auto-released.
// Manual delivery completion (`cod.manual_complete`) is a separate four-eyes action and never part of a batch.

export const RECONCILE_CAPABILITY = "payouts.reconcile" as const;
export const RECONCILE_ACTION = "cod.reconcile_release" as const;
export const MANUAL_COMPLETE_ACTION = "cod.manual_complete" as const;

const lineInput = z.strictObject({
  orderId: z.number().int().positive(),
  evidenceLineRef: z.string().trim().min(1, "Referensi baris bukti wajib diisi.").max(120),
  evidenceAmountIdr: z.number().int().nonnegative(),
  evidenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal bukti harus YYYY-MM-DD."),
});
const prepareInput = z.strictObject({
  shippingAccountId: z.number().int().positive().optional(),
  evidenceRef: z.string().trim().min(3, "Referensi invoice/laporan kurir minimal 3 karakter.").max(160),
  lines: z.array(lineInput).min(1, "Batch kosong.").max(RECONCILIATION_BATCH_MAX_ITEMS),
});

export type BatchItemRow = typeof reconciliationBatchItem.$inferSelect;

/** Step 1: a draft batch and its items. Every order must be a delivered COD order; the item's COD amount is read from the frozen financials, never typed. */
export async function prepareReconciliationBatch(op: OperatorScope, raw: unknown): Promise<{ batchId: number; breaks: { orderId: number; codAmountIdr: number; evidenceAmountIdr: number }[] }> {
  await requirePlatformCap(op, RECONCILE_CAPABILITY);
  const input = prepareInput.parse(raw);
  if (new Set(input.lines.map((l) => l.orderId)).size !== input.lines.length) throw new DomainError("duplicate_order", "Satu pesanan hanya boleh muncul sekali dalam batch.");
  return op.exec.transaction(async (tx) => {
    const orders = await tx
      .select({ id: order.id, storeId: order.storeId, shippingAccountId: order.shippingAccountId, method: order.paymentMethod, status: order.status, payable: orderFinancials.payableIdr })
      .from(order)
      .innerJoin(orderFinancials, and(eq(orderFinancials.storeId, order.storeId), eq(orderFinancials.orderId, order.id)))
      .where(inArray(order.id, input.lines.map((l) => l.orderId)));
    const byId = new Map(orders.map((o) => [o.id, o]));
    for (const l of input.lines) {
      const o = byId.get(l.orderId);
      if (!o) throw new DomainError("not_found", `Pesanan ${l.orderId} tidak ditemukan.`);
      if (o.method !== "cod" || o.status !== "completed") throw new DomainError("not_reconcilable", `Pesanan ${l.orderId} bukan pesanan COD yang sudah terkirim.`);
    }
    const shippingAccountId = input.shippingAccountId ?? orders[0]!.shippingAccountId;
    if (orders.some((o) => o.shippingAccountId !== shippingAccountId)) throw new DomainError("account_mismatch", "Satu batch hanya boleh memuat bukti dari satu akun pengiriman.");
    const [batch] = await tx.insert(reconciliationBatch).values({ shippingAccountId, source: "owner_batch", evidenceRef: input.evidenceRef, preparedByUserId: op.userId }).returning({ id: reconciliationBatch.id });
    try {
      await tx.insert(reconciliationBatchItem).values(
        input.lines.map((l) => {
          const o = byId.get(l.orderId)!;
          return { batchId: batch!.id, orderId: l.orderId, storeId: o.storeId, codAmountIdr: o.payable, evidenceLineRef: l.evidenceLineRef, evidenceAmountIdr: l.evidenceAmountIdr, evidenceDate: l.evidenceDate };
        }),
      );
    } catch (err) {
      if (pgCode(err) === "23505") throw new DomainError("already_reconciled", "Salah satu pesanan sudah masuk batch rekonsiliasi lain.");
      throw err;
    }
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: RECONCILE_CAPABILITY, action: "reconciliation.prepare", subjectKind: "reconciliation_batch", subjectId: String(batch!.id), outcome: "allowed", reason: `items:${input.lines.length}` });
    return { batchId: batch!.id, breaks: await breaksOf(tx, batch!.id) };
  });
}

type Exec = Pick<Db, "select" | "update" | "insert" | "execute">;
const breaksOf = async (tx: Exec, batchId: number) =>
  (
    await tx
      .select({ orderId: reconciliationBatchItem.orderId, codAmountIdr: reconciliationBatchItem.codAmountIdr, evidenceAmountIdr: reconciliationBatchItem.evidenceAmountIdr })
      .from(reconciliationBatchItem)
      .where(and(eq(reconciliationBatchItem.batchId, batchId), isNull(reconciliationBatchItem.voidedAt)))
  ).filter((i) => i.codAmountIdr !== i.evidenceAmountIdr);

/** Resolve a break by removing the line from a DRAFT batch (the order stays unreconciled and pending). */
export async function voidReconciliationItem(op: OperatorScope, itemId: number): Promise<void> {
  await requirePlatformCap(op, RECONCILE_CAPABILITY);
  await op.exec.transaction(async (tx) => {
    const [it] = await tx.select({ batchId: reconciliationBatchItem.batchId }).from(reconciliationBatchItem).where(eq(reconciliationBatchItem.id, itemId));
    if (!it) throw new DomainError("not_found", "Baris tidak ditemukan.");
    const [b] = await tx.select({ status: reconciliationBatch.status, by: reconciliationBatch.preparedByUserId }).from(reconciliationBatch).where(eq(reconciliationBatch.id, it.batchId));
    if (b?.status !== "draft" || b.by !== op.userId) throw new DomainError("not_draft", "Baris hanya bisa dihapus dari batch draf milik Anda.");
    await tx.update(reconciliationBatchItem).set({ voidedAt: sql`now()` as unknown as Date }).where(and(eq(reconciliationBatchItem.id, itemId), isNull(reconciliationBatchItem.voidedAt)));
  });
}

/** Everything the approver must see and the hash binds: the evidence reference and every live line. */
const batchPayload = (shippingAccountId: number | null, evidenceRef: string, items: Pick<BatchItemRow, "orderId" | "codAmountIdr" | "evidenceLineRef" | "evidenceAmountIdr" | "evidenceDate">[]) => ({
  shippingAccountId, evidenceRef,
  items: [...items].sort((a, b) => a.orderId - b.orderId).map((i) => ({ orderId: i.orderId, codAmountIdr: i.codAmountIdr, evidenceLineRef: i.evidenceLineRef, evidenceAmountIdr: i.evidenceAmountIdr, evidenceDate: i.evidenceDate })),
});

/** Step 2: freeze the header, request the four-eyes approval (the preparer is the requester). A batch with a break is refused and stays a draft. */
export async function submitReconciliationBatch(op: OperatorScope, batchId: number, reason: string): Promise<{ approvalId: number; payloadSha256: string }> {
  await requirePlatformCap(op, RECONCILE_CAPABILITY);
  const prepared = await op.exec.transaction(async (tx) => {
    const [b] = await tx.select().from(reconciliationBatch).where(eq(reconciliationBatch.id, batchId)).for("update");
    if (!b || b.preparedByUserId !== op.userId) throw new DomainError("not_found", "Batch tidak ditemukan.");
    if (b.status !== "draft") throw new DomainError("not_draft", "Batch ini sudah diajukan.");
    if (b.shippingAccountId === null) throw new DomainError("legacy_batch", "Batch ini dibuat sebelum akun pengiriman dicatat dan tidak bisa diajukan. Batalkan, lalu siapkan ulang dari bukti yang sama.");
    const items = await tx.select().from(reconciliationBatchItem).where(and(eq(reconciliationBatchItem.batchId, batchId), isNull(reconciliationBatchItem.voidedAt)));
    if (items.length === 0) throw new DomainError("empty_batch", "Batch tidak punya baris.");
    const breaks = items.filter((i) => i.codAmountIdr !== i.evidenceAmountIdr);
    if (breaks.length > 0) throw new DomainError("reconciliation_break", `Ada ${breaks.length} baris yang nilainya berbeda dari nilai COD pesanan (pesanan ${breaks.map((x) => x.orderId).join(", ")}); selesaikan atau hapus sebelum diajukan.`);
    const payload = batchPayload(b.shippingAccountId, b.evidenceRef, items);
    return { payload, sha: payloadHash(payload), items, evidenceRef: b.evidenceRef, shippingAccountId: b.shippingAccountId };
  });
  // The approval request is its own transaction (T-60 service); the batch is moved to pending_approval right after, in one more, bound to the request id.
  const req = await requestApproval(op, { actionKey: RECONCILE_ACTION, targetKind: "reconciliation_batch", targetId: String(batchId), payload: { batchId, shippingAccountId: prepared.shippingAccountId, payloadSha256: prepared.sha, itemCount: prepared.items.length, evidenceRef: prepared.evidenceRef }, reason });
  await op.exec.transaction(async (tx) => {
    const total = prepared.items.reduce((s, i) => s + i.evidenceAmountIdr, 0);
    const rows = await tx
      .update(reconciliationBatch)
      .set({ status: "pending_approval", payloadSha256: prepared.sha, itemCount: prepared.items.length, evidenceTotalIdr: total, approvalRequestId: req.id })
      .where(and(eq(reconciliationBatch.id, batchId), eq(reconciliationBatch.status, "draft")))
      .returning({ id: reconciliationBatch.id });
    if (rows.length === 0) throw new DomainError("not_draft", "Batch ini sudah diajukan.");
  });
  return { approvalId: req.id, payloadSha256: prepared.sha };
}

/**
 * Step 3: the preparer applies the batch the other person approved. The approval is consumed in the SAME transaction (a rolled-back apply leaves it
 * unconsumed), bound to this batch and the hash of its CURRENT items (an item changed after approval no longer matches). A second apply finds the batch
 * applied and the approval executed, so nothing is reconciled twice.
 */
export async function applyReconciliationBatch(op: OperatorScope, batchId: number): Promise<{ items: number }> {
  await requirePlatformCap(op, RECONCILE_CAPABILITY);
  return mapFrozen(() => op.exec.transaction(async (tx) => {
    await assertPayoutsNotFrozen(tx);
    const [b] = await tx.select().from(reconciliationBatch).where(eq(reconciliationBatch.id, batchId)).for("update");
    if (!b || b.preparedByUserId !== op.userId) throw new DomainError("not_found", "Batch tidak ditemukan.");
    if (b.status !== "pending_approval" || !b.approvalRequestId || !b.payloadSha256) throw new DomainError("not_pending", "Batch ini belum menunggu persetujuan atau sudah diproses.");
    const items = await tx.select().from(reconciliationBatchItem).where(and(eq(reconciliationBatchItem.batchId, batchId), isNull(reconciliationBatchItem.voidedAt)));
    const currentSha = payloadHash(batchPayload(b.shippingAccountId, b.evidenceRef, items));
    if (currentSha !== b.payloadSha256) throw new DomainError("approval_invalid", "Isi batch berubah setelah diajukan; ajukan ulang.");
    const { decidedBy } = await consumeApproval(tx, op, {
      approvalId: b.approvalRequestId,
      actionKey: RECONCILE_ACTION,
      targetKind: "reconciliation_batch",
      targetId: String(batchId),
      payloadSha256: payloadHash({ batchId, shippingAccountId: b.shippingAccountId, payloadSha256: b.payloadSha256, itemCount: b.itemCount, evidenceRef: b.evidenceRef }),
    });
    await tx.update(reconciliationBatch).set({ status: "applied", appliedAt: sql`now()` as unknown as Date, approvedByUserId: decidedBy }).where(eq(reconciliationBatch.id, batchId));
    await tx.update(reconciliationBatchItem).set({ reconciledAt: sql`now()` as unknown as Date }).where(and(eq(reconciliationBatchItem.batchId, batchId), isNull(reconciliationBatchItem.voidedAt)));
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: RECONCILE_CAPABILITY, action: "reconciliation.apply", subjectKind: "reconciliation_batch", subjectId: String(batchId), outcome: "allowed", reason: `approved_by:${decidedBy}` });
    return { items: items.length };
  }));
}

/** Withdraw a draft or pending batch (the approval, if any, simply expires unused). */
export async function voidReconciliationBatch(op: OperatorScope, batchId: number, reason: string): Promise<void> {
  await requirePlatformCap(op, RECONCILE_CAPABILITY);
  const why = z.string().trim().min(5, "Alasan minimal 5 karakter.").parse(reason);
  await op.exec.transaction(async (tx) => {
    const rows = await tx
      .update(reconciliationBatch)
      .set({ status: "void", voidReason: why })
      .where(and(eq(reconciliationBatch.id, batchId), inArray(reconciliationBatch.status, ["draft", "pending_approval"]), eq(reconciliationBatch.preparedByUserId, op.userId)))
      .returning({ id: reconciliationBatch.id });
    if (rows.length === 0) throw new DomainError("not_found", "Batch tidak ditemukan atau sudah diproses.");
    await tx.update(reconciliationBatchItem).set({ voidedAt: sql`now()` as unknown as Date }).where(and(eq(reconciliationBatchItem.batchId, batchId), isNull(reconciliationBatchItem.voidedAt)));
  });
}

/** The reason a batch can never be applied as it stands (or null): it names no shipping account (made before T-48), or its frozen hash no longer matches what the batch hashes to today (the hash now includes the account). */
export function staleBatchReason(b: { status: string; shippingAccountId: number | null; evidenceRef: string; payloadSha256: string | null }, items: Pick<BatchItemRow, "orderId" | "codAmountIdr" | "evidenceLineRef" | "evidenceAmountIdr" | "evidenceDate">[]): "no_account" | "hash_changed" | null {
  if (b.status !== "draft" && b.status !== "pending_approval") return null;
  if (b.shippingAccountId === null) return "no_account";
  return b.status === "pending_approval" && b.payloadSha256 !== payloadHash(batchPayload(b.shippingAccountId, b.evidenceRef, items)) ? "hash_changed" : null;
}

/**
 * Owner console action (T-48 fix 6): void a batch that can never be applied, by ANY holder of `payouts.reconcile` (not only its preparer: the preparer of a
 * pre-account batch may be long gone). Voiding moves no money and releases nothing, so no second person is required; it is audited with the reason and the
 * staleness cause. Its lines are freed, so the same COD orders can be prepared again (the new batch names the account, and its approval binds it).
 * A batch that is still valid is refused here: it is withdrawn by its preparer through `voidReconciliationBatch`.
 */
export async function voidStaleReconciliationBatch(op: OperatorScope, batchId: number, reason: string): Promise<{ cause: "no_account" | "hash_changed" }> {
  const why = z.string().trim().min(5, "Alasan minimal 5 karakter.").max(300).parse(reason);
  return consoleMutation(op, { capability: RECONCILE_CAPABILITY, action: "reconciliation.void_stale", targetKind: "reconciliation_batch", targetId: String(batchId), reason: why, reasonCode: "stale_batch" }, async (tx) => {
    const [b] = await tx.select().from(reconciliationBatch).where(eq(reconciliationBatch.id, batchId)).for("update");
    if (!b || (b.status !== "draft" && b.status !== "pending_approval")) throw new DomainError("not_found", "Batch tidak ditemukan atau sudah diproses.");
    const items = await tx.select().from(reconciliationBatchItem).where(and(eq(reconciliationBatchItem.batchId, batchId), isNull(reconciliationBatchItem.voidedAt)));
    const cause = staleBatchReason(b, items);
    if (!cause) throw new DomainError("not_stale", "Batch ini masih berlaku. Penyiapnya membatalkannya lewat Batalkan batch.");
    await tx.update(reconciliationBatch).set({ status: "void", voidReason: `batch lama (${cause}): ${why}` }).where(eq(reconciliationBatch.id, batchId));
    await tx.update(reconciliationBatchItem).set({ voidedAt: sql`now()` as unknown as Date }).where(and(eq(reconciliationBatchItem.batchId, batchId), isNull(reconciliationBatchItem.voidedAt)));
    return { cause };
  });
}

// ── Provider-sourced reconciliation (OPEN-F8, UNVERIFIED): OFF ───────────────────────────────────────────────────

export const COD_RECONCILIATION_POLL = "cod.reconciliation.poll";
/**
 * JOB-33. While `PROVIDER_RECONCILIATION_ENABLED` is false (the default, OPEN-F8) the poll reads nothing and writes nothing: no reconciliation item, no
 * release. The flag is a parameter only so a test can prove the off state; turning it on needs the owner's written acceptance of the observed
 * provider signal AND an implementation of that signal, which does not exist, so enabling it refuses loudly instead of guessing semantics.
 */
export async function runProviderReconciliationPoll(_db: Db, enabled: boolean = PROVIDER_RECONCILIATION_ENABLED): Promise<{ skipped: boolean }> {
  if (!enabled) return { skipped: true };
  throw new Error("provider reconciliation is not implemented: the isReconciliated/typeReconciliation semantics are UNVERIFIED (OPEN-F8)");
}
registerSchedule({ kind: COD_RECONCILIATION_POLL, period: "hour", catchUp: 0 });
registerPlatformHandler(COD_RECONCILIATION_POLL, async ({ db }) => {
  await runProviderReconciliationPoll(db);
});

// ── cod.manual_complete: the four-eyes completion of a COD (or manual-resi) order without a courier DELIVERED ─────

export const manualCompleteInput = z.strictObject({
  orderId: z.number().int().positive(),
  evidenceRef: z.string().trim().min(4, "Referensi bukti kurir minimal 4 karakter.").max(160),
  reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500),
});

/** Request (the requester will also be the executor, T-60). The order must be in transit; the evidence reference of the courier proof is part of the approved payload. */
export async function requestManualCompletion(op: OperatorScope, raw: unknown): Promise<{ approvalId: number }> {
  const input = manualCompleteInput.parse(raw);
  await requirePlatformCap(op, "payouts.process");
  const [o] = await op.exec.select({ status: order.status, storeId: order.storeId }).from(order).where(eq(order.id, input.orderId));
  if (!o) throw new DomainError("not_found", "Pesanan tidak ditemukan.");
  if (o.status !== "shipped") throw new DomainError("not_shipped", "Hanya pesanan berstatus Dikirim yang bisa diselesaikan manual.");
  const req = await requestApproval(op, { actionKey: MANUAL_COMPLETE_ACTION, targetKind: "order", targetId: String(input.orderId), payload: { orderId: input.orderId, storeId: o.storeId, evidenceRef: input.evidenceRef }, reason: input.reason });
  return { approvalId: req.id };
}

/** Execute the approved completion: approval consumed and the order completed in one transaction, with `source = manual_approved`. */
export async function applyManualCompletion(op: OperatorScope, input: { orderId: number; approvalId: number; evidenceRef: string }): Promise<{ status: string }> {
  await requirePlatformCap(op, "payouts.process");
  const [o] = await op.exec.select({ storeId: order.storeId }).from(order).where(eq(order.id, input.orderId));
  if (!o) throw new DomainError("not_found", "Pesanan tidak ditemukan.");
  return withStore(op.exec, o.storeId, async (tx) => {
    await consumeApproval(tx, op, { approvalId: input.approvalId, actionKey: MANUAL_COMPLETE_ACTION, targetKind: "order", targetId: String(input.orderId), payloadSha256: payloadHash({ orderId: input.orderId, storeId: o.storeId, evidenceRef: input.evidenceRef }) });
    const r = await applyProviderTransition(tx, o.storeId, input.orderId, "completed", { source: "manual_approved", note: `bukti: ${input.evidenceRef}`, actorUserId: op.userId });
    if (r.outcome === "rejected") throw new DomainError("not_completable", "Pesanan tidak bisa diselesaikan dari status ini."); // rolls back the approval consumption
    await tx.insert(auditLog).values({ storeId: o.storeId, actorUserId: op.userId, actorCapability: "payouts.process", action: "order.manual_complete", subjectKind: "order", subjectId: String(input.orderId), outcome: "allowed", reason: input.evidenceRef.slice(0, 200) });
    return { status: r.status };
  });
}

