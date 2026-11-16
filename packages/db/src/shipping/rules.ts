import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../client.ts";
import { DomainError, requireCap, type SellerScope, type StorefrontScope } from "../platform/scoped.ts";
import { inStore } from "../platform/tenant.ts";
import { hit } from "../platform/rate-limit.ts";
import { auditLog, courierServicePolicy } from "../schema.ts";
import { COURIER_LABELS } from "./mengantar/adapter.ts";
import { CREATE_ORDER_COURIER } from "./mengantar/booking.ts";
import type { CourierRate } from "./mengantar/schemas.ts";
import { PROVINCE_CODES, provinceCode, type ProvinceCode } from "./provinces.ts";
import { storeShippingAccount, type ProviderEnvironment } from "./schema-accounts.ts";
import { shippingArea, storeCourierRule, storeShippingSetting } from "./schema-shipping.ts";
import { courierLabel, sellerMengantar, type SellerArea } from "./seller.ts";

// T-105 (ADR-0013 section 4): the seller's own filters and the ONE eligibility function behind the buyer's method list and the check at order
// submit (`shippingOptions` → `sellerShippingOptions` → `sellerMethods`, then `chosenShippingFee` in `placeOrder`). Every row of the section 4
// table that belongs to shipping is enforced here:
//   courier enabled (a courier WITHOUT a rule row is closed) · courier COD enabled · provider: unsupported route, COD unsupported on the route ·
//   cargo services dropped · missing or zero price dropped · COD-blocked provinces, and an unresolved province refuses COD · store COD switch ·
//   the provider's COD refusal for the seller (the worker switches that courier's COD off, `fulfillment.ts`).
// C-P2: the platform per-service policy (`courier_service_policy`) is a ceiling the Owner console lowers (a row that is disabled or refuses COD);
// it never widens the seller's choice, and the free-return condition of the platform-managed model is dropped (decision 32).
// Prices (decisions 15 to 17): the buyer pays the provider's public rate (`price`), no margin, and the quote never asks for the provider's COD fee.

/** Loaded on use: `payments/provider-accounts.ts` pulls in checkout and the payment jobs; a static import would load them (and their schedules) with every shipping module. */
const providerAccounts = () => import("../payments/provider-accounts.ts");

/** Services a seller can switch on: every named estimate key except the cargo services (dropped by the platform, decision table row 5). */
export const isCargoService = (key: string) => /cargo/i.test(key) || CREATE_ORDER_COURIER[key]?.cargo === true;
export const SELLER_COURIERS = Object.keys(COURIER_LABELS).filter((k) => !isCargoService(k));

export type CourierRule = { courierCode: string; enabled: boolean; codEnabled: boolean; codRefusedAt: Date | null };
export type ShippingSettings = { codEnabled: boolean; codFeeBearer: "buyer" | "seller"; codBlockedProvinces: ProvinceCode[]; revision: number };
/** Before the seller saves anything: COD on (once shipping is ready), buyer bears the COD fee, no province blocked (OPEN-P4). */
export const SHIPPING_SETTINGS_DEFAULTS: ShippingSettings = { codEnabled: true, codFeeBearer: "buyer", codBlockedProvinces: [], revision: 0 };

export type DropReason = "no_rule" | "courier_off" | "unsupported" | "cargo" | "no_price";
export type CodRefusal = "store_cod_off" | "courier_cod_off" | "route_no_cod" | "platform_ceiling" | "province_unresolved" | "province_blocked";
export type SellerMethod = { courier: string; label: string; etd: string | undefined; fee: number; cod: boolean; codRefusal: CodRefusal | null };
export type MethodContext = {
  rules: ReadonlyMap<string, { enabled: boolean; codEnabled: boolean }>;
  settings: { codEnabled: boolean; codBlockedProvinces: readonly string[] };
  /** C-P2 ceiling: false when the platform lowered COD for this service. */
  codCeiling: (courier: string) => boolean;
  /** The destination's province code, or null when it could not be resolved. */
  province: ProvinceCode | null;
};

