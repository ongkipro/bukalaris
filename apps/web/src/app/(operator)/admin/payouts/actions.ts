"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { setPayoutFreeze } from "@bukalaris/db";
import { redirect } from "next/navigation";

/** The post-restore payout freeze (RUNBOOK 14): `payouts.process`, a reason, audited. While on, no payout request, transfer step or COD release moves money. */
export async function setFreezeAction(f: FormData) {
  let error: string | undefined;
  const frozen = f.get("frozen") === "1";
  try {
    const { op } = await consoleActionOp("/admin/payouts", "payouts.process");
    await requirePortalCsrf(f);
    await setPayoutFreeze(op, { frozen, reason: String(f.get("reason") ?? "") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError("/admin/payouts", error) : `/admin/payouts?saved=${frozen ? "frozen" : "unfrozen"}`);
}
