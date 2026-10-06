import { fieldClass, Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { rupiah } from "@/lib/format";
import { storeOr404 } from "@/lib/storefront";
import { canonicalSlug, getPublishedProduct } from "@bukalaris/db";
import { notFound, permanentRedirect } from "next/navigation";
import { addToCart } from "../../actions";

export default async function ProductPage({ params, searchParams }: PageProps<"/s/[store]/products/[slug]">) {
  const { store, slug } = await params;
  const { error } = await searchParams;
  const { scope, base } = await storeOr404(store);
  const p = await getPublishedProduct(scope, slug);
  if (!p) notFound();
  if (canonicalSlug(p) !== slug) permanentRedirect(`${base}/products/${canonicalSlug(p)}`);
  const sellable = p.variants.filter((v) => v.stock > 0);

  return (
    <article className="grid gap-8 md:grid-cols-2">
      <div className="aspect-square rounded-lg bg-muted" aria-hidden />
      <div className="grid content-start gap-4">
        <h1 className="text-2xl font-semibold">{p.title}</h1>
        <p className="text-xl">{rupiah(Math.min(...p.variants.map((v) => v.price)))}</p>
        {p.description && <p className="whitespace-pre-line text-muted-foreground">{p.description}</p>}
        <Notice error={error} />
        {sellable.length === 0 ? (
          <p className="font-medium">Stok habis.</p>
        ) : (
          <form action={addToCart.bind(null, store, `/products/${slug}`)} className="grid gap-4">
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Varian</legend>
              {p.variants.map((v) => (
                <label key={v.id} className="flex items-center gap-3 rounded-md border p-3 has-checked:border-foreground has-disabled:opacity-50">
                  <input type="radio" name="variantId" value={v.id} defaultChecked={v.id === sellable[0]!.id} disabled={v.stock === 0} required />
                  <span className="flex-1">{v.title}</span>
                  <span className="text-sm">{rupiah(v.price)}</span>
                  <span className="text-xs text-muted-foreground">{v.stock > 0 ? `stok ${v.stock}` : "habis"}</span>
                </label>
              ))}
            </fieldset>
            <div className="grid w-28 gap-2">
              <Label htmlFor="quantity">Jumlah</Label>
              <input id="quantity" name="quantity" type="number" inputMode="numeric" min={1} max={99} defaultValue={1} required className={fieldClass} />
            </div>
            <Button type="submit" size="lg">Tambah ke keranjang</Button>
          </form>
        )}
      </div>
    </article>
  );
}
