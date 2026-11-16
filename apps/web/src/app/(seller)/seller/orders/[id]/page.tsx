import { CsrfField } from "@/lib/auth-csrf-form";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sellerScope } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { orderActionLabel, orderStatusLabel, orderStatusTone, paymentLabel, type Tone } from "@/lib/status";
import { BOOKABLE, can, codBookingAllowed, getOrder, getShipment, providerStatusLabel, RETRYABLE, SHIPMENT_STATUS_LABEL, shipmentTimeline, TERMINAL, whiteLabel, type OrderStatus, type ShipmentStatus } from "@bukalaris/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { orderAction } from "../actions";
import { parseId } from "../status";
import { bookShipmentAction, linkUnknownBookingAction, refreshTrackingAction, releaseUnknownBookingAction } from "./actions";

const label = (s: string) => orderStatusLabel[s as OrderStatus] ?? s;
const shipmentTone: Record<ShipmentStatus, Tone> = {
  queued: "warning",
  booking: "warning",
  unknown: "destructive",
  awaiting_account: "warning",
  awaiting_balance: "warning",
  booked: "outline",
  in_transit: "default",
  delivered: "success",
  returned: "destructive",
  problem: "warning",
  cancelled: "destructive",
  failed: "destructive",
};
const savedText: Record<string, string> = {
  booking: "Booking diminta. Resi dan status pesanan diperbarui otomatis; muat ulang halaman ini sebentar lagi.",
  tracking: "Pembaruan status diminta; muat ulang halaman ini sebentar lagi.",
  released: "Booking dilepas. Anda boleh membooking pesanan ini lagi.",
  linked: "Order dari akun kurir ditautkan. Status diperbarui otomatis dari akun kurir Anda.",
};
const pickupChoices = [
  { value: "scheduled_pickup", label: "Dijemput kurir di alamat pickup" },
  { value: "drop_off", label: "Antar sendiri ke agen kurir" },
] as const;

