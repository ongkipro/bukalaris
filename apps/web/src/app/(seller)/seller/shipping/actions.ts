"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { saveCourierRules, saveShippingSettings, SELLER_COURIERS, setPickupAddress, setPickupArea } from "@bukalaris/db";
import { sellerScope } from "@/lib/context";
import { userError, withError } from "@/lib/errors";
import { redirect } from "next/navigation";

const PAGE = "/seller/shipping";
const text = (f: FormData, k: string) => String(f.get(k) ?? "");

async function run(op: () => Promise<unknown>) {
  let error: string | undefined;
  try {
    await op();
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(PAGE, error) : `${PAGE}?saved=1`);
}

export async function setPickupAreaAction(f: FormData) {
  await requirePortalCsrf(f, "/seller/shipping");
  const scope = await sellerScope();
  await run(() => setPickupArea(scope, { areaId: text(f, "areaId"), areaLabel: text(f, "areaLabel") }));
}

export async function setPickupAddressAction(f: FormData) {
  await requirePortalCsrf(f, "/seller/shipping");
  const scope = await sellerScope();
  // T-105: a store on its own courier account also sends the pickup contact (registered with that account).
  const contact = f.has("contactName") ? { contactName: text(f, "contactName"), contactPhone: text(f, "contactPhone") } : {};
  await run(() => setPickupAddress(scope, { addressText: text(f, "addressText"), ...contact }));
}

/** T-105: courier on/off and courier COD on/off; every known courier is sent, an unchecked box is off. */
export async function saveCourierRulesAction(f: FormData) {
  await requirePortalCsrf(f, "/seller/shipping");
  const scope = await sellerScope();
  await run(() => saveCourierRules(scope, { couriers: SELLER_COURIERS.map((courierCode) => ({ courierCode, enabled: f.get(`enabled:${courierCode}`) === "on", codEnabled: f.get(`cod:${courierCode}`) === "on", refusalSeen: f.get(`refused:${courierCode}`) === "1" })) }));
}

/** T-105: store COD switch, COD fee bearer and COD-blocked provinces. */
export async function saveShippingSettingsAction(f: FormData) {
  await requirePortalCsrf(f, "/seller/shipping");
  const scope = await sellerScope();
  await run(() => saveShippingSettings(scope, { codEnabled: f.get("codEnabled") === "on", codFeeBearer: text(f, "codFeeBearer"), codBlockedProvinces: f.getAll("blocked").map(String), revision: text(f, "revision") }));
}
