import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reserveShippingCost } from "../src/ledger/booking.ts";
import { releaseStore } from "../src/ledger/release.ts";
import { applyReconciliationBatch, prepareReconciliationBatch, submitReconciliationBatch } from "../src/ledger/reconciliation.ts";
import { PROVIDER_RECONCILIATION_ENABLED } from "../src/ledger/settings.ts";
import { consumeApproval, decideApproval, payloadHash } from "../src/ops/capabilities-approvals.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { withStore } from "../src/platform/tenant.ts";
import { bookShipment, setBookingAdapter, type BookingAdapter, type BookingInput } from "../src/shipping/fulfillment.ts";
import { orderShippingAccount, queueShippingAccountRecovery, sellerShippingAccounts, shippingAccountHealth } from "../src/shipping/accounts.ts";
import { applyShippingDiscount, applyShippingSettings, effectiveShippingDiscount, requestShippingSettings, saveCashbackRule, setCourierPolicy, shippingPolicyOverview } from "../src/shipping/policy.ts";
import { shippingReconciliationByAccount } from "../src/shipping/reconciliation.ts";
import { fakeMengantar } from "../src/payments/providers.ts";
import { setPickupArea, shippingOptions } from "../src/shipping/shipping.ts";
import { auditLog, job, ledgerEntry, order, orderFinancials, shipment, shipmentCost } from "../src/schema.ts";
import { admin, db, makeOperator, makeStore, makeUser, platform, seller } from "./helpers.ts";
import { accountsOf, orderAccount, provision, setSettings } from "./t48-fixtures.ts";
import { deliveredCod, deliveredPrepaid, fund, paidPrepaid, place, withoutGuard, type S } from "./t37-fixtures.ts";

// T-48 snapshots, no-failover booking, account-scoped reconciliation and the policy settings, all against the fake adapters.

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
const DEST = "b1b1b1b1b1b1b1b1b1b1b1b1";
afterEach(() => {
  setBookingAdapter(null);
  vi.unstubAllGlobals();
  delete process.env.MENGANTAR_API_KEY;
});

async function partnerStore(slug: string): Promise<S & { partner: Awaited<ReturnType<typeof accountsOf>>[number]; master: Awaited<ReturnType<typeof accountsOf>>[number] }> {
  const s = await makeStore(slug);
  await provision(s.storeId);
  await setSettings(await makeOperator(["shipping.manage"]), { preferPartner: true, discountIdr: 0, discountBps: 0 }); // OPEN-F9 is off by default: the owner turns partner routing on
  const rows = await accountsOf(s.storeId);
  return { ...s, partner: rows.find((a) => a.kind === "partner_managed")!, master: rows.find((a) => a.kind === "platform_master")! };
}
type Scripted = BookingAdapter & { inputs: BookingInput[]; tracks: number };
function scripted(): Scripted {
  const a: Scripted = {
    inputs: [],
    tracks: 0,
    async createOrder(input) {
      a.inputs.push(input);
      return { providerOrderId: `MGT-${input.orderId}`, providerBatchId: `B-${input.orderId}`, trackingNumber: `RESI-${input.orderId}`, paid: true, providerStatus: "PENDING PICKUP" };
    },
    async payUnpaid() {},
    async track() {
      a.tracks++;
      return { trackingNumber: null, providerStatus: "PENDING PICKUP", paid: null, history: [] };
    },
  };
  return a;
}
const run = () => runOnce(platform, { workerId: "t48" });
const shipmentOf = async (orderId: number) => (await platform.select().from(shipment).where(eq(shipment.orderId, orderId)))[0]!;

