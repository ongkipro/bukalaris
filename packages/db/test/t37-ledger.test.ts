import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { applyReconciliationBatch, applyManualCompletion, prepareReconciliationBatch, requestManualCompletion, runProviderReconciliationPoll, submitReconciliationBatch, voidReconciliationItem } from "../src/ledger/reconciliation.ts";
import { BALANCE_SQL, verifyLedger } from "../src/ledger/verify.ts";
import { releaseAll, releaseStore } from "../src/ledger/release.ts";
import { ledgerBalance } from "../src/ledger/ledger.ts";
import { ledgerStatement, sellerFinance } from "../src/ledger/payouts.ts";
import { decideApproval } from "../src/ops/capabilities-approvals.ts";
import { applyProviderTransition, claimDelivery, transitionOrder } from "../src/seller/commerce/orders.ts";
import { auditLog, ledgerEntry, order, orderFinancials, orderLineFinancials, orderStatusHistory, reconciliationBatch, reconciliationBatchItem, refund, variant } from "../src/schema.ts";
import { withStore } from "../src/platform/tenant.ts";
import { admin, db, makeOperator, makeStore, makeUser, platform, seller } from "./helpers.ts";
import { deliver } from "./deliver.ts";
import { balance, deliveredCod, deliveredPrepaid, fund, paidPrepaid, place, toShipped, withoutGuard } from "./t37-fixtures.ts";
import { PgDialect } from "drizzle-orm/pg-core";
import { membership } from "../src/schema.ts";

// T-37 (ADR-0006, BILL-4, BILL-5, DATA-7): the ledger against real PostgreSQL. The first group is the lesson-to-test map of the Tokophi / 99ribu study (docs/tracks/t37.md):
// every lesson is a case here that fails when the invariant is broken.

const entries = (storeId: number) => platform.select().from(ledgerEntry).where(eq(ledgerEntry.storeId, storeId)).orderBy(ledgerEntry.id);
const kindsOf = async (storeId: number, orderId?: number) => (await entries(storeId)).filter((e) => orderId === undefined || e.orderId === orderId).map((e) => `${e.kind}:${e.status}`);
const statusOf = async (id: number) => (await platform.select({ s: order.status }).from(order).where(eq(order.id, id)))[0]!.s;
const stockOf = async (id: number) => (await platform.select().from(variant).where(eq(variant.id, id)))[0]!.stock;
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
const pg = (p: Promise<unknown>) => p.then(() => "ok", (e: { cause?: { code?: string; message?: string } }) => e.cause?.code ?? "?");
const msg = (p: Promise<unknown>) => p.then(() => "", (e: { cause?: { message?: string }; message?: string }) => e.cause?.message ?? e.message ?? "");

async function applied(storeId: number, orderId: number, op: "completed" | "returned" | "cancelled") {
  return withStore(platform, storeId, (tx) => applyProviderTransition(tx, storeId, orderId, op, { source: "provider" }));
}

/** A reconciliation batch prepared by `prep`, approved by `appr`, applied by `prep`. Returns the batch id. */
async function reconcile(orders: { id: number; amount: number }[], prep = "payouts.reconcile") {
  const opA = await makeOperator([prep as "payouts.reconcile"]);
  const opB = await makeOperator(["payouts.reconcile"]);
  const { batchId } = await prepareReconciliationBatch(opA, { evidenceRef: `INV-${randomUUID().slice(0, 8)}`, lines: orders.map((o) => ({ orderId: o.id, evidenceLineRef: `LINE-${o.id}`, evidenceAmountIdr: o.amount, evidenceDate: "2026-10-28" })) });
  const { approvalId } = await submitReconciliationBatch(opA, batchId, "rekonsiliasi COD uji");
  await decideApproval(opB, approvalId, "approve");
  return { batchId, opA, opB, approvalId, apply: () => applyReconciliationBatch(opA, batchId) };
}
const payableOf = async (orderId: number) => (await platform.select({ p: orderFinancials.payableIdr }).from(orderFinancials).where(eq(orderFinancials.orderId, orderId)))[0]!.p;

