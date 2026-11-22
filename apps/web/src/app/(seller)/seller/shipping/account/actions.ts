"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { confirmDedicatedAccount, DomainError, removeWebhookSecret, requestAccountScan, resolveForeignParcel, setWebhookSecret } from "@bukalaris/db";
import { sellerScope } from "@/lib/context";
import { userError, withError } from "@/lib/errors";
import { stepUpWithCode } from "@/lib/step-up";
import { redirect } from "next/navigation";

// "Akun Mengantar" (SC-34, T-115). The store comes from the seller scope, never from the form. The Webhook Secret is sealed like the API key:
// the owner's fresh 6-digit code becomes a single-use proof for the subject `mengantar_webhook`, consumed in the writing transaction. The secret
// itself never comes back: errors are DomainError messages only.

const PAGE = "/seller/shipping/account";
const text = (f: FormData, k: string) => String(f.get(k) ?? "");
async function run(op: () => Promise<string>) {
  let target: string;
  try {
    target = `${PAGE}?saved=${await op()}`;
  } catch (err) {
    target = withError(PAGE, userError(err));
  }
  redirect(target);
}

export async function confirmDedicatedAction(f: FormData) {
  await requirePortalCsrf(f, PAGE);
  const scope = await sellerScope();
  await run(async () => {
    await confirmDedicatedAccount(scope, { confirmed: f.get("confirmed") === "on" ? true : false });
    return "dedicated";
  });
}

export async function setWebhookSecretAction(f: FormData) {
  await requirePortalCsrf(f, PAGE);
  const scope = await sellerScope();
  await run(async () => {
    const proofId = await stepUpWithCode(scope, text(f, "code"), { action: "integrations.provider_key", subjectId: "mengantar_webhook" });
    await setWebhookSecret(scope, { secret: text(f, "secret"), proofId });
    return "secret";
  });
}

export async function removeWebhookSecretAction(f: FormData) {
  await requirePortalCsrf(f, PAGE);
  const scope = await sellerScope();
  await run(async () => {
    const proofId = await stepUpWithCode(scope, text(f, "code"), { action: "integrations.provider_key", subjectId: "mengantar_webhook" });
    await removeWebhookSecret(scope, { proofId });
    return "secret_removed";
  });
}

export async function requestAccountScanAction(f: FormData) {
  await requirePortalCsrf(f, PAGE);
  const scope = await sellerScope();
  await run(async () => ((await requestAccountScan(scope)) ? "scan" : "scan_pending"));
}

export async function resolveForeignParcelAction(f: FormData) {
  await requirePortalCsrf(f, PAGE);
  const scope = await sellerScope();
  await run(async () => {
    const id = Number(text(f, "id"));
    if (!Number.isSafeInteger(id) || id <= 0) throw new DomainError("not_found", "Paket asing tidak ditemukan.");
    await resolveForeignParcel(scope, id, { note: text(f, "note") });
    return "resolved";
  });
}
