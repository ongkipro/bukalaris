"use server";

import { operatorOrDeny } from "@/lib/context";
import { userError, withError } from "@/lib/errors";
import { createStoreForOwnerEmail, setStoreStatus } from "@bukalaris/db";
import { redirect } from "next/navigation";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function createStoreAction(f: FormData) {
  const op = await operatorOrDeny();
  let id: number | undefined;
  let error: string | undefined;
  try {
    id = await createStoreForOwnerEmail(op, { slug: text(f, "slug"), name: text(f, "name"), ownerEmail: text(f, "ownerEmail") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError("/admin/stores/new", error) : `/admin/stores/${id}?saved=1`);
}

/** Same transition as the list page, but returns to the store detail. */
export async function setStoreStatusDetailAction(storeId: number, status: "active" | "suspended", f: FormData) {
  const op = await operatorOrDeny();
  let error: string | undefined;
  try {
    await setStoreStatus(op, storeId, { status, reason: text(f, "reason") });
  } catch (err) {
    error = userError(err);
  }
  const back = `/admin/stores/${storeId}`;
  redirect(error ? withError(back, error) : `${back}?saved=1`);
}
