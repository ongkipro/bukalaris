// Provider boundaries (PR-5). M1 ships fake implementations only: no network
// calls, no credentials. Real Mengantar / AutoLaris adapters implement the same
// interfaces after the provider gates (T-5, T-6) pass.

export type ShippingQuote = { courier: string; label: string; fee: number };

/** Mengantar: delivery eligibility and fee estimate, called only server-side. */
export interface ShippingAdapter {
  /** `items` = number of distinct cart lines. */
  quote(input: { storeId: number; address: string; items: number }): Promise<ShippingQuote[]>;
}

export type PaymentInstruction = { reference: string; instructions: string };

/** AutoLaris H2H: payment instruction creation, called only server-side after commit. */
export interface PaymentAdapter {
  createInstruction(input: { storeId: number; orderId: number; amount: number }): Promise<PaymentInstruction>;
}

export const fakeMengantar: ShippingAdapter = {
  async quote({ items }) {
    const extra = Math.max(0, items - 1) * 2_000;
    return [
      { courier: "fake-reg", label: "Reguler (simulasi Mengantar)", fee: 15_000 + extra },
      { courier: "fake-express", label: "Ekspres (simulasi Mengantar)", fee: 28_000 + extra },
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
