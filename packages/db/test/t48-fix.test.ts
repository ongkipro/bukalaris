import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import "../src/shipping/jobs.ts"; // the worker's registrations: the Partner schedules are exercised through the real job handlers
import { reserveShippingCost, shippingFunding } from "../src/ledger/booking.ts";
import { releaseStore } from "../src/ledger/release.ts";
import { applyReconciliationBatch, prepareReconciliationBatch, submitReconciliationBatch, voidReconciliationBatch, voidStaleReconciliationBatch } from "../src/ledger/reconciliation.ts";
import { verifyLedger } from "../src/ledger/verify.ts";
import { consumeApproval, decideApproval, payloadHash } from "../src/ops/capabilities-approvals.ts";
import { enqueuePlatform, runOnce } from "../src/ops/jobs/jobs.ts";
import { saveVoucher } from "../src/promotions/manage.ts";
import { auditLog, ledgerEntry, order, orderFinancials, reconciliationBatch, reconciliationBatchItem, shipmentCost } from "../src/schema.ts";
import { partnerClientAvailable, provisionShippingAccount, queueShippingAccountRecovery, setPartnerTransport, SHIPPING_ACCOUNT_SWEEP, SHIPPING_ACCOUNT_SYNC, sweepPendingAccounts } from "../src/shipping/accounts.ts";
import { shippingKeyring } from "../src/shipping/credentials.ts";
import { MengantarEntryGateError, mengantarRotationRecorded, requireMengantarEntryGate } from "../src/shipping/mengantar/gate.ts";
import { FakePartnerTransport, LivePartnerTransport, PartnerClient, PARTNER_BACKOFF_MAX_MS, PARTNER_CONFLICT_ROUNDS_MAX, PARTNER_EMAIL_ATTEMPTS, PARTNER_REGISTRATION_DAILY_BUDGET, PARTNER_REGISTRATIONS_PER_DAY, partnerRetryDelayMs, takePartnerBudget, type PartnerRequest, type PartnerResponse } from "../src/shipping/mengantar/partner.ts";
import { applyApprovedMargin, requestMarginRule, setCourierPolicy } from "../src/shipping/policy.ts";
import { codAllowedCouriers, getMarginRule } from "../src/shipping/shipping.ts";
import { admin, makeOperator, makeStore, openMengantarGate, platform } from "./helpers.ts";
import { balance, deliveredCod, fund, paidPrepaid, withoutGuard } from "./t37-fixtures.ts";
import { billingTestSetup } from "./t50-fixtures.ts";
import { accountsOf, fakeTransport, setMargin, setSettings } from "./t48-fixtures.ts";

// T-48 review fixes (docs/tracks/t48-fix.md). Money items are mutation-checked; every item has a named test here.
billingTestSetup();
const HOUR = 3_600_000;
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);

// ── 1. The platform shipping discount is never paid by the seller ───────────────────────────────────────────────────────────────────────────────────────

/** A store whose platform shipping discount is `discountIdr` (courier 10 500 + margin 2 000 in the fake adapter) and one paid prepaid order. */
async function discountedOrder(discountIdr: number, voucher = false) {
  const s = await makeStore("toko-a", { price: 100_000 });
  await setSettings(await makeOperator(["shipping.manage"]), { preferPartner: false, discountIdr, discountBps: 0 });
  await fund(s); // 100 000 available: the seller can cover a debit, so a wrong debit is observable as a balance change
  const v = voucher ? await saveVoucher(s.owner, { kind: "free_shipping", scope: "all", value: 0, startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + HOUR) }) : null;
  const { orderId } = await paidPrepaid(s, 1, v ? { voucherCode: v.code } : {});
  return { s, orderId };
}
const book = (s: { storeId: number }, orderId: number, bookedShippingIdr: number) => reserveShippingCost(platform, { storeId: s.storeId, orderId, requote: { bookedShippingIdr, providerCodFeeIdr: 0 }, codAmountSentIdr: null });
const costOf = async (orderId: number) => (await platform.select().from(shipmentCost).where(eq(shipmentCost.orderId, orderId)))[0]!;
const debitsOf = async (orderId: number) => (await platform.select().from(ledgerEntry).where(and(eq(ledgerEntry.orderId, orderId), eq(ledgerEntry.kind, "shipping_debit")))).length;
const marginClass = async () => Number(((await platform.execute(sql`select amount_idr from platform_money_position where class = 'platform_shipping_margin'`)) as unknown as { amount_idr: string }[])[0]!.amount_idr);

