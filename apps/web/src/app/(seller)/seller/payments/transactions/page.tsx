import { CsrfField } from "@/lib/auth-csrf-form";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sellerScope } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { can, sellerPaymentAttempts, type SellerAttemptView } from "@bukalaris/db";
import Link from "next/link";
import { confirmPaymentAction, sellerRecheckAction } from "../actions";
import { anomalyLabel, attemptStateLabel, savedLabel } from "../labels";

export const metadata = { title: "Transaksi pembayaran — Bukalaris" };

// SC-33 (T-106, ADR-0013 decisions 21 to 27): the store's AutoLaris attempts on its own account, newest first. The owner asks for a status
// check now (RL-PAY-RECHECK) or confirms a payment by hand with a reason and evidence (one record per attempt, never edited). Anomalies (a
// second settled attempt, a payment after the order closed) are shown with what the seller must do. No provider id, fee or callback is shown.

export default async function PaymentTransactionsPage({ searchParams }: PageProps<"/seller/payments/transactions">) {
  const scope = await sellerScope();
  const { error, saved } = await searchParams;
  if (!can(scope, "finance.confirm_payment"))
    return (
      <section className="grid max-w-3xl gap-6">
        <PageHeader title="Transaksi pembayaran" />
        <p role="note" data-testid="transactions-denied" className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">Hanya pemilik toko yang dapat melihat dan mengonfirmasi pembayaran.</p>
      </section>
    );
  const rows = await sellerPaymentAttempts(scope);
  const savedKey = typeof saved === "string" ? saved : undefined;
  const now = new Date();
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader
        title="Transaksi pembayaran"
        description="Tagihan QRIS/VA pesanan toko di akun AutoLaris Anda. Status dicek otomatis ke AutoLaris; uang masuk langsung ke akun Anda."
      />
      <Notice error={error} saved={savedKey} savedText={savedKey ? savedLabel[savedKey] : undefined} />
      <p className="-mt-3 text-sm">
        <Link href="/seller/payments" className="inline-flex min-h-6 items-center underline underline-offset-4">Kembali ke Akun penyedia</Link>
      </p>
      {rows.length === 0 ? (
        <EmptyState title="Belum ada transaksi" data-testid="transactions-empty">Tagihan muncul di sini setelah pembeli memilih QRIS atau virtual account di checkout.</EmptyState>
      ) : (
        <ul className="grid gap-3" data-testid="transactions">
          {rows.map((a) => (
            <AttemptCard key={a.id} a={a} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AttemptCard({ a, now }: { a: SellerAttemptView; now: Date }) {
  const state = attemptStateLabel(a, now);
  const open = a.status !== "paid" && !a.manual;
  const checkable = open && a.requestState === "accepted" && a.expiresAt.getTime() > now.getTime() - 24 * 3_600_000;
  return (
    <li className="grid gap-3 rounded-lg border p-4" data-testid={`attempt-${a.orderId}-${a.attemptNo}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          <Link href={`/seller/orders/${a.orderId}`} className="underline underline-offset-4">Pesanan #{a.orderId}</Link>
          <span className="text-muted-foreground"> · tagihan ke-{a.attemptNo} · <span className="font-mono">{a.channelCode}</span></span>
        </p>
        <span className="flex flex-wrap gap-1.5">
          {a.environment === "sandbox" && <StatusBadge label="Uji (sandbox)" tone="outline" data-testid="attempt-sandbox" />}
          <StatusBadge label={state.label} tone={state.tone} data-testid="attempt-state" />
        </span>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm tabular-nums">
        <dt className="text-muted-foreground">Total pesanan</dt><dd className="text-right">{rupiah(a.amountIdr)}</dd>
        <dt className="text-muted-foreground">Biaya layanan ditagih ke pembeli</dt><dd className="text-right">{rupiah(a.adminFeeIdr)}</dd>
        <dt className="font-medium">Total tagihan</dt><dd className="text-right font-medium" data-testid="attempt-total">{rupiah(a.totalIdr)}</dd>
        {a.feeBearer === "seller" && a.expectedFeeIdr !== null && (
          <><dt className="text-muted-foreground">Perkiraan biaya AutoLaris (ditanggung toko)</dt><dd className="text-right">{rupiah(a.expectedFeeIdr)}</dd></>
        )}
      </dl>
      <p className="text-xs text-muted-foreground">
        Dibuat {tanggal(a.createdAt)} · berlaku sampai {tanggal(a.expiresAt)}{a.paidAt ? ` · lunas ${tanggal(a.paidAt)}` : ""}
      </p>
      {a.anomalies.map((k) => (
        <p key={k} role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid={`anomaly-${k}`}>{anomalyLabel[k]}</p>
      ))}
      {a.manual && (
        <div className="grid gap-1 rounded-md bg-muted/50 p-3 text-sm" data-testid="manual-record">
          <p className="font-medium">Dikonfirmasi manual {tanggal(a.manual.at)}</p>
          <p className="break-words">Alasan: {a.manual.reason}</p>
          <p className="break-words">Bukti: {a.manual.evidence}</p>
        </div>
      )}
      {checkable && (
        <form action={sellerRecheckAction} aria-label={`Cek status pesanan ${a.orderId}`}>
          <CsrfField />
          <input type="hidden" name="orderId" value={a.orderId} />
          <SubmitButton variant="outline" pendingText="Menjadwalkan…">Cek status sekarang</SubmitButton>
        </form>
      )}
      {open && (
        <details className="rounded-md border p-3">
          <summary className="min-h-6 cursor-pointer text-sm font-medium">Konfirmasi pembayaran manual</summary>
          <form action={confirmPaymentAction} className="mt-3 grid gap-3" aria-label={`Konfirmasi manual tagihan ${a.attemptNo} pesanan ${a.orderId}`}>
            <CsrfField />
            <input type="hidden" name="attemptId" value={a.id} />
            <p className="text-xs text-muted-foreground">Pakai hanya bila uangnya sudah terlihat di akun AutoLaris atau rekening Anda. Catatan konfirmasi disimpan permanen dan tidak bisa diubah atau dihapus.</p>
            <div className="grid gap-2">
              <Label htmlFor={`reason-${a.id}`}>Alasan</Label>
              <Textarea id={`reason-${a.id}`} name="reason" rows={2} required minLength={5} maxLength={500} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`evidence-${a.id}`}>Bukti (nomor referensi mutasi atau transaksi)</Label>
              <Input id={`evidence-${a.id}`} name="evidence" required minLength={3} maxLength={500} autoComplete="off" />
            </div>
            <ConfirmSubmit className="justify-self-start" message={`Konfirmasi pembayaran pesanan #${a.orderId} secara manual? Catatan ini tidak bisa diubah.`}>Konfirmasi lunas</ConfirmSubmit>
          </form>
        </details>
      )}
    </li>
  );
}
