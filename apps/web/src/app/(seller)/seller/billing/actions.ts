"use server";

import { paySubscription } from "@bukalaris/db";
import { sellerScope } from "@/lib/context";
import { userError, withError } from "@/lib/errors";
import { redirect } from "next/navigation";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");

/**
 * Seller Pay (SC-28/SC-29). The store comes from the seller scope (membership), never from the form; the owner role (`billing.pay`) is
 * checked by the service and stays usable while Seller Admin is read-only. Double clicks and concurrent tabs get the same invoice and
 * the same live instruction (database unique indexes). The return page says "menunggu verifikasi": a browser returning is never settlement.
 */
export async function payAction(f: FormData) {
  const scope = await sellerScope();
  const invoiceId = text(f, "invoiceId");
  const back = invoiceId ? `/seller/billing/invoices/${encodeURIComponent(invoiceId)}` : "/seller/billing";
  let to: string | undefined;
  let error: string | undefined;
  try {
    const r = await paySubscription(scope, { channel: text(f, "channel"), ...(invoiceId ? { invoiceId } : {}) });
    to = `/seller/billing/invoices/${r.invoice.id}?returned=1`;
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back, error) : to!);
}
