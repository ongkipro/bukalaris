"use server";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { addCaseNote, moveCase, openCase, type CaseStatus } from "@bukalaris/db";
import { redirect } from "next/navigation";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");

/** Open a case (SA-20, cases.write); `back` is where the form lives (the case list or an account or store page). */
export async function openCaseAction(f: FormData) {
  let id: number | undefined;
  let error: string | undefined;
  const subjectKind = text(f, "subjectKind") || undefined;
  const subjectId = text(f, "subjectId") || undefined;
  const back = text(f, "back").startsWith("/admin/") ? text(f, "back") : "/admin/cases";
  try {
    const { op } = await consoleActionOp("/admin/cases", "cases.write");
    id = (await openCase(op, { kind: text(f, "kind") || "support", subjectKind, subjectId, title: text(f, "title"), priority: text(f, "priority") || "normal", reasonCode: "case_opened", reason: text(f, "reason") })).id;
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back, error) : back === "/admin/cases" ? `/admin/cases/${id}?saved=case_opened` : `${back}${back.includes("?") ? "&" : "?"}saved=case_opened`);
}

export async function addNoteAction(caseId: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/cases/[id]", "cases.write");
    await addCaseNote(op, caseId, text(f, "body"));
  } catch (err) {
    error = userError(err);
  }
  const back = `/admin/cases/${caseId}`;
  redirect(error ? withError(back, error) : `${back}?saved=note_added`);
}

export async function moveCaseAction(caseId: number, from: CaseStatus, to: CaseStatus, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/cases/[id]", "cases.write");
    await moveCase(op, caseId, { from, to, resolutionCode: text(f, "resolutionCode") || undefined, reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  const back = `/admin/cases/${caseId}`;
  redirect(error ? withError(back, error) : `${back}?saved=case_moved`);
}