describe("account snapshot on the order (DATA-9): one source of truth, immutable, no failover", () => {
  it("checkout freezes the selected account on the order, its financials and later the cost; routing changes never move an existing order", async () => {
    const s = await partnerStore("toko-a");
    const o1 = await place(s);
    expect(await orderAccount(o1)).toEqual({ order: { id: s.partner.id, kind: "partner_managed" }, financials: { id: s.partner.id, kind: "partner_managed" } });
    const op = await makeOperator(["shipping.manage"]);
    await setSettings(op, { preferPartner: false, discountIdr: 0, discountBps: 0 });
    const o2 = await place(s);
    expect((await orderAccount(o2)).order).toEqual({ id: s.master.id, kind: "platform_master" });
    expect((await orderAccount(o1)).order).toEqual({ id: s.partner.id, kind: "partner_managed" });
    await admin.execute(sql`update store_shipping_account set status = 'disabled' where id = ${s.partner.id}`);
    expect((await orderAccount(o1)).order).toEqual({ id: s.partner.id, kind: "partner_managed" }); // the snapshot is not rewritten by a disabled account
    expect(await code(orderShippingAccount(platform, s.storeId, o1))).toBe("awaiting_account"); // and it is never replaced by the master either
    expect((await orderShippingAccount(platform, s.storeId, o2)).kind).toBe("platform_master");
  });

  it("a partner account that is not active yet is not used: the new order is on the master account", async () => {
    const s = await makeStore("toko-a"); // partner pending
    const o = await place(s);
    expect((await orderAccount(o)).order).toMatchObject({ kind: "platform_master" });
  });

  it("the snapshot is immutable in the database for the app, the worker and the owner; the compound FK keeps it inside the store", async () => {
    const a = await partnerStore("toko-a");
    const b = await partnerStore("toko-b");
    const o = await place(a);
    expect(await code(Promise.resolve(platform.update(order).set({ shippingAccountId: a.master.id, shippingAccountKind: "platform_master" }).where(eq(order.id, o))))).toBe("42501");
    expect(await code(admin.execute(sql`update "order" set shipping_account_id = ${a.master.id}, shipping_account_kind = 'platform_master' where id = ${o}`))).toBe("42501");
    expect(await code(withStore(db, a.storeId, (tx) => tx.execute(sql`update "order" set shipping_account_id = ${a.master.id}, shipping_account_kind = 'platform_master' where id = ${o}`)))).toBe("42501");
    expect(await code(Promise.resolve(platform.update(orderFinancials).set({ shippingAccountId: a.master.id }).where(eq(orderFinancials.orderId, o))))).toBe("42501");
    await withoutGuard('"order"', "a_shipping_snapshot_guard", async () => {
      expect(await code(admin.execute(sql`update "order" set shipping_account_id = ${b.partner.id}, shipping_account_kind = 'partner_managed' where id = ${o}`))).toBe("23503");
    });
    expect((await orderAccount(o)).order.id).toBe(a.partner.id);
  });

  it("financial and cost rows must carry the order's account: another account, even the master of the same store, is refused", async () => {
    const s = await partnerStore("toko-a");
    await fund(s);
    const { orderId } = await paidPrepaid(s);
    expect(await code(admin.execute(sql`insert into shipment_cost (order_id, store_id, shipping_account_id, shipping_account_kind, booked_shipping_idr, shipping_charged_idr, seller_shipping_debit_idr, platform_shipping_margin_idr) select order_id, store_id, ${s.master.id}, 'platform_master', shipping_charged_idr, shipping_charged_idr, 0, 0 from order_financials where order_id = ${orderId}`))).toBe("23514");
    const r = await reserveShippingCost(platform, { storeId: s.storeId, orderId, requote: { bookedShippingIdr: 10_500, providerCodFeeIdr: 0 }, codAmountSentIdr: null });
    expect(r.outcome).toBe("reserved");
    const [cost] = await platform.select().from(shipmentCost).where(eq(shipmentCost.orderId, orderId));
    expect(cost).toMatchObject({ shippingAccountId: s.partner.id, shippingAccountKind: "partner_managed" });
    expect(await code(admin.execute(sql`update shipment_cost set shipping_account_id = ${s.master.id} where order_id = ${orderId}`))).toBe("42501");
  });
});

