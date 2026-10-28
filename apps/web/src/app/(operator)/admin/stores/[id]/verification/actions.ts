"use server";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { reviewVerification, revealVerificationField, submitVerification } from "@bukalaris/db";
import { redirect } from "next/navigation";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const opt = (f: FormData, k: string) => text(f, k).trim() || undefined;
const path = (storeId: number) => `/admin/stores/${storeId}/verification`;

/** A new immutable version of the optional record (tenants.verify). Nothing about the store depends on it. */
export async function submitVerificationAction(storeId: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/stores/[id]/verification", "tenants.verify");
    await submitVerification(op, storeId, { kind: text(f, "kind"), verifiedName: opt(f, "verifiedName"), contactEmail: opt(f, "contactEmail"), contactPhone: opt(f, "contactPhone"), registrationNumber: opt(f, "registrationNumber"), evidenceRef: opt(f, "evidenceRef"), reasonCode: "verification_submitted", reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(path(storeId), error) : `${path(storeId)}?saved=verification_saved`);
}

export async function reviewVerificationAction(storeId: number, versionId: number, to: "in_review" | "verified" | "rejected" | "revoked", f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/stores/[id]/verification", "tenants.verify");
    await reviewVerification(op, versionId, { to, reasonCode: text(f, "reasonCode") || "verification_decision", reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(path(storeId), error) : `${path(storeId)}?saved=verification_reviewed`);
}

/** Field reveal (accounts.reveal, an open case, purpose `verification_review`). The value is never put in a URL: the page that follows shows it from the open reveal window. */
export async function revealVerificationAction(storeId: number, versionId: number, f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/stores/[id]/verification", "accounts.reveal");
    await revealVerificationField(op, versionId, { field: text(f, "field"), caseRef: text(f, "caseRef").trim(), reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(path(storeId), error) : `${path(storeId)}?saved=reveal`);
}
