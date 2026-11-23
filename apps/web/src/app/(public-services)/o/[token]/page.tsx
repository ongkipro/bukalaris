import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { BANKS, refundReasonLabel, refundStatusLabel } from "@/lib/finance";
import { rupiah, tanggalIso } from "@/lib/format";
import { CopyButton } from "@/components/copy-button";
import { BUYER_STATUS_LABEL, buyerBankTransfer, buyerOrderMoneyForLink, buyerOrderPayment, db, getOrderForLink, getRefundForLink, getShipmentForLink, providerStatusLabel, resolveBuyerOrder, SHIPMENT_STATUS_LABEL, shipmentTimeline } from "@bukalaris/db";
import { servesStore } from "@/lib/storefront";
import { notFound } from "next/navigation";
import { PaymentActions, paymentSavedText } from "../../../(checkout)/checkout/payment-actions";
import { recheckPaymentByLinkAction, retryPaymentByLinkAction, submitRefundDestinationAction, uploadProofByLinkAction } from "./actions";
import { BankTransferInstruction, PROOF_STATUS_LABEL } from "@/components/bank-transfer";

export const dynamic = "force-dynamic";

/** T-107: how the seller refunded, in the buyer's words (buyer screens never name the seller's provider accounts). */
const REFUND_METHOD_BUYER = { bank_transfer: "Transfer bank", autolaris: "Ke metode pembayaran Anda", cash: "Tunai", other: "Cara lain" } as const;

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
  // On a store host only that store's orders (T-103): another store's valid link is the same not-found as an invalid one.
  if (!o || !(await servesStore(o.storeSlug))) notFound();
  // A refund exists only for a verified gateway payment on a cancelled or returned order (or a late payment): the buyer tells us where to send it.
  const refund = await getRefundForLink(db(), token);
  // T-107 (C-P9): an order paid to the store's own accounts: the COD fee the buyer bears and the refunds the seller recorded on the order.
  const own = await buyerOrderMoneyForLink(db(), token);
  // Courier tracking (T-39): only when the seller booked through Mengantar; resi alone shows above.
  const s = o.trackingNumber ? await getShipmentForLink(db(), token) : null;
  const tracking = s && s.trackingNumber ? s : null;
  // T-106: the payment of a prepaid order on the store's own AutoLaris account: instruction, "check now" and a new instruction.
  const ref = o.paymentMethod === "cod" ? null : await resolveBuyerOrder(db(), { token });
  const pay = ref ? await buyerOrderPayment(db(), ref) : null;
  // T-113: a bank-transfer order: the seller's accounts, the exact total, the proofs sent and the upload (decision 37).
  const bank = ref && o.paymentMethod === "bank_transfer" ? await buyerBankTransfer(db(), ref) : null;
  const p = pay?.payment?.sellerAccount ? pay.payment : null;
  const paySaved = typeof saved === "string" && saved in paymentSavedText ? saved : undefined;
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
        {own && o.paymentMethod === "cod" && own.codFeeIdr > 0 && (
          <>
            <dt>Biaya COD</dt><dd className="text-right" data-testid="cod-fee">{rupiah(own.codFeeIdr)}</dd>
            <dt className="font-semibold">Dibayar ke kurir</dt><dd className="text-right font-semibold" data-testid="cod-bill">{rupiah(own.billIdr)}</dd>
          </>
        )}
      </dl>
      {own && own.refunds.length > 0 && (
        <section aria-labelledby="seller-refund-heading" className="grid gap-2 border-t pt-3 text-sm" data-testid="seller-refunds">
          <h2 id="seller-refund-heading" className="font-semibold">Refund dari penjual</h2>
          <p className="text-muted-foreground">Dibayar langsung oleh {o.storeName} dan dicatat pada pesanan ini. Hubungi penjual bila belum Anda terima.</p>
          <ul className="divide-y rounded-lg border">
            {own.refunds.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-x-4 p-3">
                <span>{tanggalIso(r.refundedOn)} · {REFUND_METHOD_BUYER[r.method]}</span>
                <span className="tabular-nums">{rupiah(r.amountIdr)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <dl className="grid gap-1 border-t pt-2 text-sm">
        <div className="flex flex-wrap justify-between gap-x-4"><dt className="text-muted-foreground">Pembayaran</dt><dd>{o.paymentMethod === "cod" ? "Bayar di tempat (COD)" : o.paymentMethod === "bank_transfer" ? "Transfer bank ke rekening penjual" : "Transfer bank"}</dd></div>
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
      {p && (
        <section id="payment" aria-labelledby="payment-heading" className="grid gap-3 border-t pt-3 text-sm" data-testid="payment-section">
          <h2 id="payment-heading" className="font-semibold">Pembayaran</h2>
          {paySaved && <Notice saved={paySaved} savedText={paymentSavedText[paySaved]} />}
          {!refund && <Notice error={typeof error === "string" ? error : undefined} />}
          {p.environment === "sandbox" && <p className="text-xs text-muted-foreground" data-testid="test-order">Pesanan uji (akun pembayaran sandbox): tidak ada uang sungguhan yang ditagih.</p>}
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
            <dt>Metode</dt><dd className="text-right font-mono">{p.channelCode}</dd>
            <dt>Biaya layanan pembayaran</dt><dd className="text-right">{rupiah(p.adminFeeIdr)}</dd>
            <dt className="font-semibold">Total tagihan</dt><dd className="text-right font-semibold" data-testid="payment-total">{rupiah(p.totalIdr)}</dd>
          </dl>
          {pay!.orderStatus === "awaiting_payment" && p.instruction && !p.retryable && (
            <div className="grid gap-1 rounded-lg border p-3" data-testid="payment-instruction">
              {p.instruction.virtualAccount && (
                <p className="flex flex-wrap items-center gap-2"><span>Nomor virtual account: <strong className="select-all font-mono" data-testid="payment-va">{p.instruction.virtualAccount}</strong></span><CopyButton value={p.instruction.virtualAccount} label="nomor virtual account" /></p>
              )}
              {p.instruction.paymentCode && <p>Kode pembayaran: <strong className="select-all font-mono">{p.instruction.paymentCode}</strong></p>}
              {p.instruction.url && <p><a href={p.instruction.url} rel="noopener noreferrer" className="inline-flex min-h-6 items-center underline underline-offset-4">Buka halaman pembayaran</a></p>}
              {p.instruction.qr && (
                <label className="grid gap-1"><span>Kode QR (isi QRIS apa adanya)</span><textarea readOnly rows={3} defaultValue={p.instruction.qr} className="w-full rounded-md border bg-muted/40 p-2 font-mono text-xs" /></label>
              )}
              <p className="text-xs text-muted-foreground">Bayar sebelum {dt.format(p.expiresAt)} WIB.</p>
            </div>
          )}
          {pay!.orderStatus === "awaiting_payment" && p.retryable && <p data-testid="payment-retry-note">{p.requestState === "failed" ? "Instruksi pembayaran tidak dapat dibuat." : "Batas waktu pembayaran sudah lewat."} Pesanan Anda tetap tersimpan; buat tagihan baru bila belum membayar.</p>}
          <PaymentActions payment={p} orderStatus={pay!.orderStatus} recheck={recheckPaymentByLinkAction.bind(null, token)} retry={retryPaymentByLinkAction.bind(null, token)} />
        </section>
      )}
      {bank && (
        <section id="bank-transfer" aria-labelledby="bank-heading" className="grid gap-3 border-t pt-3 text-sm" data-testid="bank-transfer-section">
          <h2 id="bank-heading" className="font-semibold">Pembayaran transfer bank</h2>
          {!refund && <Notice error={typeof error === "string" ? error : undefined} saved={saved === "proof" ? "proof" : undefined} savedText="Bukti transfer terkirim. Penjual akan mencocokkannya dengan mutasi rekeningnya." />}
          {bank.confirmed && <p data-testid="bank-transfer-confirmed">Pembayaran sudah dikonfirmasi penjual.</p>}
          <BankTransferInstruction bank={bank} storeName={o.storeName} />
          {bank.proofs.length > 0 && (
            <ul className="divide-y rounded-lg border" aria-label="Bukti transfer yang dikirim" data-testid="proof-list">
              {bank.proofs.map((p) => (
                <li key={p.id} className="grid gap-1 p-3">
                  <span className="flex flex-wrap justify-between gap-x-4">
                    <span data-testid="proof-status">{PROOF_STATUS_LABEL[p.status]}</span>
                    <span className="text-muted-foreground">{dt.format(p.createdAt)} WIB</span>
                  </span>
                  {p.status === "rejected" && <span data-testid="proof-reject-reason">Alasan penjual: {p.rejectReason}</span>}
                  {!p.purged && (
                    <span className="flex flex-wrap gap-3">
                      {Array.from({ length: p.files }, (_, i) => (
                        <a key={i} href={`/o/${token}/proof/${p.id}/${i + 1}`} className="inline-flex min-h-6 items-center underline underline-offset-4" download>Unduh foto {i + 1}</a>
                      ))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {bank.canUpload && (
            <form action={uploadProofByLinkAction.bind(null, token)} className="grid gap-2" aria-label="Kirim bukti transfer">
              <Label htmlFor="proof">Foto bukti transfer (maksimal 3 foto, JPG, PNG atau WebP, 3 MB per foto)</Label>
              <Input id="proof" name="proof" type="file" accept="image/jpeg,image/png,image/webp" multiple required aria-describedby="proof-help" />
              <p id="proof-help" className="text-xs text-muted-foreground">Bukti hanya dilihat oleh Anda dan penjual. Mengirim bukti tidak langsung mengubah status pesanan: penjual mencocokkannya dengan mutasi rekeningnya lalu mengonfirmasi.</p>
              <SubmitButton pendingText="Mengirim…">Kirim bukti transfer</SubmitButton>
            </form>
          )}
          {!bank.canUpload && !bank.confirmed && bank.orderStatus === "awaiting_payment" && bank.proofs.some((p) => p.status === "sent") && <p data-testid="proof-waiting">Bukti terkirim, menunggu pemeriksaan penjual.</p>}
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