/** The public tariff of an estimate entry: `price`, else the undiscounted estimate without any COD fee. Null when missing. */
export function publicRate(rate: CourierRate): number | null {
  const v = rate.price ?? (rate.estimatedPrice !== undefined ? rate.estimatedPrice - (rate.codFee ?? 0) : undefined);
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * THE eligibility function (pure). Every estimate entry is either offered (with its COD verdict) or dropped with its reason; nothing is offered
 * by default. Cheapest first.
 */
export function sellerMethods(rates: Readonly<Record<string, CourierRate>>, ctx: MethodContext): { methods: SellerMethod[]; dropped: { courier: string; reason: DropReason }[] } {
  const methods: SellerMethod[] = [];
  const dropped: { courier: string; reason: DropReason }[] = [];
  for (const [courier, rate] of Object.entries(rates)) {
    const rule = ctx.rules.get(courier);
    const fee = publicRate(rate);
    const reason: DropReason | null = isCargoService(courier) ? "cargo" : !rule ? "no_rule" : !rule.enabled ? "courier_off" : rate.unsupported === true || rate.unsupportedOriginSpx === true ? "unsupported" : fee === null || fee <= 0 ? "no_price" : null;
    if (reason) {
      dropped.push({ courier, reason });
      continue;
    }
    const codRefusal: CodRefusal | null = !ctx.settings.codEnabled
      ? "store_cod_off"
      : !rule!.codEnabled
        ? "courier_cod_off"
        : rate.unsupported_cod === true
          ? "route_no_cod"
          : !ctx.codCeiling(courier)
            ? "platform_ceiling"
            : ctx.province === null
              ? "province_unresolved"
              : ctx.settings.codBlockedProvinces.includes(ctx.province)
                ? "province_blocked"
                : null;
    methods.push({ courier, label: courierLabel(courier), etd: rate.estimate_delivery ?? rate.estimatedDate, fee: fee!, cod: codRefusal === null, codRefusal });
  }
  methods.sort((a, b) => a.fee - b.fee || a.courier.localeCompare(b.courier));
  return { methods, dropped };
}

/** C-P2: the platform ceiling. A service row wins over the courier row; a disabled row or one that refuses COD lowers it; no row does not. */
export async function codCeiling(exec: Executor): Promise<(courier: string) => boolean> {
  const rows = await exec.select({ courier: courierServicePolicy.courierCode, service: courierServicePolicy.serviceCode, status: courierServicePolicy.status, cod: courierServicePolicy.codAllowed }).from(courierServicePolicy);
  const services = new Map<string, boolean>();
  const couriers = new Map<string, boolean>();
  for (const r of rows) {
    const allowed = r.status === "active" && r.cod;
    if (r.service) services.set(r.service.toLowerCase(), (services.get(r.service.toLowerCase()) ?? true) && allowed);
    else couriers.set(r.courier.toLowerCase(), allowed);
  }
  return (key) => services.get(key.toLowerCase()) ?? couriers.get(key.toLowerCase()) ?? true;
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const RULE_COLUMNS = { courierCode: storeCourierRule.courierCode, enabled: storeCourierRule.enabled, codEnabled: storeCourierRule.codEnabled, codRefusedAt: storeCourierRule.codRefusedAt };
async function readRules(exec: Executor, storeId: number): Promise<CourierRule[]> {
  return exec.select(RULE_COLUMNS).from(storeCourierRule).where(eq(storeCourierRule.storeId, storeId));
}
async function readSettings(exec: Executor, storeId: number): Promise<ShippingSettings> {
  const [row] = await exec
    .select({ codEnabled: storeShippingSetting.codEnabled, codFeeBearer: storeShippingSetting.codFeeBearer, codBlockedProvinces: storeShippingSetting.codBlockedProvinces, revision: storeShippingSetting.revision })
    .from(storeShippingSetting)
    .where(eq(storeShippingSetting.storeId, storeId));
  return row ? { ...row, codBlockedProvinces: row.codBlockedProvinces as ProvinceCode[] } : SHIPPING_SETTINGS_DEFAULTS;
}

/** The store's own Mengantar account row (non-secret columns), or null when the store never connected one (it then runs on the T-48 accounts). */
export async function sellerAccount(exec: Executor, storeId: number) {
  const [a] = await exec
    .select({ id: storeShippingAccount.id, status: storeShippingAccount.status, environment: storeShippingAccount.environment, pickupAddressId: storeShippingAccount.pickupAddressId, pickupRegisteredAt: storeShippingAccount.pickupRegisteredAt, lastResult: storeShippingAccount.lastResult, revision: storeShippingAccount.revision })
    .from(storeShippingAccount)
    .where(and(eq(storeShippingAccount.storeId, storeId), eq(storeShippingAccount.kind, "seller_owned")));
  return a ? { ...a, environment: a.environment as ProviderEnvironment } : null;
}

/** The seller's shipping-rules screen (owner and staff read; the owner changes). */
export async function sellerShippingRules(scope: SellerScope) {
  requireCap(scope, "shipping.read");
  return inStore(scope, async ({ exec }) => {
    const [rules, settings, account] = await Promise.all([readRules(exec, scope.storeId), readSettings(exec, scope.storeId), sellerAccount(exec, scope.storeId)]);
    const byCode = new Map(rules.map((r) => [r.courierCode, r]));
    return {
      ownAccount: account !== null,
      couriers: SELLER_COURIERS.map((code) => ({ courierCode: code, label: courierLabel(code), enabled: byCode.get(code)?.enabled ?? false, codEnabled: byCode.get(code)?.codEnabled ?? false, codRefusedAt: byCode.get(code)?.codRefusedAt ?? null })),
      settings,
    };
  });
}

// ── Seller changes (capability `shipping.manage`, C-P6) ──────────────────────────────────────────────────────────────────────

const courierCode = z.string().refine((c) => SELLER_COURIERS.includes(c), "Kurir tidak dikenal.");
const rulesInput = z.strictObject({
  couriers: z.array(z.strictObject({ courierCode, enabled: z.boolean(), codEnabled: z.boolean(), refusalSeen: z.boolean().default(false) })).max(SELLER_COURIERS.length),
});
/**
 * Saves the courier switches. A courier left out of the form keeps its row. A provider COD refusal is lifted only by a form that SHOWED it
 * (`refusalSeen`, review minor 4): a stale form never switches a refused courier's COD back on.
 */
export async function saveCourierRules(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "shipping.manage");
  const { couriers } = rulesInput.parse(raw);
  if (new Set(couriers.map((c) => c.courierCode)).size !== couriers.length) throw new DomainError("invalid", "Setiap kurir hanya boleh muncul sekali.");
  await inStore(scope, async ({ exec }) => {
    const current = new Map((await exec.select(RULE_COLUMNS).from(storeCourierRule).where(eq(storeCourierRule.storeId, scope.storeId)).for("update")).map((r) => [r.courierCode, r]));
    for (const c of couriers) {
      const refusedAt = current.get(c.courierCode)?.codRefusedAt ?? null;
      const keepRefusal = refusedAt !== null && !c.refusalSeen;
      const codEnabled = keepRefusal ? false : c.codEnabled;
      const values = { enabled: c.enabled, codEnabled, codRefusedAt: keepRefusal || !codEnabled ? refusedAt : null, updatedBy: scope.userId, updatedAt: new Date() };
      await exec.insert(storeCourierRule).values({ storeId: scope.storeId, courierCode: c.courierCode, ...values }).onConflictDoUpdate({ target: [storeCourierRule.storeId, storeCourierRule.courierCode], set: values });
    }
    const summary = couriers.filter((c) => c.enabled).map((c) => `${c.courierCode}${c.codEnabled ? "+cod" : ""}`).join(",") || "none";
    await exec.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: "shipping.manage", action: "shipping.courier_rules.update", subjectKind: "store", subjectId: String(scope.storeId), accessLevel: "write", outcome: "allowed", reason: `enabled=${summary}`.slice(0, 500) });
  });
}

