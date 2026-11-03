import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { BANKS, refundReasonLabel, refundStatusLabel } from "@/lib/finance";
import { rupiah } from "@/lib/format";
import { BUYER_STATUS_LABEL, db, getOrderForLink, getRefundForLink, getShipmentForLink, providerStatusLabel, SHIPMENT_STATUS_LABEL, shipmentTimeline } from "@bukalaris/db";
import { notFound } from "next/navigation";
import { submitRefundDestinationAction } from "./actions";

export const dynamic = "force-dynamic";

const dt = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });
const formatTimelineAt = (at: Date | string) => {
  if (typeof at !== "string") return `${dt.format(at)} WIB`;
  const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/.exec(at.trim());
  if (m) {
    const d = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+07:00`);
    if (Number.isFinite(d.getTime())) return `${dt.format(d)} WIB`;
  }
  return at ? `${at} WIB` : "—";
};

/**
 * Buyer order status behind a signed, expiring link (`/o/<orderId>.<expiry>.<hmac>`, T-36).
 * Shows that order's status, lines, totals, courier, tracking number and destination area
 * label only — no street address, phone or other orders. Invalid links are a 404 (see not-found.tsx).
 */
export default async function OrderStatusPage({ params, searchParams }: PageProps<"/o/[token]">) {
  const { token } = await params;
  const { error, saved } = await searchParams;
  const o = await getOrderForLink(db(), token);
  if (!o) notFound();
  // A refund exists only for a verified gateway payment on a cancelled or returned order (or a late payment): the buyer tells us where to send it.
  const refund = await getRefundForLink(db(), token);
  // Courier tracking (T-39): only when the seller booked through Mengantar; resi alone shows above.
  const s = o.trackingNumber ? await getShipmentForLink(db(), token) : null;
  const tracking = s && s.trackingNumber ? s : null;
  return (
    <section className="grid gap-4 rounded-xl border bg-background p-6" aria-labelledby="status-heading">
      <p className="text-sm font-medium text-muted-foreground">{o.storeName}</p>
      <h1 id="status-heading" className="-mt-2 text-2xl font-semibold tracking-tight">
        Pesanan <span className="font-mono" data-testid="order-id">#{o.id}</span>
      </h1>
      <p role="status" className="rounded-lg bg-muted/60 p-3">
        Status: <strong data-testid="order-status">{BUYER_STATUS_LABEL[o.status]}</strong>
        <span className="block text-xs text-muted-foreground">Diperbarui {dt.format(o.updatedAt)} WIB</span>
      </p>
      <ul className="divide-y text-sm">
        {o.lines.map((l) => (
          <li key={l.variantId} className="flex justify-between gap-4 py-2">
            <span className="min-w-0">{l.productTitle} · {l.variantTitle} × {l.quantity}</span>
            <span className="shrink-0 tabular-nums">{rupiah(l.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t pt-2 text-sm tabular-nums">
        <dt>Subtotal</dt><dd className="text-right">{rupiah(o.subtotal)}</dd>
        {o.goodsDiscount > 0 && <><dt>Diskon barang</dt><dd className="text-right" data-testid="order-goods-discount">−{rupiah(o.goodsDiscount)}</dd></>}
        {o.shippingDiscount > 0 && <><dt>Diskon ongkir</dt><dd className="text-right" data-testid="order-shipping-discount">−{rupiah(o.shippingDiscount)}</dd></>}
        <dt>Ongkir{o.shippingDiscount > 0 && <span className="font-normal text-muted-foreground"> (setelah diskon)</span>}</dt><dd className="text-right" data-testid="order-shipping">{rupiah(o.shippingFee)}</dd>
        <dt className="font-semibold">Total</dt><dd className="text-right font-semibold" data-testid="order-total">{rupiah(o.total)}</dd>
      </dl>
      <dl className="grid gap-1 border-t pt-2 text-sm">
        <div className="flex flex-wrap justify-between gap-x-4"><dt className="text-muted-foreground">Pembayaran</dt><dd>{o.paymentMethod === "cod" ? "Bayar di tempat (COD)" : "Transfer bank"}</dd></div>
        <div className="flex flex-wrap justify-between gap-x-4"><dt className="text-muted-foreground">Kurir</dt><dd data-testid="courier">{o.courier}</dd></div>
        <div className="flex flex-wrap justify-between gap-x-4"><dt className="text-muted-foreground">Tujuan</dt><dd className="text-right">{o.destinationAreaLabel}</dd></div>
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt className="text-muted-foreground">Nomor resi</dt>
          <dd className="font-mono break-all" data-testid="tracking">{o.trackingNumber ?? "Belum tersedia"}</dd>
        </div>
      </dl>
      {tracking && (
        <section aria-labelledby="tracking-heading" className="grid gap-2 border-t pt-3 text-sm" data-testid="tracking-timeline">
          <h2 id="tracking-heading" className="font-semibold">Perjalanan paket</h2>
          <p>
            <span data-testid="tracking-status">
              {(tracking.providerStatus && tracking.providerStatus !== "[dihapus]" ? providerStatusLabel(tracking.providerStatus) : null) ?? SHIPMENT_STATUS_LABEL[tracking.status]}
            </span>
            {tracking.lastTrackedAt && <span className="block text-xs text-muted-foreground">Dicek {dt.format(tracking.lastTrackedAt)} WIB</span>}
          </p>
          <ol className="grid gap-1.5">
            {shipmentTimeline(tracking)
              .slice(1)
              .reverse()
              .map((t, i) => (
                <li key={i} className="grid gap-x-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
                  <span className="text-muted-foreground tabular-nums">{formatTimelineAt(t.at)}</span>
                  <span className="break-words">{t.text}</span>
                </li>
              ))}
          </ol>
          {tracking.trackingHistory.some((h) => h.desc === "[dihapus]") && (
            <p className="text-xs text-muted-foreground" data-testid="tracking-redacted-note">
              Keterangan bebas dari kurir telah dihapus sesuai kebijakan privasi data pembeli; waktu dan status paket tetap tercatat.
            </p>
          )}
        </section>
      )}
      {refund && (
        <section id="refund" aria-labelledby="refund-heading" className="grid gap-3 border-t pt-3 text-sm" data-testid="refund-section">
          <h2 id="refund-heading" className="font-semibold">Pengembalian dana</h2>
          <Notice error={error} saved={saved} savedText="Rekening refund tersimpan. Tim Bukalaris memeriksanya sebelum mentransfer." />
          <p>
            <span data-testid="refund-status">{refundStatusLabel[refund.status] ?? refund.status}</span> · {refundReasonLabel[refund.reason] ?? refund.reason}
          </p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
            <dt>Barang</dt><dd className="text-right">{rupiah(refund.goodsRefundIdr)}</dd>
            <dt>Ongkir</dt><dd className="text-right">{rupiah(refund.shippingRefundIdr)}</dd>
            <dt>Biaya admin pembayaran</dt><dd className="text-right">{rupiah(refund.feeRefundIdr)}</dd>
            <dt className="font-semibold">Dikembalikan penuh</dt><dd className="text-right font-semibold" data-testid="refund-amount">{rupiah(refund.amountIdr)}</dd>
          </dl>
          {refund.destinationSet && <p data-testid="refund-destination">Rekening tujuan: {refund.destinationBank} ••••{refund.destinationLast4}</p>}
          {refund.status === "pending" ? (
            <form action={submitRefundDestinationAction.bind(null, token)} className="grid gap-3" aria-label="Rekening tujuan refund">
              <p className="text-xs text-muted-foreground">Isi rekening bank atau e-wallet atas nama Anda. Refund ditransfer manual oleh tim Bukalaris setelah diperiksa; nomor rekening tidak ditampilkan lagi setelah disimpan.</p>
              <div className="grid gap-1.5">
                <Label htmlFor="refund-bank">Bank atau e-wallet</Label>
                <NativeSelect id="refund-bank" name="bank" defaultValue={refund.destinationBank ?? "BCA"}>{BANKS.map((b) => <option key={b} value={b}>{b}</option>)}</NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="refund-account">Nomor rekening</Label>
                <Input id="refund-account" name="account" inputMode="numeric" pattern="[0-9]{5,24}" required autoComplete="off" aria-describedby="refund-account-help" />
                <p id="refund-account-help" className="text-xs text-muted-foreground">5–24 angka saja tanpa spasi atau tanda hubung.</p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="refund-holder">Nama pemilik rekening</Label>
                <Input id="refund-holder" name="holder" required minLength={2} maxLength={120} autoComplete="off" />
              </div>
              <SubmitButton pendingText="Menyimpan…">{refund.destinationSet ? "Ganti rekening refund" : "Simpan rekening refund"}</SubmitButton>
            </form>
          ) : (
            <p className="text-xs text-muted-foreground">Rekening sudah dikunci karena refund sedang atau sudah diproses.</p>
          )}
        </section>
      )}
      <p className="text-xs text-muted-foreground">Dipesan {dt.format(o.createdAt)} WIB. Hubungi penjual bila ada pertanyaan tentang pesanan ini.</p>
    </section>
  );
}
