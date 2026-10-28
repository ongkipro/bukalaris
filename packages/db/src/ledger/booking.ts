import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { ledgerEntry, order, orderFinancials, shipmentCost } from "../schema.ts";
import { DomainError } from "../platform/scoped.ts";
import { withStore } from "../platform/tenant.ts";
import { defaultShippingAdapter } from "../shipping/shipping.ts";
import type { ShippingAdapter } from "../payments/providers.ts";
import { ledgerBalance, lockStore } from "./ledger.ts";

// Shipping reconciliation at booking (ADR-0006 decision 7, BILL-4). Three steps, and the provider is NEVER called while a transaction or a lock is
// open: (1) a read-only live re-quote of the order's own route and weight outside any lock, (2) ONE transaction under the order row then the
// per-store lock that records the append-once `shipment_cost` and reserves the seller's `shipping_debit`, refusing BEFORE any provider write when
// the debit cannot be covered, (3) the provider call after commit (fulfillment.ts). A price that later differs is a reconciliation signal, not a
// ledger mutation. Rebooking is unsupported in M3 (one cost record per order), so a reversed reservation blocks a second booking.

let quoteAdapter: ShippingAdapter | null = null;
/** Tests inject a scripted re-quote adapter; `null` restores the platform default. */
export function setRequoteAdapter(a: ShippingAdapter | null): void {
  quoteAdapter = a;
}

export type Requote = { bookedShippingIdr: number; providerCodFeeIdr: number };

/** Step 1: what the provider charges NOW for this order's route, weight and (COD) collection amount. Throws `quote_unavailable` when the courier no longer serves it. */
export async function requoteOrder(o: { originAreaId: string; destinationAreaId: string; weightKg: number; courierCode: string; cod: boolean; payableIdr: number; shippingAccountId: number; shippingAccountKind: "partner_managed" | "platform_master" }): Promise<Requote> {
  const quotes = await (quoteAdapter ?? defaultShippingAdapter()).estimate({ originAreaId: o.originAreaId, destinationAreaId: o.destinationAreaId, weightKg: o.weightKg, codAmount: o.payableIdr, shippingAccountId: o.shippingAccountId, shippingAccountKind: o.shippingAccountKind });
  const q = quotes.find((x) => x.courier.toLowerCase() === o.courierCode.toLowerCase() && !x.unsupported && (!o.cod || !x.unsupportedCod));
  if (!q) throw new DomainError("quote_unavailable", "Kurir tidak lagi melayani rute ini; booking dibatalkan sebelum ke penyedia.");
  const booked = o.cod ? q.providerCostCod : q.providerCost;
  // The provider's COD fee is part of the booked cost (it is inside providerCostCod); the plain-cost difference is the fee of this booking basis.
  return { bookedShippingIdr: booked, providerCodFeeIdr: o.cod ? Math.max(0, q.providerCostCod - q.providerCost) : 0 };
}

/**
 * BILL-4 funding of one booking, the single formula (T-46 store discount x T-48 platform discount). The courier is paid out of what was collected:
 * the buyer's charge, the store-funded discount (the seller carries it) and the PLATFORM-funded discount (the platform carries it, out of its margin).
 *   delta = booked - (charged + storeDiscount + platformDiscount)
 *   debit = max(delta, 0) + storeDiscount     margin = max(-delta, 0)   (gross margin: the platform's net is margin - platformDiscount)
 * The seller therefore never pays any part of the platform discount: a courier price rise is absorbed by the full margin first and only a rise beyond it
 * becomes a seller debit. Identity (database CHECK): charged + platformDiscount + debit = booked + margin.
 */
export function shippingFunding(i: { bookedIdr: number; chargedIdr: number; storeDiscountIdr: number; platformDiscountIdr: number }): { debit: number; margin: number } {
  const delta = i.bookedIdr - (i.chargedIdr + i.storeDiscountIdr + i.platformDiscountIdr);
  return { debit: Math.max(0, delta) + i.storeDiscountIdr, margin: Math.max(0, -delta) };
}

export type ReserveOutcome =
  | { outcome: "reserved"; debitIdr: number; marginIdr: number; debitStatus: "available" | "pending" | null }
  | { outcome: "already"; debitIdr: number }
  | { outcome: "refused"; reason: "insufficient_balance" | "reservation_reversed" | "not_bookable" | "cod_amount_mismatch" };

/**
 * Step 2. Records `shipment_cost` (append-once) and the `shipping_debit` entry in one transaction. Coverage (ADR-0006 decision 7, D-22 items 1):
 *  - `available >= debit`: the debit is inserted `available`;
 *  - prepaid, with its own pending sale: `available + sale >= debit` -> inserted `pending`, released with the sale at delivery (nets in the held pool);
 *  - COD (no sale exists yet, OPEN-F3 default): inserted `pending`, settled with the delivered sale at release;
 *  - otherwise refuse before the provider call.
 * A second call finds the existing record and changes nothing; a cost whose debit was already reversed is a refusal (no rebooking in M3).
 */
