import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { digitalPrepaidReady, physicalActivationAllowed } from "../src/ledger/boundary.ts";
import { issueSellerStepUp } from "../src/ledger/stepup.ts";
import { addBankAccount, BANK_ACCOUNT_STEP_UP } from "../src/payments/bank-transfer.ts";
import { FakeProviderCheck, saveProviderKey, setPaymentAccountDetails, setProviderCheckTransport, storeReadiness, type Readiness, type ReadinessGap } from "../src/payments/provider-accounts.ts";
import { sellerSetupChecklist, setupChecklist, type SetupStepId } from "../src/payments/setup-checklist.ts";
import { bindSession, type SellerScope } from "../src/platform/scoped.ts";
import { acceptSellerTerms } from "../src/platform/terms.ts";
import { store } from "../src/schema.ts";
import { createProduct, updateProduct } from "../src/seller/commerce/catalog.ts";
import { keyFingerprint, keyHint } from "../src/shipping/credentials.ts";
import { setPickupAddress } from "../src/shipping/shipping.ts";
import { confirmDedicatedAccount, setWebhookSecret } from "../src/shipping/sync.ts";
import { afterEach, beforeEach } from "vitest";
import { admin, db, makeOperator, makeStore, makeUser, platform, seller } from "./helpers.ts";
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
  // Every subset of the five shipping gaps (32) x three AutoLaris readiness shapes x every boolean input x both money modes.
  const SHIP_GAPS: ReadinessGap[] = ["key", "check", "dedicated", "pickup_area", "pickup_registered"];
  const SHIP_SUBSETS = Array.from({ length: 1 << SHIP_GAPS.length }, (_, m) => SHIP_GAPS.filter((_, b) => m & (1 << b)));
  const QRIS_SHAPES: ReadinessGap[][] = [[], ["key"], ["payment_only", "production_off"]];
  const bools = [false, true];
  const cases = SHIP_SUBSETS.flatMap((missing) =>
    QRIS_SHAPES.flatMap((qrisMissing) =>
      bools.flatMap((bankTransfer) =>
        bools.flatMap((termsAccepted) =>
          bools.flatMap((webhookSecretSet) =>
            bools.flatMap((legacyPlatformShipping) =>
              (["platform_held", "seller_owned"] as const).map((moneyMode) => ({ missing, qrisMissing, bankTransfer, termsAccepted, webhookSecretSet, legacyPlatformShipping, moneyMode })),
            ),
          ),
        ),
      ),
    ),
  );
  it("covers every combination", () => expect(cases).toHaveLength(32 * 3 * 2 ** 4 * 2));
  // One test over the whole table: the per-test database reset would otherwise dominate the run. A failure names its case.
  const check = (c: (typeof cases)[number]) => {
    const shipping = r(c.missing);
    const qrisVa = r(c.qrisMissing);
    const out = setupChecklist({ shipping, qrisVa, bankTransfer: c.bankTransfer, termsAccepted: c.termsAccepted, webhookSecretSet: c.webhookSecretSet, legacyPlatformShipping: c.legacyPlatformShipping, moneyMode: c.moneyMode });
    const byId = Object.fromEntries(out.steps.map((s) => [s.id, s]));
    const has = (...g: ReadinessGap[]) => !g.some((x) => c.missing.includes(x));
    expect(out.steps.map((s) => s.id)).toEqual(["terms", "mengantar_account", "pickup", "webhook", "autolaris", "bank_account"]);
    expect(byId.terms!.done).toBe(c.termsAccepted);
    expect(byId.mengantar_account!.done).toBe(has("key", "check", "dedicated"));
    expect(byId.pickup!.done).toBe(has("pickup_area", "pickup_registered"));
    expect(byId.webhook!.done).toBe(c.webhookSecretSet);
    expect(byId.webhook!.recommended).toBe(true);
    expect(byId.webhook!.blocks).toEqual([]);
    expect(byId.autolaris!.done).toBe(qrisVa.ready);
    expect(byId.bank_account!.done).toBe(c.bankTransfer);
    // `can` is the catalog gate's own predicates over the readiness inputs (the DB walk below ties the predicates to real activations).
    const physical = physicalActivationAllowed({ moneyMode: c.moneyMode, legacyPlatformShipping: c.legacyPlatformShipping, shippingReady: shipping.ready });
    expect(out.can).toEqual({ physical, digital: digitalPrepaidReady({ qrisVaReady: qrisVa.ready, bankTransferReady: c.bankTransfer }), cod: physical, qrisVa: qrisVa.ready, bankTransfer: c.bankTransfer });
    // Review finding 1: a step never names as locked what the footer lists as activatable, and a done step names nothing.
    for (const st of out.steps) {
      if (st.done) expect(st.blocks).toEqual([]);
      for (const lock of st.blocks) if (lock !== "keys") expect(out.can[lock]).toBe(false);
    }
    expect(out.complete).toBe(out.steps.every((st) => st.recommended || st.done));
    expect(out.legacyPlatformModel).toBe(c.legacyPlatformShipping && c.moneyMode === "platform_held");
    expect(byId.mengantar_account!.href).toBe(has("key") ? "/seller/shipping/account" : "/seller/payments");
  };
  it("every case: steps equal the readiness inputs, `can` equals the gate predicates, no lock contradicts `can`", () => {
    for (const c of cases) {
      try {
        check(c);
      } catch (err) {
        throw new Error(`case ${JSON.stringify(c)}: ${(err as Error).message}`);
      }
    }
  });

  it("bank account done with AutoLaris open: the AutoLaris step locks QRIS/VA only, not digital products", () => {
    const out = setupChecklist({ shipping: r(["key"]), qrisVa: r(["key"]), bankTransfer: true, termsAccepted: true, webhookSecretSet: false, legacyPlatformShipping: false, moneyMode: "seller_owned" });
    expect(out.can.digital).toBe(true);
    expect(out.steps.find((st) => st.id === "autolaris")!.blocks).toEqual(["qrisVa"]);
  });
});