describe("booking and tracking use the snapshotted account only (no silent failover)", () => {
  it("a booked shipment is sent for the snapshot account; an account that needs recovery stops the booking visibly (awaiting_account), pays nothing, and the retry after recovery uses the SAME account", async () => {
    const s = await partnerStore("toko-a");
    const adapter = scripted();
    setBookingAdapter(adapter);
    const { orderId: o1 } = await paidPrepaid(s);
    await bookShipment(s.owner, o1);
    await run();
    expect(adapter.inputs.map((i) => [i.orderId, i.shippingAccountId, i.shippingAccountKind])).toEqual([[o1, s.partner.id, "partner_managed"]]);
    expect((await platform.select().from(shipmentCost).where(eq(shipmentCost.orderId, o1)))[0]).toMatchObject({ shippingAccountId: s.partner.id });

    const { orderId: o2 } = await paidPrepaid(s);
    await admin.execute(sql`update store_shipping_account set status = 'needs_key' where id = ${s.partner.id}`);
    await bookShipment(s.owner, o2);
    await run();
    expect(adapter.inputs).toHaveLength(1); // nothing was sent, on any account
    expect(await shipmentOf(o2)).toMatchObject({ status: "awaiting_account" });
    expect((await shipmentOf(o2)).lastError).toContain("tidak dialihkan");
    expect(await platform.select().from(shipmentCost).where(eq(shipmentCost.orderId, o2))).toEqual([]); // no debit was reserved for a booking that did not happen
    await admin.execute(sql`update store_shipping_account set status = 'active' where id = ${s.partner.id}`);
    await bookShipment(s.owner, o2); // the seller's retry (awaiting_account is retryable)
    await run();
    expect(adapter.inputs.map((i) => [i.orderId, i.shippingAccountId])).toEqual([[o1, s.partner.id], [o2, s.partner.id]]);
  });

  it("tracking polls the snapshot account; an account that needs recovery is not polled and not replaced, and tracking resumes by itself afterwards", async () => {
    const s = await partnerStore("toko-a");
    const adapter = scripted();
    setBookingAdapter(adapter);
    const { orderId } = await paidPrepaid(s);
    await bookShipment(s.owner, orderId);
    await run();
    await admin.execute(sql`update store_shipping_account set status = 'needs_key' where id = ${s.partner.id}`); // what a recovery request sets; a disabled account is final
    await admin.execute(sql`update job set next_attempt_at = now() - interval '1 second' where kind = 'shipment.track'`);
    await run();
    expect(adapter.tracks).toBe(0);
    // Wave 4 review: a booked parcel keeps its real status; the error is recorded and tracking is re-queued, so it resumes by itself once the account is usable.
    const during = await shipmentOf(orderId);
    expect(during.status).not.toBe("awaiting_account");
    expect(during.lastError).toBeTruthy();
    const pending = await platform.select().from(job).where(eq(job.kind, "shipment.track"));
    expect(pending.some((j) => j.status === "pending" && j.key.includes(":acct:"))).toBe(true);
    await admin.execute(sql`update store_shipping_account set status = 'active' where id = ${s.partner.id}`);
    await admin.execute(sql`update job set next_attempt_at = now() - interval '1 second' where kind = 'shipment.track' and status = 'pending'`);
    await run();
    expect(adapter.tracks).toBeGreaterThan(0); // polled with the SAME account after recovery, no manual refresh needed
    expect((await shipmentOf(orderId)).lastError).toBeNull();
  });

  it("a partner snapshot is never sent through the master credential, even when the real adapter is configured", async () => {
    const s = await partnerStore("toko-a");
    const { orderId } = await paidPrepaid(s);
    process.env.MENGANTAR_API_KEY = "live-key-placeholder-0123456789";
    const f = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", f);
    await bookShipment(s.owner, orderId);
    await run();
    expect(f).not.toHaveBeenCalled();
    expect(await shipmentOf(orderId)).toMatchObject({ status: "awaiting_account" });
  });
});

