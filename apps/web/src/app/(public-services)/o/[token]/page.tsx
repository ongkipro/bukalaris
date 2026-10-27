import { rupiah } from "@/lib/format";
import { BUYER_STATUS_LABEL, db, getOrderForLink, getShipmentForLink, providerStatusLabel, SHIPMENT_STATUS_LABEL, shipmentTimeline } from "@bukalaris/db";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const dt = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });

/**
 * Buyer order status behind a signed, expiring link (`/o/<orderId>.<expiry>.<hmac>`, T-36).
 * Shows that order's status, lines, totals, courier, tracking number and destination area
 * label only — no street address, phone or other orders. Invalid links are a 404 (see not-found.tsx).
 */
export default async function OrderStatusPage({ params }: PageProps<"/o/[token]">) {
  const { token } = await params;
  const o = await getOrderForLink(db(), token);
  if (!o) notFound();
  // Courier tracking (T-39): only when the seller booked through Mengantar; resi alone shows above.
  const s = o.trackingNumber ? await getShipmentForLink(db(), token) : null;
  const tracking = s && s.trackingNumber ? s : null;
  return (
    <section className="grid gap-4 rounded-xl border bg-background p-6" aria-labelledby="status-heading">
      <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">{o.storeName}</p>
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
        <dt>Ongkir</dt><dd className="text-right">{rupiah(o.shippingFee)}</dd>
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
            <span data-testid="tracking-status">{providerStatusLabel(tracking.providerStatus) ?? SHIPMENT_STATUS_LABEL[tracking.status]}</span>
            {tracking.lastTrackedAt && <span className="block text-xs text-muted-foreground">Dicek {dt.format(tracking.lastTrackedAt)} WIB</span>}
          </p>
          <ol className="grid gap-1.5">
            {shipmentTimeline(tracking)
              .slice(1)
              .reverse()
              .map((t, i) => (
                <li key={i} className="grid gap-x-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
                  <span className="text-muted-foreground tabular-nums">{typeof t.at === "string" ? (t.at ? `${t.at} WIB` : "—") : `${dt.format(t.at)} WIB`}</span>
                  <span className="break-words">{t.text}</span>
                </li>
              ))}
          </ol>
        </section>
      )}
      <p className="text-xs text-muted-foreground">Dipesan {dt.format(o.createdAt)} WIB. Hubungi penjual bila ada pertanyaan tentang pesanan ini.</p>
    </section>
  );
}