describe("T-48 fix 1: a platform shipping discount is funded by the platform, never by the seller (BILL-4)", () => {
  it("courier 10 500, margin 2 000, platform discount 2 000, re-quote 11 000: the seller debit is 0 and the gross margin is reduced to 1 500", async () => {
    const { s, orderId } = await discountedOrder(2_000);
    const [fin] = await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId));
    expect(fin).toMatchObject({ shippingChargedIdr: 10_500, shippingDiscountIdr: 0, platformShippingDiscountIdr: 2_000 }); // the discount amount is frozen with the order
    const before = (await balance(s.storeId)).availableIdr;
    expect(await book(s, orderId, 11_000)).toMatchObject({ outcome: "reserved", debitIdr: 0, marginIdr: 1_500, debitStatus: null });
    expect(await costOf(orderId)).toMatchObject({ sellerShippingDebitIdr: 0, platformShippingMarginIdr: 1_500, platformShippingDiscountIdr: 2_000, shippingChargedIdr: 10_500, bookedShippingIdr: 11_000, shippingDebitEntryId: null });
    expect(await debitsOf(orderId)).toBe(0);
    expect((await balance(s.storeId)).availableIdr).toBe(before); // "tidak pernah dari saldo seller" is true
    expect(await marginClass()).toBe(-500); // the platform's own result: 1 500 gross margin minus the 2 000 it gave away
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });

  it("a re-quote below the courier cost leaves the platform the whole saving (gross margin 3 000) and still no seller debit", async () => {
    const { s, orderId } = await discountedOrder(2_000);
    const before = (await balance(s.storeId)).availableIdr;
    expect(await book(s, orderId, 9_500)).toMatchObject({ outcome: "reserved", debitIdr: 0, marginIdr: 3_000 });
    expect(await costOf(orderId)).toMatchObject({ sellerShippingDebitIdr: 0, platformShippingMarginIdr: 3_000 });
    expect((await balance(s.storeId)).availableIdr).toBe(before);
    expect(await marginClass()).toBe(1_000);
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });

  it("only a rise BEYOND the full margin (12 500) reaches the seller, and only that excess", async () => {
    const { s, orderId } = await discountedOrder(2_000);
    const before = (await balance(s.storeId)).availableIdr;
    expect(await book(s, orderId, 12_500)).toMatchObject({ outcome: "reserved", debitIdr: 0, marginIdr: 0 }); // the margin absorbs exactly 2 000
    const second = (await paidPrepaid(s)).orderId;
    expect(await book(s, second, 12_600)).toMatchObject({ outcome: "reserved", debitIdr: 100, marginIdr: 0 });
    expect((await balance(s.storeId)).availableIdr).toBe(before - 100);
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });

  it("a store-funded free-shipping voucher AND a platform discount together: the seller carries only the voucher, the platform the discount", async () => {
    const { s, orderId } = await discountedOrder(2_000, true);
    const [fin] = await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId));
    const [o] = await platform.select().from(order).where(eq(order.id, orderId));
    expect(fin).toMatchObject({ shippingChargedIdr: 0, shippingDiscountIdr: 10_500, platformShippingDiscountIdr: 2_000 });
    expect(o).toMatchObject({ shippingProviderCost: 10_500, shippingMargin: 0, shippingFee: 0, shippingDiscount: 10_500 });
    const before = (await balance(s.storeId)).availableIdr;
    expect(await book(s, orderId, 10_500)).toMatchObject({ outcome: "reserved", debitIdr: 10_500, marginIdr: 2_000 }); // seller: the voucher only
    const second = (await paidPrepaid(s, 1, { voucherCode: (await saveVoucher(s.owner, { kind: "free_shipping", scope: "all", value: 0, startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + HOUR) })).code })).orderId;
    expect(await book(s, second, 11_000)).toMatchObject({ outcome: "reserved", debitIdr: 10_500, marginIdr: 1_500 }); // the 500 rise is the platform's
    expect((await balance(s.storeId)).availableIdr).toBe(before - 21_000);
    for (const id of [orderId, second]) {
      const c = await costOf(id);
      expect(c.shippingChargedIdr + c.platformShippingDiscountIdr + c.sellerShippingDebitIdr).toBe(c.bookedShippingIdr + c.platformShippingMarginIdr);
      expect(c).toMatchObject({ shippingDiscountIdr: 10_500, platformShippingDiscountIdr: 2_000 });
    }
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });

  it("one formula for every combination: the seller pays the store discount plus only what exceeds charged + store + platform discount; the identity holds to the rupiah", () => {
    for (const platformDiscountIdr of [0, 500, 2_000]) for (const storeDiscountIdr of [0, 3_000, 10_500]) for (const chargedIdr of [0, 4_500, 10_500]) {
      for (let bookedIdr = 0; bookedIdr <= 30_000; bookedIdr += 250) {
        const { debit, margin } = shippingFunding({ bookedIdr, chargedIdr, storeDiscountIdr, platformDiscountIdr });
        expect(debit - storeDiscountIdr).toBe(Math.max(0, bookedIdr - (chargedIdr + storeDiscountIdr + platformDiscountIdr))); // never any part of the platform discount
        expect(chargedIdr + platformDiscountIdr + debit).toBe(bookedIdr + margin);
        expect(debit === storeDiscountIdr || margin === 0).toBe(true);
      }
    }
  });

  it("verify:ledger recomputes the funding from the frozen snapshot: a clean book passes, a snapshot changed under a booked cost is reported", async () => {
    const { s, orderId } = await discountedOrder(2_000);
    await book(s, orderId, 11_000);
    expect((await verifyLedger(platform)).violations).toEqual([]);
    await withoutGuard("order_financials", "order_financials_guard", () => admin.execute(sql`update order_financials set platform_shipping_discount_idr = 0 where order_id = ${orderId}`));
    expect((await verifyLedger(platform)).violations.map((v) => v.code)).toEqual(["shipment_cost_funding_differs"]);
  });

  it("the database refuses the old behaviour: a cost that debits the seller while keeping a margin, a broken identity, a platform discount that differs from the frozen one, and any rewrite of the snapshot", async () => {
    const { s, orderId } = await discountedOrder(2_000);
    const [fin] = await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId));
    const insert = (over: Record<string, number>) => {
      const v = { order_id: orderId, store_id: s.storeId, shipping_discount_idr: 0, platform_shipping_discount_idr: 2_000, booked_shipping_idr: 11_000, shipping_charged_idr: fin!.shippingChargedIdr, seller_shipping_debit_idr: 0, platform_shipping_margin_idr: 1_500, ...over };
      return admin.execute(sql`insert into shipment_cost (order_id, store_id, shipping_discount_idr, platform_shipping_discount_idr, booked_shipping_idr, shipping_charged_idr, seller_shipping_debit_idr, platform_shipping_margin_idr) values (${v.order_id}, ${v.store_id}, ${v.shipping_discount_idr}, ${v.platform_shipping_discount_idr}, ${v.booked_shipping_idr}, ${v.shipping_charged_idr}, ${v.seller_shipping_debit_idr}, ${v.platform_shipping_margin_idr})`);
    };
    expect(await code(insert({ seller_shipping_debit_idr: 500, platform_shipping_margin_idr: 2_000 }))).toBe("23514"); // identity holds, but the seller pays and the platform keeps a margin
    expect(await code(insert({ platform_shipping_margin_idr: 1_000 }))).toBe("23514"); // identity broken
    expect(await code(insert({ platform_shipping_discount_idr: 0, booked_shipping_idr: 10_000, platform_shipping_margin_idr: 500 }))).toBe("23514"); // a discount that differs from the frozen financials
    expect(await code(insert({ platform_shipping_discount_idr: -1, booked_shipping_idr: 9_999, platform_shipping_margin_idr: 0 }))).toBe("23514");
    expect(await book(s, orderId, 11_000)).toMatchObject({ outcome: "reserved", debitIdr: 0 }); // the legitimate booking is unaffected by the refused attempts
    expect(await code(admin.execute(sql`update order_financials set platform_shipping_discount_idr = 0 where order_id = ${orderId}`))).toBe("42501"); // immutable snapshot
    expect(await code(admin.execute(sql`update shipment_cost set platform_shipping_discount_idr = 0 where order_id = ${orderId}`))).toBe("42501");
  });
});

