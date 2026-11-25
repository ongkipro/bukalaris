// T-117 (PR-27, ADR-0013 decisions 12 to 14 and 36, ADR-0016 decision 21, D-37): the seller setup checklist. It reads the readiness
// functions of T-104/T-113/T-115/T-116 and keeps no state of its own; a step never shows or asks for a key — it links to the
// screen that owns the form (SC-32 `/seller/payments` with the T-116 terms section, SC-34 `/seller/shipping/account`, SC-22 `/seller/shipping`).

import { eq } from "drizzle-orm";
import { digitalPrepaidReady, physicalActivationAllowed, storeMoneyMode, type MoneyMode } from "../ledger/boundary.ts";
import { sellerTermsStatus } from "../platform/terms.ts";
import { requireCap, type SellerScope } from "../platform/scoped.ts";
import { inStore } from "../platform/tenant.ts";
import { store } from "../schema.ts";
import { shippingSync } from "../shipping/sync.ts";
import { sellerProviderAccounts, type Readiness, type ReadinessGap } from "./provider-accounts.ts";

export type SetupStepId = "terms" | "mengantar_account" | "pickup" | "webhook" | "autolaris" | "bank_account";
/** What stays blocked while the step is open. */
export type SetupLock = "physical" | "cod" | "qrisVa" | "bankTransfer" | "keys" | "digital";
export interface SetupStep {
  id: SetupStepId;
  done: boolean;
  /** "disarankan" steps (the webhook) block nothing and never gate the checklist away. */
  recommended: boolean;
  href: string;
  /** What stays blocked while this step is open AND nothing else has unlocked it already (never a lock the footer lists as activatable). */
  blocks: SetupLock[];
}
export interface SetupChecklist {
  steps: SetupStep[];
  can: { physical: boolean; digital: boolean; cod: boolean; qrisVa: boolean; bankTransfer: boolean };
  /** Every required step done: the card leaves (an open webhook keeps one small note). */
  complete: boolean;
  /** A pre-0027 store still on the platform model (D-37): saving its own key or bank account moves it to its own accounts for good. */
  legacyPlatformModel: boolean;
}
export interface SetupChecklistInput {
  shipping: Readiness;
  qrisVa: Readiness;
  bankTransfer: boolean;
  termsAccepted: boolean;
  webhookSecretSet: boolean;
  legacyPlatformShipping: boolean;
  moneyMode: MoneyMode;
}

const has = (r: Readiness, ...gaps: ReadinessGap[]) => !gaps.some((g) => r.missing.includes(g));

/** The pure rule: steps in checklist order, then what each state unlocks. `can` uses the same predicates as the catalog activation gate. */
export function setupChecklist(input: SetupChecklistInput): SetupChecklist {
  const physical = physicalActivationAllowed({ moneyMode: input.moneyMode, legacyPlatformShipping: input.legacyPlatformShipping, shippingReady: input.shipping.ready });
  const can = {
    physical,
    digital: digitalPrepaidReady({ qrisVaReady: input.qrisVa.ready, bankTransferReady: input.bankTransfer }),
    cod: physical,
    qrisVa: input.qrisVa.ready,
    bankTransfer: input.bankTransfer,
  };
  const step = (id: SetupStepId, done: boolean, href: string, blocks: SetupLock[], recommended = false): SetupStep => ({
    id,
    done,
    recommended,
    href,
    blocks: done ? [] : blocks.filter((l) => l === "keys" || !can[l]),
  });
  const steps = [
    step("terms", input.termsAccepted, "/seller/payments#syarat-penjual", ["keys", "bankTransfer"]),
    // Without a key the account screen only points back to the key form, so the step links straight to it.
    step("mengantar_account", has(input.shipping, "key", "check", "dedicated"), has(input.shipping, "key") ? "/seller/shipping/account" : "/seller/payments", ["physical", "cod"]),
    step("pickup", has(input.shipping, "pickup_area", "pickup_registered"), "/seller/shipping", ["physical", "cod"]),
    step("webhook", input.webhookSecretSet, "/seller/shipping/account", [], true),
    step("autolaris", input.qrisVa.ready, "/seller/payments", ["qrisVa", "digital"]),
    step("bank_account", input.bankTransfer, "/seller/payments", ["bankTransfer", "digital"]),
  ];
  return {
    steps,
    can,
    complete: steps.every((st) => st.recommended || st.done),
    legacyPlatformModel: input.legacyPlatformShipping && input.moneyMode === "platform_held",
  };
}

/** SC-01 "Persiapan toko" (owner only): the checklist of one store. Never a key, a hint, a fingerprint or a webhook secret. Needs `integrations.manage` (and `shipping.manage`, read through `shippingSync`). */
export async function sellerSetupChecklist(scope: SellerScope): Promise<SetupChecklist> {
  requireCap(scope, "integrations.manage");
  const [accounts, sync, terms, [s], moneyMode] = await Promise.all([
    sellerProviderAccounts(scope),
    shippingSync(scope),
    sellerTermsStatus(scope),
    inStore(scope, ({ exec }) => exec.select({ legacy: store.legacyPlatformShipping }).from(store).where(eq(store.id, scope.storeId))),
    inStore(scope, ({ exec }) => storeMoneyMode(exec, scope.storeId)),
  ]);
  return setupChecklist({
    shipping: accounts.readiness.shipping,
    qrisVa: accounts.readiness.qrisVa,
    bankTransfer: accounts.readiness.bankTransfer,
    termsAccepted: terms.acceptedCurrent,
    webhookSecretSet: sync.webhook.secretSet,
    legacyPlatformShipping: s?.legacy ?? false,
    moneyMode,
  });
}