describe("checkout freezes the allocation (BILL-4, DATA-7)", () => {
  it("every order gets one order_financials row and one line row per order line; the identity holds and equals the order", async () => {
    const s = await makeStore("toko-a", { price: 125_000 });
    const id = await place(s, { paymentMethod: "manual_transfer" }, 3);
    const [f] = await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, id));
    const [o] = await platform.select().from(order).where(eq(order.id, id));
    expect(f).toMatchObject({ subtotalIdr: 375_000, goodsProceedsIdr: 375_000, saleAmountIdr: 375_000, includedSalesTaxIdr: 0, addedSalesTaxIdr: 0, codFeeIdr: 0, affiliateCommissionIdr: 0 });
    expect(f!.payableIdr).toBe(o!.total);
    expect(f!.shippingChargedIdr).toBe(o!.shippingFee);
    expect(f!.payableIdr).toBe(f!.goodsProceedsIdr + f!.shippingChargedIdr);
    expect(f!.expectedGatewayFeeIdr).toBeGreaterThan(0); // the VABCA schedule, stored for the platform money position
    const lines = await platform.select().from(orderLineFinancials).where(eq(orderLineFinancials.orderId, id));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ lineNo: 1, lineGrossIdr: 375_000, discountAllocIdr: 0, netGoodsIdr: 375_000, commissionBaseIdr: 375_000 });
    const cod = await place(s, { paymentMethod: "cod" });
    expect((await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, cod)))[0]).toMatchObject({ saleAmountIdr: 125_000 });
  });

  it("the snapshot is immutable: no login role can change or delete it, and the owner-side trigger refuses too", async () => {
    const s = await makeStore("toko-a");
    const id = await place(s);
    expect(await pg(platform.update(orderFinancials).set({ saleAmountIdr: 1 }).where(eq(orderFinancials.orderId, id)))).toBe("42501"); // no UPDATE grant
    expect(await pg(platform.delete(orderFinancials).where(eq(orderFinancials.orderId, id)))).toBe("42501");
    expect(await pg(withStore(db, s.storeId, (tx) => tx.update(orderFinancials).set({ saleAmountIdr: 1 }).where(eq(orderFinancials.orderId, id))))).toBe("42501");
    expect(await msg(admin.execute(sql`update order_financials set sale_amount_idr = 1 where order_id = ${id}`))).toMatch(/written once/); // superuser: the trigger is the backstop
    expect(await msg(admin.execute(sql`delete from order_line_financials where order_id = ${id}`))).toMatch(/never deleted/);
    expect((await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, id)))[0]!.saleAmountIdr).toBe(100_000);
  });

  it("a snapshot that does not add up is refused by the database: wrong identity, wrong payable, lines that do not sum", async () => {
    const s = await makeStore("toko-a");
    const raw = async () =>
      String((await admin.execute(sql`insert into "order" (store_id, cart_id, idempotency_key, request_hash, status, payment_method, buyer_name, buyer_phone, shipping_address, courier_code, courier, origin_area_id, destination_area_id, destination_area_label, weight_kg, shipping_provider_cost, shipping_margin, subtotal, shipping_fee, total)
        values (${s.storeId}, gen_random_uuid(), ${randomUUID()}, 'h', 'placed', 'cod', 'B', '0811', 'Jl. A No. 1', 'JNE', 'JNE', ${"a".repeat(24)}, ${"b".repeat(24)}, 'x', 1, 1000, 500, 10000, 1500, 11500) returning id`))[0]!.id);
    const fin = (id: string, over: Record<string, number> = {}) => {
      const v = { subtotal: 10_000, proceeds: 10_000, shipping: 1_500, payable: 11_500, sale: 10_000, ...over };
      return sql`insert into order_financials (order_id, store_id, subtotal_idr, goods_proceeds_idr, shipping_charged_idr, payable_idr, sale_amount_idr) values (${id}, ${s.storeId}, ${v.subtotal}, ${v.proceeds}, ${v.shipping}, ${v.payable}, ${v.sale})`;
    };
    // BILL-4 identity: payable = goods + taxes + shipping + COD fee + VAT.
    expect(await pg(admin.execute(fin(await raw(), { payable: 11_501 })))).toBe("23514");
    // The order's own total is the anchor: a snapshot of 12 000 for an order of 11 500 is refused.
    expect(await msg(admin.execute(fin(await raw(), { subtotal: 10_500, proceeds: 10_500, payable: 12_000, sale: 10_500 })))).toMatch(/must equal the totals of its order/);
    // A well-formed snapshot without its line rows fails when the transaction ends (deferred constraint trigger).
    expect(await msg(admin.transaction(async (tx) => { await tx.execute(fin(await raw())); }))).toMatch(/do not add up/);
  });
});