// ── 2. The COD allow-list is service-aware ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("T-48 fix 2: courier COD policy honours the service code (a service-level row wins over the courier-level row)", () => {
  const policy = async (rows: { courierCode: string; serviceCode: string; codAllowed: boolean; returnFree?: boolean; status?: "active" | "disabled" }[]) => {
    const op = await makeOperator(["shipping.manage"]);
    for (const r of rows) await setCourierPolicy(op, { returnFree: true, status: "active", reason: "uji kebijakan", ...r });
    return codAllowedCouriers(platform);
  };

  it("a service row alone allows only that service, not the whole courier (the old reader allowed every service of the courier)", async () => {
    const cod = await policy([{ courierCode: "SAP", serviceCode: "SAPLite", codAllowed: true }]);
    expect(cod.has("SAPLite")).toBe(true);
    expect(cod.has("saplite")).toBe(true);
    expect(cod.has("SAP")).toBe(false);
    expect(cod.has("JNE")).toBe(true); // the seeded courier-level fixture row is untouched
    expect(cod.has("Unknown")).toBe(false); // no row: refused
  });

  it("a refusing or disabled service row overrides an allowing courier row; an allowing service row overrides a refusing courier row", async () => {
    const cod = await policy([
      { courierCode: "SAP", serviceCode: "", codAllowed: true }, { courierCode: "SAP", serviceCode: "SAPLite", codAllowed: false },
      { courierCode: "ID", serviceCode: "", codAllowed: true }, { courierCode: "ID", serviceCode: "iDlite", codAllowed: true, status: "disabled" },
      { courierCode: "LION", serviceCode: "", codAllowed: false }, { courierCode: "LION", serviceCode: "lionreg", codAllowed: true },
      { courierCode: "POS", serviceCode: "", codAllowed: true, returnFree: false },
    ]);
    expect(cod.has("SAP")).toBe(true);
    expect(cod.has("SAPLite")).toBe(false);
    expect(cod.has("ID")).toBe(true);
    expect(cod.has("iDlite")).toBe(false);
    expect(cod.has("LION")).toBe(false);
    expect(cod.has("lionreg")).toBe(true);
    expect(cod.has("POS")).toBe(false); // COD needs a free return as well
  });
});

