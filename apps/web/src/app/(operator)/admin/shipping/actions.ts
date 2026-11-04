"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { applyApprovedMargin, applyShippingSettings, queueShippingAccountRecovery, requestMarginRule, requestShippingSettings, saveCashbackRule, setCourierPolicy, DomainError, marginRuleInput } from "@bukalaris/db";
import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { redirect } from "next/navigation";

// Every SA-07 write starts with the console gate (T-62) and the service re-checks the capability; a refusal or a validation error keeps the prior setting effective.
const PAGE = "/admin/shipping";
const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const flag = (f: FormData, k: string) => f.get(k) === "on";
const percentBps = (f: FormData, k: string) => {
  const percent = Number(text(f, k).replace(",", "."));
  return Number.isFinite(percent) ? Math.round(percent * 100) : Number.NaN;
};
const approvalId = (f: FormData) => {
  const id = Number(text(f, "approvalId"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new DomainError("approval_invalid", "Isi ID persetujuan yang sudah disetujui orang kedua.");
  return id;
};
const done = (error: string | undefined, saved: string) => (error ? withError(PAGE, error) : `${PAGE}?saved=${saved}`);
const margin = (f: FormData) => marginRuleInput.parse({ fixedIdr: text(f, "fixedIdr"), percentBps: percentBps(f, "percent"), roundTo: text(f, "roundTo") });
const settings = (f: FormData) => ({
  revision: text(f, "revision"),
  preferPartner: flag(f, "preferPartner"),
  discountIdr: text(f, "discountIdr"),
  discountBps: percentBps(f, "discountPercent"),
  reason: text(f, "reason"),
});

export async function requestMarginAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/shipping", "shipping.manage");
    await requirePortalCsrf(f);
    await requestMarginRule(op, margin(f));
  } catch (err) {
    error = userError(err);
  }
  redirect(done(error, "margin_requested"));
}

export async function applyMarginAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/shipping", "shipping.manage");
    await requirePortalCsrf(f);
    await applyApprovedMargin(op, margin(f), approvalId(f));
  } catch (err) {
    error = userError(err);
  }
  redirect(done(error, "margin_applied"));
}

export async function requestSettingsAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/shipping", "shipping.manage");
    await requirePortalCsrf(f);
    await requestShippingSettings(op, settings(f));
  } catch (err) {
    error = userError(err);
  }
  redirect(done(error, "settings_requested"));
}

export async function applySettingsAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/shipping", "shipping.manage");
    await requirePortalCsrf(f);
    await applyShippingSettings(op, approvalId(f), settings(f));
  } catch (err) {
    error = userError(err);
  }
  redirect(done(error, "settings_applied"));
}

export async function saveCashbackRuleAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/shipping", "shipping.manage");
    await requirePortalCsrf(f);
    await saveCashbackRule(op, { courierCode: text(f, "courierCode"), serviceCode: text(f, "serviceCode"), sellerShareBps: percentBps(f, "sellerSharePercent"), fixedSellerBonusIdr: text(f, "fixedSellerBonusIdr"), revision: text(f, "revision") || "0", reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  redirect(done(error, "cashback_saved"));
}

export async function setCourierPolicyAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/shipping", "shipping.manage");
    await requirePortalCsrf(f);
    await setCourierPolicy(op, { courierCode: text(f, "courierCode"), serviceCode: text(f, "serviceCode"), codAllowed: flag(f, "codAllowed"), returnFree: flag(f, "returnFree"), status: text(f, "status") || "active", reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  redirect(done(error, "courier_saved"));
}

export async function recoverAccountAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/shipping", "shipping.manage");
    await requirePortalCsrf(f);
    await queueShippingAccountRecovery(op, { accountId: text(f, "accountId"), revision: text(f, "revision"), reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  redirect(done(error, "recovery_queued"));
}
