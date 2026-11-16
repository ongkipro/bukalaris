import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../client.ts";
import { mengantarFromEnv } from "./mengantar/adapter.ts";
import { fakeAutoLaris, fakeMengantar, type ProviderQuote, type Providers, type ShippingAdapter } from "../payments/providers.ts";
import { auditLog, courierServicePolicy, shippingMarginRule, storePickupArea } from "../schema.ts";
import { DomainError, requireCap, type OperatorScope, type SellerScope, type StorefrontScope } from "../platform/scoped.ts";
import { inStore } from "../platform/tenant.ts";
import { requirePlatformCap } from "../ops/capabilities.ts";
import { selectShippingAccount } from "./accounts.ts";
import { applyApprovedMargin, applyShippingDiscount, effectiveShippingDiscount } from "./policy.ts";
import type { ProviderEnvironment, ShippingAccountKind } from "./schema-accounts.ts";
import { storeShippingAccount } from "./schema-accounts.ts";
import { searchSellerAreas, sellerAccount, sellerShippingOptions } from "./rules.ts";
import { sellerMengantar } from "./seller.ts";

export { MengantarClient, MengantarError, MengantarWriteDisabledError, redactUrl } from "./mengantar/client.ts";
export { COURIER_LABELS, mengantarAdapter, mengantarFromEnv, toProviderQuote } from "./mengantar/adapter.ts";
export * from "./rules.ts";
export * from "./live-setting.ts";
export { PROVINCE_NAME, PROVINCES, SUGGESTED_COD_BLOCKED, type ProvinceCode } from "./provinces.ts";

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
/** A fee after the platform shipping discount: `platformDiscount` is what the platform funds out of its margin (frozen on the order financials). */
export type PricedFee = FeeBreakdown & { platformDiscount: number };
export type ShippingOption<F extends FeeBreakdown = FeeBreakdown> = {
  courier: string;
  label: string;
  etd?: string | undefined;
  /** Fee for prepaid (transfer) payment. */
  prepaid: F;
  /** Fee for COD, or null when the courier refuses COD on this route. */
  cod: F | null;
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

/** Margin changes use the same four-eyes shipping.margin contract as the discount/routing policy. */
export async function setMarginRule(op: OperatorScope, raw: unknown, approvalId?: number): Promise<MarginRule> {
  await requirePlatformCap(op, "shipping.manage");
  const rule = marginRuleInput.parse(raw);
  if (!approvalId) throw new DomainError("approval_invalid", "Perubahan margin memerlukan persetujuan operator kedua.");
  return applyApprovedMargin(op, rule, approvalId);
}
export const MARGIN_AUDIT_ACTION = "shipping.margin.update";

export async function marginRuleAudit(op: OperatorScope) {
  await requirePlatformCap(op, "shipping.manage");
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
  // T-105: the person the courier asks for at pickup, required by the provider when the address is registered with the store's own account.
  contactName: z.string().trim().max(120).optional(),
  contactPhone: z.string().trim().max(20).optional(),
});
const pickupContact = z.strictObject({
  contactName: z.string().trim().min(2, "Isi nama penanggung jawab pickup.").max(120),
  contactPhone: z.string().trim().regex(/^\+?[0-9]{10,15}$/, "Nomor HP penanggung jawab 10–15 digit."),
});

export async function getPickupArea(scope: SellerScope) {
  requireCap(scope, "shipping.read");
  return inStore(scope, async (scope) => {
    const [row] = await scope.exec
      .select({ areaId: storePickupArea.areaId, areaLabel: storePickupArea.areaLabel, addressText: storePickupArea.addressText, updatedAt: storePickupArea.updatedAt })
      .from(storePickupArea)
      .where(eq(storePickupArea.storeId, scope.storeId));
    return row ?? null;
  });
}

/** Server-side area search for the pickup form (owner only; no provider write). A store on its own account searches with its own key (T-105). */
export async function searchPickupAreas(scope: SellerScope, keyword: string, adapter: ShippingAdapter = defaultShippingAdapter()) {
  requireCap(scope, "shipping.manage");
  const k = keyword.trim();
  if (k.length < 3) throw new DomainError("keyword", "Ketik minimal 3 huruf nama kelurahan, kecamatan atau kota.");
  const own = await inStore(scope, ({ exec }) => sellerAccount(exec, scope.storeId));
  if (own?.status === "active") return searchSellerAreas(scope, k, own.environment, undefined, "pickup"); // the seller's own bucket, never the buyers' one
  return adapter.searchArea(k);
}