describe("a sale is booked pending once, at the right moment (BILL-5, ADR-0006 decision 4)", () => {
  it("prepaid: nothing at order, nothing at a manual 'mark paid'; one pending sale only when the payment is VERIFIED; a replayed verification books nothing more", async () => {
    const s = await makeStore("toko-a", { price: 200_000 });
    const unpaid = await place(s, { paymentMethod: "manual_transfer", paymentChannel: "VABCA" });
    expect(await entries(s.storeId)).toHaveLength(0);
    await transitionOrder(s.owner, unpaid, "pay"); // the seller's manual path: no verified platform receipt, so no credit
    expect(await entries(s.storeId)).toHaveLength(0);
    const { orderId, attempt } = await paidPrepaid(s);
    expect(await kindsOf(s.storeId, orderId)).toEqual(["sale:pending"]);
    const [sale] = await entries(s.storeId);
    expect(sale!.amountIdr).toBe((await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId)))[0]!.saleAmountIdr);
    const { recordPaymentInquiry } = await import("../src/payments/attempts.ts");
    const again = await recordPaymentInquiry({ exec: platform, storeId: s.storeId }, attempt.id, { rc: "00", ket: "Sukses", data: { status: "PAID", amount: attempt.totalIdr } }, { source: "reconcile", mode: "fake" });
    expect(again.applied).toBe(false);
    expect(await kindsOf(s.storeId, orderId)).toEqual(["sale:pending"]);
    expect(await balance(s.storeId)).toEqual({ availableIdr: 0, pendingIdr: sale!.amountIdr });
  });

  it("COD: no credit at order, confirmation, packing or dispatch; one pending sale at the courier's DELIVERED; a second DELIVERED books nothing; a seller 'delivered' claim changes nothing", async () => {
    const s = await makeStore("toko-a", { price: 150_000 });
    const id = await place(s, { paymentMethod: "cod" });
    await toShipped(s, id, true);
    expect(await entries(s.storeId)).toHaveLength(0);
    await claimDelivery(s.owner, id); // a seller can never complete for credit
    await claimDelivery(s.owner, id);
    expect(await statusOf(id)).toBe("shipped");
    expect(await entries(s.storeId)).toHaveLength(0);
    expect((await platform.select().from(orderStatusHistory).where(and(eq(orderStatusHistory.orderId, id), eq(orderStatusHistory.toStatus, "shipped")))).filter((h) => h.fromStatus === "shipped")).toHaveLength(1); // the claim is recorded once
    expect(await applied(s.storeId, id, "completed")).toMatchObject({ outcome: "applied" });
    expect(await kindsOf(s.storeId)).toEqual(["sale:pending"]);
    expect(await applied(s.storeId, id, "completed")).toMatchObject({ outcome: "noop" }); // same status: no-op
    expect(await kindsOf(s.storeId)).toEqual(["sale:pending"]);
    expect((await platform.select({ p: order.paidAt }).from(order).where(eq(order.id, id)))[0]!.p).toBeInstanceOf(Date); // COD cash is collected at delivery
  });

  it("the seller has no way to complete an order, and claiming outside 'shipped' is refused", async () => {
    const s = await makeStore("toko-a");
    const id = await place(s, { paymentMethod: "cod" });
    expect(await code(transitionOrder(s.owner, id, "complete" as never))).toBe("invalid_action");
    expect(await code(claimDelivery(s.owner, id))).toBe("invalid_transition");
  });

  it("a database-level backstop: the app login cannot book a sale or any credit at all, whatever the service says", async () => {
    const s = await makeStore("toko-a");
    const id = await place(s, { paymentMethod: "cod" });
    await toShipped(s, id, true);
    await deliver(s.storeId, id);
    await platform.delete(ledgerEntry).where(eq(ledgerEntry.orderId, id)).catch(() => undefined); // no DELETE grant: stays
    const credit = (kind: string, status: string, amount: number) =>
      withStore(db, s.storeId, (tx) => tx.execute(sql`insert into ledger_entry (store_id, order_id, kind, status, amount_idr) values (${s.storeId}, ${id}, ${kind}, ${status}, ${amount})`));
    expect(await msg(credit("sale", "pending", 100_000))).toMatch(/only debit/); // the seller login can only debit its own balance
    expect(await msg(credit("adjustment", "available", 5))).toMatch(/only debit|check/);
    expect(await pg(platform.delete(ledgerEntry).where(eq(ledgerEntry.orderId, id)))).toBe("42501");
  });
});

