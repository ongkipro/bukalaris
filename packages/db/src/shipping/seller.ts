import { and, eq, sql } from "drizzle-orm";
import type { Db, Executor } from "../client.ts";
import type { ProviderCheckResult, ProviderCheckTransport } from "../payments/provider-accounts.ts";
import { FAKE_AREAS, FAKE_NO_COD_AREA, type Area } from "../payments/providers.ts";
import { DomainError } from "../platform/scoped.ts";
import { unsealCredential } from "./credentials.ts";
import { COURIER_LABELS } from "./mengantar/adapter.ts";
import { mengantarBooking, type BookingAdapter } from "./mengantar/booking.ts";
import { MengantarClient, MengantarError, redactUrl } from "./mengantar/client.ts";
import type { CourierRate } from "./mengantar/schemas.ts";
import { provinceOfLabel } from "./provinces.ts";
import { storeShippingAccount, type ProviderEnvironment } from "./schema-accounts.ts";
import { providerLiveSetting } from "./schema-shipping.ts";

// T-105 (ADR-0013 sections 2, 7 and 9): the ONE client for calls made with a store's own Mengantar key: quotes, area search, pickup
// registration, booking and tracking. The key is opened by the caller (the request through `openProviderKey`, the worker through
// `openSellerKeyAsWorker`) and travels only inside this object; every error that leaves a method is rebuilt with the raw, URL-encoded and
// JSON-escaped key removed (decision 9).
//
// Transport choice (decisions 10, 33, 34), the same for every operation:
// - no origin configured for the account's environment: the deterministic fake, and only where T-104's `fakeCheckAllowed` allows it
//   (outside production, or the loopback e2e build); otherwise refused, nothing is called;
// - an origin configured: the live client on that origin. A PRODUCTION account additionally needs the Owner console switch of
//   `provider_live_setting` (off by default, only after a recorded sandbox pass). The origin is never built from stored or submitted text.

export type SellerTransport = { mode: "fake" } | { mode: "live"; origin: string };
/** Loaded on use: `payments/provider-accounts.ts` pulls in checkout and the payment jobs; a static import would load them (and their schedules) with every shipping module. */
const providerAccounts = () => import("../payments/provider-accounts.ts");

/** ADR-0013 decision 34: production calls on sellers' keys are on only when the Owner console switched them on (a missing row is off). */
export async function productionCallsEnabled(exec: Executor, provider: "mengantar" | "autolaris"): Promise<boolean> {
  const [row] = await exec.select({ on: providerLiveSetting.productionEnabled }).from(providerLiveSetting).where(eq(providerLiveSetting.provider, provider));
  return row?.on === true;
}

export async function sellerTransport(exec: Executor, environment: ProviderEnvironment, env: NodeJS.ProcessEnv = process.env): Promise<SellerTransport> {
  const { fakeCheckAllowed, providerOrigin } = await providerAccounts();
  const origin = providerOrigin("mengantar", environment, env);
  if (origin === null) {
    if (fakeCheckAllowed(null, env)) return { mode: "fake" };
    throw new DomainError("provider_unavailable", "Layanan kurir belum tersedia di server ini. Tidak ada yang dikirim ke penyedia.");
  }
  if (environment === "production" && !(await productionCallsEnabled(exec, "mengantar"))) {
    throw new DomainError("provider_off", "Pengiriman lewat akun produksi belum dibuka oleh Bukalaris. Tidak ada yang dikirim ke penyedia.");
  }
  return { mode: "live", origin };
}

let fetchOverride: typeof fetch | null = null;
/** Test seam: the live client's fetch. Tests stub it, so a live-path test never reaches a network. */
export function setSellerMengantarFetch(f: typeof fetch | null): void {
  fetchOverride = f;
}

/** Rebuild an error without any form of the key. Our own domain refusals never carry it and pass unchanged. */
export function scrubKey(err: unknown, key: string): unknown {
  if (err instanceof DomainError) return err;
  const r = (s: string) => redactUrl(s, key);
  if (err instanceof MengantarError) {
    let body: unknown;
    try { body = err.body === undefined ? undefined : JSON.parse(r(JSON.stringify(err.body))); } catch { body = undefined; }
    return new MengantarError(err.code, r(err.message), err.status, body, err.providerCode === undefined ? undefined : r(err.providerCode));
  }
  const e = new Error(r(err instanceof Error ? err.message : String(err)));
  e.name = err instanceof Error ? err.name : "Error";
  return e;
}

export type SellerArea = Area & { province: string | null };
export type PickupRegistration = { areaId: string; addressText: string; storeName: string; contactName: string; contactPhone: string; existingId: string | null };

