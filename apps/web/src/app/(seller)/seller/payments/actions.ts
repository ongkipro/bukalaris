"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { checkProviderNow, DomainError, PROVIDERS, removeProviderKey, saveProviderKey, setPaymentAccountDetails, type Provider } from "@bukalaris/db";
import { sellerScope } from "@/lib/context";
import { userError, withError } from "@/lib/errors";
import { stepUpWithCode } from "@/lib/step-up";
import { redirect } from "next/navigation";
import { checkLabel } from "./labels";

// SC-32 provider accounts (T-104). The store comes from the seller scope, never from the form; the provider is one of two fixed values. A key
// change needs the owner's fresh second factor: the 6-digit code becomes a single-use proof bound to this session, the action and the provider,
// consumed by the service in the transaction that writes the key. The key itself never comes back: errors are DomainError messages only.

const PAGE = "/seller/payments";
const text = (f: FormData, k: string) => String(f.get(k) ?? "");
function providerOf(f: FormData): Provider {
  const p = text(f, "provider");
  if (!(PROVIDERS as readonly string[]).includes(p)) throw new DomainError("invalid_provider", "Penyedia tidak dikenal.");
  return p as Provider;
}
async function run(op: () => Promise<string>) {
  let target: string;
  try {
    target = `${PAGE}?saved=${await op()}`;
  } catch (err) {
    target = withError(PAGE, userError(err));
  }
  redirect(target);
}

export async function saveProviderKeyAction(f: FormData) {
  await requirePortalCsrf(f, PAGE);
  const scope = await sellerScope();
  await run(async () => {
    const provider = providerOf(f);
    const proofId = await stepUpWithCode(scope, text(f, "code"), { action: "integrations.provider_key", subjectId: provider });
    await saveProviderKey(scope, { provider, environment: text(f, "environment"), apiKey: text(f, "apiKey"), proofId });
    return "key";
  });
}

export async function removeProviderKeyAction(f: FormData) {
  await requirePortalCsrf(f, PAGE);
  const scope = await sellerScope();
  await run(async () => {
    const provider = providerOf(f);
    const proofId = await stepUpWithCode(scope, text(f, "code"), { action: "integrations.provider_key", subjectId: provider });
    await removeProviderKey(scope, { provider, proofId });
    return "removed";
  });
}

export async function checkProviderNowAction(f: FormData) {
  await requirePortalCsrf(f, PAGE);
  const scope = await sellerScope();
  await run(async () => {
    const result = await checkProviderNow(scope, providerOf(f));
    if (!result.ok) throw new DomainError("check_failed", `Pengecekan gagal: ${checkLabel[result.code]}. Kunci tetap tersimpan; toko belum siap memakai akun ini sampai pengecekan berhasil.`);
    return "check";
  });
}

export async function savePaymentDetailsAction(f: FormData) {
  await requirePortalCsrf(f, PAGE);
  const scope = await sellerScope();
  await run(async () => {
    await setPaymentAccountDetails(scope, {
      originAreaId: text(f, "originAreaId"),
      destinationAreaId: text(f, "destinationAreaId"),
      shipperEmail: text(f, "shipperEmail"),
      senderAddress: text(f, "senderAddress"),
      paymentOnlyConfirmed: f.get("paymentOnly") === "on",
    });
    return "details";
  });
}
