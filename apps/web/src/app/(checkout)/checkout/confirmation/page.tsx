import { Pixels } from "@/components/pixels/pixels";
import { SignalEvent } from "@/components/pixels/runtime";
import { rupiah } from "@/lib/format";
import { browserMatch, signalsFor } from "@/lib/signals";
import { ORDER_COOKIE } from "@/lib/storefront";
import { channelReturnTarget, db, getBuyerOrder, purchaseEventId } from "@bukalaris/db";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

/** The provider returns `YYYYMMDDHHMMSS` in WIB or a ready-made stamp: show the first as `dd/mm/yyyy hh:mm WIB`, anything else as returned. */
const wibStamp = (s: string) => {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}$/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]} WIB` : s;
};

export default async function ConfirmationPage({ searchParams }: PageProps<"/checkout/confirmation">) {
  const { order } = await searchParams;
  const id = typeof order === "string" && /^[0-9]{1,15}$/.test(order) ? Number(order) : null;
  const cartId = (await cookies()).get(ORDER_COOKIE)?.value;
  const o = id ? await getBuyerOrder(db(), id, cartId) : null;
  if (!o) notFound();
  // Headless buyers return to the channel's registered origin + path (allowlist, channels track).
  const back = (await channelReturnTarget(db(), cartId)) ?? `/s/${o.storeSlug}`;
  const signals = await signalsFor(o.storeId);
  const match = signals ? browserMatch(o) : undefined;
  return (
    <section className="mx-auto grid w-full max-w-2xl gap-4 rounded-xl border bg-background p-6" aria-labelledby="done" data-purchase-event={o.paymentMethod === "cod" && signals ? purchaseEventId(o.id) : undefined}>
      <Pixels storeId={o.storeId} match={match} />
      {signals && o.paymentMethod === "cod" && (
        <SignalEvent
          config={signals}
          store={o.storeSlug}
          name="Purchase"
          eventId={purchaseEventId(o.id)}
          orderId={String(o.id)}
          items={o.lines.map((l) => ({ id: l.variantCatalogId, quantity: l.quantity, price: l.unitPrice }))}
          value={o.subtotal}
          match={match}
          serverLeg={false}
        />
      )}
      <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Terima kasih</p>
      <h1 id="done" className="-mt-2 text-2xl font-semibold tracking-tight">Pesanan diterima</h1>
      <p>
        Nomor pesanan <strong data-testid="order-id" className="select-all font-mono">#{o.id}</strong> di {o.storeName}. Simpan nomor ini untuk menanyakan status pesanan.
      </p>
      <p role="status" className="rounded-lg bg-muted/60 p-3" data-testid="payment-status">
        {o.paymentMethod === "cod"
          ? "Bayar di tempat (COD) saat barang tiba. Penjual akan menghubungi nomor HP Anda untuk konfirmasi sebelum pesanan dikirim."
          : !o.payment
            ? "Menunggu pembayaran. Instruksi pembayaran sedang disiapkan — muat ulang halaman ini nanti."
            : o.payment.status === "paid"
              ? "Pembayaran terverifikasi. Terima kasih."
              : o.payment.requestState === "failed"
                ? "Instruksi pembayaran tidak dapat dibuat. Hubungi penjual atau buat pesanan baru."
                : o.payment.requestState === "unknown"
                  ? "Instruksi pembayaran sedang kami periksa ke penyedia pembayaran. Jangan membayar sebelum instruksi tampil; muat ulang halaman ini nanti."
                  : o.payment.requestState === "in_progress"
                    ? "Menunggu pembayaran. Instruksi pembayaran sedang disiapkan — muat ulang halaman ini nanti."
                    : "Menunggu pembayaran. Selesaikan pembayaran sebelum batas waktu di bawah."}
      </p>
      {o.payment?.instruction && o.payment.status !== "paid" && (
        <section aria-labelledby="instruksi" className="grid gap-2 rounded-lg border p-3 text-sm" data-testid="payment-instruction">
          <h2 id="instruksi" className="font-medium">Instruksi pembayaran · {o.payment.channelCode}</h2>
          {o.payment.instruction.virtualAccount && <p>Nomor virtual account: <strong className="select-all font-mono" data-testid="payment-va">{o.payment.instruction.virtualAccount}</strong></p>}
          {o.payment.instruction.paymentCode && <p>Kode pembayaran: <strong className="select-all font-mono" data-testid="payment-code">{o.payment.instruction.paymentCode}</strong></p>}
          {o.payment.instruction.url && (
            <p><a href={o.payment.instruction.url} rel="noopener noreferrer" className="underline underline-offset-4" data-testid="payment-url">Buka halaman pembayaran</a></p>
          )}
          {o.payment.instruction.qr && (
            <label className="grid gap-1">
              <span>Kode QR (isi QRIS apa adanya)</span>
              <textarea readOnly rows={4} defaultValue={o.payment.instruction.qr} className="w-full rounded-md border bg-muted/40 p-2 font-mono text-xs" data-testid="payment-qr" />
            </label>
          )}
          <p className="text-muted-foreground">Bayar sebelum <span data-testid="payment-expiry">{wibStamp(o.payment.instruction.expiresAt)}</span>. Tagihan tertera di atas termasuk biaya layanan.</p>
        </section>
      )}
      <ul className="divide-y text-sm">
        {o.lines.map((l) => (
          <li key={l.variantId} className="flex justify-between gap-4 py-2">
            <span>{l.productTitle} · {l.variantTitle} × {l.quantity}</span>
            <span>{rupiah(l.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground" data-testid="shipping-route">
        Dikirim dengan <strong className="font-medium text-foreground">{o.courier}</strong> ke {o.destinationAreaLabel}.
      </p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t pt-2 text-sm tabular-nums">
        <dt>Subtotal</dt><dd className="text-right">{rupiah(o.subtotal)}</dd>
        {o.goodsDiscount > 0 && <><dt>Diskon barang</dt><dd className="text-right" data-testid="order-goods-discount">−{rupiah(o.goodsDiscount)}</dd></>}
        <dt>Ongkir{o.shippingDiscount > 0 && <span className="font-normal text-muted-foreground"> (diskon ongkir {rupiah(o.shippingDiscount)})</span>}</dt><dd className="text-right" data-testid="order-shipping">{rupiah(o.shippingFee)}</dd>
        <dt className="font-semibold">Total</dt><dd className="text-right font-semibold" data-testid="order-total">{rupiah(o.total)}</dd>
        {o.payment && (
          <>
            <dt>Biaya layanan pembayaran</dt><dd className="text-right" data-testid="payment-fee">{rupiah(o.payment.adminFeeIdr)}</dd>
            <dt className="font-semibold">Total tagihan</dt><dd className="text-right font-semibold" data-testid="payment-total">{rupiah(o.payment.totalIdr)}</dd>
          </>
        )}
      </dl>
      <a href={back} className="text-sm underline underline-offset-4" data-testid="return-link">Kembali ke toko</a>
    </section>
  );
}
