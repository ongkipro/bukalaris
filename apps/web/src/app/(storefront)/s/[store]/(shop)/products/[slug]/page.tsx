import { fieldClass, Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SignalEvent } from "@/components/pixels/runtime";
import { rupiah } from "@/lib/format";
import { signalsFor } from "@/lib/signals";
import { canonicalSlug, getPublishedProduct, publishedProductImages } from "@bukalaris/db";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { StoreImage } from "../../_components/store-image";
import { storeShell } from "../../_lib";
import { addToCart } from "../../actions";

export async function generateMetadata({ params }: PageProps<"/s/[store]/products/[slug]">): Promise<Metadata> {
  const { store, slug } = await params;
  const { scope, base } = await storeShell(store);
  const p = await getPublishedProduct(scope, slug);
  if (!p) return { title: scope.storeName };
  const canonical = `${base}/products/${canonicalSlug(p)}`;
  const minPrice = Math.min(...p.variants.map((v) => v.price));
  const description = (p.description?.trim().replace(/\s+/g, " ").slice(0, 160)) || `${p.title} di ${scope.storeName} — mulai ${rupiah(minPrice)}.`;
  return {
    title: `${p.title} — ${scope.storeName}`,
    description,
    alternates: { canonical },
    openGraph: {
      title: `${p.title} — ${scope.storeName}`,
      description,
      url: canonical,
      type: "website",
    },
  };
}
export default async function ProductPage({ params, searchParams }: PageProps<"/s/[store]/products/[slug]">) {
  const { store, slug } = await params;
  const { error } = await searchParams;
  const { scope, base } = await storeShell(store);
  const p = await getPublishedProduct(scope, slug);
  if (!p) notFound();
  if (canonicalSlug(p) !== slug) permanentRedirect(`${base}/products/${canonicalSlug(p)}`);
  const images = await publishedProductImages(scope, p.id);
  const sellable = p.variants.filter((v) => v.stock > 0);
  const signals = await signalsFor(scope.storeId);
  const viewed = sellable[0] ?? p.variants[0];
  const prices = p.variants.map((v) => v.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const canonical = `${base}/products/${canonicalSlug(p)}`;
  const seoDescription = (p.description?.trim().replace(/\s+/g, " ").slice(0, 160)) || `${p.title} di ${scope.storeName} — mulai ${rupiah(min)}.`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.title,
    description: seoDescription,
    productID: p.catalogId,
    sku: viewed?.catalogId ?? p.catalogId,
    url: canonical,
    offers: {
      "@type": p.variants.length > 1 ? "AggregateOffer" : "Offer",
      priceCurrency: "IDR",
      price: min,
      lowPrice: min,
      highPrice: max,
      offerCount: p.variants.length,
      availability: sellable.length > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    },
  };

  return (
    <article className="grid gap-8 @3xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] @3xl:gap-12">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      {signals && viewed && <SignalEvent config={signals} store={scope.storeSlug} name="ViewContent" items={[{ id: viewed.catalogId, quantity: 1, price: viewed.price }]} value={viewed.price} />}
      <div className="grid gap-3">
        <StoreImage base={base} image={images[0]} priority className="aspect-square w-full rounded-xl" fallbackLabel={`Belum ada foto untuk ${p.title}`} />
        {images.length > 1 && (
          <ul className="grid grid-cols-4 gap-2 @3xl:grid-cols-5" aria-label="Foto lainnya">
            {images.slice(1).map((img) => (
              <li key={img.id}>
                <StoreImage base={base} image={img} className="aspect-square w-full rounded-lg" />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid content-start gap-5">
        <div className="grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-balance @3xl:text-3xl">{p.title}</h1>
          <p className="text-xl font-medium tabular-nums" data-testid="price">
            {rupiah(min)}
            {max > min && <span className="text-base font-normal text-muted-foreground"> – {rupiah(max)}</span>}
          </p>
        </div>
        <Notice error={error} />
        {sellable.length === 0 ? (
          <p role="status" className="rounded-lg bg-muted p-3 font-medium">Stok habis.</p>
        ) : (
          <form action={addToCart.bind(null, store, `/products/${slug}`)} className="grid gap-5">
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">Varian</legend>
              {p.variants.map((v) => (
                <label key={v.id} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 has-checked:border-foreground has-checked:bg-muted/40 has-disabled:cursor-not-allowed has-disabled:opacity-50 has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
                  <input type="radio" name="variantId" value={v.id} defaultChecked={v.id === sellable[0]!.id} disabled={v.stock === 0} required className="accent-foreground" />
                  <span className="flex-1 font-medium">{v.title}</span>
                  <span className="text-sm tabular-nums">{rupiah(v.price)}</span>
                  <span className="text-xs text-muted-foreground">{v.stock > 0 ? `stok ${v.stock}` : "habis"}</span>
                </label>
              ))}
            </fieldset>
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid w-24 gap-2">
                <Label htmlFor="quantity">Jumlah</Label>
                <input id="quantity" name="quantity" type="number" inputMode="numeric" min={1} max={99} defaultValue={1} required className={`${fieldClass} h-11 text-base`} />
              </div>
              <Button type="submit" size="lg" className="h-11 flex-1 px-6 text-base">Tambah ke keranjang</Button>
            </div>
          </form>
        )}
        {p.description && (
          <section aria-labelledby="deskripsi" className="grid gap-2 border-t pt-5">
            <h2 id="deskripsi" className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Deskripsi</h2>
            <p className="whitespace-pre-line text-pretty leading-relaxed">{p.description}</p>
          </section>
        )}
      </div>
    </article>
  );
}
