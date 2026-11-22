import { rupiah } from "@/lib/format";
import { COLLECTED_METHOD_LABEL, type Collected } from "@bukalaris/db";
import { angka } from "./kpi";

/**
 * T-107 (ADR-0013 section 8): money a store on its own accounts received, by method, from order and payment state. It went straight into the
 * seller's AutoLaris and Mengantar accounts; Bukalaris shows a record, never a balance it holds. Recorded refunds sit beside it, not netted.
 */
export function CollectedByMethod({ c, title, testId }: { c: Collected; title: string; testId: string }) {
  return (
    <section aria-label={title} className="grid content-start gap-2 rounded-lg border p-4 text-sm" data-testid={testId}>
      <h3 className="font-medium">{title}</h3>
      {c.orders === 0 ? (
        <p className="text-muted-foreground">Belum ada pesanan yang dibayar atau diterima pada periode ini.</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 tabular-nums">
          {c.byMethod.map((m) => (
            <div key={m.method} className="contents" data-testid={`${testId}-${m.method}`}>
              <dt className="min-w-0">
                {COLLECTED_METHOD_LABEL[m.method]} <span className="text-muted-foreground">· {angka(m.orders)} pesanan</span>
              </dt>
              <dd className="text-right">{rupiah(m.amountIdr)}</dd>
            </div>
          ))}
          <dt className="font-semibold">Total dibayar pembeli</dt>
          <dd className="text-right font-semibold" data-testid={`${testId}-total`}>{rupiah(c.totalIdr)}</dd>
          {c.refunds > 0 && (
            <>
              <dt>Refund yang Anda catat · {angka(c.refunds)}</dt>
              <dd className="text-right" data-testid={`${testId}-refunded`}>−{rupiah(c.refundedIdr)}</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

export const COLLECTED_NOTE =
  "Dibayar langsung ke akun AutoLaris (QRIS dan virtual account) dan akun Mengantar (COD) milik toko Anda, dihitung dari pesanan yang dibayar atau paketnya diterima. Bukalaris tidak memegang uang ini; biaya penyedia dan pencairan COD ada di akun Mengantar dan AutoLaris Anda. Pesanan uji tidak dihitung.";