// ── 3. A hex integration key reused as the shipping key is refused ──────────────────────────────────────────────────────────────────────────────────────

describe("T-48 fix 3: the key-purpose check reads other keys as hex or base64, like the signals module", () => {
  const key = Buffer.alloc(32, 7);
  const ring = { KEYRING_SHIPPING_CREDENTIALS: `ship:${key.toString("base64")}` };

  it("INTEGRATION_TOKEN_KEY in hex (either case) or base64, and the other rings, are recognised as the same key", () => {
    expect(() => shippingKeyring({ ...ring, INTEGRATION_TOKEN_KEY: key.toString("hex") })).toThrow("shipping_key_purpose_reused");
    expect(() => shippingKeyring({ ...ring, INTEGRATION_TOKEN_KEY: key.toString("hex").toUpperCase() })).toThrow("shipping_key_purpose_reused");
    expect(() => shippingKeyring({ ...ring, INTEGRATION_TOKEN_KEY: key.toString("base64") })).toThrow("shipping_key_purpose_reused");
    expect(() => shippingKeyring({ ...ring, KEYRING_BUYER_FINGERPRINT: `k1:${key.toString("base64")}` })).toThrow("shipping_key_purpose_reused");
    expect(() => shippingKeyring({ ...ring, KEYRING_INTEGRATION_TOKENS: `i1:${key.toString("hex")}` })).toThrow("shipping_key_purpose_reused");
  });

  it("a different key in either encoding passes (positive control)", () => {
    const other = Buffer.alloc(32, 8);
    expect(shippingKeyring({ ...ring, INTEGRATION_TOKEN_KEY: other.toString("hex") })).toHaveLength(1);
    expect(shippingKeyring({ ...ring, INTEGRATION_TOKEN_KEY: other.toString("base64") })).toHaveLength(1);
  });
});

// ── 5. The entry gate sits where bytes leave, and is closed by default everywhere ───────────────────────────────────────────────────────────────────────

