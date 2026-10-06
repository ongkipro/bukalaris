// Provider boundaries (PR-5). The fake implementations make no network calls
// and need no credentials. The real Mengantar adapter lives in ./mengantar/
// (server-only); AutoLaris stays fake until its gate (T-6) passes.

export type ShippingQuote = { courier: string; label: string; fee: number };

/** A provider area (kelurahan/kecamatan level); `id` is the provider's area id used for origin/destination. */
export type Area = { id: string; label: string };

export type EstimateInput = {
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
  /** M1 address-string quote used by the current hosted checkout. `items` = number of distinct cart lines. */
  quote(input: { storeId: number; address: string; items: number }): Promise<ShippingQuote[]>;
  searchArea(keyword: string): Promise<Area[]>;
  estimate(input: EstimateInput): Promise<ProviderQuote[]>;
}

export type PaymentInstruction = { reference: string; instructions: string };

/** AutoLaris H2H: payment instruction creation, called only server-side after commit. */
export interface PaymentAdapter {
  createInstruction(input: { storeId: number; orderId: number; amount: number }): Promise<PaymentInstruction>;
}

/** Fake areas: 24-hex ids like the provider's, so validation is identical in tests and e2e. */
export const FAKE_AREAS: Area[] = [
  { id: "a1a1a1a1a1a1a1a1a1a1a1a1", label: "Braga, Sumur Bandung, Bandung, Jawa Barat 40111" },
  { id: "a2a2a2a2a2a2a2a2a2a2a2a2", label: "Cihapit, Bandung Wetan, Bandung, Jawa Barat 40114" },
  { id: "b1b1b1b1b1b1b1b1b1b1b1b1", label: "Menteng, Menteng, Jakarta Pusat, DKI Jakarta 10310" },
  { id: "c1c1c1c1c1c1c1c1c1c1c1c1", label: "Gubeng, Gubeng, Surabaya, Jawa Timur 60281" },
];

export const fakeMengantar: ShippingAdapter = {
  async quote({ items }) {
    const extra = Math.max(0, items - 1) * 2_000;
    return [
      { courier: "fake-reg", label: "Reguler (simulasi Mengantar)", fee: 15_000 + extra },
      { courier: "fake-express", label: "Ekspres (simulasi Mengantar)", fee: 28_000 + extra },
    ];
  },
  async searchArea(keyword) {
    const k = keyword.trim().toLowerCase();
    return k.length < 3 ? [] : FAKE_AREAS.filter((a) => a.label.toLowerCase().includes(k));
  },
  /** Deterministic shape with every gating case: supported, COD-refused and unsupported. */
  async estimate({ weightKg }) {
    const w = Math.max(0, weightKg - 1) * 5_000;
    return [
      { courier: "JNE", label: "JNE Express (simulasi)", etd: "1 - 2 days", unsupported: false, unsupportedCod: false, providerCost: 10_500 + w, providerCostCod: 15_494 + w },
      { courier: "SiCepat", label: "SiCepat Ekspres (simulasi)", etd: "2 - 3 days", unsupported: false, unsupportedCod: true, providerCost: 8_000 + w, providerCostCod: 12_994 + w },
      { courier: "pos", label: "POS Indonesia (simulasi)", etd: "4 days", unsupported: true, unsupportedCod: false, providerCost: 16_150 + w, providerCostCod: 21_144 + w },
    ];
  },
};

export const fakeAutoLaris: PaymentAdapter = {
  async createInstruction({ orderId, amount }) {
    return {
      reference: `FAKE-AL-${orderId}`,
      instructions: `Simulasi: transfer Rp${amount.toLocaleString("id-ID")} dengan kode FAKE-AL-${orderId}. Bukan rekening sungguhan.`,
    };
  },
};

export type Providers = { shipping: ShippingAdapter; payment: PaymentAdapter };
export const fakeProviders: Providers = { shipping: fakeMengantar, payment: fakeAutoLaris };
