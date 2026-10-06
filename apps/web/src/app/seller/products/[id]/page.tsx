import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { sellerScope } from "@/lib/context";
import { canonicalSlug, getProduct } from "@bukalaris/db";
import { notFound } from "next/navigation";
import { addVariantAction, updateProductAction, updateVariantAction } from "../../actions";
import { ProductFields, VariantFields } from "../product-fields";

export default async function ProductPage({ params, searchParams }: PageProps<"/seller/products/[id]">) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const productId = /^[0-9]{1,15}$/.test(id) ? Number(id) : NaN;
  const p = Number.isSafeInteger(productId) ? await getProduct(scope, productId) : null;
  if (!p) notFound();
  const url = `/s/${scope.storeSlug}/products/${canonicalSlug(p)}`;

  return (
    <section className="grid max-w-3xl gap-8">
      <div>
        <h1 className="text-2xl font-semibold">{p.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          ID produk <span className="font-mono" data-testid="product-id">{p.id}</span> ·{" "}
          {p.status === "active" ? <a href={url} className="underline">{url}</a> : <span>{url} (belum aktif)</span>}
        </p>
      </div>
      <Notice error={error} saved={saved} />
      <form action={updateProductAction.bind(null, p.id)} className="grid gap-4">
        <ProductFields d={p} idHint={String(p.id)} />
        <div>
          <Button type="submit">Simpan produk</Button>
        </div>
      </form>

      <section aria-labelledby="variants" className="grid gap-4">
        <h2 id="variants" className="text-lg font-semibold">Varian</h2>
        {p.variants.map((v) => (
          <form key={v.id} action={updateVariantAction.bind(null, p.id, v.id)} className="grid gap-3 rounded-lg border p-4">
            <VariantFields prefix={`v${v.id}_`} d={v} />
            <div>
              <Button type="submit" variant="outline" size="sm">Simpan varian</Button>
            </div>
          </form>
        ))}
        <form action={addVariantAction.bind(null, p.id)} className="grid gap-3 rounded-lg border border-dashed p-4">
          <h3 className="text-sm font-medium">Tambah varian</h3>
          <VariantFields prefix="new_" />
          <div>
            <Button type="submit" variant="outline" size="sm">Tambah varian</Button>
          </div>
        </form>
      </section>
    </section>
  );
}
