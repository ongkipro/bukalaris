"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { applyManualCompletion, DomainError, prepareReconciliationBatch, requestManualCompletion } from "@bukalaris/db";
import { redirect } from "next/navigation";

// SA-53 actions (T-37). The batch is PREPARED by one staff member from carrier invoice evidence, APPROVED by another in Persetujuan (`cod.reconcile_release`), and applied by the
// preparer; the amounts come from the frozen COD amounts of the orders, never from the form, and a line whose evidence differs is a break that blocks submission.
const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const BACK = "/admin/money/cod-reconciliation";

/** One evidence line per row: `orderId; carrier line reference; amount; YYYY-MM-DD` (semicolon, tab or comma separated). */
function parseLines(raw: string) {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((l, i) => {
    const [orderId, ref, amount, date] = l.split(/\s*[;\t,]\s*/);
    if (!orderId || !ref || !amount || !date) throw new DomainError("bad_line", `Baris ${i + 1}: isi "id pesanan; referensi baris kurir; jumlah; tanggal YYYY-MM-DD".`);
    return { orderId: Number(orderId), evidenceLineRef: ref, evidenceAmountIdr: Number(amount.replace(/\./g, "")), evidenceDate: date };
  });
}

export async function prepareBatchAction(f: FormData) {
  let error: string | undefined;
  let batchId: number | undefined;
  try {
    const { op } = await consoleActionOp("/admin/money/cod-reconciliation", "payouts.reconcile");
    await requirePortalCsrf(f);
    batchId = (await prepareReconciliationBatch(op, { evidenceRef: text(f, "evidenceRef"), lines: parseLines(text(f, "lines")) })).batchId;
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(BACK, error) : `${BACK}/${batchId}?saved=prepared`);
}

/** `cod.manual_complete`: a COD order the courier never reported DELIVERED, completed on courier proof with a second approver (never part of a batch). */
export async function requestManualCompleteAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/money/cod-reconciliation", "payouts.process");
    await requirePortalCsrf(f);
    await requestManualCompletion(op, { orderId: Number(text(f, "orderId")), evidenceRef: text(f, "evidenceRef"), reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(BACK, error) : `${BACK}?saved=manual_requested`);
}

export async function applyManualCompleteAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/money/cod-reconciliation", "payouts.process");
    await requirePortalCsrf(f);
    await applyManualCompletion(op, { orderId: Number(text(f, "orderId")), approvalId: Number(text(f, "approvalId")), evidenceRef: text(f, "evidenceRef") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(BACK, error) : `${BACK}?saved=manual_done`);
}