const settingsInput = z.strictObject({
  codEnabled: z.boolean(),
  codFeeBearer: z.enum(["buyer", "seller"], { error: "Pilih siapa yang menanggung biaya COD." }),
  codBlockedProvinces: z.array(z.enum(PROVINCE_CODES as [ProvinceCode, ...ProvinceCode[]], { error: "Provinsi tidak dikenal." })).max(PROVINCE_CODES.length),
  revision: z.coerce.number().int().nonnegative(),
});
/** COD on/off, the COD fee bearer and the COD-blocked provinces of the store; the revision read with the form must still be current. */
export async function saveShippingSettings(scope: SellerScope, raw: unknown): Promise<ShippingSettings> {
  requireCap(scope, "shipping.manage");
  const input = settingsInput.parse(raw);
  const provinces = [...new Set(input.codBlockedProvinces)].sort();
  return inStore(scope, async ({ exec }) => {
    const values = { codEnabled: input.codEnabled, codFeeBearer: input.codFeeBearer, codBlockedProvinces: provinces, updatedBy: scope.userId, updatedAt: new Date() };
    const saved = input.revision === 0
      ? await exec.insert(storeShippingSetting).values({ storeId: scope.storeId, ...values, revision: 1 }).onConflictDoNothing().returning({ revision: storeShippingSetting.revision })
      : await exec.update(storeShippingSetting).set({ ...values, revision: input.revision + 1 }).where(and(eq(storeShippingSetting.storeId, scope.storeId), eq(storeShippingSetting.revision, input.revision))).returning({ revision: storeShippingSetting.revision });
    if (saved.length === 0) throw new DomainError("conflict", "Pengaturan baru saja diubah di sesi lain. Muat ulang halaman lalu simpan lagi.");
    await exec.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: "shipping.manage", action: "shipping.settings.update", subjectKind: "store", subjectId: String(scope.storeId), accessLevel: "write", outcome: "allowed", reason: `cod=${input.codEnabled}; bearer=${input.codFeeBearer}; blocked=${provinces.join(",") || "none"}`.slice(0, 500) });
    return { codEnabled: input.codEnabled, codFeeBearer: input.codFeeBearer, codBlockedProvinces: provinces, revision: saved[0]!.revision };
  });
}

