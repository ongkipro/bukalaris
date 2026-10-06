import { rupiah } from "@/lib/format";
import { ORDER_COOKIE } from "@/lib/storefront";
import { channelReturnTarget, db, getBuyerOrder } from "@bukalaris/db";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

export default async function ConfirmationPage({ searchParams }: PageProps<"/checkout/confirmation">) {
  const { order } = await searchParams;
  const id = typeof order === "string" && /^[0-9]{1,15}$/.test(order) ? Number(order) : null;
  const cartId = (await cookies()).get(ORDER_COOKIE)?.value;
  const o = id ? await getBuyerOrder(db(), id, cartId) : null;
  if (!o) notFound();
  // Headless buyers return to the channel's registered origin + path (allowlist, channels track).
  const back = (await channelReturnTarget(db(), cartId)) ?? `/s/${o.storeSlug}`;
  return (
    <section className="mx-auto grid w-full max-w-2xl gap-4 rounded-xl border bg-background p-6" aria-labelledby="done">
      <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Terima kasih</p>
      <h1 id="done" className="-mt-2 text-2xl font-semibold tracking-tight">Pesanan diterima</h1>
      <p>
        Nomor pesanan <strong data-testid="order-id" className="select-all font-mono">#{o.id}</strong> di {o.storeName}. Simpan nomor ini untuk menanyakan status pesanan.
      </p>
      <p role="status" className="rounded-lg bg-muted/60 p-3">
        {o.paymentMethod === "cod"
          ? "Bayar di tempat (COD) saat barang tiba."
          : o.paymentReference
            ? `Menunggu pembayaran. Kode referensi simulasi: ${o.paymentReference}.`
            : "Menunggu pembayaran. Instruksi pembayaran sedang disiapkan — muat ulang halaman ini nanti."}
      </p>
      <ul className="divide-y text-sm">
        {o.lines.map((l) => (
          <li key={l.variantId} className="flex justify-between gap-4 py-2">
            <span>{l.productTitle} · {l.variantTitle} × {l.quantity}</span>
            <span>{rupiah(l.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t pt-2 text-sm tabular-nums">
        <dt>Subtotal</dt><dd className="text-right">{rupiah(o.subtotal)}</dd>
        <dt>Ongkir ({o.courier})</dt><dd className="text-right">{rupiah(o.shippingFee)}</dd>
        <dt className="font-semibold">Total</dt><dd className="text-right font-semibold" data-testid="order-total">{rupiah(o.total)}</dd>
      </dl>
      <a href={back} className="text-sm underline underline-offset-4" data-testid="return-link">Kembali ke toko</a>
    </section>
  );
}
