import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { storeMoneyMode } from "../src/ledger/boundary.ts";
import { issueSellerStepUp } from "../src/ledger/stepup.ts";
import { addBankAccount, BANK_ACCOUNT_STEP_UP } from "../src/payments/bank-transfer.ts";
import { FakeProviderCheck, saveProviderKey, setPaymentAccountDetails, setProviderCheckTransport, storeReadiness, type Readiness, type ReadinessGap } from "../src/payments/provider-accounts.ts";
import { sellerSetupChecklist, setupChecklist, type SetupStepId } from "../src/payments/setup-checklist.ts";
import { bindSession } from "../src/platform/scoped.ts";
import { acceptSellerTerms } from "../src/platform/terms.ts";
import { store } from "../src/schema.ts";
import { createProduct, updateProduct } from "../src/seller/commerce/catalog.ts";
import { keyFingerprint, keyHint } from "../src/shipping/credentials.ts";
import { setPickupAddress } from "../src/shipping/shipping.ts";
import { confirmDedicatedAccount, setWebhookSecret } from "../src/shipping/sync.ts";
import { afterEach, beforeEach } from "vitest";
import { db, makeOperator, makeStore, makeUser, platform, seller } from "./helpers.ts";
import { sessionOf } from "./t37-fixtures.ts";
import { createStore } from "../src/platform/platform.ts";

// T-117 (PR-27, D-37): the setup checklist reads the T-104/T-113/T-115/T-116 readiness functions and never keeps state; the
// activation gate refuses physical products on a new store until its own Mengantar account is ready. Mutation checks live in
// docs/tracks/t117-setup-checklist.md: each breaks one rule once and names the test that fails.

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? String(e));
const r = (missing: ReadinessGap[]): Readiness => ({ ready: missing.length === 0, missing });
const step = (c: Awaited<ReturnType<typeof sellerSetupChecklist>>, id: SetupStepId) => c.steps.find((s) => s.id === id)!;

beforeEach(() => setProviderCheckTransport(new FakeProviderCheck()));
afterEach(() => setProviderCheckTransport(null));

describe("T-117 setupChecklist table", () => {
  const SHIP_SUBSETS: ReadinessGap[][] = [
    [],
    ["key"],
    ["check"],
    ["dedicated"],
    ["pickup_area"],
    ["pickup_registered"],
    ["key", "check"],
    ["key", "dedicated"],
    ["check", "dedicated"],
    ["pickup_area", "pickup_registered"],
    ["key", "pickup_area"],
    ["key", "check", "dedicated"],
    ["key", "check", "dedicated", "pickup_area", "pickup_registered"],
  ];
  const cases = SHIP_SUBSETS.flatMap((missing) =>
    [false, true].flatMap((qrisReady) =>
      [false, true].flatMap((bankTransfer) =>
        [false, true].flatMap((termsAccepted) =>
          [false, true].flatMap((webhookSecretSet) =>
            [false, true].flatMap((legacyPlatformShipping) =>
              (["platform_held", "seller_owned"] as const).map((moneyMode) => ({ missing, qrisReady, bankTransfer, termsAccepted, webhookSecretSet, legacyPlatformShipping, moneyMode })),
            ),
          ),
        ),
      ),
    ),
  );
  it.each(cases)("gaps $missing | qrisVa=$qrisReady bank=$bankTransfer terms=$termsAccepted hook=$webhookSecretSet legacy=$legacyPlatformShipping $moneyMode", (c) => {
    const shipping = r(c.missing);
    const qrisVa = r(c.qrisReady ? [] : ["key"]);
    const out = setupChecklist({ shipping, qrisVa, bankTransfer: c.bankTransfer, termsAccepted: c.termsAccepted, webhookSecretSet: c.webhookSecretSet, legacyPlatformShipping: c.legacyPlatformShipping, moneyMode: c.moneyMode });
    const byId = Object.fromEntries(out.steps.map((s) => [s.id, s]));
    const has = (...g: ReadinessGap[]) => !g.some((x) => c.missing.includes(x));
    expect(byId.terms!.done).toBe(c.termsAccepted);
    expect(byId.mengantar_account!.done).toBe(has("key", "check", "dedicated"));
    expect(byId.pickup!.done).toBe(has("pickup_area", "pickup_registered"));
    expect(byId.webhook!.done).toBe(c.webhookSecretSet);
    expect(byId.webhook!.recommended).toBe(true);
    expect(byId.webhook!.blocks).toEqual([]);
    expect(byId.autolaris!.done).toBe(c.qrisReady);
    expect(byId.bank_account!.done).toBe(c.bankTransfer);
    const physical = shipping.ready || (c.legacyPlatformShipping && c.moneyMode === "platform_held");
    expect(out.can).toEqual({ physical, digital: c.qrisReady || c.bankTransfer, cod: physical, qrisVa: c.qrisReady, bankTransfer: c.bankTransfer });
  });
});