describe("release only for delivered AND reconciled parcels (D-14)", () => {
  it("prepaid: stays pending while shipped, is released by the job once delivered (released_at and basis stamped), and the job is idempotent", async () => {
    const s = await makeStore("toko-a", { price: 300_000 });
    const { orderId } = await paidPrepaid(s);
    await toShipped(s, orderId);
    expect(await releaseStore(platform, s.storeId)).toEqual({ released: 0, netted: 0 });
    expect(await kindsOf(s.storeId)).toEqual(["sale:pending"]);
    await deliver(s.storeId, orderId);
    expect(await kindsOf(s.storeId)).toEqual(["sale:pending"]); // delivered is not yet released: the job does it
    expect(await releaseStore(platform, s.storeId)).toEqual({ released: 1, netted: 0 });
    const [e] = await entries(s.storeId);
    expect(e).toMatchObject({ status: "available", releaseBasis: "delivery", reconciliationItemId: null });
    expect(e!.releasedAt).toBeInstanceOf(Date);
    expect(await releaseStore(platform, s.storeId)).toEqual({ released: 0, netted: 0 });
    expect(await balance(s.storeId)).toEqual({ availableIdr: 300_000, pendingIdr: 0 });
  });

  it("COD: a delivered but unreconciled order stays pending after the job; only an applied reconciliation item releases it, with basis 'reconciliation'", async () => {
    const s = await makeStore("toko-a", { price: 90_000 });
    const id = await deliveredCod(s);
    expect(await releaseAll(platform)).toMatchObject({ released: 0 });
    expect(await kindsOf(s.storeId)).toEqual(["sale:pending"]);
    // The database refuses the release itself without an applied item (a COD sale can never use 'delivery').
    const sale = (await entries(s.storeId))[0]!;
    expect(await msg(platform.execute(sql`update ledger_entry set status = 'available', released_at = now(), release_basis = 'delivery' where id = ${sale.id}`))).toMatch(/delivery releases a prepaid sale/);
    expect(await msg(platform.execute(sql`update ledger_entry set status = 'available', released_at = now(), release_basis = 'reconciliation' where id = ${sale.id}`))).toMatch(/check|item/i);
    const batch = await reconcile([{ id, amount: await payableOf(id) }]);
    expect(await releaseAll(platform)).toMatchObject({ released: 0 }); // approved is not applied
    await batch.apply();
    expect(await releaseAll(platform)).toMatchObject({ released: 1 });
    const [after] = await entries(s.storeId);
    expect(after).toMatchObject({ status: "available", releaseBasis: "reconciliation" });
    expect(after!.reconciliationItemId).not.toBeNull();
    expect(await balance(s.storeId)).toEqual({ availableIdr: 90_000, pendingIdr: 0 });
  });

  it("the ledger refuses what the job would never do: changing an amount, a second sale, releasing a reversed order, a prepaid sale before completion", async () => {
    const s = await makeStore("toko-a", { price: 80_000 });
    const { orderId } = await paidPrepaid(s);
    const sale = (await entries(s.storeId))[0]!;
    expect(await msg(platform.execute(sql`update ledger_entry set amount_idr = amount_idr + 1 where id = ${sale.id}`))).toMatch(/append-only|only a pending/);
    expect(await msg(platform.execute(sql`update ledger_entry set status = 'available', released_at = now(), release_basis = 'delivery' where id = ${sale.id}`))).toMatch(/completed order/); // order is still `placed`
    expect(await pg(platform.insert(ledgerEntry).values({ storeId: s.storeId, orderId, kind: "sale", status: "pending", amountIdr: sale.amountIdr }))).toBe("23505"); // ledger_one_sale_per_order
    expect(await msg(platform.execute(sql`delete from ledger_entry where id = ${sale.id}`))).toMatch(/permission denied/);
    // A reversed (cancelled) order's sale is never released, even by a writer that skips the status check.
    await transitionOrder(s.owner, orderId, "cancel", { reason: "pembeli batal" });
    expect(await msg(withoutGuard(`"order"`, "order_status_guard", () => platform.execute(sql`update "order" set status = 'completed', tracking_number = 'X' where id = ${orderId}`)).then(() => platform.execute(sql`update ledger_entry set status = 'available', released_at = now(), release_basis = 'delivery' where id = ${sale.id}`)))).toMatch(/reversed order is never released/);
  });
});

