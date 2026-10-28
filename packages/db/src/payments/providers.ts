// Provider boundaries (PR-5). The fake implementations make no network calls
// and need no credentials. The real Mengantar adapter lives in ./mengantar/
// (server-only); AutoLaris stays fake until its gate (T-6) passes.

import type { AdviceInput, PaymentChannel, PaymentCreateInput, PaymentInstruction } from "./contract.ts";
import { fakeAutoLaris } from "./fake.ts";
export { fakeAutoLaris } from "./fake.ts";
export type { PaymentInstruction, PaymentCreateInput, PaymentChannel } from "./contract.ts";

/** A provider area (kelurahan/kecamatan level); `id` is the provider's area id used for origin/destination. */
export type Area = { id: string; label: string };

export type EstimateInput = {
  shippingAccountId?: number;
  shippingAccountKind?: "partner_managed" | "platform_master";
  originAreaId: string;
  destinationAreaId: string;
  /** Whole kilograms, >= 1. */
  weightKg: number;
  /** COD value the provider prices its COD fee on (goods + shipping; we pass the cart subtotal). */
  codAmount: number;
};

/** One courier service as the provider prices it for the platform account; integer IDR, before margin. */
export type ProviderQuote = {
  /** Provider estimate key (e.g. "JNE", "SAPLite"); snapshotted on the order as the courier code. */
  courier: string;
  label: string;
  etd?: string | undefined;
  /** Courier does not serve the route: never offered. */
  unsupported: boolean;
  /** Courier serves the route but refuses COD: offered for prepaid only. */
  unsupportedCod: boolean;
  /** Platform cost for a prepaid shipment. */
  providerCost: number;
  /** Platform cost for a COD shipment (includes the provider's COD fee). */
  providerCostCod: number;
};

/** Mengantar: area search, delivery eligibility and fee estimate, called only server-side. */
export interface ShippingAdapter {
  searchArea(keyword: string): Promise<Area[]>;
  estimate(input: EstimateInput): Promise<ProviderQuote[]>;
}

/** AutoLaris H2H server boundary. There is intentionally no live transport in this build. */
export interface PaymentAdapter {
  readonly mode: "fake" | "live";
  listChannels(): Promise<PaymentChannel[]>;
  submit(input: PaymentCreateInput): Promise<PaymentInstruction>;
  advice(input: AdviceInput): Promise<unknown>;
  /** Only fake adapters may recover a lost create response by local reference. No such live endpoint is assumed. */
  recoverCreate?(input: PaymentCreateInput): Promise<PaymentInstruction | null>;
}

/** Fake areas: 24-hex ids like the provider's, so validation is identical in tests and e2e. */
export const FAKE_AREAS: Area[] = [
  { id: "a1a1a1a1a1a1a1a1a1a1a1a1", label: "Braga, Sumur Bandung, Bandung, Jawa Barat 40111" },
  { id: "a2a2a2a2a2a2a2a2a2a2a2a2", label: "Cihapit, Bandung Wetan, Bandung, Jawa Barat 40114" },
  { id: "b1b1b1b1b1b1b1b1b1b1b1b1", label: "Menteng, Menteng, Jakarta Pusat, DKI Jakarta 10310" },
  { id: "c1c1c1c1c1c1c1c1c1c1c1c1", label: "Gubeng, Gubeng, Surabaya, Jawa Timur 60281" },
  /** No courier offers COD here (every supported courier flags `unsupported_cod`). */
  { id: "d1d1d1d1d1d1d1d1d1d1d1d1", label: "Wamena, Wamena, Jayawijaya, Papua Pegunungan 99511" },
];
/** Fake destination where COD is refused by every courier. */
export const FAKE_NO_COD_AREA = FAKE_AREAS[4]!.id;

export const fakeMengantar: ShippingAdapter = {
  async searchArea(keyword) {
    const k = keyword.trim().toLowerCase();
    return k.length < 3 ? [] : FAKE_AREAS.filter((a) => a.label.toLowerCase().includes(k));
  },
  /**
   * Deterministic shape with every gating case: supported, COD-refused and unsupported.
   * Unknown destinations get no quotes (the provider serves no route there); the
   * `FAKE_NO_COD_AREA` destination refuses COD on every courier.
   */
  async estimate({ destinationAreaId, weightKg }) {
    if (!FAKE_AREAS.some((a) => a.id === destinationAreaId)) return [];
    const noCod = destinationAreaId === FAKE_NO_COD_AREA;
    const w = Math.max(0, weightKg - 1) * 5_000;
    return [
      { courier: "JNE", label: "JNE Express (simulasi)", etd: "1 - 2 days", unsupported: false, unsupportedCod: noCod, providerCost: 10_500 + w, providerCostCod: 15_494 + w },
      { courier: "SiCepat", label: "SiCepat Ekspres (simulasi)", etd: "2 - 3 days", unsupported: false, unsupportedCod: true, providerCost: 8_000 + w, providerCostCod: 12_994 + w },
      { courier: "pos", label: "POS Indonesia (simulasi)", etd: "4 days", unsupported: true, unsupportedCod: false, providerCost: 16_150 + w, providerCostCod: 21_144 + w },
    ];
  },
};


export type Providers = { shipping: ShippingAdapter; payment: PaymentAdapter };
export const fakeProviders: Providers = { shipping: fakeMengantar, payment: fakeAutoLaris };
