"use server";

import { db, defaultProviders, DomainError, getOrderForLink, requestPaymentCheck, resolveBuyerOrder, retryOrderPayment, submitRefundDestination } from "@bukalaris/db";
import { userError, withError } from "@/lib/errors";
import { clientIp, servesStore } from "@/lib/storefront";
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
    // A store host accepts only its own store's link (T-103), with the same answer as an invalid link.
    const o = await getOrderForLink(db(), token);
    if (!o || !(await servesStore(o.storeSlug))) throw new DomainError("not_found", "Tautan tidak valid atau sudah kedaluwarsa.");
    await submitRefundDestination(db(), token, { bank: text(f, "bank"), account: text(f, "account"), holder: text(f, "holder") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back, error) : `${back}?saved=1#refund`);
}

/**
 * T-106: "check now" and "new instruction" on the signed one-order page. The verified link is the only authority (as for the refund
 * destination); the services re-check the order state, RL-PAY-RECHECK and the method rules, and never call the provider from this request
 * except through the queued jobs.
 */
async function linkPayment(token: string, op: (ref: { storeId: number; orderId: number }, ip: string | undefined) => Promise<unknown>, saved: string) {
  const back = `/o/${token}`;
  let error: string | undefined;
  try {
    // A store host accepts only its own store's link (T-103), with the same answer as an invalid link.
    const o = await getOrderForLink(db(), token);
    const ref = o && (await servesStore(o.storeSlug)) ? await resolveBuyerOrder(db(), { token }) : null;
    if (!ref) throw new DomainError("not_found", "Tautan tidak valid atau sudah kedaluwarsa.");
    await op(ref, await clientIp());
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back, error) : `${back}?saved=${saved}#payment`);
}
export async function recheckPaymentByLinkAction(token: string) {
  await linkPayment(token, (ref, ip) => requestPaymentCheck(db(), ref, { clientIp: ip }), "recheck");
}
export async function retryPaymentByLinkAction(token: string) {
  await linkPayment(token, (ref, ip) => retryOrderPayment(db(), ref, defaultProviders().payment, { clientIp: ip }), "retry");
}