describe("returns and cancellations never make `available` negative (ADR-0006 decision 4)", () => {
  it("a COD parcel returned in transit never earned a credit: stock back once, no ledger entry, nothing negative", async () => {
    const s = await makeStore("toko-a", { stock: 10, price: 70_000 });
    const id = await place(s, { paymentMethod: "cod" }, 2);
    await toShipped(s, id, true);
    expect(await stockOf(s.variantId)).toBe(8);
    expect(await applied(s.storeId, id, "returned")).toMatchObject({ outcome: "applied", status: "returned" });
    expect(await applied(s.storeId, id, "returned")).toMatchObject({ outcome: "noop" });
    expect(await stockOf(s.variantId)).toBe(10); // restored once
    expect(await entries(s.storeId)).toHaveLength(0);
    expect(await balance(s.storeId)).toEqual({ availableIdr: 0, pendingIdr: 0 });
    expect(await platform.select().from(refund).where(eq(refund.orderId, id))).toHaveLength(0); // a COD parcel collected no cash
  });

  it("a prepaid order returned in transit reverses its still-pending sale pending-against-pending and opens the full buyer refund; the other released money is untouched", async () => {
    const s = await makeStore("toko-a", { stock: 20, price: 120_000 });
    await fund(s); // 120 000 released and available
    const { orderId, attempt } = await paidPrepaid(s);
    await toShipped(s, orderId);
    const before = await balance(s.storeId);
    expect(before).toEqual({ availableIdr: 120_000, pendingIdr: 120_000 });
    expect(await applied(s.storeId, orderId, "returned")).toMatchObject({ outcome: "applied" });
    expect(await kindsOf(s.storeId, orderId)).toEqual(["sale:pending", "return_reversal:pending"]);
    expect(await balance(s.storeId)).toEqual({ availableIdr: 120_000, pendingIdr: 0 }); // both net to zero in the held pool
    const [r] = await platform.select().from(refund).where(eq(refund.orderId, orderId));
    expect(r).toMatchObject({ status: "pending", reason: "order_returned", amountIdr: attempt.totalIdr, paymentAttemptId: attempt.id });
    expect(r!.goodsRefundIdr + r!.shippingRefundIdr + r!.feeRefundIdr).toBe(attempt.totalIdr);
    expect(r!.feeRefundIdr).toBe(attempt.adminFeeIdr); // the buyer-paid gateway fee is refunded too (D-20)
    expect(await releaseAll(platform)).toMatchObject({ released: 0 }); // a reversed sale is never released
  });

  it("a verified gateway-paid order cancelled by the seller reverses its sale once and opens exactly one refund; a second cancel and the late callback change nothing", async () => {
    const s = await makeStore("toko-a", { stock: 5, price: 60_000 });
    const { orderId, attempt } = await paidPrepaid(s);
    await transitionOrder(s.owner, orderId, "cancel", { reason: "stok habis" });
    expect(await kindsOf(s.storeId)).toEqual(["sale:pending", "return_reversal:pending"]);
    expect(await code(transitionOrder(s.owner, orderId, "cancel", { reason: "stok habis" }))).toBe("invalid_transition");
    expect(await kindsOf(s.storeId)).toHaveLength(2);
    expect(await platform.select().from(refund).where(eq(refund.orderId, orderId))).toMatchObject([{ reason: "order_cancelled", amountIdr: attempt.totalIdr }]);
    expect(await stockOf(s.variantId)).toBe(5);
  });

  it("completed -> cancelled and completed -> returned do not exist: the courier writer REJECTS and records them; the database refuses a direct write too; nothing is restocked or clawed back", async () => {
    const s = await makeStore("toko-a", { stock: 10, price: 50_000 });
    const id = await deliveredCod(s);
    const stock = await stockOf(s.variantId);
    expect(await applied(s.storeId, id, "cancelled")).toMatchObject({ outcome: "rejected", status: "completed", reason: "illegal_transition" });
    expect(await applied(s.storeId, id, "returned")).toMatchObject({ outcome: "rejected", status: "completed" });
    expect(await stockOf(s.variantId)).toBe(stock);
    expect(await statusOf(id)).toBe("completed");
    expect(await kindsOf(s.storeId)).toEqual(["sale:pending"]);
    const rejected = await platform.select().from(auditLog).where(and(eq(auditLog.action, "order.transition_rejected"), eq(auditLog.subjectId, String(id))));
    expect(rejected).toHaveLength(2); // recorded, never silently dropped
    expect(await msg(platform.update(order).set({ status: "cancelled" }).where(eq(order.id, id)))).toMatch(/not a legal move/);
    expect(await msg(platform.update(order).set({ status: "returned" }).where(eq(order.id, id)))).toMatch(/not a legal move/);
  });

  it("a courier-driven forward jump (placed -> completed in one poll) is accepted instead of freezing the order uncredited; returned only from shipped", async () => {
    const s = await makeStore("toko-a", { price: 50_000 });
    const jump = await place(s, { paymentMethod: "cod" });
    await transitionOrder(s.owner, jump, "confirm");
    await platform.update(order).set({ trackingNumber: "RESI-JUMP" }).where(eq(order.id, jump)); // the resi exists (booking), the order was never shipped by hand
    expect(await applied(s.storeId, jump, "completed")).toMatchObject({ outcome: "applied", status: "completed" });
    expect(await kindsOf(s.storeId, jump)).toEqual(["sale:pending"]);
    const early = await place(s, { paymentMethod: "cod" });
    await transitionOrder(s.owner, early, "confirm");
    expect(await applied(s.storeId, early, "returned")).toMatchObject({ outcome: "rejected", reason: "illegal_transition" }); // not in transit: no RTS
  });

  it("delivery and return racing on one parcel: the order row lock lets exactly one win, the ledger stays consistent whichever it is", async () => {
    for (let round = 0; round < 6; round++) {
      const s = await makeStore(`toko-r${round}`, { stock: 10, price: 40_000 });
      const { orderId } = await paidPrepaid(s);
      await toShipped(s, orderId);
      const [a, b] = await Promise.all([applied(s.storeId, orderId, "completed"), applied(s.storeId, orderId, "returned")]);
      expect([a.outcome, b.outcome].sort()).toEqual(["applied", "rejected"]);
      await releaseStore(platform, s.storeId);
      const kinds = await kindsOf(s.storeId, orderId);
      const final = await statusOf(orderId);
      if (final === "completed") expect(kinds).toEqual(["sale:available"]);
      else expect(kinds).toEqual(["sale:pending", "return_reversal:pending"]);
      expect((await balance(s.storeId)).availableIdr).toBeGreaterThanOrEqual(0);
    }
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });
});