describe("BILL-4 booking funding: a promotion discount keeps the platform margin whole (shipment_cost.shipping_discount_idr)", () => {
  it("debit = max(booked - (charged + discount), 0) + discount; margin = max(-(booked - (charged + discount)), 0); the identity holds to the rupiah", async () => {
    const s = await makeStore("toko-a");
    await fund(s);
    const first = (await paidPrepaid(s)).orderId;
    const second = (await paidPrepaid(s)).orderId;
    const third = (await paidPrepaid(s)).orderId;
    const charged = (await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, first)))[0]!.shippingChargedIdr;
    await withoutGuard("order_financials", "order_financials_guard", () => admin.execute(sql`update order_financials set shipping_discount_idr = 500 where order_id in (${first}, ${second}, ${third})`));
    expect(await reserveShippingCost(platform, { storeId: s.storeId, orderId: first, requote: { bookedShippingIdr: charged + 500 + 300, providerCodFeeIdr: 0 }, codAmountSentIdr: null })).toMatchObject({ outcome: "reserved", debitIdr: 800, marginIdr: 0 });
    expect(await reserveShippingCost(platform, { storeId: s.storeId, orderId: second, requote: { bookedShippingIdr: charged + 500 - 200, providerCodFeeIdr: 0 }, codAmountSentIdr: null })).toMatchObject({ outcome: "reserved", debitIdr: 500, marginIdr: 200 });
    // The promotion scenario (T-46): the courier is booked at exactly what the buyer paid plus the seller-funded discount: the seller carries the discount and the platform margin is untouched.
    expect(await reserveShippingCost(platform, { storeId: s.storeId, orderId: third, requote: { bookedShippingIdr: charged + 500, providerCodFeeIdr: 0 }, codAmountSentIdr: null })).toMatchObject({ outcome: "reserved", debitIdr: 500, marginIdr: 0 });
    const costs = await platform.select().from(shipmentCost).where(sql`${shipmentCost.orderId} in (${first}, ${second}, ${third})`);
    for (const c of costs) {
      expect(c.shippingChargedIdr + c.sellerShippingDebitIdr).toBe(c.bookedShippingIdr + c.platformShippingMarginIdr);
      expect(c.shippingDiscountIdr).toBe(500);
    }
    // the database refuses a cost whose discount differs from the frozen financials
    expect(await code(admin.execute(sql`update shipment_cost set shipping_discount_idr = 0 where order_id = ${first}`))).toBe("42501");
  });
});

