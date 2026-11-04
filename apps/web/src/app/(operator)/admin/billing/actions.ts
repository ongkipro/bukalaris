"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { changePlanDays, changePlanPrice, createInvoiceAsOperator, grantComp, requestCompApproval, requestPlanPriceApproval, setBillingControls, setPpnSwitch } from "@bukalaris/db";
import { redirect } from "next/navigation";

// SA-09 actions (T-50). Every action runs the console gate first with the capability its service needs (billing.manage; tax.manage for the PPN
// switch), and the service re-checks it (IAM-15). Comp and a price change are four-eyes: this page files the request, a second operator decides it in
// Persetujuan, and the requester executes it here with the approval id, bound to exactly the payload that was approved.

const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const whole = (f: FormData, k: string) => (text(f, k).trim() === "" ? undefined : Number(text(f, k)));
const BACK = "/admin/billing";

const leave = (error: string | undefined, extra = ""): never => redirect(error ? withError(BACK, error) : `${BACK}?saved=1${extra}`);

export async function createInvoiceAction(f: FormData) {
  let error: string | undefined;
  let extra = "";
  try {
    const { op } = await consoleActionOp(BACK, "billing.manage");
    await requirePortalCsrf(f);
    const r = await createInvoiceAsOperator(op, { storeId: Number(text(f, "storeId")), periodIndex: whole(f, "periodIndex"), reason: text(f, "reason") });
    if (r.kind === "invoice") extra = `&invoice=${r.invoice.id}&created=${r.created ? 1 : 0}`;
  } catch (err) {
    error = userError(err);
  }
  leave(error, extra);
}

/** The PPN switch (D-17): tax.manage, the confirmation tick and a reason; not four-eyes, no PKP gate. */
export async function setPpnAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp(BACK, "tax.manage");
    await requirePortalCsrf(f);
    await setPpnSwitch(op, { enabled: text(f, "enabled") === "1", confirmed: f.get("confirmed") === "on", reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  leave(error);
}

export async function changeDaysAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp(BACK, "billing.manage");
    await requirePortalCsrf(f);
    await changePlanDays(op, { trialDays: Number(text(f, "trialDays")), graceDays: Number(text(f, "graceDays")), reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  leave(error);
}

export async function setControlsAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp(BACK, "billing.manage");
    await requirePortalCsrf(f);
    await setBillingControls(op, { jobsFrozen: f.get("jobsFrozen") === "on", dunningEnabled: f.get("dunningEnabled") === "on", reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  leave(error);
}

export async function requestPriceAction(f: FormData) {
  let error: string | undefined;
  let extra = "";
  try {
    const { op } = await consoleActionOp(BACK, "billing.manage");
    await requirePortalCsrf(f);
    const r = await requestPlanPriceApproval(op, { monthlyDppIdr: Number(text(f, "monthlyDppIdr")), reason: text(f, "reason") });
    extra = `&requested=${r.id}`;
  } catch (err) {
    error = userError(err);
  }
  leave(error, extra);
}

export async function changePriceAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp(BACK, "billing.manage");
    await requirePortalCsrf(f);
    await changePlanPrice(op, { monthlyDppIdr: Number(text(f, "monthlyDppIdr")), reason: text(f, "reason"), approvalId: Number(text(f, "approvalId")) });
  } catch (err) {
    error = userError(err);
  }
  leave(error);
}

/** The comp request key is derived from store and period, so the request and its execution always agree on the payload the approver saw. */
const compKey = (f: FormData) => `comp-${Number(text(f, "storeId"))}-p${Number(text(f, "periodIndex"))}`;

export async function requestCompAction(f: FormData) {
  let error: string | undefined;
  let extra = "";
  try {
    const { op } = await consoleActionOp(BACK, "billing.manage");
    await requirePortalCsrf(f);
    const r = await requestCompApproval(op, { storeId: Number(text(f, "storeId")), periodIndex: Number(text(f, "periodIndex")), requestKey: compKey(f), reason: text(f, "reason") });
    extra = `&requested=${r.id}`;
  } catch (err) {
    error = userError(err);
  }
  leave(error, extra);
}

export async function grantCompAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp(BACK, "billing.manage");
    await requirePortalCsrf(f);
    await grantComp(op, { storeId: Number(text(f, "storeId")), periodIndex: Number(text(f, "periodIndex")), requestKey: compKey(f), reason: text(f, "reason"), approvalId: Number(text(f, "approvalId")) });
  } catch (err) {
    error = userError(err);
  }
  leave(error);
}
