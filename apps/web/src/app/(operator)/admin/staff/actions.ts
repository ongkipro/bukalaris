"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { savedKey } from "@/lib/governance";
import { deactivateStaff, executeStaffMfaReset, grantPayload, grantStaffCapability, reactivateStaff, requestApproval, requestStaffMfaReset, revokeStaffCapability, revokeStaffSessions, type PlatformCapability } from "@bukalaris/db";
import { redirect } from "next/navigation";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const why = (f: FormData) => ({ reasonCode: text(f, "reasonCode") || "staff_change", reason: text(f, "reason") });
const back = (id: string) => `/admin/staff/${id}`;
const done = (id: string, error: string | undefined, saved = "staff_changed") => redirect(error ? withError(back(id), error) : `${back(id)}?saved=${saved}`);

export async function grantAction(userId: string, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/[id]", "staff.manage");
    await requirePortalCsrf(f);
    const hours = Number(text(f, "hours"));
    const approval = Number(text(f, "approvalRequestId"));
    await grantStaffCapability(op, { userId, capability: text(f, "capability"), reason: text(f, "reason"), expiresAt: hours > 0 ? new Date(Date.now() + hours * 3_600_000) : undefined, approvalRequestId: approval > 0 ? approval : undefined });
  } catch (err) {
    error = userError(err);
  }
  done(userId, error);
}

/** A sensitive grant needs a second `staff.manage` holder to approve this exact payload first (the approvals inbox); the grant is then made with the approval id. */
export async function requestSensitiveGrantAction(userId: string, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/[id]", "staff.manage");
    await requirePortalCsrf(f);
    const hours = Number(text(f, "hours"));
    const expiresAt = hours > 0 ? new Date(Date.now() + hours * 3_600_000) : undefined;
    await requestApproval(op, { actionKey: "grant.sensitive", targetKind: "operator", targetId: userId, payload: grantPayload({ userId, capability: text(f, "capability") as PlatformCapability, expiresAt }), reason: text(f, "reason"), ttlSeconds: undefined });
  } catch (err) {
    error = userError(err);
  }
  done(userId, error, "staff_changed");
}

export async function revokeAction(userId: string, capability: string, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/[id]", "staff.manage");
    await requirePortalCsrf(f);
    await revokeStaffCapability(op, { userId, capability, reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  done(userId, error);
}

export async function deactivateAction(userId: string, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/[id]", "staff.manage");
    await requirePortalCsrf(f);
    await deactivateStaff(op, userId, why(f));
  } catch (err) {
    error = userError(err);
  }
  done(userId, error);
}

export async function reactivateAction(userId: string, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/[id]", "staff.manage");
    await requirePortalCsrf(f);
    await reactivateStaff(op, userId, why(f));
  } catch (err) {
    error = userError(err);
  }
  done(userId, error);
}

export async function revokeSessionsAction(userId: string, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/[id]", "staff.manage");
    await requirePortalCsrf(f);
    await revokeStaffSessions(op, userId, why(f));
  } catch (err) {
    error = userError(err);
  }
  done(userId, error);
}

export async function requestMfaResetAction(userId: string, f: FormData) {
  let error: string | undefined;
  let saved: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/[id]", "staff.manage");
    await requirePortalCsrf(f);
    saved = savedKey(await requestStaffMfaReset(op, userId, { ...why(f), idempotencyKey: text(f, "idempotencyKey") }));
  } catch (err) {
    error = userError(err);
  }
  done(userId, error, saved);
}

export async function executeMfaResetAction(userId: string, supportActionId: number, f: FormData) {
  let error: string | undefined;
  let saved: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/[id]", "staff.manage");
    await requirePortalCsrf(f);
    saved = savedKey(await executeStaffMfaReset(op, supportActionId));
  } catch (err) {
    error = userError(err);
  }
  done(userId, error, saved);
}