describe("COD reconciliation is scoped to one shipping account (BILL-5, ADR-0007)", () => {
  const reconcile = async (storeId: number, orderId: number) => {
    const opA = await makeOperator(["payouts.reconcile"]);
    const opB = await makeOperator(["payouts.reconcile"]);
    const [fin] = await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId));
    const { batchId } = await prepareReconciliationBatch(opA, { evidenceRef: `INV-${orderId}`, lines: [{ orderId, evidenceLineRef: `L${orderId}`, evidenceAmountIdr: fin!.payableIdr, evidenceDate: "2026-10-28" }] });
    const { approvalId } = await submitReconciliationBatch(opA, batchId, "rekonsiliasi per akun");
    await decideApproval(opB, approvalId, "approve");
    await applyReconciliationBatch(opA, batchId);
    await releaseStore(platform, storeId);
    return { batchId, approvalId };
  };
  const saleOf = async (orderId: number) => (await platform.select().from(ledgerEntry).where(and(eq(ledgerEntry.orderId, orderId), eq(ledgerEntry.kind, "sale"))))[0]!;

  it("a batch holds one account's orders; the other account's order stays pending; the approval and the hash bind the account; the summary counts per account", async () => {
    const s = await partnerStore("toko-a");
    const viaPartner = await deliveredCod(s);
    await setSettings(await makeOperator(["shipping.manage"]), { preferPartner: false, discountIdr: 0, discountBps: 0 });
    const viaMaster = await deliveredCod(s);
    const opA = await makeOperator(["payouts.reconcile"]);
    const line = async (id: number) => ({ orderId: id, evidenceLineRef: `L${id}`, evidenceAmountIdr: (await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, id)))[0]!.payableIdr, evidenceDate: "2026-10-28" });
    expect(await code(prepareReconciliationBatch(opA, { evidenceRef: "INV-MIX", lines: [await line(viaPartner), await line(viaMaster)] }))).toBe("account_mismatch");

    const view = await shippingReconciliationByAccount(opA);
    expect(view.filter((r) => r.storeId === s.storeId).map((r) => [r.kind, r.awaitingOrders, r.openBatches, r.appliedBatches]).sort()).toEqual([["partner_managed", 1, 0, 0], ["platform_master", 1, 0, 0]]);

    const { batchId, approvalId } = await reconcile(s.storeId, viaPartner);
    const [batch] = (await platform.execute(sql`select shipping_account_id from reconciliation_batch where id = ${batchId}`)) as unknown as { shipping_account_id: string }[];
    expect(Number(batch!.shipping_account_id)).toBe(s.partner.id);
    const [approval] = (await platform.execute(sql`select payload_canonical from approval_request where id = ${approvalId}`)) as unknown as { payload_canonical: string }[];
    expect(approval!.payload_canonical).toContain(`"shippingAccountId":${s.partner.id}`);
    // The batch hash binds the account too: recomputed from the stored items it equals the frozen header hash (the approval payload is bound to that hash).
    const [frozen] = (await platform.execute(sql`select payload_sha256, evidence_ref from reconciliation_batch where id = ${batchId}`)) as unknown as { payload_sha256: string; evidence_ref: string }[];
    const [pf] = await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, viaPartner));
    expect(frozen!.payload_sha256).toBe(payloadHash({ shippingAccountId: s.partner.id, evidenceRef: frozen!.evidence_ref, items: [{ orderId: viaPartner, codAmountIdr: pf!.payableIdr, evidenceLineRef: `L${viaPartner}`, evidenceAmountIdr: pf!.payableIdr, evidenceDate: "2026-10-28" }] }));
    expect(await saleOf(viaPartner)).toMatchObject({ status: "available", releaseBasis: "reconciliation" });
    expect(await saleOf(viaMaster)).toMatchObject({ status: "pending" }); // the other account's cash is not reconciled by this batch
    const after = await shippingReconciliationByAccount(opA);
    expect(after.filter((r) => r.storeId === s.storeId).map((r) => [r.kind, r.awaitingOrders, r.appliedBatches]).sort()).toEqual([["partner_managed", 0, 1], ["platform_master", 1, 0]]);
    expect(await code(shippingReconciliationByAccount(await makeOperator(["tenants.read"])))).toBe("forbidden");
  });

  it("the database refuses an item of another account in a batch, a batch without an account, a changed batch account and a provider batch while OPEN-F8 is off", async () => {
    const s = await partnerStore("toko-a");
    const viaPartner = await deliveredCod(s);
    await setSettings(await makeOperator(["shipping.manage"]), { preferPartner: false, discountIdr: 0, discountBps: 0 });
    const viaMaster = await deliveredCod(s);
    const opA = await makeOperator(["payouts.reconcile"]);
    const [fin] = await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, viaPartner));
    const { batchId } = await prepareReconciliationBatch(opA, { evidenceRef: "INV-ONE", lines: [{ orderId: viaPartner, evidenceLineRef: "L1", evidenceAmountIdr: fin!.payableIdr, evidenceDate: "2026-10-28" }] });
    const [other] = await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, viaMaster));
    expect(await code(platform.execute(sql`insert into reconciliation_batch_item (batch_id, order_id, store_id, cod_amount_idr, evidence_line_ref, evidence_amount_idr, evidence_date) values (${batchId}, ${viaMaster}, ${s.storeId}, ${other!.payableIdr}, 'L2', ${other!.payableIdr}, '2026-10-28')`))).toBe("23514");
    expect(await code(platform.execute(sql`insert into reconciliation_batch (evidence_ref, prepared_by_user_id) values ('INV-NOACCT', ${opA.userId})`))).toBe("23514");
    expect(await code(platform.execute(sql`update reconciliation_batch set shipping_account_id = ${s.master.id} where id = ${batchId}`))).toBe("42501");
    expect(PROVIDER_RECONCILIATION_ENABLED).toBe(false);
    expect(await code(platform.execute(sql`insert into reconciliation_batch (shipping_account_id, source, evidence_ref) values (${s.partner.id}, 'provider', 'SIGNAL')`))).toBe("0A000");
  });
});

