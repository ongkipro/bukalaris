"use server";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { decideConsoleApproval } from "@bukalaris/db";
import { redirect } from "next/navigation";

/**
 * Approve or reject one request. The second person's decision needs a reason and a fresh second-factor verification of this
 * session (a single-use proof consumed in the same transaction as the decision); the requester is refused by the service and
 * by the database. The action never executes the approved change: execution is the requester's, with the same capability
 * re-checked (`consumeApproval`).
 */
export async function decideApprovalAction(approvalId: number, decision: "approve" | "reject", f: FormData) {
  let error: string | undefined;
  try {
    const { op, sessionId } = await consoleActionOp("/admin/approvals");
    await decideConsoleApproval(op, sessionId, { approvalId, decision, reason: String(f.get("reason") ?? "") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError("/admin/approvals", error) : "/admin/approvals?saved=1");
}