/** Store the chosen provider AREA id + label locally (keeps the address text). Another area drops the registration with the store's own account (T-105). */
export async function setPickupArea(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "shipping.manage");
  return inStore(scope, async (scope) => {
    const input = pickupAreaInput.parse(raw);
    const [before] = await scope.exec.select({ areaId: storePickupArea.areaId }).from(storePickupArea).where(eq(storePickupArea.storeId, scope.storeId)).for("update");
    await scope.exec
      .insert(storePickupArea)
      .values({ storeId: scope.storeId, ...input, updatedBy: scope.userId })
      .onConflictDoUpdate({ target: storePickupArea.storeId, set: { ...input, updatedBy: scope.userId, updatedAt: new Date() } });
    if (before?.areaId !== input.areaId) {
      await scope.exec.update(storeShippingAccount).set({ pickupRegisteredAt: null, pickupAddressId: null }).where(and(eq(storeShippingAccount.storeId, scope.storeId), eq(storeShippingAccount.kind, "seller_owned")));
    }
  });
}

/**
 * Saves the pickup address text. On a store with its own Mengantar account the address is first registered with that account (ADR-0013
 * decision 12: if the provider refuses, nothing changes locally); the registration makes shipping ready.
 */
export async function setPickupAddress(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "shipping.manage");
  const input = pickupAddressInput.parse(raw);
  const { addressText } = input;
  const [own, [pickup]] = await inStore(scope, ({ exec }) => Promise.all([sellerAccount(exec, scope.storeId), exec.select({ areaId: storePickupArea.areaId }).from(storePickupArea).where(eq(storePickupArea.storeId, scope.storeId))]));
  if (!pickup) throw new DomainError("no_pickup_area", "Pilih area pickup terlebih dahulu.");
  let registered: { id: string; accountId: number; revision: number } | null = null;
  if (own?.status === "active") {
    const contact = pickupContact.parse({ contactName: input.contactName ?? "", contactPhone: input.contactPhone ?? "" });
    if (own.lastResult !== "ready") throw new DomainError("check_failed", "Kunci akun kurir toko belum lolos pengecekan. Cek kunci di Akun penyedia, lalu simpan alamat lagi.");
    const { openProviderKey } = await import("../payments/provider-accounts.ts"); // loaded on use, as in rules.ts
    const client = await sellerMengantar(scope.exec, await openProviderKey(scope, "mengantar"), own.environment);
    let id: string;
    try {
      id = await client.registerPickup({ areaId: pickup.areaId, addressText, storeName: scope.storeName, ...contact, existingId: own.pickupAddressId });
    } catch (err) {
      if (err instanceof DomainError) throw err;
      const e = new DomainError("pickup_registration_failed", "Alamat pickup tidak bisa didaftarkan ke akun kurir toko Anda. Tidak ada yang diubah; periksa alamat dan nomor HP lalu coba lagi.");
      e.cause = err;
      throw e;
    }
    registered = { id, accountId: own.id, revision: own.revision };
  }
  await inStore(scope, async ({ exec }) => {
    const updated = await exec
      .update(storePickupArea)
      .set({ addressText, updatedBy: scope.userId, updatedAt: new Date() })
      .where(and(eq(storePickupArea.storeId, scope.storeId), eq(storePickupArea.areaId, pickup.areaId)))
      .returning({ storeId: storePickupArea.storeId });
    if (updated.length === 0) throw new DomainError("conflict", "Area pickup baru saja diubah. Muat ulang halaman lalu simpan lagi.");
    if (!registered) return;
    // The account must still be the one the address was registered with (a key replaced meanwhile is another account).
    const done = await exec
      .update(storeShippingAccount)
      .set({ pickupAddressId: registered.id, pickupRegisteredAt: sql`now()` as unknown as Date })
      .where(and(eq(storeShippingAccount.storeId, scope.storeId), eq(storeShippingAccount.id, registered.accountId), eq(storeShippingAccount.revision, registered.revision)))
      .returning({ id: storeShippingAccount.id });
    if (done.length === 0) throw new DomainError("conflict", "Akun kurir toko baru saja diubah. Muat ulang halaman lalu simpan alamat lagi.");
    await exec.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: "shipping.manage", action: "shipping.pickup.register", subjectKind: "provider_account", subjectId: "mengantar", accessLevel: "write", outcome: "allowed", reason: `area=${pickup.areaId}` });
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
  clientIp?: string,
): Promise<{ originAreaId: string; destinationAreaId: string; weightKg: number; shippingAccountId: number; shippingAccountKind: ShippingAccountKind; environment: ProviderEnvironment | null; options: ShippingOption<PricedFee>[] }> {
  const destination = areaId.parse(destinationAreaId);
  // Store context for the pickup row only; the provider call below must not run inside a transaction.
  const [origin] = await inStore(scope, (scope) =>
    scope.exec.select({ areaId: storePickupArea.areaId }).from(storePickupArea).where(eq(storePickupArea.storeId, scope.storeId)),
  );
  if (!origin) throw new DomainError("no_pickup_area", "Toko belum mengatur area pickup.");
  const account = await selectShippingAccount(scope);
  const weightKg = parcelWeightKg(cart.lines);
  if (account.kind === "seller_owned") {
    // T-105: the store's own account. The buyer pays the provider's public rate; no margin, no platform discount (ADR-0013 decision 15).
    const own = await sellerShippingOptions(scope, { environment: account.environment! }, { originAreaId: origin.areaId, destinationAreaId: destination, weightKg }, clientIp);
    const options = own.map((o): ShippingOption<PricedFee> => {
      const fee = { providerCost: o.fee, margin: 0, buyerFee: o.fee, platformDiscount: 0 };
      return { courier: o.courier, label: o.label, etd: o.etd, prepaid: fee, cod: o.cod ? fee : null };
    });
    return { originAreaId: origin.areaId, destinationAreaId: destination, weightKg, shippingAccountId: account.id, shippingAccountKind: account.kind, environment: account.environment, options };
  }
  const [rule, discount, quotes] = await Promise.all([
    getMarginRule(scope.exec),
    effectiveShippingDiscount(scope.exec),
    adapter.estimate({ originAreaId: origin.areaId, destinationAreaId: destination, weightKg, codAmount: cart.subtotal, shippingAccountId: account.id, shippingAccountKind: account.kind }),
  ]);
  const codPolicy = await codAllowedCouriers(scope.exec);
  // COD only where the data-driven allow-list says `cod_allowed AND return_free` (ADR-0006 decision 4); no courier name is hard-coded here.
  const options = quoteWithMargin(quotes, rule).map((o): ShippingOption<PricedFee> => ({ ...o, prepaid: applyShippingDiscount(o.prepaid, discount), cod: o.cod && codPolicy.has(o.courier) ? applyShippingDiscount(o.cod, discount) : null }));
  return { originAreaId: origin.areaId, destinationAreaId: destination, weightKg, shippingAccountId: account.id, shippingAccountKind: account.kind, environment: null, options };
}

