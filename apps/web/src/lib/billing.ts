import type { Tone } from "@/lib/status";

// Labels and tones of the subscription billing enums (UX-18, T-50). Pages never print a raw enum; a new value gets its row here first.
export type BillingState = "trial" | "active" | "past_due" | "suspended";
export const billingStateLabel: Record<BillingState, string> = { trial: "Masa percobaan", active: "Aktif", past_due: "Belum dibayar", suspended: "Ditangguhkan (tagihan)" };
export const billingStateTone: Record<BillingState, Tone> = { trial: "secondary", active: "success", past_due: "warning", suspended: "destructive" };

export type InvoiceStatus = "pending" | "paid" | "void";
export const invoiceStatusLabel: Record<InvoiceStatus, string> = { pending: "Menunggu pembayaran", paid: "Lunas", void: "Dibatalkan" };
export const invoiceStatusTone: Record<InvoiceStatus, Tone> = { pending: "warning", paid: "success", void: "outline" };

export type InvoiceKind = "subscription" | "comp";
export const invoiceKindLabel: Record<InvoiceKind, string> = { subscription: "Langganan", comp: "Comp (Rp0)" };

export type SettlementSource = "provider" | "comp" | "bookkeeping";
/** Truthful payment-source labels: a comp is a grant and a manual entry is bookkeeping, neither is a payment that earned coverage. */
export const settlementLabel: Record<SettlementSource, string> = {
  provider: "Pembayaran terverifikasi lewat Bukalaris Bayar",
  comp: "Pemberian comp dari tim Bukalaris (bukan pembayaran, tanpa pendapatan)",
  bookkeeping: "Dicatat manual oleh tim Bukalaris (pencatatan; tidak menambah masa aktif)",
};

export const voidReasonLabel = (reason: string | null): string => (reason === "lapsed" ? "Periode sudah lewat tanpa pembayaran (tidak ditagih mundur)" : reason === "comp_replaced" ? "Digantikan oleh comp" : (reason ?? "Dibatalkan"));

export const attemptStatusLabel = (a: { requestState: string; status: string }): string =>
  a.status === "paid" ? "Terverifikasi lunas"
    : a.status === "expired" ? "Instruksi kedaluwarsa"
      : a.requestState === "failed" ? "Instruksi gagal dibuat"
        : a.requestState === "unknown" ? "Sedang diperiksa ke penyedia pembayaran"
          : a.requestState === "in_progress" ? "Instruksi sedang disiapkan"
            : "Menunggu pembayaran";

export const CHANNEL_LABEL: Record<string, string> = { VABCA: "Virtual account BCA", VABNI: "Virtual account BNI", VABRI: "Virtual account BRI", VAMANDIRI: "Virtual account Mandiri", VAPERMATA: "Virtual account Permata", QRIS: "QRIS" };
export const channelName = (code: string): string => CHANNEL_LABEL[code] ?? code;

/** Basis points as the percent a reader expects: 1234 -> "12,34%". */
export const bpsPercent = (bps: number): string => `${(bps / 100).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;