/** The fake account behind every seller key locally and in CI: deterministic, no network. `failRegistration` lets a test refuse once. */
export const fakeSellerMengantar = { failRegistration: false, registrations: 0 };

/**
 * Deterministic account estimate (`courier=all`, no COD amount) with one entry per gating case: a COD-capable service, one the route refuses
 * COD on, a cargo service, a zero price, an unsupported route and a second COD-capable service. `price` is the public tariff, the discounted
 * `estimatedSpecialPrice` is the seller's saving (decision 15).
 */
function fakeRates(destinationAreaId: string, weightKg: number): Record<string, CourierRate> {
  if (!FAKE_AREAS.some((a) => a.id === destinationAreaId)) return {};
  const noCod = destinationAreaId === FAKE_NO_COD_AREA;
  const w = Math.max(0, weightKg - 1) * 5_000;
  const rate = (price: number, extra: Partial<CourierRate> = {}): CourierRate => ({ price, discount: Math.round(price * 0.1), codFee: 0, estimatedPrice: price, estimatedSpecialPrice: price - Math.round(price * 0.1), unsupported: false, unsupported_cod: noCod, ...extra });
  return {
    JNE: rate(12_000 + w, { estimate_delivery: "1 - 2 days" }),
    SiCepat: rate(9_000 + w, { estimate_delivery: "2 - 3 days", unsupported_cod: true }),
    anteraja: rate(11_000 + w, { estimate_delivery: "2 - 4 days" }),
    JNECargo: rate(40_000 + w, { estimate_delivery: "3 - 5 days" }),
    lion: rate(0),
    pos: rate(16_000 + w, { unsupported: true }),
  };
}

/** The one client for a store's own Mengantar key. */
export class SellerMengantar {
  readonly #key: string;
  readonly transport: SellerTransport;
  constructor(key: string, transport: SellerTransport) {
    this.#key = key;
    this.transport = transport;
  }
  get mode() {
    return this.transport.mode;
  }

  #client(): MengantarClient {
    if (this.transport.mode !== "live") throw new Error("seller client: no live transport");
    return new MengantarClient({ apiKey: this.#key, baseUrl: this.transport.origin, fetchImpl: fetchOverride ?? undefined, writeEnabled: true, partnerGate: false });
  }
  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw scrubKey(err, this.#key);
    }
  }

  /** Account estimate for every courier. Never sends a COD amount: the provider's COD fee is never part of a checkout quote (decision 17). */
  estimate(p: { originAreaId: string; destinationAreaId: string; weightKg: number }): Promise<Record<string, CourierRate>> {
    return this.#guard(async () => (this.transport.mode === "fake" ? fakeRates(p.destinationAreaId, p.weightKg) : this.#client().estimateAll({ ...p })));
  }

  /**
   * A keyed read that needs no pickup area (review M2): the account's own pickup-address list (`GET /address`). It lets a new seller check and
   * save the key first and then search the pickup area on that key. Whether an invalid key answers 401 here is UNVERIFIED (read in sandbox).
   */
  verifyKey(): Promise<void> {
    return this.#guard(async () => {
      if (this.transport.mode === "live") await this.#client().listOrigins();
    });
  }

  /** Area search with the provider's province name (the COD-province filter resolves it later from `shipping_area`). */
  searchArea(keyword: string): Promise<SellerArea[]> {
    return this.#guard(async () => {
      if (this.transport.mode === "fake") {
        const k = keyword.trim().toLowerCase();
        return k.length < 3 ? [] : FAKE_AREAS.filter((a) => a.label.toLowerCase().includes(k)).map((a) => ({ ...a, province: provinceOfLabel(a.label) }));
      }
      return (await this.#client().searchArea(keyword)).map((a) => ({
        id: a._id,
        label: [a.SUBDISTRICT_NAME, a.DISTRICT_NAME, a.CITY_NAME, a.PROVINCE_NAME].filter(Boolean).join(", ") + (a.ZIP_CODE ? ` ${a.ZIP_CODE}` : ""),
        province: a.PROVINCE_NAME ?? null,
      }));
    });
  }

  /** `POST /address` (decision 12): adds, or updates in place (`_id`), the store's pickup address on this account; returns its id. */
  registerPickup(p: PickupRegistration): Promise<string> {
    return this.#guard(async () => {
      if (this.transport.mode === "fake") {
        fakeSellerMengantar.registrations++;
        if (fakeSellerMengantar.failRegistration) {
          fakeSellerMengantar.failRegistration = false;
          throw new MengantarError("http", "HTTP 400", 400);
        }
        return p.existingId ?? `fakepickup${p.areaId.slice(0, 12)}`;
      }
      const body = await this.#client().upsertOrigin({
        PICKUP_AUTOFILL: p.areaId,
        PICKUP_ADDRESS: p.addressText,
        PICKUP_NAME: p.storeName,
        PICKUP_PIC: p.contactName,
        PICKUP_PIC_PHONE: p.contactPhone,
        ...(p.existingId ? { _id: p.existingId } : {}),
      });
      // UNVERIFIED (T-105): the documentation shows the request only; the id is read from `data._id` (or `_id`) of the answer.
      const data = (body && typeof body === "object" && "_id" in body ? body : (body as { data?: unknown } | null)?.data) as { _id?: unknown } | undefined;
      const id = typeof data?._id === "string" ? data._id : p.existingId;
      if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new MengantarError("invalid_shape", "pickup address answer has no usable id", 200);
      return id;
    });
  }

  /** Booking and tracking on this key (decision 28). `fake` is the local adapter used when no origin is configured. */
  booking(pickupAddressId: string, fake: BookingAdapter): BookingAdapter {
    const inner = this.transport.mode === "fake" ? fake : mengantarBooking(this.#client(), { pickupAddressId });
    return {
      createOrder: (input) => this.#guard(() => inner.createOrder(input)),
      payUnpaid: (batchId, courier) => this.#guard(() => inner.payUnpaid(batchId, courier)),
      track: (ref) => this.#guard(() => inner.track(ref)),
    };
  }
}