/**
 * The COD allow-list reader, service-aware. The provider's estimate map names every service by one key (`JNE`, `SAPLite`) and that key is what the order
 * snapshots as its courier code. A policy row whose `service_code` equals the key is the SERVICE-level row and wins; otherwise the COURIER-level row
 * (`service_code = ''`, courier code equal to the key) decides; a key with neither is refused (fail closed). A row allows COD only when it is active
 * with `cod_allowed AND return_free`; a disabled or refusing service row therefore also overrides an allowing courier row. A service code listed
 * under two couriers allows COD only when both rows do.
 */
export type CodPolicy = { has(estimateKey: string): boolean };
export async function codAllowedCouriers(exec: Executor): Promise<CodPolicy> {
  const rows = await exec.select({ courier: courierServicePolicy.courierCode, service: courierServicePolicy.serviceCode, status: courierServicePolicy.status, cod: courierServicePolicy.codAllowed, free: courierServicePolicy.returnFree }).from(courierServicePolicy);
  const services = new Map<string, boolean>();
  const couriers = new Map<string, boolean>();
  for (const r of rows) {
    const allowed = r.status === "active" && r.cod && r.free;
    if (r.service) services.set(r.service.toLowerCase(), (services.get(r.service.toLowerCase()) ?? true) && allowed);
    else couriers.set(r.courier.toLowerCase(), allowed);
  }
  return { has: (key) => services.get(key.toLowerCase()) ?? couriers.get(key.toLowerCase()) ?? false };
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
