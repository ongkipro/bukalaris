// T-117 (PR-27, ADR-0013 decisions 12 to 14 and 36, ADR-0016 decision 21): the seller setup checklist. It reads the readiness
// functions of T-104/T-113/T-115/T-116 and keeps no state of its own; a step never shows or asks for a key — it links to the
// screen that owns the form (SC-34, SC-31/SC-32, the T-116 terms section).

import { eq } from "drizzle-orm";
import { storeMoneyMode, type MoneyMode } from "../ledger/boundary.ts";
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
  blocks: SetupLock[];
}
export interface SetupChecklist {
  steps: SetupStep[];
  can: { physical: boolean; digital: boolean; cod: boolean; qrisVa: boolean; bankTransfer: boolean };
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

/** The pure rule: steps in checklist order, then what each state unlocks. `physical`/`cod` use the same rule as the T-117 activation gate. */
export function setupChecklist(input: SetupChecklistInput): SetupChecklist {
  const shippingReady = input.shipping.ready || (input.legacyPlatformShipping && input.moneyMode === "platform_held");
  const steps: SetupStep[] = [
    { id: "terms", done: input.termsAccepted, recommended: false, href: "/seller/payments#syarat-penjual", blocks: ["keys", "bankTransfer"] },
    { id: "mengantar_account", done: has(input.shipping, "key", "check", "dedicated"), recommended: false, href: "/seller/shipping/account", blocks: ["physical", "cod"] },
    { id: "pickup", done: has(input.shipping, "pickup_area", "pickup_registered"), recommended: false, href: "/seller/shipping", blocks: ["physical", "cod"] },
    { id: "webhook", done: input.webhookSecretSet, recommended: true, href: "/seller/shipping/account", blocks: [] },
    { id: "autolaris", done: input.qrisVa.ready, recommended: false, href: "/seller/payments", blocks: ["qrisVa", "digital"] },
    { id: "bank_account", done: input.bankTransfer, recommended: false, href: "/seller/payments", blocks: ["bankTransfer", "digital"] },
  ];
  return {
    steps,
    can: {
      physical: shippingReady,
      digital: input.qrisVa.ready || input.bankTransfer,
      cod: shippingReady,
      qrisVa: input.qrisVa.ready,
      bankTransfer: input.bankTransfer,
    },
  };
}

/** SC-01 "Persiapan toko" (owner only): the checklist of one store. Never a key, a hint, a fingerprint or a webhook secret. */
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