describe("COD reconciliation batch (SA-53, four-eyes `cod.reconcile_release`)", () => {
  it("prepared by one staff member, approved by ANOTHER, applied once by the preparer: the preparer can neither approve nor apply without that approval", async () => {
    const s = await makeStore("toko-a", { price: 60_000 });
    const id = await deliveredCod(s);
    const opA = await makeOperator(["payouts.reconcile"]);
    const opB = await makeOperator(["payouts.reconcile"]);
    const { batchId } = await prepareReconciliationBatch(opA, { evidenceRef: "INV-2026-10-001", lines: [{ orderId: id, evidenceLineRef: "L1", evidenceAmountIdr: await payableOf(id), evidenceDate: "2026-10-28" }] });
    expect(await code(applyReconciliationBatch(opA, batchId))).toBe("not_pending"); // a draft cannot be applied
    const { approvalId } = await submitReconciliationBatch(opA, batchId, "uji rekonsiliasi");
    expect(await code(decideApproval(opA, approvalId, "approve"))).toBe("self_approval"); // the preparer is never the approver
    expect(await code(applyReconciliationBatch(opA, batchId))).toBe("approval_invalid"); // pending approval is not an approval
    expect(await code(applyReconciliationBatch(opB, batchId))).toBe("not_found"); // only the preparer executes
    await decideApproval(opB, approvalId, "approve");
    expect(await applyReconciliationBatch(opA, batchId)).toEqual({ items: 1 });
    expect((await platform.select().from(reconciliationBatch).where(eq(reconciliationBatch.id, batchId)))[0]).toMatchObject({ status: "applied", preparedByUserId: opA.userId, approvedByUserId: opB.userId });
    expect((await platform.select().from(reconciliationBatchItem).where(eq(reconciliationBatchItem.batchId, batchId)))[0]!.reconciledAt).toBeInstanceOf(Date);
    // replay: the batch is applied and the approval executed, so nothing reconciles twice and the job releases once
    expect(await code(applyReconciliationBatch(opA, batchId))).toBe("not_pending");
    expect(await releaseAll(platform)).toMatchObject({ released: 1 });
    expect(await releaseAll(platform)).toMatchObject({ released: 0 });
    expect(await entries(s.storeId)).toHaveLength(1);
  });

  it("the database refuses an applied batch whose preparer approved it (CHECK), and an approver without the capability cannot approve", async () => {
    const s = await makeStore("toko-a", { price: 60_000 });
    const id = await deliveredCod(s);
    const opA = await makeOperator(["payouts.reconcile"]);
    const noCap = await makeOperator(["tenants.read"]);
    const { batchId } = await prepareReconciliationBatch(opA, { evidenceRef: "INV-X-1", lines: [{ orderId: id, evidenceLineRef: "L1", evidenceAmountIdr: await payableOf(id), evidenceDate: "2026-10-28" }] });
    const { approvalId } = await submitReconciliationBatch(opA, batchId, "uji rekonsiliasi");
    expect(await code(decideApproval(noCap, approvalId, "approve"))).toBe("forbidden");
    // Forged state: the same user as preparer and approver violates reconciliation_batch_applied_chk even for a writer that skips the service.
    expect(await pg(platform.update(reconciliationBatch).set({ status: "applied", appliedAt: new Date(), approvedByUserId: opA.userId }).where(eq(reconciliationBatch.id, batchId)))).toBe("23514");
  });

  it("a line whose evidence differs from the order's COD amount is a break: it blocks submission and is never released; removing the line unblocks the rest", async () => {
    const s = await makeStore("toko-a", { price: 55_000 });
    const good = await deliveredCod(s);
    const bad = await deliveredCod(s);
    const opA = await makeOperator(["payouts.reconcile"]);
    const { batchId, breaks } = await prepareReconciliationBatch(opA, {
      evidenceRef: "INV-BRK",
      lines: [
        { orderId: good, evidenceLineRef: "G", evidenceAmountIdr: await payableOf(good), evidenceDate: "2026-10-28" },
        { orderId: bad, evidenceLineRef: "B", evidenceAmountIdr: (await payableOf(bad)) - 1_000, evidenceDate: "2026-10-28" },
      ],
    });
    expect(breaks).toEqual([{ orderId: bad, codAmountIdr: await payableOf(bad), evidenceAmountIdr: (await payableOf(bad)) - 1_000 }]);
    expect(await code(submitReconciliationBatch(opA, batchId, "ada selisih"))).toBe("reconciliation_break");
    expect(await pg(platform.update(reconciliationBatch).set({ status: "pending_approval", payloadSha256: "x", itemCount: 2, evidenceTotalIdr: 1 }).where(eq(reconciliationBatch.id, batchId)))).toBe("23514"); // the guard refuses a break too
    const item = (await platform.select().from(reconciliationBatchItem).where(and(eq(reconciliationBatchItem.batchId, batchId), eq(reconciliationBatchItem.orderId, bad))))[0]!;
    await voidReconciliationItem(opA, item.id);
    const opB = await makeOperator(["payouts.reconcile"]);
    const { approvalId } = await submitReconciliationBatch(opA, batchId, "selisih dihapus");
    await decideApproval(opB, approvalId, "approve");
    await applyReconciliationBatch(opA, batchId);
    expect(await releaseAll(platform)).toMatchObject({ released: 1 });
    expect((await kindsOf(s.storeId)).sort()).toEqual(["sale:available", "sale:pending"]); // the broken order stays pending
  });

  it("only a delivered COD order can be reconciled, once; an approval for one batch cannot apply another", async () => {
    const s = await makeStore("toko-a", { price: 55_000 });
    const cod = await deliveredCod(s);
    const prepaid = (await deliveredPrepaid(s)).orderId;
    const shipped = await place(s, { paymentMethod: "cod" });
    await toShipped(s, shipped, true);
    const op = await makeOperator(["payouts.reconcile"]);
    const line = async (id: number) => ({ orderId: id, evidenceLineRef: `L${id}`, evidenceAmountIdr: await payableOf(id), evidenceDate: "2026-10-28" });
    expect(await code(prepareReconciliationBatch(op, { evidenceRef: "INV-1", lines: [await line(prepaid)] }))).toBe("not_reconcilable");
    expect(await code(prepareReconciliationBatch(op, { evidenceRef: "INV-1", lines: [await line(shipped)] }))).toBe("not_reconcilable");
    const first = await reconcile([{ id: cod, amount: await payableOf(cod) }]);
    await first.apply();
    expect(await code(prepareReconciliationBatch(op, { evidenceRef: "INV-2", lines: [await line(cod)] }))).toBe("already_reconciled");
    // wrong binding: an approval granted to batch A is not valid for batch B
    const s2 = await makeStore("toko-b", { price: 55_000 });
    const c2 = await deliveredCod(s2);
    const c3 = await deliveredCod(s2);
    const a = await reconcile([{ id: c2, amount: await payableOf(c2) }]);
    const opX = await makeOperator(["payouts.reconcile"]);
    const { batchId: b } = await prepareReconciliationBatch(opX, { evidenceRef: "INV-B", lines: [await line(c3)] });
    await submitReconciliationBatch(opX, b, "batch lain");
    await platform.update(reconciliationBatch).set({ approvalRequestId: a.approvalId }).where(eq(reconciliationBatch.id, b)).catch(() => undefined); // best effort: the unique approval index may refuse
    expect(await code(applyReconciliationBatch(opX, b))).toBe("approval_invalid");
  });

  it("the provider reconciliation poll is OFF by default and does nothing; enabling it refuses loudly; the database refuses a provider batch while the flag is off", async () => {
    const s = await makeStore("toko-a", { price: 55_000 });
    const id = await deliveredCod(s);
    expect(await runProviderReconciliationPoll(platform)).toEqual({ skipped: true });
    expect(await platform.select().from(reconciliationBatch)).toHaveLength(0);
    expect(await releaseAll(platform)).toMatchObject({ released: 0 });
    await expect(runProviderReconciliationPoll(platform, true)).rejects.toThrow(/UNVERIFIED/);
    expect(await msg(platform.execute(sql`insert into reconciliation_batch (source, evidence_ref) values ('provider', 'x')`))).toMatch(/provider reconciliation is off/);
    expect(await kindsOf(s.storeId, id)).toEqual(["sale:pending"]);
  });

  it("cod.manual_complete: a courier-proof evidence reference, a second approver and the requester's execution complete the order with a pending COD sale; no one-sided path exists", async () => {
    const s = await makeStore("toko-a", { price: 65_000 });
    const id = await place(s, { paymentMethod: "cod" });
    await toShipped(s, id, true);
    await claimDelivery(s.owner, id);
    const opA = await makeOperator(["payouts.process"]);
    const opB = await makeOperator(["payouts.process"]);
    const { approvalId } = await requestManualCompletion(opA, { orderId: id, evidenceRef: "POD-77881", reason: "kurir kirim foto bukti serah terima" });
    expect(await code(applyManualCompletion(opA, { orderId: id, approvalId, evidenceRef: "POD-77881" }))).toBe("approval_invalid"); // not approved yet
    await decideApproval(opB, approvalId, "approve");
    expect(await code(applyManualCompletion(opA, { orderId: id, approvalId, evidenceRef: "POD-OTHER" }))).toBe("approval_invalid"); // evidence is part of the bound payload
    expect(await statusOf(id)).toBe("shipped");
    expect(await applyManualCompletion(opA, { orderId: id, approvalId, evidenceRef: "POD-77881" })).toEqual({ status: "completed" });
    expect(await kindsOf(s.storeId)).toEqual(["sale:pending"]);
    expect(await code(applyManualCompletion(opA, { orderId: id, approvalId, evidenceRef: "POD-77881" }))).toBe("approval_invalid"); // single use
    expect(await code(requestManualCompletion(opB, { orderId: id, evidenceRef: "POD-1234", reason: "sudah selesai" }))).toBe("not_shipped");
  });
});

