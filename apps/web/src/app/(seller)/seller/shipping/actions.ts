"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { setPickupAddress, setPickupArea } from "@bukalaris/db";
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
  await run(() => setPickupAddress(scope, { addressText: text(f, "addressText") }));
}
