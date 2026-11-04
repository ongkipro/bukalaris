"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { reviewBreakGlass, reviewGrant } from "@bukalaris/db";
import { redirect } from "next/navigation";

const PATH = "/admin/staff/access-reviews";
const text = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function reviewGrantAction(operatorUserId: string, capability: string, decision: "confirmed" | "revoked", f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/access-reviews", "access.review");
    await requirePortalCsrf(f);
    await reviewGrant(op, { operatorUserId, capability, decision, reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(PATH, error) : `${PATH}?saved=review_saved`);
}

export async function reviewBreakGlassAction(grantId: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/staff/access-reviews", "access.review");
    await requirePortalCsrf(f);
    await reviewBreakGlass(op, grantId);
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(PATH, error) : `${PATH}?saved=break_glass_ended`);
}
