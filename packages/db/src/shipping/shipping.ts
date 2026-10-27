import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../client.ts";
import { mengantarFromEnv } from "./mengantar/adapter.ts";
import { fakeAutoLaris, fakeMengantar, type ProviderQuote, type Providers, type ShippingAdapter } from "../payments/providers.ts";
import { auditLog, shippingMarginRule, storePickupArea } from "../schema.ts";
import { DomainError, requireCap, type OperatorScope, type SellerScope, type StorefrontScope } from "../platform/scoped.ts";
import { inStore } from "../platform/tenant.ts";

export { MengantarClient, MengantarError, MengantarWriteDisabledError, redactUrl } from "./mengantar/client.ts";
export { COURIER_LABELS, mengantarAdapter, mengantarFromEnv, toProviderQuote } from "./mengantar/adapter.ts";

// Shipping quotes with platform margin (T-34, PR-5, Q-12). Provider cost comes
// from the adapter (never the client), the margin rule is platform-wide and
// operator-edited, and the result is integer IDR ready to be snapshotted on the
// order (provider cost, margin, buyer fee, courier code, area ids).

// ── Margin rule ────────────────────────────────────────────────────────────

export type MarginRule = { fixedIdr: number; percentBps: number; roundTo: number };
/** Until an operator edits it: Rp 2.000 flat, no percent, rounded up to Rp 500. */
export const DEFAULT_MARGIN_RULE: MarginRule = { fixedIdr: 2_000, percentBps: 0, roundTo: 500 };
export const ROUND_TO_OPTIONS = [1, 100, 500, 1000] as const;

export const marginRuleInput = z.strictObject({
  fixedIdr: z.coerce.number().int("Margin tetap harus bilangan bulat rupiah.").min(0).max(100_000, "Margin tetap maksimal Rp 100.000."),
  percentBps: z.coerce.number().int().min(0).max(10_000, "Persen maksimal 100%."),
  roundTo: z.coerce.number().int().refine((v) => (ROUND_TO_OPTIONS as readonly number[]).includes(v), "Pembulatan tidak valid."),
});

export type FeeBreakdown = { providerCost: number; margin: number; buyerFee: number };
export type ShippingOption = {
  courier: string;
  label: string;
  etd?: string | undefined;
  /** Fee for prepaid (transfer) payment. */
  prepaid: FeeBreakdown;
  /** Fee for COD, or null when the courier refuses COD on this route. */
  cod: FeeBreakdown | null;
};

/** Pure: buyer fee = roundUp(cost + fixed + ceil(cost × bps / 10000), roundTo); margin = buyer fee − cost. Integer IDR only. */
export function applyMargin(providerCost: number, rule: MarginRule): FeeBreakdown {
  if (!Number.isInteger(providerCost) || providerCost < 0) throw new DomainError("bad_cost", "Biaya kurir tidak valid.");
  const raw = providerCost + rule.fixedIdr + Math.ceil((providerCost * rule.percentBps) / 10_000);
  const buyerFee = Math.ceil(raw / rule.roundTo) * rule.roundTo;
  return { providerCost, margin: buyerFee - providerCost, buyerFee };
}

/** Pure: drops `unsupported` couriers, prices prepaid and COD (null when `unsupportedCod`), cheapest prepaid first. */
export function quoteWithMargin(quotes: ProviderQuote[], rule: MarginRule): ShippingOption[] {
  return quotes
    .filter((q) => !q.unsupported)
    .map((q) => ({
      courier: q.courier,
      label: q.label,
      etd: q.etd,
      prepaid: applyMargin(q.providerCost, rule),
      cod: q.unsupportedCod ? null : applyMargin(q.providerCostCod, rule),
    }))
    .sort((a, b) => a.prepaid.buyerFee - b.prepaid.buyerFee || a.courier.localeCompare(b.courier));
}

export async function getMarginRule(exec: Executor): Promise<MarginRule> {
  const [row] = await exec.select().from(shippingMarginRule).where(eq(shippingMarginRule.key, "default"));
  return row ? { fixedIdr: row.fixedIdr, percentBps: row.percentBps, roundTo: row.roundTo } : DEFAULT_MARGIN_RULE;
}

/** Operator-only edit of the platform margin, audited (IAM-5). */
export async function setMarginRule(op: OperatorScope, raw: unknown): Promise<MarginRule> {
  const rule = marginRuleInput.parse(raw);
  await op.exec.transaction(async (tx) => {
    await tx
      .insert(shippingMarginRule)
      .values({ key: "default", ...rule, updatedBy: op.userId })
      .onConflictDoUpdate({ target: shippingMarginRule.key, set: { ...rule, updatedBy: op.userId, updatedAt: new Date() } });
    await tx.insert(auditLog).values({
      actorUserId: op.userId,
      action: MARGIN_AUDIT_ACTION,
      reason: `fixed=${rule.fixedIdr} bps=${rule.percentBps} roundTo=${rule.roundTo}`,
    });
  });
  return rule;
}
export const MARGIN_AUDIT_ACTION = "shipping.margin.update";

export async function marginRuleAudit(op: OperatorScope) {
  return op.exec.select().from(auditLog).where(eq(auditLog.action, MARGIN_AUDIT_ACTION)).orderBy(desc(auditLog.id)).limit(10);
}

