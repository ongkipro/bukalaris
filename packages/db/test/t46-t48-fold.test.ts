import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { reserveShippingCost } from "../src/ledger/booking.ts";
import { verifyLedger } from "../src/ledger/verify.ts";
import { saveVoucher } from "../src/promotions/manage.ts";
import { ledgerEntry, order, orderFinancials, shipmentCost } from "../src/schema.ts";
import { makeStore, platform } from "./helpers.ts";
import { balance, fund, paidPrepaid } from "./t37-fixtures.ts";
import { billingTestSetup } from "./t50-fixtures.ts";

// Integration of T-46 (store-funded shipping discount) with T-37 booking and T-48 shipment_cost: the case T-46 could not test alone.
billingTestSetup();
const HOUR = 3_600_000;

describe("a seller-funded shipping discount at booking (T-46 x T-37 x T-48)", () => {
  it("free shipping covering the courier cost books the seller debit and keeps the platform margin; the ledger stays consistent", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    await fund(s, 3); // 300 000 available: the debit is covered
    const v = await saveVoucher(s.owner, { kind: "free_shipping", scope: "all", value: 0, startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + HOUR) });
    const { orderId } = await paidPrepaid(s, 1, { voucherCode: v.code });
    const [o] = await platform.select().from(order).where(eq(order.id, orderId));
    const [fin] = await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId));
    expect(fin!.shippingDiscountIdr).toBe(o!.shippingProviderCost); // the store funds the whole courier cost
    expect(fin!.shippingChargedIdr).toBe(o!.shippingMargin); // the buyer paid exactly the platform margin
    // The provider re-quote equals the original courier cost: nothing extra, but the seller carries the discount.
    const before = (await balance(s.storeId)).availableIdr;
    const r = await reserveShippingCost(platform, { storeId: s.storeId, orderId, requote: { bookedShippingIdr: o!.shippingProviderCost + o!.shippingMargin, providerCodFeeIdr: 0 }, codAmountSentIdr: null });
    expect(r).toMatchObject({ outcome: "reserved", debitIdr: o!.shippingProviderCost, marginIdr: 0 });
    const [cost] = await platform.select().from(shipmentCost).where(eq(shipmentCost.orderId, orderId));
    expect(cost).toMatchObject({ sellerShippingDebitIdr: o!.shippingProviderCost, shippingDiscountIdr: o!.shippingProviderCost, shippingChargedIdr: o!.shippingMargin });
    const debit = (await platform.select().from(ledgerEntry).where(eq(ledgerEntry.orderId, orderId))).filter((e) => e.kind === "shipping_debit");
    expect(debit).toHaveLength(1);
    expect(debit[0]!.amountIdr).toBe(-o!.shippingProviderCost);
    expect((await balance(s.storeId)).availableIdr).toBe(before - o!.shippingProviderCost);
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });
});
