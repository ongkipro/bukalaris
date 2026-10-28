"use server";

import { requestPayout, setPayoutDestination } from "@bukalaris/db";
import { sellerScope } from "@/lib/context";
import { userError, withError } from "@/lib/errors";
import { stepUpWithCode } from "@/lib/step-up";
import { redirect } from "next/navigation";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const BACK = "/seller/finance";

/**
 * Change the payout destination (SC-25, D-19): the store comes from the seller scope (membership), never from the form; the owner role (`finance.payout`) and the
 * subscription policy are checked by the service. The 6-digit code becomes a single-use proof bound to this session, the action and this store; the new destination is
 * HELD (72 hours by default) and the previous contact is notified.
 */
export async function setDestinationAction(f: FormData) {
  const scope = await sellerScope();
  let error: string | undefined;
  try {
    const proofId = await stepUpWithCode(scope, text(f, "code"), { action: "payout.destination", subjectId: String(scope.storeId) });
    await setPayoutDestination(scope, { proofId, bankCode: text(f, "bankCode"), accountNumber: text(f, "accountNumber"), accountHolderName: text(f, "accountHolderName") });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(BACK, error) : `${BACK}?saved=destination`);
}

/**
 * Request a payout. The idempotency key is rendered with the form, so a double click or a resubmitted form returns the first payout and debits once; the proof is bound to
 * that key. Amount, minimum, balance, destination hold and the post-restore freeze are all checked by the service inside one locked transaction.
 */
export async function requestPayoutAction(f: FormData) {
  const scope = await sellerScope();
  const requestKey = text(f, "requestKey");
  let error: string | undefined;
  let replayed = false;
  try {
    const amountIdr = Number(text(f, "amountIdr").replace(/[.\s]/g, ""));
    const proofId = await stepUpWithCode(scope, text(f, "code"), { action: "payout.request", subjectId: requestKey });
    replayed = (await requestPayout(scope, { proofId, requestKey, amountIdr })).replayed;
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(BACK, error) : `${BACK}?saved=${replayed ? "replayed" : "payout"}`);
}