describe("T-48 fix 5: the Partner entry gate is enforced in the live send itself and is closed by default in every environment", () => {
  const request: PartnerRequest = { method: "POST", path: "/api/partner/v1/sellers/list", type: "application/json", body: "{}", headers: { "partner-id": "p", timestamp: "1", signature: "s" } };

  it("closed by default: no test environment, config file, example env, compose file or workflow records a rotation", () => {
    expect(mengantarRotationRecorded()).toBe(false);
    expect(() => requireMengantarEntryGate()).toThrow(MengantarEntryGateError);
    expect(process.env.MENGANTAR_PARTNER_SECRET_ROTATED_AT).toBeUndefined();
    expect(process.env.MENGANTAR_PARTNER_OLD_SECRET_REVOKED).toBeUndefined();
    const root = new URL("../../../", import.meta.url);
    const assigned = /^\s*(?:-\s*)?["']?MENGANTAR_PARTNER_(?:SECRET_ROTATED_AT|OLD_SECRET_REVOKED)["']?\s*[:=]/m;
    for (const f of ["packages/db/vitest.config.ts", "apps/web/playwright.config.ts", ".env.example", "docker-compose.yml", "package.json", "apps/web/package.json", "packages/db/package.json"]) {
      expect(assigned.test(readFileSync(new URL(f, root), "utf8")), f).toBe(false);
    }
  });

  it("a transport that merely CALLS itself 'fake' is not trusted: the client refuses it with the gate closed, sends nothing and spends no budget", async () => {
    let sends = 0;
    const liar = { mode: "fake" as const, async send(): Promise<PartnerResponse> { sends++; return { status: 200, body: { sellers: [], hasMore: false } }; } };
    await expect(new PartnerClient(platform, liar).list(1)).rejects.toBeInstanceOf(MengantarEntryGateError);
    expect(sends).toBe(0);
    expect(((await admin.execute(sql`select count(*)::int as n from shipping_partner_budget`)) as unknown as { n: number }[])[0]!.n).toBe(0);
    openMengantarGate(); // positive control: with the gate recorded the same object goes through
    await new PartnerClient(platform, liar).list(1);
    expect(sends).toBe(1);
  });

  it("every live transport meets the gate inside its own send, however it is called; the local fake never does", async () => {
    let dispatched = 0;
    class Live extends LivePartnerTransport { protected async dispatch() { dispatched++; return { status: 200, body: {} } satisfies PartnerResponse; } }
    const live = new Live();
    await expect(live.send(request)).rejects.toBeInstanceOf(MengantarEntryGateError); // called directly, bypassing PartnerClient
    expect(dispatched).toBe(0);
    openMengantarGate();
    await live.send(request);
    expect(dispatched).toBe(1);
    vi.unstubAllEnvs();
    expect((await new FakePartnerTransport().send({ ...request, body: JSON.stringify({ page: 1, limit: 50 }) })).status).toBe(200); // the fake needs no gate
    expect(((await accountsOf((await makeStore("toko-a")).storeId))).length).toBe(2);
  });
});

// ── 6. Leftover pre-account COD batches and the demo reset ──────────────────────────────────────────────────────────────────────────────────────────────

describe("T-48 fix 6: a batch made before shipping accounts can be voided by the console and prepared again; the demo reset refuses clearly", () => {
  const evidence = async (orderId: number) => ({ orderId, evidenceLineRef: `L${orderId}`, evidenceAmountIdr: (await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId)))[0]!.payableIdr, evidenceDate: "2026-10-28" });
  const batchOf = async (id: number) => (await platform.select().from(reconciliationBatch).where(eq(reconciliationBatch.id, id)))[0]!;
  /** What a pre-T-48 batch looked like: no account, and a hash over the payload WITHOUT the account. */
  async function legacyPending(orderId: number, opA: Awaited<ReturnType<typeof makeOperator>>, opB: Awaited<ReturnType<typeof makeOperator>>) {
    const line = await evidence(orderId);
    const { batchId } = await prepareReconciliationBatch(opA, { evidenceRef: `INV-${orderId}`, lines: [line] });
    const { approvalId } = await submitReconciliationBatch(opA, batchId, "rekonsiliasi lama");
    await decideApproval(opB, approvalId, "approve");
    const oldHash = payloadHash({ evidenceRef: `INV-${orderId}`, items: [{ orderId, codAmountIdr: line.evidenceAmountIdr, evidenceLineRef: line.evidenceLineRef, evidenceAmountIdr: line.evidenceAmountIdr, evidenceDate: line.evidenceDate }] });
    await withoutGuard("reconciliation_batch", "z_shipping_reconciliation_guard", () => admin.execute(sql`update reconciliation_batch set shipping_account_id = null, payload_sha256 = ${oldHash} where id = ${batchId}`));
    return { batchId, line };
  }

  it("such a batch can never be applied; any holder of payouts.reconcile voids it (audited, no second person), the same order is prepared again and released", async () => {
    const s = await makeStore("toko-a");
    const orderId = await deliveredCod(s);
    const [opA, opB, opC] = [await makeOperator(["payouts.reconcile"]), await makeOperator(["payouts.reconcile"]), await makeOperator(["payouts.reconcile"])];
    const { batchId, line } = await legacyPending(orderId, opA, opB);
    expect(await batchOf(batchId)).toMatchObject({ status: "pending_approval", shippingAccountId: null });
    expect(await code(applyReconciliationBatch(opA, batchId))).toBe("approval_invalid"); // the hash now includes the account: the stored hash can never match
    expect(await code(voidReconciliationBatch(opC, batchId, "bukan penyiap"))).toBe("not_found"); // the ordinary void is the preparer's alone

    expect(await code(voidStaleReconciliationBatch(await makeOperator(["tenants.read"]), batchId, "tanpa izin rekonsiliasi"))).toBe("forbidden");
    await expect(voidStaleReconciliationBatch(opC, batchId, "x")).rejects.toMatchObject({ name: "ZodError" });
    expect(await voidStaleReconciliationBatch(opC, batchId, "batch sebelum akun pengiriman dicatat")).toEqual({ cause: "no_account" });
    expect(await batchOf(batchId)).toMatchObject({ status: "void" });
    expect((await batchOf(batchId)).voidReason).toContain("no_account");
    expect((await platform.select().from(reconciliationBatchItem).where(eq(reconciliationBatchItem.batchId, batchId))).every((i) => i.voidedAt !== null)).toBe(true);
    const audit = (await platform.select().from(auditLog).where(eq(auditLog.action, "reconciliation.void_stale")))[0]!;
    expect(audit).toMatchObject({ actorUserId: opC.userId, subjectId: String(batchId), purposeCode: "stale_batch", outcome: "allowed" });
    expect(await code(voidStaleReconciliationBatch(opC, batchId, "sudah dibatalkan"))).toBe("not_found"); // once

    // re-prepare from the same evidence: the new batch names the account, its approval binds it, and the sale is released
    const again = await prepareReconciliationBatch(opA, { evidenceRef: "INV-BARU", lines: [line] });
    const fresh = await batchOf(again.batchId);
    expect(fresh.shippingAccountId).not.toBeNull();
    const { approvalId } = await submitReconciliationBatch(opA, again.batchId, "rekonsiliasi ulang");
    await decideApproval(opB, approvalId, "approve");
    await applyReconciliationBatch(opA, again.batchId);
    await releaseStore(platform, s.storeId);
    expect((await platform.select().from(ledgerEntry).where(and(eq(ledgerEntry.orderId, orderId), eq(ledgerEntry.kind, "sale"))))[0]).toMatchObject({ status: "available", releaseBasis: "reconciliation" });
  });

  it("a still-valid batch is refused by the stale path; a pre-account DRAFT can no longer be submitted; a hash that no longer matches counts as stale", async () => {
    const s = await makeStore("toko-a");
    const [first, second] = [await deliveredCod(s), await deliveredCod(s)];
    const [opA, opB] = [await makeOperator(["payouts.reconcile"]), await makeOperator(["payouts.reconcile"])];
    const { batchId: valid } = await prepareReconciliationBatch(opA, { evidenceRef: "INV-OK", lines: [await evidence(first)] });
    expect(await code(voidStaleReconciliationBatch(opB, valid, "masih berlaku"))).toBe("not_stale"); // a valid draft
    await submitReconciliationBatch(opA, valid, "ajukan");
    expect(await code(voidStaleReconciliationBatch(opB, valid, "masih berlaku"))).toBe("not_stale"); // a valid pending batch
    expect(await batchOf(valid)).toMatchObject({ status: "pending_approval" });

    const { batchId: draft } = await prepareReconciliationBatch(opA, { evidenceRef: "INV-DRAFT", lines: [await evidence(second)] });
    await withoutGuard("reconciliation_batch", "z_shipping_reconciliation_guard", () => admin.execute(sql`update reconciliation_batch set shipping_account_id = null where id = ${draft}`));
    expect(await code(submitReconciliationBatch(opA, draft, "lama"))).toBe("legacy_batch");
    expect(await voidStaleReconciliationBatch(opB, draft, "draf sebelum akun dicatat")).toEqual({ cause: "no_account" });

    await withoutGuard("reconciliation_batch", "z_shipping_reconciliation_guard", () => admin.execute(sql`update reconciliation_batch set payload_sha256 = ${"0".repeat(64)} where id = ${valid}`));
    expect(await voidStaleReconciliationBatch(opB, valid, "hash tidak cocok")).toEqual({ cause: "hash_changed" });
  });

  const reasonOf = (e: unknown) => (e as { cause?: { message?: string } }).cause?.message ?? String(e);
  const reset = (ids: number[]) => admin.execute(sql`select reset_demo_shipping(array[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::bigint[]) as n`);
  const refusal = (ids: number[]) => reset(ids).then(() => "ok", reasonOf);

  it("reset_demo_shipping refuses up front, naming the reason and deleting nothing, when an order or a reconciliation batch references the account; a clean demo store resets; a non-demo store is never touched", async () => {
    // an order of the demo store still references its account
    const withOrder = await makeStore("demo-satu");
    await fund(withOrder);
    expect(await refusal([withOrder.storeId])).toContain("orders of these demo stores still reference their shipping accounts");
    expect((await accountsOf(withOrder.storeId)).length).toBe(2);

    // no order is left, but a reconciliation batch (batches are never deleted) still references the account: this used to end in an anonymous FK error
    const withBatch = await makeStore("demo-dua");
    const [master] = (await accountsOf(withBatch.storeId)).filter((a) => a.kind === "platform_master");
    await admin.execute(sql`insert into reconciliation_batch (status, source, evidence_ref, prepared_by_user_id, shipping_account_id) values ('draft', 'owner_batch', 'INV-DEMO', ${withBatch.ownerId}, ${master!.id})`);
    const message = await refusal([withBatch.storeId]);
    expect(message).toContain("1 reconciliation batch(es) reference the shipping accounts of these demo stores");
    expect(message).toContain("batches are never deleted");
    expect((await accountsOf(withBatch.storeId)).length).toBe(2); // nothing was deleted

    // one refused store refuses the whole call, before anything is deleted
    const clean = await makeStore("demo-tiga");
    expect(await refusal([clean.storeId, withBatch.storeId])).toContain("reconciliation batch(es)");
    expect((await accountsOf(clean.storeId)).length).toBe(2);

    // a clean demo store resets (both accounts), a real store is ignored (0 rows)
    const real = await makeStore("toko-nyata");
    expect(Number(((await reset([clean.storeId])) as unknown as { n: string }[])[0]!.n)).toBe(2);
    expect((await accountsOf(clean.storeId)).length).toBe(0);
    expect(Number(((await reset([real.storeId])) as unknown as { n: string }[])[0]!.n)).toBe(0);
    expect((await accountsOf(real.storeId)).length).toBe(2);
  });
});

