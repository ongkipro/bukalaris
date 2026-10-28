"use server";
import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { assignIssue, transitionIssue, type IssueStatus } from "@bukalaris/db";
import { redirect } from "next/navigation";
export async function transitionIssueAction(id: number, from: IssueStatus, form: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/issues/[id]", "ops.issues.manage");
    await transitionIssue(op, { id, from, to: String(form.get("to") ?? ""), note: String(form.get("note") ?? ""), duplicateOf: form.get("duplicateOf") ? Number(form.get("duplicateOf")) : undefined });
  } catch (err) { error = userError(err); }
  redirect(error ? withError(`/admin/issues/${id}`, error) : `/admin/issues/${id}?saved=transition`);
}
export async function assignIssueAction(id: number, expected: string | null, form: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/issues/[id]", "ops.issues.manage");
    await assignIssue(op, { id, expected, assigneeId: String(form.get("assigneeId") ?? "").trim() || null });
  } catch (err) { error = userError(err); }
  redirect(error ? withError(`/admin/issues/${id}`, error) : `/admin/issues/${id}?saved=assignment`);
}
