"use server";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { approveForTransfer, claimTransfer, completeTransfer, DomainError, recordTransferUnknown, rejectTransfer, reopenFailedRefund, requestRejectApproval, requestTransferApproval, type PlatformCapability, type TransferKind } from "@bukalaris/db";
import { redirect } from "next/navigation";

// SA-08 actions (T-37). Every action runs the console gate first with the capability of its kind (`payouts.process` / `refunds.process`) and the service re-checks it (IAM-15).
// The second person decides in Persetujuan (SA-28); the REQUESTER executes here with the approval the second person gave, bound to the exact text that was approved.

const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const cap = (kind: TransferKind): PlatformCapability => (kind === "payout" ? "payouts.process" : "refunds.process");
const back = (kind: TransferKind, id: number) => `/admin/payouts/${kind}/${id}`;

export async function requestApprovalAction(kind: TransferKind, id: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/payouts/[kind]/[id]", cap(kind));
    await requestTransferApproval(op, kind, id, text(f, "reason"));
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(kind, id), error) : `${back(kind, id)}?saved=requested`);
}

export async function executeApprovalAction(kind: TransferKind, id: number) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/payouts/[kind]/[id]", cap(kind));
    await approveForTransfer(op, kind, id);
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(kind, id), error) : `${back(kind, id)}?saved=approved`);
}

export async function claimAction(kind: TransferKind, id: number) {
  let error: string | undefined;
  try {
    const { op, sessionId } = await consoleActionOp("/admin/payouts/[kind]/[id]", cap(kind));
    await claimTransfer(op, sessionId, kind, id);
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(kind, id), error) : `${back(kind, id)}?saved=claimed`);
}

export async function unknownAction(kind: TransferKind, id: number) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/payouts/[kind]/[id]", cap(kind));
    await recordTransferUnknown(op, kind, id);
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(kind, id), error) : `${back(kind, id)}?saved=unknown`);
}

/** Record the evidence of the transfer the claimant made: a bank reference and the receipt file (magic bytes, 10 MB, unique). It writes no seller ledger row. */
export async function completeAction(kind: TransferKind, id: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/payouts/[kind]/[id]", cap(kind));
    const file = f.get("receipt");
    if (!(file instanceof File) || file.size === 0) throw new DomainError("receipt_size", "Pilih berkas bukti transfer (PNG, JPEG, WebP atau PDF).");
    await completeTransfer(op, kind, id, { evidenceRef: text(f, "evidenceRef"), receipt: new Uint8Array(await file.arrayBuffer()) });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(kind, id), error) : `${back(kind, id)}?saved=done`);
}

/** A payout still `requested` is rejected by one operator with a reason; the exact debit returns to the seller. */
export async function rejectDirectAction(kind: TransferKind, id: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/payouts/[kind]/[id]", cap(kind));
    await rejectTransfer(op, kind, id, { reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(kind, id), error) : `${back(kind, id)}?saved=rejected`);
}

/** Rejecting a payout in `processing` or failing any refund asks a second person: the reason and the bank evidence reference are part of what they approve. */
export async function requestRejectAction(kind: TransferKind, id: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/payouts/[kind]/[id]", cap(kind));
    const ref = text(f, "noTransferEvidenceRef").trim();
    await requestRejectApproval(op, kind, id, { reason: text(f, "reason"), ...(ref ? { noTransferEvidenceRef: ref } : {}) });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(kind, id), error) : `${back(kind, id)}?saved=reject_requested`);
}

export async function executeRejectAction(kind: TransferKind, id: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/payouts/[kind]/[id]", cap(kind));
    await rejectTransfer(op, kind, id, { approvalId: Number(text(f, "approvalId")) });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(kind, id), error) : `${back(kind, id)}?saved=rejected`);
}

/** A failed refund is still owed: open a new pending refund for the same payment (the buyer supplies the account again). */
export async function reopenRefundAction(id: number, f: FormData) {
  let error: string | undefined;
  let to = back("refund", id);
  try {
    const { op } = await consoleActionOp("/admin/payouts/[kind]/[id]", "refunds.process");
    const r = await reopenFailedRefund(op, id, text(f, "reason"));
    to = back("refund", r.refundId);
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(to, error) : `${to}?saved=reopened`);
}
