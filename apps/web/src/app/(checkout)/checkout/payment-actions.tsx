import { CsrfField } from "@/lib/auth-csrf-form";
import { SubmitButton } from "@/components/submit-button";
import type { OrderPaymentView } from "@bukalaris/db";

// T-106 (ADR-0013 decisions 21 to 25, RL-PAY-RECHECK): what a buyer may do about a prepaid order that still awaits payment, on the checkout
// confirmation and on the signed order-status page. "Check now" only schedules a status check on the store's own key (the page shows the
// last known status); a new instruction is offered only when the last one failed or expired, and the old one stays payable.

export const paymentSavedText: Record<string, string> = {
  recheck: "Status pembayaran sedang dicek ke penyedia pembayaran. Muat ulang halaman ini sebentar lagi.",
  retry: "Tagihan baru sedang dibuat. Muat ulang halaman ini sebentar lagi. Tagihan lama tetap tercatat; bila sudah terlanjur dibayar, pesanan tetap diproses.",
};

export function PaymentActions({ payment, orderStatus, recheck, retry, csrf }: {
  payment: OrderPaymentView | null;
  orderStatus: string;
  recheck: (f: FormData) => Promise<void>;
  retry: (f: FormData) => Promise<void>;
  /** Cart CSRF token of the confirmation page; the signed order-status link is its own authority. */
  csrf?: string;
}) {
  if (!payment || orderStatus !== "awaiting_payment" || payment.status === "paid") return null;
  const checkable = payment.requestState === "accepted";
  if (!checkable && !payment.retryable) return null;
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="payment-actions">
      {checkable && (
        <form action={recheck} aria-label="Cek status pembayaran">
          {csrf && <CsrfField token={csrf} />}
          <SubmitButton variant="outline" pendingText="Mengecek…">Saya sudah bayar, cek status</SubmitButton>
        </form>
      )}
      {payment.retryable && (
        <form action={retry} aria-label="Buat tagihan baru">
          {csrf && <CsrfField token={csrf} />}
          <SubmitButton pendingText="Membuat tagihan…">Buat tagihan baru</SubmitButton>
        </form>
      )}
    </div>
  );
}
