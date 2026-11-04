"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { requeueDeadJob, resolveUnknownJob } from "@bukalaris/db";
import { redirect } from "next/navigation";

const jobId = (v: number) => (Number.isSafeInteger(v) && v > 0 ? v : -1);

/** Put a dead, replay-safe job back to pending. Needs `ops.jobs.manage` (gate and service); the service writes the audit row. */
export async function requeueJobAction(id: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/ops", "ops.jobs.manage");
    await requirePortalCsrf(f);
    await requeueDeadJob(op, { jobId: jobId(id), reason: String(f.get("reason") ?? "") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError("/admin/ops", error) : "/admin/ops?saved=1");
}

/** Settle an `unknown` job after someone established whether its effect happened. Needs `ops.jobs.manage`. */
export async function resolveJobAction(id: number, outcome: "effect_confirmed" | "effect_absent", f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/ops", "ops.jobs.manage");
    await requirePortalCsrf(f);
    await resolveUnknownJob(op, { jobId: jobId(id), outcome, evidence: String(f.get("evidence") ?? "") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError("/admin/ops", error) : "/admin/ops?saved=1");
}
