import type { ProviderQuote, ShippingAdapter } from "../providers.ts";
import { MengantarClient } from "./client.ts";
import type { CourierRate } from "./schemas.ts";

// Real ShippingAdapter over the platform-owned Mengantar account (Q-12/Q-2).
// Estimate source: the ACCOUNT estimate (`/order/estimate?courier=all` with
// COD_AMOUNT) — it is the only endpoint that shows what this account actually
// pays (account discount + COD fee). The keyless 3PL tariff has neither; see
// docs/tracks/shipping.md "Observed contract evidence".

/** Estimate-map key → buyer-facing label (docs/02 §1.1 of the Mengantar toolkit; unknown keys fall back to the key). */
export const COURIER_LABELS: Record<string, string> = {
  JNE: "JNE Express",
  JNECargo: "JNE Trucking (JTR)",
  SiCepat: "SiCepat Ekspres",
  SiCepatCargo: "SiCepat Cargo",
  SAP: "SAP Express",
  SAPLite: "SAP Lite",
  SapCargo: "SAP Cargo",
  iDexpress: "IDExpress",
  iDlite: "IDExpress Lite",
  iDexpressCargo: "IDExpress IDTruck",
  JT: "J&T Express",
  lion: "Lion Parcel",
  anteraja: "Anteraja",
  pos: "POS Indonesia",
  spx: "SPX Express",
};

/**
 * One estimate entry → provider quote. Cost basis (observed 2026-10-06):
 * `estimatedSpecialPrice` = discounted tariff + `codFee`; prepaid cost = that minus `codFee`.
 * Returns null for entries without a price or cargo services below their minimum weight.
 */
export function toProviderQuote(key: string, rate: CourierRate, weightKg: number): ProviderQuote | null {
  const codCost = rate.estimatedSpecialPrice ?? rate.estimatedPrice ?? rate.price;
  if (codCost === undefined) return null;
  const min = (rate as { minimumWeightCargo?: unknown }).minimumWeightCargo;
  if (typeof min === "number" && weightKg < min) return null;
  const toIdr = (n: number) => Math.max(0, Math.round(n));
  return {
    courier: key,
    label: COURIER_LABELS[key] ?? key,
    etd: rate.estimate_delivery ?? rate.estimatedDate,
    // `null` means "not flagged" in the observed responses; only `true` hides.
    unsupported: rate.unsupported === true || rate.unsupportedOriginSpx === true,
    unsupportedCod: rate.unsupported_cod === true,
    providerCost: toIdr(codCost - (rate.codFee ?? 0)),
    providerCostCod: toIdr(codCost),
  };
}

export function mengantarAdapter(client: MengantarClient): ShippingAdapter {
  return {
    // Legacy address-string quote (M1 fake checkout path). The real account needs area ids:
    // no option is offered rather than guessing a route. Checkout moves to estimate() in the next phase.
    async quote() {
      return [];
    },
    async searchArea(keyword) {
      const rows = await client.searchArea(keyword);
      return rows.map((a) => ({
        id: a._id,
        label: [a.SUBDISTRICT_NAME, a.DISTRICT_NAME, a.CITY_NAME, a.PROVINCE_NAME].filter(Boolean).join(", ") + (a.ZIP_CODE ? ` ${a.ZIP_CODE}` : ""),
      }));
    },
    async estimate(input) {
      const map = await client.estimateAll(input);
      return Object.entries(map)
        .map(([key, rate]) => toProviderQuote(key, rate, input.weightKg))
        .filter((q): q is ProviderQuote => q !== null);
    },
  };
}

/** Real adapter when the platform credentials are present in the process env (never in `.env` files); otherwise null. */
export function mengantarFromEnv(env: NodeJS.ProcessEnv = process.env): ShippingAdapter | null {
  if (!env.MENGANTAR_API_KEY) return null;
  return mengantarAdapter(new MengantarClient({ apiKey: env.MENGANTAR_API_KEY, baseUrl: env.MENGANTAR_BASE_URL }));
}