describe("T-117 sellerSetupChecklist against storeReadiness", () => {
  const expectCan = async (storeId: number, out: Awaited<ReturnType<typeof sellerSetupChecklist>>) => {
    const r0 = await storeReadiness({ exec: db, storeId });
    const legacy = (await platform.select({ l: store.legacyPlatformShipping }).from(store).where(eq(store.id, storeId)))[0]!.l;
    const mode = await storeMoneyMode(db, storeId);
    const physical = r0.shipping.ready || (legacy && mode === "platform_held");
    expect(out.can).toEqual({ physical, digital: r0.qrisVa.ready || r0.bankTransfer, cod: physical, qrisVa: r0.qrisVa.ready, bankTransfer: r0.bankTransfer });
  };

  it("a fresh non-legacy store walks every step to ready and each stage equals storeReadiness", async () => {
    const s = await makeStore("t117walk", { legacy: false });
    const me = bindSession(s.owner, await sessionOf(s.ownerId));

    let out = await sellerSetupChecklist(me);
    await expectCan(s.storeId, out);
    expect(step(out, "terms").done).toBe(false);
    expect(step(out, "mengantar_account").done).toBe(false);
    expect(step(out, "pickup").done).toBe(false); // pickup_registered stays open until the store's own account registers it
    expect(step(out, "webhook").done).toBe(false);
    expect(step(out, "autolaris").done).toBe(false);
    expect(step(out, "bank_account").done).toBe(false);
    expect(out.can).toMatchObject({ physical: false, digital: false, cod: false });

    await acceptSellerTerms(me, { version: 1, agreed: true });
    out = await sellerSetupChecklist(me);
    expect(step(out, "terms").done).toBe(true);
    expect(out.can.physical).toBe(false);

    await addBankAccount(me, { bankCode: "BCA", accountNumber: "9876543210", holderName: "Budi Pemilik", proofId: await issueSellerStepUp(me, BANK_ACCOUNT_STEP_UP) });
    out = await sellerSetupChecklist(me);
    await expectCan(s.storeId, out);
    expect(step(out, "bank_account").done).toBe(true);
    expect(out.can).toMatchObject({ digital: true, bankTransfer: true, physical: false, qrisVa: false });

    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: "CANARY-T117-MENGANTAR-0123456789abcdef", proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
    await confirmDedicatedAccount(me, { confirmed: true });
    out = await sellerSetupChecklist(me);
    expect(step(out, "mengantar_account").done).toBe(true);
    expect(step(out, "pickup").done).toBe(false); // pickup_registered still open

    await setPickupAddress(me, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
    out = await sellerSetupChecklist(me);
    await expectCan(s.storeId, out);
    expect(step(out, "pickup").done).toBe(true);
    expect(out.can).toMatchObject({ physical: true, cod: true });
    expect(step(out, "webhook").done).toBe(false);

    await setWebhookSecret(me, { secret: "CANARY-T117-WEBHOOK-SECRET-0123456789", proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar_webhook" }) });
    out = await sellerSetupChecklist(me);
    expect(step(out, "webhook").done).toBe(true);
    await expectCan(s.storeId, out);

    await saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: "CANARY-T117-AUTOLARIS-0123456789abcdef", proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    await setPaymentAccountDetails(me, { originAreaId: "3517100", destinationAreaId: "3518010", shipperEmail: "t117@example.invalid", senderAddress: "Jl. Braga No. 1, Bandung 40111", paymentOnlyConfirmed: true });
    out = await sellerSetupChecklist(me);
    expect(step(out, "autolaris").done).toBe(true);
    expect(out.steps.every((st) => st.done)).toBe(true);
    await expectCan(s.storeId, out);
  });

  it("a store with no step done can activate nothing; a legacy store still activates physical products", async () => {
    const op = await makeOperator();
    const ownerId = await makeUser("t117fresh-owner");
    await createStore(op, { slug: "t117fresh", name: "Toko Fresh", ownerUserId: ownerId });
    const owner = await seller(ownerId);
    const physical = await createProduct(owner, { title: "Kaos Fresh", status: "draft", variant: { title: "M", price: 50_000, stock: 5, weightGrams: 1000 } });
    expect(await code(updateProduct(owner, physical, { title: "Kaos Fresh", status: "active" }))).toBe("shipping_not_ready");
    expect(await code(createProduct(owner, { title: "Kaos Fresh 2", status: "active", variant: { title: "L", price: 50_000, stock: 5, weightGrams: 1000 } }))).toBe("shipping_not_ready");
    expect(await code(createProduct(owner, { title: "E-Book Fresh", kind: "digital", status: "active", variant: { title: "PDF", price: 25_000, stock: 0 } }))).toBe("prepaid_not_ready");

    // Regression: the pre-0027 (legacy) store keeps the platform model — the same physical activation still succeeds.
    const legacy = await makeStore("t117legacy");
    expect(await code(createProduct(legacy.owner, { title: "Kaos Legacy", status: "active", variant: { title: "M", price: 60_000, stock: 3, weightGrams: 1000 } }))).toBe("ok");
    const draft = await createProduct(legacy.owner, { title: "Kaos Legacy Draft", status: "draft", variant: { title: "M", price: 60_000, stock: 3, weightGrams: 1000 } });
    expect(await code(updateProduct(legacy.owner, draft, { title: "Kaos Legacy Draft", status: "active" }))).toBe("ok");
  });

  it("the serialized checklist never carries a key, hint, fingerprint or webhook secret", async () => {
    const s = await makeStore("t117hyg", { legacy: false });
    const me = bindSession(s.owner, await sessionOf(s.ownerId));
    await acceptSellerTerms(me, { version: 1, agreed: true });
    const mkey = "CANARY-T117-HYG-MENGANTAR-0123456789abcdef";
    const akey = "CANARY-T117-HYG-AUTOLARIS-0123456789abcdef";
    const secret = "CANARY-T117-HYG-WEBHOOK-SECRET-0123456789";
    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: mkey, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
    await saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: akey, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    await setWebhookSecret(me, { secret, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar_webhook" }) });
    const json = JSON.stringify(await sellerSetupChecklist(me));
    for (const forbidden of [mkey, akey, secret, keyHint(mkey), keyHint(akey), keyFingerprint("shipping_credentials", mkey), keyFingerprint("payment_credentials", akey), keyFingerprint("shipping_credentials", secret)]) {
      expect(json).not.toContain(forbidden);
    }
  });
});
