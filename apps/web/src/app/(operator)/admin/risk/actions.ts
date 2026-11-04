"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { acknowledgeRisk } from "@bukalaris/db";
import { redirect } from "next/navigation";

/** Acknowledge a flag (tenants.manage): reason and expiry are required; the flag stays derived and returns when the acknowledgement ends. */
export async function acknowledgeRiskAction(storeId: number, flagKey: string, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/risk", "tenants.manage");
    await requirePortalCsrf(f);
    const hours = Number(f.get("hours"));
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 90) throw new Error("hours");
    await acknowledgeRisk(op, storeId, { flagKey, reason: String(f.get("reason") ?? ""), expiresAt: new Date(Date.now() + hours * 3_600_000) });
  } catch (err) {
    error = err instanceof Error && err.message === "hours" ? "Lama pengakuan harus 1 sampai 2160 jam." : userError(err);
  }
  redirect(error ? withError("/admin/risk", error) : "/admin/risk?saved=risk_ack");
}
