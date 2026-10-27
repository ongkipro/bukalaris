"use server";

import { setStoreStatus } from "@bukalaris/db";
import { operatorOrDeny } from "@/lib/context";
import { userError, withError } from "@/lib/errors";
import { redirect } from "next/navigation";

export async function setStoreStatusAction(storeId: number, status: "active" | "suspended", f: FormData) {
  const op = await operatorOrDeny();
  let error: string | undefined;
  try {
    await setStoreStatus(op, storeId, { status, reason: String(f.get("reason") ?? "") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError("/admin", error) : "/admin?saved=1");
}
