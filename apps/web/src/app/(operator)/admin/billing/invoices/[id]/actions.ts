"use server";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { failUnknownAttemptAsOperator, markInvoicePaidBookkeeping, requestMarkPaidApproval, voidInvoiceAsOperator } from "@bukalaris/db";
import { redirect } from "next/navigation";

// SA-10 actions (T-50). Gate first, capability re-checked by the service. Mark-paid is four-eyes and BOOKKEEPING ONLY (no coverage); the store id comes
// from the invoice row the operator is looking at, passed as a bound argument, never typed into the form.

const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const TEMPLATE = "/admin/billing/invoices/[id]";
const leave = (id: string, error: string | undefined, extra = ""): never => redirect(error ? withError(`/admin/billing/invoices/${id}`, error) : `/admin/billing/invoices/${id}?saved=1${extra}`);

export async function requestMarkPaidAction(invoiceId: string, storeId: number, f: FormData) {
  let error: string | undefined;
  let extra = "";
  try {
    const { op } = await consoleActionOp(TEMPLATE, "billing.manage");
    const r = await requestMarkPaidApproval(op, { invoiceId, storeId, evidence: text(f, "evidence"), reason: text(f, "reason") });
    extra = `&requested=${r.id}`;
  } catch (err) {
    error = userError(err);
  }
  leave(invoiceId, error, extra);
}

export async function markPaidAction(invoiceId: string, storeId: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp(TEMPLATE, "billing.manage");
    await markInvoicePaidBookkeeping(op, { invoiceId, storeId, evidence: text(f, "evidence"), reason: text(f, "reason"), approvalId: Number(text(f, "approvalId")) });
  } catch (err) {
    error = userError(err);
  }
  leave(invoiceId, error);
}

export async function voidInvoiceAction(invoiceId: string, storeId: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp(TEMPLATE, "billing.manage");
    await voidInvoiceAsOperator(op, { invoiceId, storeId, reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  leave(invoiceId, error);
}

export async function failUnknownAttemptAction(invoiceId: string, storeId: number, attemptId: string, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp(TEMPLATE, "billing.manage");
    await failUnknownAttemptAsOperator(op, { attemptId, storeId, reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  leave(invoiceId, error);
}