// ── 7. A margin approval is bound to the rule revision it was requested against ─────────────────────────────────────────────────────────────────────────

describe("T-48 fix 7: an approved but unapplied margin can never overwrite a later approved one", () => {
  const approve = async (op: Awaited<ReturnType<typeof makeOperator>>, rule: { fixedIdr: number; percentBps: number; roundTo: number }) => {
    const { approvalId } = await requestMarginRule(op, rule);
    await decideApproval(await makeOperator(["shipping.manage"]), approvalId, "approve");
    return approvalId;
  };
  const revisionRow = async () => ((await admin.execute(sql`select revision, fixed_idr from shipping_margin_rule where key = 'default'`)) as unknown as { revision: number; fixed_idr: string }[])[0];

  it("A and B are both approved against the same revision; B is applied; A (still inside its 24 h validity) is refused as stale and the rule stays B", async () => {
    const op = await makeOperator(["shipping.manage"]);
    const A = { fixedIdr: 1_000, percentBps: 0, roundTo: 500 };
    const B = { fixedIdr: 3_000, percentBps: 0, roundTo: 500 };
    const approvalA = await approve(op, A);
    const approvalB = await approve(op, B);
    await applyApprovedMargin(op, B, approvalB);
    expect(await revisionRow()).toMatchObject({ revision: 1, fixed_idr: "3000" });
    expect(await code(applyApprovedMargin(op, A, approvalA))).toBe("approval_stale");
    expect(await getMarginRule(platform)).toMatchObject({ fixedIdr: 3_000 }); // B survived
    expect(await revisionRow()).toMatchObject({ revision: 1 });
    // the stale approval was not consumed by the refused attempt, and a fresh request against the new revision works
    const approvalC = await approve(op, { fixedIdr: 4_000, percentBps: 0, roundTo: 500 });
    await applyApprovedMargin(op, { fixedIdr: 4_000, percentBps: 0, roundTo: 500 }, approvalC);
    expect(await revisionRow()).toMatchObject({ revision: 2, fixed_idr: "4000" });
    expect(await code(applyApprovedMargin(op, { fixedIdr: 4_000, percentBps: 0, roundTo: 500 }, approvalC))).toBe("approval_invalid"); // one use: an executed approval is invalid, not stale
  });

  it("the database refuses the same overwrite when the service is bypassed: the approval's payload names the revision, the guard compares it with the row", async () => {
    const op = await makeOperator(["shipping.manage"]);
    const A = { fixedIdr: 1_000, percentBps: 0, roundTo: 500 };
    const approvalA = await approve(op, A);
    await setMargin(op, { fixedIdr: 2_500, percentBps: 0, roundTo: 500 }); // revision 1
    const forged = platform.transaction(async (tx) => {
      await consumeApproval(tx, op, { approvalId: approvalA, actionKey: "shipping.margin", targetKind: "shipping_margin_rule", targetId: "default", payloadSha256: payloadHash({ revision: 0, ...A }) });
      await tx.execute(sql`update shipping_margin_rule set fixed_idr = 1000, revision = 2, approval_request_id = ${approvalA}, updated_by = ${op.userId} where key = 'default'`);
    });
    expect(await code(forged)).toBe("23514");
    expect(await revisionRow()).toMatchObject({ revision: 1, fixed_idr: "2500" });
    // and a revision that does not move by exactly one is refused too
    expect(await code(admin.execute(sql`update shipping_margin_rule set revision = 5 where key = 'default'`))).toBe("23514");
  });
});

