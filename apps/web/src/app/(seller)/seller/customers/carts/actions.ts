"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { openWhatsAppRecovery } from "@bukalaris/db";
import { surfaceOriginsFromEnv } from "@bukalaris/db/host";
import { sellerScope } from "@/lib/context";
import { userError, withError } from "@/lib/errors";
import { redirect } from "next/navigation";
import { text } from "../../_run";

const PAGE = "/seller/customers/carts";

/**
 * "Hubungi lewat WhatsApp" (SC-26): stamp "WA dibuka" on this store's abandoned session and send the seller to `wa.me` with the prefilled message and a
 * signed 7-day resume link on the checkout origin (DOM-5). The session id is a row id of THIS store (RLS); another store's id is simply not found.
 */
export async function openWhatsApp(f: FormData) {
  await requirePortalCsrf(f, "/seller/customers/carts");
  const scope = await sellerScope();
  let url: string | undefined;
  let error: string | undefined;
  try {
    url = (await openWhatsAppRecovery(scope, Number(text(f, "id")), { origin: surfaceOriginsFromEnv(process.env).checkoutOrigin })).url;
  } catch (err) {
    error = userError(err);
  }
  redirect(url && !error ? url : withError(PAGE, error ?? "Gagal membuka WhatsApp."));
}