// ── Seller pickup origin (store-scoped) ────────────────────────────────────

const areaId = z.string().regex(/^[a-f0-9]{24}$/, "Area tidak valid.");
export const pickupAreaInput = z.strictObject({
  areaId,
  areaLabel: z.string().trim().min(3, "Label area wajib diisi.").max(200),
});
export const pickupAddressInput = z.strictObject({
  addressText: z.string().trim().min(10, "Alamat pickup terlalu pendek.").max(500),
});

export async function getPickupArea(scope: SellerScope) {
  return inStore(scope, async (scope) => {
    const [row] = await scope.exec
      .select({ areaId: storePickupArea.areaId, areaLabel: storePickupArea.areaLabel, addressText: storePickupArea.addressText, updatedAt: storePickupArea.updatedAt })
      .from(storePickupArea)
      .where(eq(storePickupArea.storeId, scope.storeId));
    return row ?? null;
  });
}

/** Server-side area search for the pickup form (owner only; no provider write). */
export async function searchPickupAreas(scope: SellerScope, keyword: string, adapter: ShippingAdapter = defaultShippingAdapter()) {
  requireCap(scope, "shipping.manage");
  const k = keyword.trim();
  if (k.length < 3) throw new DomainError("keyword", "Ketik minimal 3 huruf nama kelurahan, kecamatan atau kota.");
  return adapter.searchArea(k);
}

/** Store the chosen provider AREA id + label locally (keeps the address text). */
export async function setPickupArea(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "shipping.manage");
  return inStore(scope, async (scope) => {
    const input = pickupAreaInput.parse(raw);
    await scope.exec
      .insert(storePickupArea)
      .values({ storeId: scope.storeId, ...input, updatedBy: scope.userId })
      .onConflictDoUpdate({ target: storePickupArea.storeId, set: { ...input, updatedBy: scope.userId, updatedAt: new Date() } });
  });
}

export async function setPickupAddress(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "shipping.manage");
  return inStore(scope, async (scope) => {
    const { addressText } = pickupAddressInput.parse(raw);
    const updated = await scope.exec
      .update(storePickupArea)
      .set({ addressText, updatedBy: scope.userId, updatedAt: new Date() })
      .where(eq(storePickupArea.storeId, scope.storeId))
      .returning({ storeId: storePickupArea.storeId });
    if (updated.length === 0) throw new DomainError("no_pickup_area", "Pilih area pickup terlebih dahulu.");
  });
}

// ── Checkout-facing service (wired to /checkout in the next phase) ─────────

export type CartForShipping = { lines: { quantity: number; weightGrams: number }[]; subtotal: number };

/**
 * Parcel weight in whole kilograms (T-61): the sum of quantity × variant weight, rounded up, minimum 1 kg.
 * The quote, the order snapshot (`order.weight_kg`) and the booking all read this one number. Rounding up and the
 * provider minimum are UNVERIFIED against Mengantar until an observed estimate or booking confirms them.
 */
export function parcelWeightKg(lines: readonly { quantity: number; weightGrams: number }[]): number {
  const grams = lines.reduce((sum, l) => sum + l.quantity * l.weightGrams, 0);
  return Math.max(1, Math.ceil(grams / 1000));
}

/**
 * Shipping options for a storefront cart: store pickup area (error if missing) →
 * provider estimate → margin + gating. Weight is `parcelWeightKg`; `codAmount` is the cart subtotal.
 */
export async function shippingOptions(
  scope: StorefrontScope,
  destinationAreaId: string,
  cart: CartForShipping,
  adapter: ShippingAdapter = defaultShippingAdapter(),
): Promise<{ originAreaId: string; destinationAreaId: string; weightKg: number; options: ShippingOption[] }> {
  const destination = areaId.parse(destinationAreaId);
  // Store context for the pickup row only; the provider call below must not run inside a transaction.
  const [origin] = await inStore(scope, (scope) =>
    scope.exec.select({ areaId: storePickupArea.areaId }).from(storePickupArea).where(eq(storePickupArea.storeId, scope.storeId)),
  );
  if (!origin) throw new DomainError("no_pickup_area", "Toko belum mengatur area pickup.");
  const weightKg = parcelWeightKg(cart.lines);
  const [rule, quotes] = await Promise.all([
    getMarginRule(scope.exec),
    adapter.estimate({ originAreaId: origin.areaId, destinationAreaId: destination, weightKg, codAmount: cart.subtotal }),
  ]);
  return { originAreaId: origin.areaId, destinationAreaId: destination, weightKg, options: quoteWithMargin(quotes, rule) };
}

let adapterInstance: ShippingAdapter | undefined;
/** Real Mengantar when the platform key is in the process env, else the fake (tests, e2e, local dev). */
export function defaultShippingAdapter(): ShippingAdapter {
  return (adapterInstance ??= mengantarFromEnv() ?? fakeMengantar);
}

/** Runtime providers for checkout: shipping per `defaultShippingAdapter()`, payment still fake (T-6 gate). */
export function defaultProviders(): Providers {
  return { shipping: defaultShippingAdapter(), payment: fakeAutoLaris };
}
