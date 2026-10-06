import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { rupiah } from "@/lib/format";
import { cartCookie } from "@/lib/storefront";
import { checkoutSummary, db, storefrontScope } from "@bukalaris/db";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { submitCheckout } from "./actions";

export default async function CheckoutPage({ searchParams }: PageProps<"/checkout">) {
  const { error, store } = await searchParams;
  // The store comes from the URL only to pick which cart cookie to read; the cart row
  // itself must belong to that active store.
  const scope = typeof store === "string" ? await storefrontScope(db(), store) : null;
  if (!scope) return <p role="alert" className="rounded-lg border bg-background p-6">Toko tidak tersedia atau sedang tidak menerima pesanan.</p>;
  const found = await checkoutSummary(db(), (await cookies()).get(cartCookie(scope.storeId))?.value);
  const summary = found?.storeId === scope.storeId ? found : null;
  if (!summary) return <p className="rounded-lg border bg-background p-6">Keranjang kosong atau sudah di-checkout.</p>;
  if (summary.store.status !== "active")
    return <p role="alert" className="rounded-lg border bg-background p-6">{summary.store.name} sedang tidak menerima pesanan.</p>;

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Checkout · {summary.store.name}</h1>
      <Notice error={error} />
      <section aria-labelledby="ringkasan" className="rounded-lg border bg-background p-4">
        <h2 id="ringkasan" className="mb-2 font-medium">Ringkasan pesanan</h2>
        <ul className="divide-y text-sm">
          {summary.lines.map((l) => (
            <li key={l.variantId} className="flex justify-between gap-4 py-2">
              <span>{l.productTitle} · {l.variantTitle} × {l.quantity}</span>
              <span>{rupiah(l.price * l.quantity)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 flex justify-between border-t pt-2 font-medium">
          <span>Subtotal</span>
          <span data-testid="subtotal">{rupiah(summary.subtotal)}</span>
        </p>
      </section>

      <form action={submitCheckout} className="grid gap-6 rounded-lg border bg-background p-4">
        {/* Same key across double-clicks/resubmits of this render: the server returns the same order. */}
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <input type="hidden" name="store" value={scope.storeSlug} />
        <fieldset className="grid gap-4">
          <legend className="mb-2 font-medium">Data penerima</legend>
          <div className="grid gap-2">
            <Label htmlFor="buyerName">Nama</Label>
            <Input id="buyerName" name="buyerName" autoComplete="name" required minLength={2} maxLength={120} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="buyerPhone">Nomor HP</Label>
            <Input id="buyerPhone" name="buyerPhone" type="tel" autoComplete="tel" inputMode="tel" required pattern="\+?[0-9]{8,15}" aria-describedby="phone-help" />
            <p id="phone-help" className="text-xs text-muted-foreground">Angka saja, 8–15 digit.</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="shippingAddress">Alamat lengkap</Label>
            <Textarea id="shippingAddress" name="shippingAddress" autoComplete="street-address" required minLength={10} maxLength={500} rows={3} />
          </div>
        </fieldset>
        <fieldset className="grid gap-2">
          <legend className="mb-2 font-medium">Pengiriman</legend>
          {summary.options.map((o, i) => (
            <label key={o.courier} className="flex items-center gap-3 rounded-md border p-3 has-checked:border-foreground">
              <input type="radio" name="courier" value={o.courier} defaultChecked={i === 0} required />
              <span className="flex-1">{o.label}</span>
              <span className="text-right text-sm">
                {rupiah(o.fee)}
                <span className="block text-xs text-muted-foreground">Total {rupiah(summary.subtotal + o.fee)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="grid gap-2">
          <legend className="mb-2 font-medium">Pembayaran</legend>
          <label className="flex items-center gap-3 rounded-md border p-3 has-checked:border-foreground">
            <input type="radio" name="paymentMethod" value="cod" defaultChecked required />
            <span>Bayar di tempat (COD)</span>
          </label>
          <label className="flex items-center gap-3 rounded-md border p-3 has-checked:border-foreground">
            <input type="radio" name="paymentMethod" value="manual_transfer" required />
            <span>Transfer bank (simulasi, tanpa transaksi nyata)</span>
          </label>
        </fieldset>
        <p className="text-sm text-muted-foreground">Harga, stok dan ongkir dicek ulang oleh server saat pesanan dibuat.</p>
        <Button type="submit" size="lg">Buat pesanan</Button>
      </form>
    </div>
  );
}