export default async function OrderPage({ params, searchParams }: PageProps<"/seller/orders/[id]">) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const orderId = parseId(id);
  const o = Number.isSafeInteger(orderId) ? await getOrder(scope, orderId) : null;
  if (!o) notFound();
  const shipmentRow = await getShipment(scope, o.id);
  const fulfil = can(scope, "orders.fulfill");
  const bookable = (BOOKABLE as readonly string[]).includes(o.status);
  // T-105: a store on its own courier account collects its own COD; the platform COD gate does not apply to it.
  const ownAccount = o.shippingAccountKind === "seller_owned";
  const codLocked = !ownAccount && o.paymentMethod === "cod" && !codBookingAllowed();
  const carrier = ownAccount ? "akun kurir toko" : "Bukalaris Kirim";
  const simple = o.actions.filter((a) => a === "confirm" || a === "pay" || a === "process");
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
      <Notice error={error} saved={saved} savedText={typeof saved === "string" ? savedText[saved] : undefined} />

      {confirming && (
        <section aria-labelledby="risk" className="grid gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm" data-testid="cod-risk">
          <h2 id="risk" className="text-base font-semibold">Sinyal risiko COD</h2>
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
          <h2 id="actions" className="text-base font-semibold">Tindakan</h2>
          {o.actions.includes("confirm") && (
            <p className="text-sm text-muted-foreground">Konfirmasi hanya setelah pembeli membenarkan pesanan dan alamatnya. Tahan jika belum bisa dihubungi; tolak jika pesanan tidak valid.</p>
          )}
          {o.actions.includes("pay") && (
            <p className="text-sm text-muted-foreground">
              Tandai dibayar hanya setelah Anda memeriksa transfer masuk sendiri. Ini konfirmasi manual, bukan rekonsiliasi otomatis dari penyedia pembayaran.
            </p>
          )}
          {o.status === "awaiting_payment" && o.payment?.sellerAccount && (
            <p className="text-sm text-muted-foreground" data-testid="own-account-confirm">
              Pembayaran pesanan ini lewat akun pembayaran milik toko. Status dicek otomatis; bila uangnya sudah masuk tetapi belum terverifikasi, konfirmasi dengan alasan dan bukti di{" "}
              <Link href="/seller/payments/transactions" className="font-medium text-foreground underline underline-offset-4">Transaksi pembayaran</Link>.
            </p>
          )}
          {simple.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {simple.map((a) => (
                <form key={a} action={orderAction.bind(null, o.id, a)}>
        <CsrfField />
                  <SubmitButton variant={a === "pay" ? "outline" : "default"} pendingText="Memproses…">{orderActionLabel[a]}</SubmitButton>
                </form>
              ))}
            </div>
          )}
          {o.actions.includes("ship") && (
            <form action={orderAction.bind(null, o.id, "ship")} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <CsrfField />
              <div className="grid gap-2">
                <Label htmlFor="trackingNumber">Nomor resi kurir</Label>
                <Input id="trackingNumber" name="trackingNumber" required minLength={3} maxLength={80} placeholder={`Resi ${o.courier}`} aria-describedby="tracking-help" />
                <p id="tracking-help" className="text-xs text-muted-foreground">Resi yang Anda buat sendiri di {o.courier}. Untuk resi otomatis, gunakan Bukalaris Kirim di bawah.</p>
              </div>
              <SubmitButton pendingText="Mengirim…">{orderActionLabel.ship}</SubmitButton>
            </form>
          )}
          {o.actions.includes("hold") && (
            <form action={orderAction.bind(null, o.id, "hold")} className="grid gap-2 border-t pt-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <CsrfField />
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
        <CsrfField />
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
        <CsrfField />
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

      {(shipmentRow || (fulfil && bookable)) && (
        <section aria-labelledby="shipment" className="grid gap-4 rounded-lg border p-4" data-testid="shipment">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="shipment" className="text-base font-semibold">{ownAccount ? "Pengiriman lewat akun kurir toko" : "Pengiriman Bukalaris Kirim"}</h2>
            {shipmentRow && <StatusBadge label={SHIPMENT_STATUS_LABEL[shipmentRow.status]} tone={shipmentTone[shipmentRow.status]} data-testid="shipment-status" />}
          </div>

          {!shipmentRow && codLocked && (
            <p className="text-sm text-muted-foreground" data-testid="cod-locked">
              Booking COD lewat Bukalaris Kirim belum dibuka: kebijakan remitansi COD masih menunggu keputusan pemilik platform. Kirim pesanan COD ini dengan resi manual di atas.
            </p>
          )}
          {!shipmentRow && !codLocked && (
            <form action={bookShipmentAction.bind(null, o.id)} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" aria-label="Booking pengiriman">
              <CsrfField />
              <div className="grid gap-3">
                <p className="text-sm text-muted-foreground">
                  Booking {o.courier} ke {o.destinationAreaLabel} ({o.weightKg} kg{o.paymentMethod === "cod" ? `, COD ${rupiah(o.total)}` : ""}) lewat {carrier}. Resi terbit otomatis dan pesanan berpindah ke
                  &ldquo;Dikirim&rdquo;; pembeli diberi tahu sekali.
                </p>
                {ownAccount && <PickupChoice />}
              </div>
              <SubmitButton pendingText="Mengantre…">{ownAccount ? "Booking sekarang" : "Kirim dengan Bukalaris Kirim"}</SubmitButton>
            </form>
          )}

          {shipmentRow && (
            <>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Resi</dt>
                <dd className="font-mono break-all" data-testid="shipment-resi">{shipmentRow.trackingNumber ?? "Belum terbit"}</dd>
                <dt className="text-muted-foreground">Status kurir</dt>
                <dd data-testid="shipment-provider-status">{providerStatusLabel(shipmentRow.providerStatus) ?? "Belum ada pembaruan"}</dd>
                <dt className="text-muted-foreground">{ownAccount ? "ID order kurir" : "Order Bukalaris Kirim"}</dt>
                <dd className="font-mono break-all">{shipmentRow.providerOrderId ?? "—"}</dd>
                <dt className="text-muted-foreground">Diperbarui</dt>
                <dd>{shipmentRow.lastTrackedAt ? tanggal(shipmentRow.lastTrackedAt) : "—"}</dd>
              </dl>
              {shipmentRow.lastError && (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive" data-testid="shipment-error">
                  {whiteLabel(shipmentRow.lastError)}
                </p>
              )}
              {fulfil && ownAccount && shipmentRow.status === "unknown" && (
                <div className="grid gap-4 rounded-lg border border-destructive/30 p-3" data-testid="shipment-unknown">
                  <p className="text-sm">Booking ulang dikunci. Buka daftar order di akun kurir, lalu pilih salah satu:</p>
                  <form action={linkUnknownBookingAction.bind(null, o.id)} className="grid gap-2" aria-label="Tautkan order kurir">
                    <CsrfField />
                    <p className="text-sm font-medium">Order ada di akun kurir: tautkan</p>
                    <div className="grid gap-2">
                      <Label htmlFor="providerOrderId">ID order kurir</Label>
                      <Input id="providerOrderId" name="providerOrderId" required minLength={3} maxLength={64} autoComplete="off" aria-describedby="link-help" />
                      <p id="link-help" className="text-xs text-muted-foreground">Resi dan status diambil dari akun kurir toko; pesanan berpindah ke &ldquo;Dikirim&rdquo; setelah resinya terbaca.</p>
                    </div>
                    <SubmitButton variant="outline" className="justify-self-start" pendingText="Menautkan…">Tautkan order</SubmitButton>
                  </form>
                  <form action={releaseUnknownBookingAction.bind(null, o.id)} className="grid gap-2 border-t pt-4" aria-label="Lepaskan booking">
                    <CsrfField />
                    <Label htmlFor="releaseReason">Tidak ada order di akun kurir: lepaskan booking</Label>
                    <Input id="releaseReason" name="reason" required minLength={5} maxLength={300} placeholder="mis. Daftar order akun kurir sudah dicek, kosong" />
                    <ConfirmSubmit variant="destructive" className="justify-self-start" message={`Lepaskan booking pesanan #${o.id}? Pastikan akun kurir tidak memuat order untuk paket ini, agar tidak terbit dua order.`}>
                      Lepaskan booking
                    </ConfirmSubmit>
                  </form>
                </div>
              )}
              {fulfil && ((RETRYABLE as readonly string[]).includes(shipmentRow.status) || (shipmentRow.providerOrderId && !(TERMINAL as readonly string[]).includes(shipmentRow.status))) && (
                <div className="flex flex-wrap items-end gap-2">
                  {(RETRYABLE as readonly string[]).includes(shipmentRow.status) && bookable && (
                    <form action={bookShipmentAction.bind(null, o.id)} className="grid gap-2">
                      <CsrfField />
                      {ownAccount && <PickupChoice current={shipmentRow.pickupType} />}
                      <SubmitButton className="justify-self-start" pendingText="Mengantre…">Coba lagi</SubmitButton>
                    </form>
                  )}
                  {shipmentRow.providerOrderId && !(TERMINAL as readonly string[]).includes(shipmentRow.status) && (
                    <form action={refreshTrackingAction.bind(null, o.id)}>
        <CsrfField />
                      <SubmitButton variant="outline" pendingText="Meminta…">Perbarui status</SubmitButton>
                    </form>
                  )}
                </div>
              )}
              <ol className="divide-y rounded-lg border text-sm" aria-label="Riwayat pengiriman" data-testid="shipment-timeline">
                {shipmentTimeline(shipmentRow).map((t, i) => (
                  <li key={i} className="grid gap-0.5 p-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
                    {typeof t.at === "string" ? (
                      <span className="text-muted-foreground tabular-nums">{t.at ? `${t.at} WIB` : "—"}</span>
                    ) : (
                      <time dateTime={t.at.toISOString()} className="text-muted-foreground">{tanggal(t.at)}</time>
                    )}
                    <span className="break-words">{t.text}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <section aria-labelledby="buyer" className="grid content-start gap-1.5 rounded-lg border p-4 text-sm">
          <h2 id="buyer" className="text-base font-semibold">Pembeli & Pengiriman</h2>
          <p className="font-medium">{o.buyerName}</p>
          <p><a href={`tel:${o.buyerPhone}`} className="underline underline-offset-4">{o.buyerPhone}</a></p>
          <p className="whitespace-pre-line text-muted-foreground">{o.shippingAddress}</p>
          <p className="text-muted-foreground">Area: {o.destinationAreaLabel}</p>
          <p className="text-muted-foreground">Kurir: {o.courier} <span className="font-mono text-xs">({o.courierCode})</span> · {o.weightKg} kg</p>
          <p className="text-muted-foreground" data-testid="order-shipping-account">
            {ownAccount ? "Akun kurir: milik toko Anda" : `Akun Bukalaris Kirim: ${o.shippingAccountKind === "partner_managed" ? "Akun khusus toko Anda" : "Akun induk Bukalaris Kirim"}`}
          </p>
          {o.trackingNumber && <p>Resi: <span className="font-mono font-medium" data-testid="tracking">{o.trackingNumber}</span></p>}
          {o.status === "returned" && (
            <p className="mt-1 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
              Paket dikembalikan ke penjual (RTS). Stok setiap barang sudah dikembalikan ke inventaris.
            </p>
          )}
        </section>
        <section aria-labelledby="payment" className="grid content-start gap-1.5 rounded-lg border p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="payment" className="text-base font-semibold">Pembayaran</h2>
            <StatusBadge
              label={
                o.paymentMethod === "cod"
                  ? o.status === "completed"
                    ? "COD diterima kurir"
                    : o.status === "cancelled" || o.status === "returned"
                      ? "COD tidak tertagih"
                      : "Bayar saat terima"
                  : o.paidAt || o.payment?.status === "paid"
                    ? "Sudah dibayar"
                    : o.status === "cancelled"
                      ? "Dibatalkan"
                      : "Belum dibayar"
              }
              tone={
                o.paymentMethod === "cod"
                  ? o.status === "completed"
                    ? "success"
                    : o.status === "cancelled" || o.status === "returned"
                      ? "outline"
                      : "warning"
                  : o.paidAt || o.payment?.status === "paid"
                    ? "success"
                    : o.status === "cancelled"
                      ? "outline"
                      : "warning"
              }
            />
          </div>
          <p className="font-medium">{paymentLabel[o.paymentMethod]}</p>
          {o.payment ? (
            <p className="text-muted-foreground" data-testid="payment-attempt">
              {o.payment.channelCode} · Total tagihan {rupiah(o.payment.totalIdr)} (termasuk biaya layanan {rupiah(o.payment.adminFeeIdr)}) ·{" "}
              {o.payment.status === "paid"
                ? "terverifikasi"
                : o.paidAt
                  ? "dikonfirmasi manual oleh penjual"
                  : o.payment.requestState === "failed"
                    ? "instruksi gagal dibuat"
                    : o.payment.requestState === "unknown"
                      ? "menunggu pengecekan ke penyedia"
                      : o.payment.requestState === "in_progress"
                        ? "instruksi sedang disiapkan"
                        : "menunggu pembayaran"}
            </p>
          ) : (
            <p className="text-muted-foreground">Tagihan online: —</p>
          )}
          {o.paidAt && <p className="text-muted-foreground">Dikonfirmasi dibayar {tanggal(o.paidAt)}</p>}
          {o.confirmedAt && <p className="text-muted-foreground">Pesanan COD dikonfirmasi {tanggal(o.confirmedAt)}</p>}
          {o.paymentMethod === "cod" && !o.paidAt && (
            <p className="text-muted-foreground">
              {o.status === "completed"
                ? "COD: paket sudah diterima pembeli; dana masuk ke Dana dalam Proses sampai direkonsiliasi ke Saldo Tersedia."
                : o.status === "cancelled" || o.status === "returned"
                  ? "COD: pesanan batal atau kembali ke toko (RTS), tidak ada uang yang ditagih."
                  : "COD: uang diterima kurir saat barang sampai, belum tercatat sebagai pembayaran."}
            </p>
          )}
        </section>
      </div>

      <section aria-labelledby="lines" className="grid gap-2">
        <h2 id="lines" className="text-base font-semibold">Barang</h2>
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
          {o.goodsDiscount > 0 && <><dt>Diskon barang (dibiayai toko)</dt><dd className="text-right" data-testid="order-goods-discount">−{rupiah(o.goodsDiscount)}</dd></>}
          <dt>Ongkir{o.shippingDiscount > 0 && <span className="font-normal text-muted-foreground"> (diskon ongkir dibiayai toko {rupiah(o.shippingDiscount)})</span>}</dt><dd className="text-right">{rupiah(o.shippingFee)}</dd>
          <dt className="font-semibold">Total</dt><dd className="text-right font-semibold" data-testid="order-total">{rupiah(o.total)}</dd>
        </dl>
      </section>

      <section aria-labelledby="history" className="grid gap-2">
        <h2 id="history" className="text-base font-semibold">Riwayat status</h2>
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

/** T-105 (ADR-0013 decision 28): how the parcel reaches the courier, chosen on every booking request. */
function PickupChoice({ current = "scheduled_pickup" }: { current?: string }) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1 text-sm font-medium">Cara serah paket</legend>
      {pickupChoices.map((c) => (
        <label key={c.value} className="flex min-h-6 items-center gap-2 text-sm">
          <input type="radio" name="pickupType" value={c.value} defaultChecked={current === c.value} required className="size-4 accent-foreground" />
          {c.label}
        </label>
      ))}
    </fieldset>
  );
}
