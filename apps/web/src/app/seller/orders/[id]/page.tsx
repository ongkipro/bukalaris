import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sellerScope } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { orderActionLabel, orderStatusLabel, orderStatusTone, paymentLabel } from "@/lib/status";
import { can, getOrder, type OrderStatus } from "@bukalaris/db";
import { notFound } from "next/navigation";
import { orderAction } from "../actions";
import { parseId } from "../status";

const label = (s: string) => orderStatusLabel[s as OrderStatus] ?? s;

export default async function OrderPage({ params, searchParams }: PageProps<"/seller/orders/[id]">) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const orderId = parseId(id);
  const o = Number.isSafeInteger(orderId) ? await getOrder(scope, orderId) : null;
  if (!o) notFound();
  const fulfil = can(scope, "orders.fulfill");
  const simple = o.actions.filter((a) => a === "confirm" || a === "pay" || a === "process" || a === "complete");
  const confirming = o.status === "awaiting_confirmation" || o.status === "on_hold";

  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader
        back={{ href: "/seller/orders", label: "Semua pesanan" }}
        title={`Pesanan #${o.id}`}
        badge={<StatusBadge label={orderStatusLabel[o.status]} tone={orderStatusTone[o.status]} data-testid="order-status" />}
        description={
          <>
            Dibuat <time dateTime={o.createdAt.toISOString()}>{tanggal(o.createdAt)}</time> · diperbarui <time dateTime={o.updatedAt.toISOString()}>{tanggal(o.updatedAt)}</time>
          </>
        }
      />
      <Notice error={error} saved={saved} />

      {confirming && (
        <section aria-labelledby="risk" className="grid gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm" data-testid="cod-risk">
          <h2 id="risk" className="text-lg font-semibold">Sinyal risiko COD</h2>
          <p className="text-muted-foreground">
            Dari data toko ini saja. Hubungi pembeli di nomor HP di bawah sebelum mengonfirmasi; pesanan yang belum dikonfirmasi tidak akan dikirim.
          </p>
          {o.risk.length === 0 ? (
            <p>Tidak ada sinyal risiko dari riwayat toko ini.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5">
              {o.risk.map((r) => (
                <li key={r.code}>{r.message}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {fulfil && o.actions.length > 0 && (
        <section aria-labelledby="actions" className="grid gap-4 rounded-lg border p-4">
          <h2 id="actions" className="text-lg font-semibold">Tindakan</h2>
          {o.actions.includes("confirm") && (
            <p className="text-sm text-muted-foreground">Konfirmasi hanya setelah pembeli membenarkan pesanan dan alamatnya. Tahan jika belum bisa dihubungi; tolak jika pesanan tidak valid.</p>
          )}
          {o.actions.includes("pay") && (
            <p className="text-sm text-muted-foreground">
              Tandai dibayar hanya setelah Anda memeriksa transfer masuk sendiri. Ini konfirmasi manual, bukan rekonsiliasi otomatis dari penyedia pembayaran.
            </p>
          )}
          {simple.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {simple.map((a) => (
                <form key={a} action={orderAction.bind(null, o.id, a)}>
                  <SubmitButton variant={a === "pay" ? "outline" : "default"} pendingText="Memproses…">{orderActionLabel[a]}</SubmitButton>
                </form>
              ))}
            </div>
          )}
          {o.actions.includes("ship") && (
            <form action={orderAction.bind(null, o.id, "ship")} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="grid gap-2">
                <Label htmlFor="trackingNumber">Nomor resi kurir</Label>
                <Input id="trackingNumber" name="trackingNumber" required minLength={3} maxLength={80} placeholder={`Resi ${o.courier}`} aria-describedby="tracking-help" />
                <p id="tracking-help" className="text-xs text-muted-foreground">Nomor resi dari {o.courier}; pembeli melacak paket dengan nomor ini.</p>
              </div>
              <SubmitButton pendingText="Mengirim…">{orderActionLabel.ship}</SubmitButton>
            </form>
          )}
          {o.actions.includes("hold") && (
            <form action={orderAction.bind(null, o.id, "hold")} className="grid gap-2 border-t pt-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="grid gap-2">
                <Label htmlFor="holdReason">Alasan penahanan</Label>
                <Input id="holdReason" name="reason" required minLength={5} maxLength={500} placeholder="mis. Nomor HP belum bisa dihubungi" aria-describedby="hold-help" />
                <p id="hold-help" className="text-xs text-muted-foreground">Pesanan menunggu tanpa dikirim; bisa dikonfirmasi atau ditolak nanti.</p>
              </div>
              <SubmitButton variant="outline" pendingText="Menahan…">{orderActionLabel.hold}</SubmitButton>
            </form>
          )}
          {o.actions.includes("reject") && (
            <form action={orderAction.bind(null, o.id, "reject")} className="grid gap-2 border-t pt-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="grid gap-2">
                <Label htmlFor="rejectReason">Alasan penolakan</Label>
                <Input id="rejectReason" name="reason" required minLength={5} maxLength={500} placeholder="Wajib, tercatat di riwayat" aria-describedby="reject-help" />
                <p id="reject-help" className="text-xs text-muted-foreground">Pesanan dibatalkan dan stok setiap barang dikembalikan sekali.</p>
              </div>
              <ConfirmSubmit variant="destructive" message={`Tolak pesanan COD #${o.id}? Stok barang akan dikembalikan dan pesanan tidak bisa dilanjutkan.`}>
                {orderActionLabel.reject}
              </ConfirmSubmit>
            </form>
          )}
          {o.actions.includes("cancel") && (
            <form action={orderAction.bind(null, o.id, "cancel")} className="grid gap-2 border-t pt-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="grid gap-2">
                <Label htmlFor="reason">Alasan pembatalan</Label>
                <Input id="reason" name="reason" required minLength={5} maxLength={500} placeholder="Wajib, tercatat di riwayat" aria-describedby="cancel-help" />
                <p id="cancel-help" className="text-xs text-muted-foreground">Stok setiap barang dikembalikan sekali saat dibatalkan.</p>
              </div>
              <ConfirmSubmit variant="destructive" message={`Batalkan pesanan #${o.id}? Stok barang akan dikembalikan dan pesanan tidak bisa dilanjutkan.`}>
                {orderActionLabel.cancel}
              </ConfirmSubmit>
            </form>
          )}
        </section>
      )}
      {!fulfil && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Akun Anda hanya dapat melihat pesanan; tindakan pemenuhan dilakukan pemilik atau staf toko.</p>}

      <div className="grid gap-6 sm:grid-cols-2">
        <section aria-labelledby="buyer" className="grid content-start gap-1 text-sm">
          <h2 id="buyer" className="text-lg font-semibold">Pembeli</h2>
          <p className="font-medium">{o.buyerName}</p>
          <p><a href={`tel:${o.buyerPhone}`} className="underline underline-offset-4">{o.buyerPhone}</a></p>
          <p className="whitespace-pre-line text-muted-foreground">{o.shippingAddress}</p>
          <p className="text-muted-foreground">Area: {o.destinationAreaLabel}</p>
          <p className="text-muted-foreground">Kurir: {o.courier} <span className="font-mono text-xs">({o.courierCode})</span> · {o.weightKg} kg</p>
          {o.trackingNumber && <p>Resi: <span className="font-mono" data-testid="tracking">{o.trackingNumber}</span></p>}
        </section>
        <section aria-labelledby="payment" className="grid content-start gap-1 text-sm">
          <h2 id="payment" className="text-lg font-semibold">Pembayaran</h2>
          <p>{paymentLabel[o.paymentMethod]}</p>
          <p className="text-muted-foreground">
            Referensi: {o.paymentReference ? <span className="font-mono break-all">{o.paymentReference}</span> : "—"}
          </p>
          {o.paidAt && <p className="text-muted-foreground">Dikonfirmasi dibayar {tanggal(o.paidAt)}</p>}
          {o.confirmedAt && <p className="text-muted-foreground">Pesanan COD dikonfirmasi {tanggal(o.confirmedAt)}</p>}
          {o.paymentMethod === "cod" && !o.paidAt && <p className="text-muted-foreground">COD: uang diterima kurir saat barang sampai, belum tercatat sebagai pembayaran.</p>}
        </section>
      </div>

      <section aria-labelledby="lines" className="grid gap-2">
        <h2 id="lines" className="text-lg font-semibold">Barang</h2>
        <ul className="divide-y rounded-lg border text-sm">
          {o.lines.map((l) => (
            <li key={l.variantId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-3">
              <span>
                {l.productTitle} · {l.variantTitle}
                <span className="text-muted-foreground tabular-nums"> × {l.quantity} @ {rupiah(l.unitPrice)}</span>
              </span>
              <span className="font-medium tabular-nums">{rupiah(l.lineTotal)}</span>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-3 text-sm tabular-nums">
          <dt>Subtotal</dt><dd className="text-right">{rupiah(o.subtotal)}</dd>
          <dt>Ongkir</dt><dd className="text-right">{rupiah(o.shippingFee)}</dd>
          <dt className="font-semibold">Total</dt><dd className="text-right font-semibold" data-testid="order-total">{rupiah(o.total)}</dd>
        </dl>
      </section>

      <section aria-labelledby="history" className="grid gap-2">
        <h2 id="history" className="text-lg font-semibold">Riwayat status</h2>
        <ol className="divide-y rounded-lg border text-sm">
          <li className="grid gap-0.5 p-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
            <time dateTime={o.createdAt.toISOString()} className="text-muted-foreground">{tanggal(o.createdAt)}</time>
            <span>Pesanan dibuat oleh pembeli ({paymentLabel[o.paymentMethod]})</span>
          </li>
          {o.history.map((h) => (
            <li key={h.id} className="grid gap-0.5 p-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
              <time dateTime={h.createdAt.toISOString()} className="text-muted-foreground">{tanggal(h.createdAt)}</time>
              <div>
                <span>{label(h.fromStatus)} → <strong>{label(h.toStatus)}</strong> oleh {h.actorName ?? "—"}</span>
                {h.note && <p className="mt-1 break-words text-muted-foreground">{h.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}
