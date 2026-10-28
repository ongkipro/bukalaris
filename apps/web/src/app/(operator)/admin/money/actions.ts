"use server";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { applyLedgerAdjustment, requestLedgerAdjustment } from "@bukalaris/db";
import { redirect } from "next/navigation";

// SA-26 actions (T-37). A manual adjustment is `ledger.adjust` and four-eyes: this page files the exact amount for a second person (Persetujuan), and the requester applies it
// here with the approval id; the entry is bound to that approval by the service and by the database.
const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const input = (f: FormData) => ({ storeId: Number(text(f, "storeId")), amountIdr: Number(text(f, "amountIdr")), businessRef: text(f, "businessRef"), reason: text(f, "reason") });

export async function requestAdjustmentAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/money", "ledger.adjust");
    await requestLedgerAdjustment(op, input(f));
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError("/admin/money", error) : "/admin/money?saved=adjust_requested");
}

export async function applyAdjustmentAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/money", "ledger.adjust");
    await applyLedgerAdjustment(op, { ...input(f), approvalId: Number(text(f, "approvalId")) });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError("/admin/money", error) : "/admin/money?saved=adjust_applied");
}
