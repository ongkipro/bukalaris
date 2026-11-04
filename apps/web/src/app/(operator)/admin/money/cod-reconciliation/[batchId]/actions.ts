"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { applyReconciliationBatch, submitReconciliationBatch, voidReconciliationBatch, voidReconciliationItem, voidStaleReconciliationBatch } from "@bukalaris/db";
import { redirect } from "next/navigation";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const back = (id: number) => `/admin/money/cod-reconciliation/${id}`;

export async function submitBatchAction(batchId: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/money/cod-reconciliation/[batchId]", "payouts.reconcile");
    await requirePortalCsrf(f);
    await submitReconciliationBatch(op, batchId, text(f, "reason"));
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(batchId), error) : `${back(batchId)}?saved=submitted`);
}

export async function applyBatchAction(batchId: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/money/cod-reconciliation/[batchId]", "payouts.reconcile");
    await requirePortalCsrf(f);
    await applyReconciliationBatch(op, batchId);
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(batchId), error) : `${back(batchId)}?saved=applied`);
}

export async function voidItemAction(batchId: number, itemId: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/money/cod-reconciliation/[batchId]", "payouts.reconcile");
    await requirePortalCsrf(f);
    await voidReconciliationItem(op, itemId);
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(batchId), error) : `${back(batchId)}?saved=item_voided`);
}

export async function voidBatchAction(batchId: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/money/cod-reconciliation/[batchId]", "payouts.reconcile");
    await requirePortalCsrf(f);
    await voidReconciliationBatch(op, batchId, text(f, "reason"));
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(batchId), error) : `${back(batchId)}?saved=voided`);
}

/** A batch made before accounts were recorded (or whose hash no longer matches) can never be applied: any holder of the capability voids it, then prepares it again. */
export async function voidStaleBatchAction(batchId: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/money/cod-reconciliation/[batchId]", "payouts.reconcile");
    await requirePortalCsrf(f);
    await voidStaleReconciliationBatch(op, batchId, text(f, "reason"));
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(batchId), error) : `${back(batchId)}?saved=stale_voided`);
}