describe("policy settings: named, conservative defaults, four-eyes, shipping cashback stays off (D-22, OPEN-F9)", () => {
  it("defaults: no discount, master account until OPEN-F9, cashback off; the quote is the margin rule alone; an active partner account is not used until the owner switches routing on", async () => {
    const s = await makeStore("toko-a");
    expect((await platform.execute(sql`select prefer_partner, discount_idr::int, discount_bps, cashback_enabled from shipping_control`)) as unknown).toEqual([{ prefer_partner: false, discount_idr: 0, discount_bps: 0, cashback_enabled: false }]);
    await provision(s.storeId);
    expect((await orderAccount(await place(s))).order.kind).toBe("platform_master");
    expect(await effectiveShippingDiscount(platform)).toEqual({ discountIdr: 0, discountBps: 0 });
    const q = await shippingOptions(s.sf, DEST, { lines: [{ quantity: 1, weightGrams: 1000 }], subtotal: 100_000 }, fakeMengantar);
    expect(q.options.find((o) => o.courier === "JNE")!.prepaid).toEqual({ providerCost: 10_500, margin: 2_000, buyerFee: 12_500, platformDiscount: 0 });
    expect(q).toMatchObject({ shippingAccountKind: "platform_master" });
    expect((await shippingPolicyOverview(await makeOperator(["shipping.manage"]))).cashbackEffective).toBe(false);
  });

  it("a settings change needs a second person's approval of exactly this payload, executed once by the requester at the revision it was made for", async () => {
    const op = await makeOperator(["shipping.manage"]);
    const other = await makeOperator(["shipping.manage"]);
    const body = { revision: 0, preferPartner: true, discountIdr: 500, discountBps: 0, reason: "diskon uji" };
    expect(await code(applyShippingSettings(op, 999_999, body))).toBe("approval_invalid");
    const { approvalId } = await requestShippingSettings(op, body);
    expect(await code(applyShippingSettings(op, approvalId, body))).toBe("approval_invalid"); // still pending
    expect(await code(decideApproval(op, approvalId, "approve"))).toBe("self_approval");
    await decideApproval(other, approvalId, "approve");
    expect(await code(applyShippingSettings(op, approvalId, { ...body, discountIdr: 600 }))).toBe("approval_invalid"); // another payload
    expect(await code(applyShippingSettings(other, approvalId, body))).toBe("approval_invalid"); // only the requester executes
    expect(await code(Promise.resolve(platform.execute(sql`update shipping_control set discount_idr = 900`)))).toBe("23514"); // no direct write, by the worker login
    expect(await code(admin.execute(sql`update shipping_control set discount_idr = 900`))).toBe("23514"); // nor by the owner
    await applyShippingSettings(op, approvalId, body);
    expect(await effectiveShippingDiscount(platform)).toEqual({ discountIdr: 500, discountBps: 0 });
    expect(await code(applyShippingSettings(op, approvalId, body))).toBe("approval_invalid"); // single use
    const stale = await requestShippingSettings(op, { ...body, discountIdr: 100 }); // made for revision 0, which is gone
    await decideApproval(other, stale.approvalId, "approve");
    expect(await code(applyShippingSettings(op, stale.approvalId, { ...body, discountIdr: 100 }))).toBe("conflict");
    expect(((await platform.execute(sql`select status from approval_request where id = ${stale.approvalId}`)) as unknown as { status: string }[])[0]!.status).toBe("approved"); // a failed apply does not burn the approval
    expect((await platform.select().from(auditLog).where(eq(auditLog.action, "shipping.settings"))).length).toBe(1);
  });

  it("the database binds an executed approval to the exact new values: an approval granted for one payload cannot write another", async () => {
    const op = await makeOperator(["shipping.manage"]);
    const other = await makeOperator(["shipping.manage"]);
    const granted = { revision: 0, preferPartner: true, discountIdr: 500, discountBps: 0 };
    const { approvalId } = await requestShippingSettings(op, { ...granted, reason: "diskon uji" });
    await decideApproval(other, approvalId, "approve");
    const forged = platform.transaction(async (tx) => {
      await consumeApproval(tx, op, { approvalId, actionKey: "shipping.margin", targetKind: "shipping_policy", targetId: "default", payloadSha256: payloadHash(granted) });
      await tx.execute(sql`update shipping_control set discount_idr = 9000, revision = 1, approval_request_id = ${approvalId}, updated_by = ${op.userId}`); // the approval was for 500
    });
    expect(await code(forged)).toBe("23514");
    expect(await effectiveShippingDiscount(platform)).toEqual({ discountIdr: 0, discountBps: 0 });
  });

  it("a discount is funded from the platform margin only: the buyer fee never falls below the courier cost and the seller is never debited for it", async () => {
    expect(applyShippingDiscount({ providerCost: 10_500, margin: 2_000, buyerFee: 12_500 }, { discountIdr: 5_000, discountBps: 0 })).toEqual({ providerCost: 10_500, margin: 0, buyerFee: 10_500, platformDiscount: 2_000 });
    expect(applyShippingDiscount({ providerCost: 10_500, margin: 2_000, buyerFee: 12_500 }, { discountIdr: 0, discountBps: 10_000 })).toEqual({ providerCost: 10_500, margin: 0, buyerFee: 10_500, platformDiscount: 2_000 });
    expect(applyShippingDiscount({ providerCost: 10_500, margin: 2_000, buyerFee: 12_500 }, { discountIdr: 300, discountBps: 100 })).toEqual({ providerCost: 10_500, margin: 1_575, buyerFee: 12_075, platformDiscount: 425 });
    const s = await makeStore("toko-a");
    await setSettings(await makeOperator(["shipping.manage"]), { preferPartner: true, discountIdr: 5_000, discountBps: 0 });
    await fund(s);
    const { orderId } = await paidPrepaid(s);
    const [o] = await platform.select().from(order).where(eq(order.id, orderId));
    expect(o).toMatchObject({ shippingProviderCost: 10_500, shippingMargin: 0, shippingFee: 10_500 });
    // The courier is booked at exactly what the buyer paid: the platform's gross margin is the 2 000 it gave away (net 0); the seller is never debited.
    expect(await reserveShippingCost(platform, { storeId: s.storeId, orderId, requote: { bookedShippingIdr: 10_500, providerCodFeeIdr: 0 }, codAmountSentIdr: null })).toMatchObject({ outcome: "reserved", debitIdr: 0, marginIdr: 2_000 });
  });

  it("cashback rules can be drafted but never take effect: the status is forced to disabled by the database, the switch is off, and a delivered order books no cashback", async () => {
    const op = await makeOperator(["shipping.manage"]);
    const rule = { courierCode: "JNE", serviceCode: "", sellerShareBps: 5_000, fixedSellerBonusIdr: 0, reason: "draf pembagian" };
    await saveCashbackRule(op, { ...rule, revision: 0 }); // new draft
    await saveCashbackRule(op, { ...rule, revision: 0 }); // edit of revision 0
    expect(await code(saveCashbackRule(op, { ...rule, revision: 0 }))).toBe("conflict"); // the row is at revision 1 now
    await saveCashbackRule(op, { ...rule, revision: 1 });
    expect((await platform.execute(sql`select status, revision from cashback_rule`)) as unknown).toEqual([{ status: "disabled", revision: 2 }]);
    expect(await code(admin.execute(sql`insert into cashback_rule (courier_code, service_code, status, seller_share_bps) values ('SiCepat', '', 'active', 100)`))).toBe("23514");
    await withoutGuard("shipping_control", "shipping_policy_guard", async () => {
      expect(await code(admin.execute(sql`update shipping_control set cashback_enabled = true`))).toBe("23514");
    });
    expect(await code(saveCashbackRule(await makeOperator(["tenants.read"]), { ...rule, revision: 0 }))).toBe("forbidden");
    const s = await makeStore("toko-a");
    const { orderId } = await deliveredPrepaid(s);
    await releaseStore(platform, s.storeId);
    expect((await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId)))[0]).toMatchObject({ shippingCashbackGrossIdr: 0, platformCashbackIdr: 0, sellerCashbackIdr: 0 });
    expect(await platform.select().from(ledgerEntry).where(and(eq(ledgerEntry.storeId, s.storeId), eq(ledgerEntry.kind, "cashback")))).toEqual([]);
  });

  it("the courier policy is data: an edit is audited and affects new orders only, SPX keeps the T-37 seed, and a case-only duplicate cannot shadow a refusal", async () => {
    const op = await makeOperator(["shipping.manage"]);
    const spx = async () => (await platform.execute(sql`select cod_allowed, return_free, return_free_evidence_ref, status, updated_by from courier_service_policy where courier_code = 'SPX'`)) as unknown;
    const seeded = await spx();
    expect(seeded).toEqual([{ cod_allowed: true, return_free: true, return_free_evidence_ref: null, status: "active", updated_by: "migration:t37" }]);
    const s = await makeStore("toko-a");
    const cart = { lines: [{ quantity: 1, weightGrams: 1000 }], subtotal: 100_000 };
    expect((await shippingOptions(s.sf, DEST, cart, fakeMengantar)).options.find((o) => o.courier === "JNE")!.cod).not.toBeNull();
    const earlier = await place(s, { paymentMethod: "cod" });
    await setCourierPolicy(op, { courierCode: "JNE", serviceCode: "", codAllowed: false, returnFree: true, status: "active", reason: "COD dimatikan untuk uji" });
    expect((await shippingOptions(s.sf, DEST, cart, fakeMengantar)).options.find((o) => o.courier === "JNE")!.cod).toBeNull();
    expect((await platform.select().from(order).where(eq(order.id, earlier)))[0]).toMatchObject({ paymentMethod: "cod" }); // the existing order is untouched
    expect(await spx()).toEqual(seeded);
    expect(await code(setCourierPolicy(op, { courierCode: "jne", serviceCode: "", codAllowed: true, returnFree: true, status: "active", reason: "huruf kecil" }))).toBe("23505");
    expect((await platform.select().from(auditLog).where(eq(auditLog.action, "shipping.courier"))).map((a) => a.subjectId)).toEqual(["JNE/"]);
    expect(await code(setCourierPolicy(await makeOperator(["tenants.read"]), { courierCode: "JNE", serviceCode: "", codAllowed: true, returnFree: true, status: "active", reason: "tanpa izin" }))).toBe("forbidden");
  });
});

