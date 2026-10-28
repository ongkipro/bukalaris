"use server";

import { db, submitRefundDestination } from "@bukalaris/db";
import { userError, withError } from "@/lib/errors";
import { redirect } from "next/navigation";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");

/**
 * The buyer supplies (or corrects) the refund destination on the signed one-order page (D-20, OPEN-F4). The signed link is the only authority: the order is resolved from
 * the verified token, a typed phone or e-mail authorises nothing, and the database accepts nothing but the destination columns of a still-pending refund.
 */
export async function submitRefundDestinationAction(token: string, f: FormData) {
  const back = `/o/${token}`;
  let error: string | undefined;
  try {
    await submitRefundDestination(db(), token, { bank: text(f, "bank"), account: text(f, "account"), holder: text(f, "holder") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back, error) : `${back}?saved=1#refund`);
}