// ── Provider areas and their province ─────────────────────────────────────────────────────────────────────────────────────

/** Records the province name each searched area carries (provider answers only), per environment: sandbox never overwrites production (review minor 5). */
export async function rememberAreas(exec: Executor, areas: readonly SellerArea[], environment: ProviderEnvironment): Promise<void> {
  for (const a of areas) {
    if (!/^[a-f0-9]{24}$/.test(a.id)) continue;
    const provinceName = a.province?.slice(0, 80) ?? null;
    await exec.insert(shippingArea).values({ areaId: a.id, environment, provinceName }).onConflictDoUpdate({ target: [shippingArea.areaId, shippingArea.environment], set: { provinceName, updatedAt: new Date() } });
  }
}
/** The destination's province code in this environment; null when the area was never seen in a provider answer there or its province name is unknown. */
export async function areaProvince(exec: Executor, areaId: string, environment: ProviderEnvironment): Promise<ProvinceCode | null> {
  const [row] = await exec.select({ name: shippingArea.provinceName }).from(shippingArea).where(and(eq(shippingArea.areaId, areaId), eq(shippingArea.environment, environment)));
  return provinceCode(row?.name);
}

/**
 * Provider calls on a seller's own key, counted before the call (a refusal makes no provider call). Buyer-driven calls (review minor 6): the
 * per-client-IP limit is the primary limit; the per-store bucket is only a cost ceiling, sized well above normal traffic, because a few IPs
 * filling it block every buyer of that store (the lockout trade-off recorded in doc 16, RL-SELLER-AREA / RL-SELLER-QUOTE). The seller's own
 * pickup-area search (an authenticated owner action) has its own bucket and never shares the buyer one (confirmation review 2).
 */
export const SELLER_PROVIDER_LIMITS = {
  area: { store: { limit: 3000, windowSec: 600 }, ip: { limit: 60, windowSec: 600 } },
  quote: { store: { limit: 6000, windowSec: 600 }, ip: { limit: 120, windowSec: 600 } },
  pickup: { store: { limit: 120, windowSec: 600 }, ip: { limit: 120, windowSec: 600 } },
} as const;
export async function limitSellerProviderUse(exec: Executor, kind: keyof typeof SELLER_PROVIDER_LIMITS, storeId: number, clientIp?: string): Promise<void> {
  const rules = SELLER_PROVIDER_LIMITS[kind];
  const hits = [{ key: `seller-${kind}:store:${storeId}`, rule: rules.store }, ...(clientIp && kind !== "pickup" ? [{ key: `seller-${kind}:ip:${clientIp}`, rule: rules.ip }] : [])];
  const results = await Promise.all(hits.map((h) => hit(exec, h.key, h.rule)));
  const over = results.filter((r, i) => r.count > hits[i]!.rule.limit);
  if (over.length) throw new DomainError("rate_limited", `Terlalu banyak percobaan. Coba lagi dalam ${Math.max(...over.map((r) => r.retryAfterSec))} detik.`);
}

/** Area search on the store's own key (destination at checkout, pickup area in Seller Admin); the provinces are remembered for the COD filter. */
export async function searchSellerAreas(scope: Pick<SellerScope | StorefrontScope, "exec" | "storeId">, keyword: string, environment: ProviderEnvironment, clientIp?: string, bucket: "area" | "pickup" = "area"): Promise<SellerArea[]> {
  await limitSellerProviderUse(scope.exec, bucket, scope.storeId, clientIp);
  const client = await sellerMengantar(scope.exec, await (await providerAccounts()).openProviderKey(scope, "mengantar"), environment);
  const areas = await client.searchArea(keyword);
  await rememberAreas(scope.exec, areas, environment);
  return areas;
}

// ── The buyer's method list (and the same at submit) ──────────────────────────────────────────────────────────────────────