/** The client for a key the caller already opened (the request: `openProviderKey`; the worker: `openSellerKeyAsWorker`). */
export async function sellerMengantar(exec: Executor, key: string, environment: ProviderEnvironment): Promise<SellerMengantar> {
  return new SellerMengantar(key, await sellerTransport(exec, environment));
}

export type SellerAccountRow = { id: number; storeId: number; environment: ProviderEnvironment; pickupAddressId: string | null };
/**
 * The worker side (platform pool, like the T-48 re-seal job): reads this store's `seller_owned` envelope and opens it; the additional data binds
 * store, row and kind, so another store's envelope never opens here.
 */
export async function openSellerKeyAsWorker(db: Db, storeId: number, accountId: number): Promise<{ key: string; account: SellerAccountRow }> {
  const [a] = await db
    .select({ id: storeShippingAccount.id, storeId: storeShippingAccount.storeId, environment: storeShippingAccount.environment, sealedKey: storeShippingAccount.sealedKey, keyId: storeShippingAccount.keyId, pickupAddressId: storeShippingAccount.pickupAddressId })
    .from(storeShippingAccount)
    .where(and(eq(storeShippingAccount.storeId, storeId), eq(storeShippingAccount.id, accountId), eq(storeShippingAccount.kind, "seller_owned"), sql`${storeShippingAccount.status} = 'active'`));
  if (!a?.sealedKey || !a.keyId || !a.environment) throw new DomainError("awaiting_account", "Kunci akun kurir toko ini belum terhubung. Pesanan tidak dialihkan ke akun lain.");
  return { key: unsealCredential("shipping_credentials", a.sealedKey, a.keyId, storeId, a.id, "seller_owned"), account: { id: a.id, storeId: a.storeId, environment: a.environment, pickupAddressId: a.pickupAddressId } };
}

/** The connection check of T-104 (decision 8) on a configured origin: a real rate estimate from the pickup area through this same client. */
export const mengantarLiveCheck: ProviderCheckTransport = {
  mode: "live",
  async check(input): Promise<ProviderCheckResult> {
    if (!input.exec || input.origin === null) return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    let client: SellerMengantar;
    try {
      client = await sellerMengantar(input.exec, input.apiKey, input.environment);
    } catch {
      return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    }
    try {
      // Decision 8: a real rate estimate from the pickup area once one is set; before that (a new seller) the keyed pickup-address list.
      if (!input.pickupAreaId) {
        await client.verifyKey();
        return { ok: true };
      }
      const rates = await client.estimate({ originAreaId: input.pickupAreaId, destinationAreaId: input.pickupAreaId, weightKg: 1 });
      return Object.keys(rates).length > 0 ? { ok: true } : { ok: false, code: "INVALID_RESPONSE" };
    } catch (err) {
      return { ok: false, code: err instanceof MengantarError && (err.status === 401 || err.status === 403) ? "AUTH_FAILED" : "PROVIDER_UNAVAILABLE" };
    }
  },
};

/** Courier label for a buyer: the documented service name, or the key itself for a service this product does not name. */
export const courierLabel = (key: string) => COURIER_LABELS[key] ?? key;