describe("T-117 sellerSetupChecklist against storeReadiness", () => {
  // Review finding 2: each stage's `can.physical` / `can.digital` is checked against a real activation attempt through the catalog gate,
  // and against storeReadiness — not against a re-statement of the rule.
  const expectCan = async (me: SellerScope, storeId: number, out: Awaited<ReturnType<typeof sellerSetupChecklist>>) => {
    const r0 = await storeReadiness({ exec: db, storeId });
    expect({ qrisVa: out.can.qrisVa, bankTransfer: out.can.bankTransfer }).toEqual({ qrisVa: r0.qrisVa.ready, bankTransfer: r0.bankTransfer });
    const tag = `${storeId}-${++attempt}`;
    const physical = await code(createProduct(me, { title: `Fisik ${tag}`, status: "active", variant: { title: "M", price: 50_000, stock: 1, weightGrams: 500 } }));
    expect(physical === "ok", `physical activation: ${physical}`).toBe(out.can.physical);
    if (out.can.physical) expect(physical).toBe("ok");
    else expect(physical).toBe("shipping_not_ready");
    // A digital product without delivery content is refused either way; WHICH refusal says whether the prepaid rule held.
    const digital = await code(createProduct(me, { title: `Digital ${tag}`, kind: "digital", status: "active", variant: { title: "PDF", price: 25_000, stock: 0 } }));
    expect(digital).toBe(out.can.digital ? "delivery_content_required" : "prepaid_not_ready");
  };
  let attempt = 0;

  it("a fresh non-legacy store walks every step to ready and each stage equals storeReadiness", async () => {
    const s = await makeStore("t117walk", { legacy: false });
    const me = bindSession(s.owner, await sessionOf(s.ownerId));

    let out = await sellerSetupChecklist(me);
    await expectCan(me, s.storeId, out);
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
    await expectCan(me, s.storeId, out);
    expect(step(out, "bank_account").done).toBe(true);
    expect(out.can).toMatchObject({ digital: true, bankTransfer: true, physical: false, qrisVa: false });

    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: "CANARY-T117-MENGANTAR-0123456789abcdef", proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
    await confirmDedicatedAccount(me, { confirmed: true });
    out = await sellerSetupChecklist(me);
    expect(step(out, "mengantar_account").done).toBe(true);
    expect(step(out, "pickup").done).toBe(false); // pickup_registered still open

    await setPickupAddress(me, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
    out = await sellerSetupChecklist(me);
    await expectCan(me, s.storeId, out);
    expect(step(out, "pickup").done).toBe(true);
    expect(out.can).toMatchObject({ physical: true, cod: true });
    expect(step(out, "webhook").done).toBe(false);

    await setWebhookSecret(me, { secret: "CANARY-T117-WEBHOOK-SECRET-0123456789", proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar_webhook" }) });
    out = await sellerSetupChecklist(me);
    expect(step(out, "webhook").done).toBe(true);
    await expectCan(me, s.storeId, out);

    await saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: "CANARY-T117-AUTOLARIS-0123456789abcdef", proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    await setPaymentAccountDetails(me, { originAreaId: "3517100", destinationAreaId: "3518010", shipperEmail: "t117@example.invalid", senderAddress: "Jl. Braga No. 1, Bandung 40111", paymentOnlyConfirmed: true });
    out = await sellerSetupChecklist(me);
    expect(step(out, "autolaris").done).toBe(true);
    expect(out.steps.every((st) => st.done)).toBe(true);
    expect(out.complete).toBe(true); // the card leaves
    expect(out.legacyPlatformModel).toBe(false);
    await expectCan(me, s.storeId, out);
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

describe("T-117 review follow-up", () => {
  it("staff cannot read the checklist (owner only)", async () => {
    const s = await makeStore("t117staff", { legacy: false });
    const staffId = await makeUser("t117staff-staff");
    await admin.execute(sql`insert into membership (store_id, user_id, role) values (${s.storeId}, ${staffId}, 'staff')`);
    expect(await code(sellerSetupChecklist(await seller(staffId, s.storeId)))).toBe("forbidden");
  });

  it("a legacy store that moved to its own accounts (bank account listed) can no longer activate a physical product without its own Mengantar account", async () => {
    const s = await makeStore("t117moved");
    const me = bindSession(s.owner, await sessionOf(s.ownerId));
    let out = await sellerSetupChecklist(me);
    expect(out.legacyPlatformModel).toBe(true); // the card warns before the move
    expect(out.can.physical).toBe(true);
    await acceptSellerTerms(me, { version: 1, agreed: true });
    await addBankAccount(me, { bankCode: "BCA", accountNumber: "1122334455", holderName: "Budi Pemilik", proofId: await issueSellerStepUp(me, BANK_ACCOUNT_STEP_UP) });
    out = await sellerSetupChecklist(me);
    expect(out.legacyPlatformModel).toBe(false);
    expect(out.can.physical).toBe(false);
    expect(await code(createProduct(me, { title: "Kaos Pindah", status: "active", variant: { title: "M", price: 60_000, stock: 3, weightGrams: 1000 } }))).toBe("shipping_not_ready");
  });

  it("the application role cannot write store.legacy_platform_shipping", async () => {
    const s = await makeStore("t117flag", { legacy: false });
    await expect(db.execute(sql`update store set legacy_platform_shipping = true where id = ${s.storeId}`)).rejects.toMatchObject({ cause: { code: "42501" } });
    expect((await platform.select({ l: store.legacyPlatformShipping }).from(store).where(eq(store.id, s.storeId)))[0]!.l).toBe(false);
  });
});
