"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { activateBreakGlass, requestBreakGlass, revokeBreakGlass } from "@bukalaris/db";
import { redirect } from "next/navigation";

const PATH = "/admin/staff/break-glass";
const text = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function requestBreakGlassAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/break-glass", "break_glass.approve");
    await requirePortalCsrf(f);
    await requestBreakGlass(op, { userId: text(f, "userId").trim(), caseRef: text(f, "caseRef").trim(), capabilities: f.getAll("capabilities").map(String), durationSeconds: Math.round(Number(text(f, "minutes")) * 60), reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(PATH, error) : `${PATH}?saved=break_glass_requested`);
}

export async function activateBreakGlassAction(f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/break-glass", "break_glass.approve");
    await requirePortalCsrf(f);
    await activateBreakGlass(op, Number(text(f, "approvalId")));
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(PATH, error) : `${PATH}?saved=break_glass_granted`);
}

export async function revokeBreakGlassAction(grantId: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/break-glass", "break_glass.approve");
    await requirePortalCsrf(f);
    await revokeBreakGlass(op, grantId);
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(PATH, error) : `${PATH}?saved=break_glass_ended`);
}