describe("isolation, statements and the verification command (DATA-7, TEN-1)", () => {
  it("a store sees only its own ledger and finance screen; staff see no money; only the owner reads finance", async () => {
    const a = await makeStore("toko-a", { price: 50_000 });
    const b = await makeStore("toko-b", { price: 50_000 });
    await fund(a);
    await fund(b);
    await fund(b);
    expect((await ledgerStatement(a.owner)).rows.map((r) => r.storeId)).toEqual([a.storeId]);
    expect((await ledgerStatement(b.owner)).rows).toHaveLength(2);
    expect((await sellerFinance(a.owner)).balance).toEqual({ availableIdr: 50_000, pendingIdr: 0 });
    expect(await withStore(db, a.storeId, (tx) => tx.select().from(ledgerEntry).where(eq(ledgerEntry.storeId, b.storeId)))).toEqual([]); // RLS: store B's rows do not exist for store A
    const staffId = await makeUser("staff");
    await platform.insert(membership).values({ storeId: a.storeId, userId: staffId, role: "staff" });
    const staff = await seller(staffId, a.storeId);
    expect(await code(ledgerStatement(staff))).toBe("forbidden");
    expect(await code(sellerFinance(staff))).toBe("forbidden");
  });

  it("the statement pages by keyset over ledger_entry alone and a payout entry (no order) is part of the balance", async () => {
    const s = await makeStore("toko-a", { price: 150_000 });
    await fund(s);
    await fund(s);
    await fund(s);
    const p1 = await ledgerStatement(s.owner, { limit: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.next).not.toBeNull();
    const p2 = await ledgerStatement(s.owner, { limit: 2, cursor: p1.next! });
    expect(p2.rows.map((r) => r.id)).toEqual([(await entries(s.storeId))[0]!.id]);
  });

  it("verify:ledger recomputes every store and finds nothing wrong on a healthy mix (sale, COD, return, reconciliation); it runs in a READ ONLY transaction", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    await fund(s);
    await fund(s);
    const cod = await deliveredCod(s);
    await reconcile([{ id: cod, amount: await payableOf(cod) }]).then((b) => b.apply());
    await releaseAll(platform);
    const { orderId } = await paidPrepaid(s);
    await transitionOrder(s.owner, orderId, "cancel", { reason: "uji pembatalan" });
    let readOnly = "";
    let isolation = "";
    const probe = {
      ...platform,
      transaction: (cb: Parameters<typeof platform.transaction>[0], config?: Parameters<typeof platform.transaction>[1]) =>
        platform.transaction(async (tx) => {
          const r = await cb(tx);
          readOnly = String((await tx.execute(sql`show transaction_read_only`))[0]!.transaction_read_only);
          isolation = String((await tx.execute(sql`show transaction_isolation`))[0]!.transaction_isolation);
          return r;
        }, config),
    } as unknown as typeof platform;
    const v = await verifyLedger(probe);
    expect(readOnly).toBe("on");
    expect(isolation).toBe("repeatable read"); // one snapshot (T-37 review P3-4)
    expect(v.violations).toEqual([]);
    expect(v.stores).toHaveLength(1);
    expect(v.stores[0]).toMatchObject({ storeId: s.storeId, availableIdr: 300_000, pendingIdr: 0 }); // 3 released sales of 100 000; the cancelled order nets to zero
    expect(v.entries).toBe((await entries(s.storeId)).length);
  });

  it("verify:ledger detects each corruption (guards lifted by the superuser only to plant it)", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const codId = await deliveredCod(s);
    const prepaid = await deliveredPrepaid(s);
    await releaseStore(platform, s.storeId);
    const codSale = (await entries(s.storeId)).find((e) => e.orderId === codId)!;
    const codes = async () => (await verifyLedger(platform)).violations.map((v) => v.code);
    expect(await codes()).toEqual([]);
    // 1. a COD sale released without a reconciliation item
    await withoutGuard("ledger_entry", "ledger_entry_change_guard", () => admin.execute(sql`update ledger_entry set status = 'available', released_at = now(), release_basis = 'delivery' where id = ${codSale.id}`));
    expect(await codes()).toContain("released_without_delivery_and_reconciliation");
    await withoutGuard("ledger_entry", "ledger_entry_change_guard", () => admin.execute(sql`update ledger_entry set status = 'pending', released_at = null, release_basis = null where id = ${codSale.id}`).catch(() => undefined));
    // 2. a negative adjustment that takes available below zero (the insert guard lifted by the superuser only to plant it)
    await withoutGuard("ledger_entry", "ledger_entry_insert_guard", () => admin.execute(sql`insert into ledger_entry (store_id, kind, status, amount_idr, business_ref, approval_request_id, released_at, release_basis) values (${s.storeId}, 'adjustment', 'available', -900000, 'PLANT-1', 1, now(), 'direct')`));
    const found = await codes();
    expect(found).toContain("available_negative");
    expect(found).toContain("available_dipped_negative");
    // 3. an order that met its booking condition but lost its sale (the change guard lifted to plant it)
    await withoutGuard("ledger_entry", "ledger_entry_change_guard", () => admin.execute(sql`delete from ledger_entry where store_id = ${s.storeId} and order_id = ${prepaid.orderId} and kind = 'sale'`));
    expect(await codes()).toContain("missing_sale");
  });

  it("no balance query joins order: the balance SQL is a single-table aggregate and the service reads ledger_entry alone (a payout entry has order_id NULL and must count)", async () => {
    const sqlText = new PgDialect().sqlToQuery(BALANCE_SQL).sql;
    expect(sqlText).toMatch(/from ledger_entry/);
    expect(sqlText).not.toMatch(/\bjoin\b|"order"/i);
    expect(ledgerBalance.toString()).not.toMatch(/innerJoin|leftJoin|\.join\(|order\b/);
    const s = await makeStore("toko-a", { price: 150_000 });
    await fund(s);
    expect((await ledgerBalance(platform, s.storeId)).availableIdr).toBe(150_000);
    const [row] = (await platform.execute(BALANCE_SQL)) as unknown as { store_id: string; available_idr: string }[];
    expect(Number(row!.available_idr)).toBe(150_000);
  });
});