// ── 8. Production noise and the registration budget ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("T-48 fix 8: no dead jobs while no live adapter exists; bounded, backed-off, budgeted registrations", () => {
  it("the sweep and sync schedules are no-ops in production without a live adapter (one log line each, job done, nothing provisioned); the same jobs work where a fake is installed", async () => {
    const s = await makeStore("toko-a");
    setPartnerTransport(null);
    vi.stubEnv("NODE_ENV", "production");
    expect(partnerClientAvailable()).toBe(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await enqueuePlatform(platform, { kind: SHIPPING_ACCOUNT_SWEEP, key: "t48fix-sweep" });
    await enqueuePlatform(platform, { kind: SHIPPING_ACCOUNT_SYNC, key: "t48fix-sync" });
    const out = await runOnce(platform, { workerId: "t48fix" });
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("shipping.partner.skipped"));
    log.mockRestore();
    vi.unstubAllEnvs();
    expect(out.filter((o) => o.kind === SHIPPING_ACCOUNT_SWEEP || o.kind === SHIPPING_ACCOUNT_SYNC).map((o) => o.status)).toEqual(["done", "done"]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => (JSON.parse(l) as { kind: string }).kind).sort()).toEqual([SHIPPING_ACCOUNT_SWEEP, SHIPPING_ACCOUNT_SYNC]);
    expect((await accountsOf(s.storeId)).find((a) => a.kind === "partner_managed")).toMatchObject({ status: "pending", sealedKey: null });
    expect(((await admin.execute(sql`select count(*)::int as n from job where status in ('dead', 'failed')`)) as unknown as { n: number }[])[0]!.n).toBe(0);

    const { transport } = fakeTransport(); // control: with a transport installed the identical job provisions the store
    expect(partnerClientAvailable()).toBe(true);
    await enqueuePlatform(platform, { kind: SHIPPING_ACCOUNT_SWEEP, key: "t48fix-sweep-2" });
    await runOnce(platform, { workerId: "t48fix" });
    expect(transport.registrations).toBe(1);
    expect((await accountsOf(s.storeId)).find((a) => a.kind === "partner_managed")).toMatchObject({ status: "active" });
  });

  it("repeated 409s: back-off doubles per failed round, a store stops after the per-store cap (9 registrations), the sweep skips it, and an owner recovery starts it again", async () => {
    const s = await makeStore("toko-a");
    const { transport, client } = fakeTransport();
    transport.conflictNext = 10_000; // every registration answers 409
    const partner = async () => (await accountsOf(s.storeId)).find((a) => a.kind === "partner_managed")!;
    for (let round = 1; round <= PARTNER_CONFLICT_ROUNDS_MAX; round++) {
      await admin.execute(sql`update store_shipping_account set next_retry_at = null where store_id = ${s.storeId} and kind = 'partner_managed'`);
      await expect(provisionShippingAccount(platform, s.storeId, client())).rejects.toMatchObject({ code: "EMAIL_ALREADY_REGISTERED" });
      const row = await partner();
      expect(row).toMatchObject({ registrationAttempts: round, lastResult: "EMAIL_ALREADY_REGISTERED", status: "pending" });
      const delay = row.nextRetryAt!.getTime() - Date.now();
      expect(delay).toBeGreaterThan(partnerRetryDelayMs(round) - 30_000);
      expect(delay).toBeLessThanOrEqual(partnerRetryDelayMs(round));
    }
    expect([partnerRetryDelayMs(1), partnerRetryDelayMs(2), partnerRetryDelayMs(3), partnerRetryDelayMs(50)]).toEqual([15 * 60_000, 30 * 60_000, 60 * 60_000, PARTNER_BACKOFF_MAX_MS]);
    expect(transport.calls.filter((c) => c.path === "/api/partner/v1/sellers")).toHaveLength(PARTNER_CONFLICT_ROUNDS_MAX * PARTNER_EMAIL_ATTEMPTS);

    // capped: even when due, neither a direct attempt nor the sweep calls the provider again
    await admin.execute(sql`update store_shipping_account set next_retry_at = now() - interval '1 second' where store_id = ${s.storeId} and kind = 'partner_managed'`);
    expect(await provisionShippingAccount(platform, s.storeId, client())).toMatchObject({ outcome: "busy" });
    expect(await sweepPendingAccounts(platform, client())).toEqual([]);
    expect(transport.calls.filter((c) => c.path === "/api/partner/v1/sellers")).toHaveLength(PARTNER_CONFLICT_ROUNDS_MAX * PARTNER_EMAIL_ATTEMPTS);
    const health = (await (await import("../src/shipping/accounts.ts")).shippingAccountHealth(await makeOperator(["shipping.manage"]))).accounts.find((a) => a.kind === "partner_managed" && a.storeId === s.storeId)!;
    expect(health).toMatchObject({ registrationAttempts: PARTNER_CONFLICT_ROUNDS_MAX, autoRetryStopped: true });

    // the owner recovers the account: counters reset, and once the conflict is gone the store provisions
    transport.conflictNext = 0;
    const row = await partner();
    await queueShippingAccountRecovery(await makeOperator(["shipping.manage"]), { accountId: row.id, revision: row.revision, reason: "pemilik memulihkan akun" });
    expect(await partner()).toMatchObject({ registrationAttempts: 0 });
    expect(await provisionShippingAccount(platform, s.storeId, client())).toMatchObject({ outcome: "active" });
    expect(await partner()).toMatchObject({ status: "active", registrationAttempts: 0 });
  });

  it("a global daily registration budget (named, below the provider's 1 000) is shared by every store and worker; a rate limit never counts against a store", async () => {
    expect(PARTNER_REGISTRATION_DAILY_BUDGET).toBeLessThan(PARTNER_REGISTRATIONS_PER_DAY);
    await takePartnerBudget(platform, false); // creates the shared row
    await admin.execute(sql`update shipping_partner_budget set tokens = 60, registrations = ${PARTNER_REGISTRATION_DAILY_BUDGET - 1}`);
    await takePartnerBudget(platform, true); // the last one of the day
    await admin.execute(sql`update shipping_partner_budget set tokens = 60`);
    await expect(takePartnerBudget(platform, true)).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 86_400 });
    await takePartnerBudget(platform, false); // reads and key fetches still work
    const s = await makeStore("toko-a");
    const { transport, client } = fakeTransport();
    await expect(provisionShippingAccount(platform, s.storeId, client())).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(transport.calls).toEqual([]); // nothing reached the provider
    const row = (await accountsOf(s.storeId)).find((a) => a.kind === "partner_managed")!;
    expect(row).toMatchObject({ registrationAttempts: 0, lastResult: "RATE_LIMITED", status: "pending" });
    expect(row.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });
});
