import { rupiah } from "@/lib/format";
import { ORDER_COOKIE } from "@/lib/storefront";
import { db, getBuyerOrder } from "@bukalaris/db";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

export default async function ConfirmationPage({ searchParams }: PageProps<"/checkout/confirmation">) {
  const { order } = await searchParams;
  const id = typeof order === "string" && /^[0-9]{1,15}$/.test(order) ? Number(order) : null;
  const o = id ? await getBuyerOrder(db(), id, (await cookies()).get(ORDER_COOKIE)?.value) : null;
  if (!o) notFound();
  return (
    <section className="grid gap-4 rounded-lg border bg-background p-6" aria-labelledby="done">
      <h1 id="done" className="text-2xl font-semibold">Pesanan diterima</h1>
      <p>
        Nomor pesanan <strong data-testid="order-id">#{o.id}</strong> di {o.storeName}.
      </p>
      <p role="status">
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
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t pt-2 text-sm">
        <dt>Subtotal</dt><dd className="text-right">{rupiah(o.subtotal)}</dd>
        <dt>Ongkir ({o.courier})</dt><dd className="text-right">{rupiah(o.shippingFee)}</dd>
        <dt className="font-semibold">Total</dt><dd className="text-right font-semibold" data-testid="order-total">{rupiah(o.total)}</dd>
      </dl>
      <a href={`/s/${o.storeSlug}`} className="text-sm underline">Kembali ke toko</a>
    </section>
  );
}