describe("seller and console views: which account, never a secret; isolation and read-only mode", () => {
  it("the seller sees the account kind and status for their own store only; staff may read, the owner alone manages; unpaid subscriptions still read", async () => {
    const a = await partnerStore("toko-a");
    const b = await partnerStore("toko-b");
    const mine = await sellerShippingAccounts(a.owner);
    expect(mine.selected).toMatchObject({ kind: "partner_managed", status: "active", storeId: a.storeId });
    expect(mine.accounts.map((x) => x.storeId)).toEqual([a.storeId, a.storeId]);
    expect(mine.cashback).toBe("off");
    expect(JSON.stringify(mine)).not.toMatch(/sealed|keyId|key_id|registered|sellerId|email/i);
    const rows = await withStore(db, a.storeId, (tx) => tx.execute(sql`select distinct store_id from store_shipping_account`));
    expect((rows as unknown as { store_id: string }[]).map((r) => Number(r.store_id))).toEqual([a.storeId]);
    expect(b.partner.storeId).not.toBe(a.storeId);

    const staffId = await makeUser("staff");
    await admin.execute(sql`insert into membership (store_id, user_id, role) values (${a.storeId}, ${staffId}, 'staff')`);
    const staff = await seller(staffId, a.storeId);
    expect((await sellerShippingAccounts(staff)).selected?.kind).toBe("partner_managed");
    await expect(setPickupArea(staff, { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Bandung" })).rejects.toMatchObject({ code: "forbidden" });

    const unpaid = { ...a.owner, billing: { ...a.owner.billing, writable: false } };
    expect((await sellerShippingAccounts(unpaid)).selected?.kind).toBe("partner_managed");
    await expect(setPickupArea(unpaid, { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Bandung" })).rejects.toMatchObject({ code: "billing_read_only" });
  });

  it("the console health view needs shipping.manage, carries statuses and results only, and shows the gate as locked while the rotation is unrecorded", async () => {
    const s = await partnerStore("toko-a");
    const op = await makeOperator(["shipping.manage"]);
    expect(await code(shippingAccountHealth(await makeOperator(["tenants.read"])))).toBe("forbidden");
    const saved = process.env.MENGANTAR_PARTNER_SECRET_ROTATED_AT;
    delete process.env.MENGANTAR_PARTNER_SECRET_ROTATED_AT;
    try {
      const h = await shippingAccountHealth(op);
      expect(h).toMatchObject({ rotationRecorded: false, providerCalls: "disabled", mode: "fake" });
      expect(h.accounts.filter((x) => x.storeId === s.storeId).map((x) => [x.kind, x.status])).toEqual([["platform_master", "active"], ["partner_managed", "active"]]);
    } finally {
      if (saved !== undefined) process.env.MENGANTAR_PARTNER_SECRET_ROTATED_AT = saved;
    }
    await queueShippingAccountRecovery(op, { accountId: s.partner.id, revision: s.partner.revision, reason: "uji pemulihan kunci" });
    const [audit] = await platform.select().from(auditLog).where(eq(auditLog.action, "shipping.account.recover"));
    expect(audit).toMatchObject({ subjectKind: "shipping_account", subjectId: String(s.partner.id), actorUserId: op.userId });
  });
});