export async function reserveShippingCost(db: Db, input: { storeId: number; orderId: number; requote: Requote; codAmountSentIdr: number | null }): Promise<ReserveOutcome> {
  const { storeId, orderId } = input;
  return withStore(db, storeId, async (tx) => {
    const [o] = await tx.select({ status: order.status, method: order.paymentMethod }).from(order).where(and(eq(order.storeId, storeId), eq(order.id, orderId))).for("update");
    const [fin] = await tx.select().from(orderFinancials).where(and(eq(orderFinancials.storeId, storeId), eq(orderFinancials.orderId, orderId)));
    if (!o || !fin || !["placed", "processing"].includes(o.status)) return { outcome: "refused", reason: "not_bookable" } as const;
    await lockStore(tx, storeId);
    const [existing] = await tx.select().from(shipmentCost).where(and(eq(shipmentCost.storeId, storeId), eq(shipmentCost.orderId, orderId)));
    if (existing) {
      const [rev] = await tx.select({ id: ledgerEntry.id }).from(ledgerEntry).where(and(eq(ledgerEntry.storeId, storeId), eq(ledgerEntry.orderId, orderId), eq(ledgerEntry.kind, "shipping_debit_reversal")));
      return rev ? ({ outcome: "refused", reason: "reservation_reversed" } as const) : ({ outcome: "already", debitIdr: existing.sellerShippingDebitIdr } as const);
    }
    const cod = o.method === "cod";
    if (cod && input.codAmountSentIdr !== fin.payableIdr) return { outcome: "refused", reason: "cod_amount_mismatch" } as const;
    const { debit, margin } = shippingFunding({ bookedIdr: input.requote.bookedShippingIdr, chargedIdr: fin.shippingChargedIdr, storeDiscountIdr: fin.shippingDiscountIdr, platformDiscountIdr: fin.platformShippingDiscountIdr });
    let entryId: number | null = null;
    let debitStatus: "available" | "pending" | null = null;
    if (debit > 0) {
      const bal = await ledgerBalance(tx, storeId);
      const [sale] = await tx.select({ amount: ledgerEntry.amountIdr, status: ledgerEntry.status }).from(ledgerEntry).where(and(eq(ledgerEntry.storeId, storeId), eq(ledgerEntry.orderId, orderId), eq(ledgerEntry.kind, "sale")));
      if (bal.availableIdr >= debit) debitStatus = "available";
      else if (cod || (sale?.status === "pending" && bal.availableIdr + sale.amount >= debit)) debitStatus = "pending";
      else return { outcome: "refused", reason: "insufficient_balance" } as const;
      const [e] = await tx
        .insert(ledgerEntry)
        .values({
          storeId,
          orderId,
          kind: "shipping_debit",
          status: debitStatus,
          amountIdr: -debit,
          ...(debitStatus === "available" ? { releasedAt: new Date(), releaseBasis: "direct" as const } : {}),
          note: "Selisih ongkir kurir di atas ongkir yang dibayar pembeli",
        })
        .returning({ id: ledgerEntry.id });
      entryId = e!.id;
    }
    await tx.insert(shipmentCost).values({
      orderId,
      storeId,
      shippingDiscountIdr: fin.shippingDiscountIdr,
      platformShippingDiscountIdr: fin.platformShippingDiscountIdr,
      bookedShippingIdr: input.requote.bookedShippingIdr,
      shippingChargedIdr: fin.shippingChargedIdr,
      sellerShippingDebitIdr: debit,
      platformShippingMarginIdr: margin,
      providerCodFeeIdr: input.requote.providerCodFeeIdr,
      codAmountSentIdr: cod ? input.codAmountSentIdr : null,
      shippingDebitEntryId: entryId,
    });
    return { outcome: "reserved", debitIdr: debit, marginIdr: margin, debitStatus } as const;
  });
}

/**
 * After a DEFINITE provider rejection (nothing was created) or a provider-confirmed void: the exact opposing credit, once (unique index). A
 * transport failure or an unknown outcome never calls this: the reservation stays until the outcome is proven.
 */
export async function reverseShippingReservation(db: Db, storeId: number, orderId: number): Promise<{ reversed: boolean }> {
  return withStore(db, storeId, async (tx) => {
    await lockStore(tx, storeId);
    const [d] = await tx.select({ amount: ledgerEntry.amountIdr, status: ledgerEntry.status }).from(ledgerEntry).where(and(eq(ledgerEntry.storeId, storeId), eq(ledgerEntry.orderId, orderId), eq(ledgerEntry.kind, "shipping_debit"))).for("update");
    if (!d) return { reversed: false };
    const rows = await tx
      .insert(ledgerEntry)
      .values({
        storeId,
        orderId,
        kind: "shipping_debit_reversal",
        status: d.status,
        amountIdr: -d.amount,
        ...(d.status === "available" ? { releasedAt: new Date(), releaseBasis: "direct" as const } : {}),
        note: "Booking ditolak penyedia: potongan ongkir dikembalikan",
      })
      .onConflictDoNothing()
      .returning({ id: ledgerEntry.id });
    return { reversed: rows.length > 0 };
  });
}