export type SellerOption = { courier: string; label: string; etd?: string | undefined; fee: number; cod: boolean };
/**
 * The method list of a `seller_owned` store. A store whose shipping is not ready shows no method (decision 13: never shown and then failed).
 * The provider call runs outside any transaction; the store's filters are read in its store context.
 */
export async function sellerShippingOptions(scope: StorefrontScope, account: { environment: ProviderEnvironment }, route: { originAreaId: string; destinationAreaId: string; weightKg: number }, clientIp?: string): Promise<SellerOption[]> {
  const { openProviderKey, shippingReadiness } = await providerAccounts();
  const readiness = await shippingReadiness(scope);
  if (!readiness.ready) throw new DomainError("shipping_not_ready", "Toko ini belum siap mengirim pesanan. Hubungi penjual.");
  await limitSellerProviderUse(scope.exec, "quote", scope.storeId, clientIp);
  const client = await sellerMengantar(scope.exec, await openProviderKey(scope, "mengantar"), account.environment);
  const rates = await client.estimate(route);
  const ctx = await inStore(scope, async ({ exec }) => {
    const [rules, settings, ceiling, province] = await Promise.all([readRules(exec, scope.storeId), readSettings(exec, scope.storeId), codCeiling(exec), areaProvince(exec, route.destinationAreaId, account.environment)]);
    return { rules: new Map(rules.map((r) => [r.courierCode, r])), settings, codCeiling: ceiling, province } satisfies MethodContext;
  });
  return sellerMethods(rates, ctx).methods.map((m) => ({ courier: m.courier, label: m.label, etd: m.etd, fee: m.fee, cod: m.cod }));
}

// ── The check at submit ──────────────────────────────────────────────────────────────────────────────────────────────────

type Fee = { buyerFee: number };
type QuotedOption<F extends Fee> = { courier: string; label: string; prepaid: F; cod: F | null };
/** What the buyer saw, sent back with the order form: `courier:prepaid:cod` per option (`-` when COD was not offered). */
export const formatShippingQuote = (options: readonly QuotedOption<Fee>[]) => options.map((o) => `${o.courier}:${o.prepaid.buyerFee}:${o.cod ? o.cod.buyerFee : "-"}`).join(",");
export const SHIPPING_QUOTE_RE = /^[A-Za-z0-9_-]{1,40}:\d{1,9}:(?:\d{1,9}|-)(?:,[A-Za-z0-9_-]{1,40}:\d{1,9}:(?:\d{1,9}|-)){0,39}$/;
function parseShippingQuote(s: string): Map<string, { prepaid: number; cod: number | null }> {
  return new Map(s.split(",").map((part) => {
    const [courier, prepaid, cod] = part.split(":");
    return [courier!, { prepaid: Number(prepaid), cod: cod === "-" ? null : Number(cod) }];
  }));
}

/**
 * The submit-time check (decisions 16 and section 4): the courier must be in the re-quoted method list, COD must be allowed for it on this
 * route, and — when the form carried the quote the buyer saw — the fee must not have changed. Never priced from the request.
 */
export function chosenShippingFee<F extends Fee>(options: readonly QuotedOption<F>[], courier: string, paymentMethod: "cod" | "manual_transfer", seenQuote?: string, requireSeen = false): F {
  const option = options.find((o) => o.courier === courier);
  if (!option) throw new DomainError("courier", "Pilihan kurir tidak tersedia untuk area tujuan ini. Pilih kurir lain dari daftar terbaru.");
  const fee = paymentMethod === "cod" ? option.cod : option.prepaid;
  if (!fee) throw new DomainError("courier_cod", `${option.label} tidak melayani COD ke area tujuan ini. Pilih kurir lain atau bayar transfer.`);
  // Review minor 2: a store on its own account always compares (the buyer's public rate can change at the provider at any time).
  if (requireSeen && !seenQuote) throw new DomainError("quote_changed", "Muat ulang halaman checkout: daftar kurir yang Anda lihat tidak ikut terkirim.");
  if (seenQuote) {
    const seen = parseShippingQuote(seenQuote).get(courier);
    const seenFee = seen ? (paymentMethod === "cod" ? seen.cod : seen.prepaid) : undefined;
    if (seenFee !== fee.buyerFee) throw new DomainError("quote_changed", `Ongkir ${option.label} berubah menjadi Rp ${fee.buyerFee.toLocaleString("id-ID")}. Periksa daftar kurir terbaru lalu buat pesanan lagi.`);
  }
  return fee;
}
