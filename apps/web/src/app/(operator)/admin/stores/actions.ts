"use server";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { createStoreForOwnerEmail, setStoreStatus } from "@bukalaris/db";
import { redirect } from "next/navigation";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function createStoreAction(f: FormData) {
  let id: number | undefined;
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/stores/new", "tenants.manage");
    id = await createStoreForOwnerEmail(op, { slug: text(f, "slug"), name: text(f, "name"), ownerEmail: text(f, "ownerEmail") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError("/admin/stores/new", error) : `/admin/stores/${id}?saved=1`);
}

/** Same transition as the list page, but returns to the store detail. */
export async function setStoreStatusDetailAction(storeId: number, status: "active" | "suspended", f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/stores/[id]", "tenants.manage");
    await setStoreStatus(op, storeId, { status, reason: text(f, "reason"), reasonCode: text(f, "reasonCode") || "operator_decision", caseId: text(f, "caseId").trim() || undefined });
  } catch (err) {
    error = userError(err);
  }
  const back = `/admin/stores/${storeId}`;
  redirect(error ? withError(back, error) : `${back}?saved=1`);
}

/** Suspend or reactivate from the store list (SA-02, `/admin/stores`). */
export async function setStoreStatusAction(storeId: number, status: "active" | "suspended", f: FormData) {
  let error: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/stores", "tenants.manage");
    await setStoreStatus(op, storeId, { status, reason: text(f, "reason"), reasonCode: text(f, "reasonCode") || "operator_decision", caseId: text(f, "caseId").trim() || undefined });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError("/admin/stores", error) : "/admin/stores?saved=1");
}
