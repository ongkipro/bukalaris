import { Notice } from "@/components/notice";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { rupiah } from "@/lib/format";
import { cartCookie } from "@/lib/storefront";
import { checkoutShippingOptions, checkoutSummary, db, DomainError, searchDestinationAreas, storefrontScope, type Area, type ShippingOption } from "@bukalaris/db";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { submitCheckout } from "./actions";

const optionClass =
  "flex cursor-pointer items-center gap-3 rounded-lg border p-3 has-checked:border-foreground has-checked:bg-muted/40 has-focus-visible:ring-3 has-focus-visible:ring-ring/50";
const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * Hosted checkout. Step 1 (GET, works without JS): search the destination area through
 * the provider adapter and pick one (`?q=…&area=<id>`). Step 2: courier options quoted
 * server-side for that route, recipient data, payment, submit. Money never comes from the client.
 */
export default async function CheckoutPage({ searchParams }: PageProps<"/checkout">) {
  const sp = await searchParams;
  // The store comes from the URL only to pick which cart cookie to read; the cart row
  // itself must belong to that active store.
  const scope = typeof sp.store === "string" ? await storefrontScope(db(), sp.store) : null;
  if (!scope) return <p role="alert" className="rounded-lg border bg-background p-6">Toko tidak tersedia atau sedang tidak menerima pesanan.</p>;
  const found = await checkoutSummary(db(), (await cookies()).get(cartCookie(scope.storeId))?.value);
  const summary = found?.storeId === scope.storeId ? found : null;
  if (!summary) return <p className="rounded-lg border bg-background p-6">Keranjang kosong atau sudah di-checkout.</p>;
  if (summary.store.status !== "active")
    return <p role="alert" className="rounded-lg border bg-background p-6">{summary.store.name} sedang tidak menerima pesanan.</p>;

  const q = str(sp.q).trim();
  let results: Area[] = [];
  let searchError: string | undefined;
  if (q) {
    try {
      results = await searchDestinationAreas(q);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      searchError = err.message;
    }
  }
  // The chosen area must be one of the current results, so its label is the provider's, not the URL's.
  const area = results.find((a) => a.id === str(sp.area)) ?? null;
  let options: ShippingOption[] = [];
  let quoteError: string | undefined;
  if (area && summary.canShip) {
    try {
      ({ options } = await checkoutShippingOptions(scope, area.id, { items: summary.lines.length, subtotal: summary.subtotal }));
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      quoteError = err.message;
    }
  }
  const codOffered = options.some((o) => o.cod !== null);
  const defaultCourier = options.find((o) => o.cod !== null) ?? options[0];
  const here = `/checkout?store=${encodeURIComponent(scope.storeSlug)}`;
  const pick = (id: string) => `${here}&q=${encodeURIComponent(q)}&area=${id}`;

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Checkout · {summary.store.name}</h1>
      <Notice error={str(sp.error) || undefined} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="ringkasan" className="rounded-xl border bg-background p-4 lg:sticky lg:top-6 lg:order-2">
          <h2 id="ringkasan" className="mb-2 font-medium">Ringkasan pesanan</h2>
          <ul className="divide-y text-sm">
            {summary.lines.map((l) => (
              <li key={l.variantId} className="flex justify-between gap-4 py-2">
                <span className="min-w-0">{l.productTitle} · {l.variantTitle} × {l.quantity}</span>
                <span className="shrink-0 tabular-nums">{rupiah(l.price * l.quantity)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 flex justify-between border-t pt-2 font-medium">
            <span>Subtotal</span>
            <span data-testid="subtotal" className="tabular-nums">{rupiah(summary.subtotal)}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Ongkir ditambahkan sesuai kurir yang dipilih.</p>
        </section>

        <div className="grid gap-6 lg:order-1">
          <section aria-labelledby="tujuan" className="grid gap-4 rounded-xl border bg-background p-4 sm:p-6">
            <h2 id="tujuan" className="font-medium">1. Area tujuan</h2>
            {!summary.canShip ? (
              <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                Toko ini belum mengatur area pickup, jadi ongkir belum bisa dihitung dan pesanan belum bisa dibuat. Hubungi penjual.
              </p>
            ) : (
              <>
                <form method="get" action="/checkout" className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                  <input type="hidden" name="store" value={scope.storeSlug} />
                  <div className="grid gap-2">
                    <Label htmlFor="q">Cari kelurahan, kecamatan atau kota tujuan</Label>
                    <Input id="q" name="q" type="search" defaultValue={q} minLength={3} required placeholder="mis. Menteng" autoComplete="off" />
                  </div>
                  <Button type="submit" variant="outline">Cari area</Button>
                </form>
                {searchError && <p role="alert" className="text-sm text-destructive">{searchError}</p>}
                {q && !searchError && !area && (
                  <ul aria-label="Hasil pencarian area" className="grid gap-2">
                    {results.length === 0 && <li className="text-sm text-muted-foreground">Area tidak ditemukan. Coba nama kecamatan atau kota.</li>}
                    {results.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                        <span>{a.label}</span>
                        <a href={pick(a.id)} className={buttonVariants({ size: "sm" })} aria-label={`Pilih ${a.label}`}>Pilih</a>
                      </li>
                    ))}
                  </ul>
                )}
                {area && (
                  <p className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="destination-area">
                    <span><span className="text-muted-foreground">Dikirim ke:</span> {area.label}</span>
                    <a href={`${here}&q=${encodeURIComponent(q)}`} className="underline underline-offset-4">Ubah</a>
                  </p>
                )}
              </>
            )}
          </section>

          {area && summary.canShip && (
            <form action={submitCheckout} className="grid gap-6 rounded-xl border bg-background p-4 sm:p-6">
              {/* Same key across double-clicks/resubmits of this render: the server returns the same order. */}
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <input type="hidden" name="store" value={scope.storeSlug} />
              <input type="hidden" name="q" value={q} />
              <input type="hidden" name="destinationAreaId" value={area.id} />
              <input type="hidden" name="destinationAreaLabel" value={area.label} />
              <fieldset className="grid gap-2">
                <legend className="mb-2 font-medium">2. Kurir</legend>
                {quoteError && <p role="alert" className="text-sm text-destructive">{quoteError}</p>}
                {!quoteError && options.length === 0 && (
                  <p role="alert" className="text-sm text-destructive">Belum ada kurir yang melayani area ini. Coba area lain.</p>
                )}
                {options.map((o) => (
                  <label key={o.courier} className={optionClass}>
                    <input type="radio" name="courier" value={o.courier} defaultChecked={o.courier === defaultCourier?.courier} required />
                    <span className="min-w-0 flex-1">
                      {o.label}
                      {o.etd && <span className="block text-xs text-muted-foreground">Estimasi {o.etd}</span>}
                    </span>
                    <span className="text-right text-sm tabular-nums">
                      <span className="block">Transfer {rupiah(o.prepaid.buyerFee)}</span>
                      <span className="block text-xs text-muted-foreground">{o.cod ? `COD ${rupiah(o.cod.buyerFee)}` : "Tidak melayani COD"}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="grid gap-4">
                <legend className="mb-2 font-medium">3. Data penerima</legend>
                <div className="grid gap-2">
                  <Label htmlFor="buyerName">Nama</Label>
                  <Input id="buyerName" name="buyerName" autoComplete="name" required minLength={2} maxLength={120} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="buyerPhone">Nomor HP</Label>
                  <Input id="buyerPhone" name="buyerPhone" type="tel" autoComplete="tel" inputMode="tel" required pattern="\+?[0-9]{8,15}" aria-describedby="phone-help" />
                  <p id="phone-help" className="text-xs text-muted-foreground">Angka saja, 8–15 digit. Penjual menghubungi nomor ini untuk konfirmasi.</p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="shippingAddress">Alamat lengkap</Label>
                  <Textarea id="shippingAddress" name="shippingAddress" autoComplete="street-address" required minLength={10} maxLength={500} rows={3} aria-describedby="address-help" />
                  <p id="address-help" className="text-xs text-muted-foreground">Nama jalan, nomor rumah, RT/RW dan patokan di {area.label.split(",")[0]}.</p>
                </div>
              </fieldset>
              <fieldset className="grid gap-2">
                <legend className="mb-2 font-medium">4. Pembayaran</legend>
                {codOffered && (
                  <label className={optionClass}>
                    <input type="radio" name="paymentMethod" value="cod" defaultChecked required />
                    <span className="flex-1">
                      Bayar di tempat (COD)
                      <span className="block text-xs text-muted-foreground">Penjual mengonfirmasi pesanan lewat telepon/WA sebelum dikirim.</span>
                    </span>
                  </label>
                )}
                <label className={optionClass}>
                  <input type="radio" name="paymentMethod" value="manual_transfer" defaultChecked={!codOffered} required />
                  <span>Transfer bank (simulasi, tanpa transaksi nyata)</span>
                </label>
                {!codOffered && options.length > 0 && <p className="text-xs text-muted-foreground">COD tidak tersedia untuk area ini.</p>}
              </fieldset>
              <p className="text-sm text-muted-foreground">Harga, stok dan ongkir dicek ulang oleh server saat pesanan dibuat.</p>
              <Button type="submit" size="lg" className="h-11 text-base sm:justify-self-start sm:px-8" disabled={options.length === 0}>
                Buat pesanan
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
