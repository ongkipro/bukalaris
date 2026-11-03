import { SubmitButton } from "@/components/submit-button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { attemptStatusLabel, channelName } from "@/lib/billing";
import { rupiah, tanggal } from "@/lib/format";
import type { SubscriptionPaymentView } from "@bukalaris/db";
import { payAction } from "./actions";

/** The live payment instruction of an invoice (reused on every visit) and its honest status: only a verified settlement is "lunas". */
export function Instruction({ view }: { view: SubscriptionPaymentView }) {
  const i = view.instruction;
  return (
    <section aria-labelledby="instruksi" className="grid gap-2 rounded-lg border p-3 text-sm" data-testid="billing-instruction">
      <h2 id="instruksi" className="font-medium">Instruksi pembayaran · {channelName(view.channelCode)}</h2>
      <p data-testid="billing-attempt-status" role="status">{attemptStatusLabel(view)}</p>
      {i?.virtualAccount && <p>Nomor virtual account: <strong className="select-all break-all font-mono" data-testid="billing-va">{i.virtualAccount}</strong></p>}
      {i?.paymentCode && <p>Kode pembayaran: <strong className="select-all break-all font-mono">{i.paymentCode}</strong></p>}
      {i?.url && <p><a href={i.url} rel="noopener noreferrer" className="underline underline-offset-4">Buka halaman pembayaran</a></p>}
      {i?.qr && (
        <label className="grid gap-1">
          <span>Kode QR (isi QRIS apa adanya)</span>
          <textarea readOnly rows={4} defaultValue={i.qr} className="w-full rounded-md border bg-muted/40 p-2 font-mono text-base md:text-sm" data-testid="billing-qr" />
        </label>
      )}
      <p className="text-muted-foreground">Total yang dibayar {rupiah(view.totalIdr)}{view.status === "expired" ? "" : <> · bayar sebelum <span data-testid="billing-expiry">{tanggal(view.expiresAt)}</span></>}.</p>
    </section>
  );
}

/** Pay form: one channel select from the provider's current list; the same form is a retry when the instruction failed or expired. */
export function PayForm({ channels, invoiceId, label }: { channels: { code: string }[]; invoiceId?: string; label: string }) {
  if (channels.length === 0) return <p role="note" className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Metode pembayaran sedang tidak tersedia. Coba lagi sebentar.</p>;
  return (
    <form action={payAction} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" data-testid="billing-pay-form">
      {invoiceId && <input type="hidden" name="invoiceId" value={invoiceId} />}
      <div className="grid gap-1.5">
        <Label htmlFor={`channel-${invoiceId ?? "now"}`}>Metode pembayaran</Label>
        <NativeSelect id={`channel-${invoiceId ?? "now"}`} name="channel" defaultValue={channels[0]!.code}>
          {channels.map((c) => (
            <option key={c.code} value={c.code}>{channelName(c.code)}</option>
          ))}
        </NativeSelect>
      </div>
      <SubmitButton pendingText="Memproses…">{label}</SubmitButton>
    </form>
  );
}
