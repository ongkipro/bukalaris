import { CsrfField } from "@/lib/auth-csrf-form";
import { CopyButton } from "@/components/copy-button";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { sellerScope } from "@/lib/context";
import { productStatusLabel, productStatusTone } from "@/lib/status";
import { canonicalSlug, getProduct, listCatalogHistory, listProductMedia, storeBaseUrl } from "@bukalaris/db";
import { notFound } from "next/navigation";
import { addVariantAction, updateProductAction, updateVariantAction } from "../../actions";
import { ProductFields, VariantFields } from "../product-fields";
import { ProductHistory } from "../product-history";
import { ProductImages } from "../product-images";

export default async function ProductPage({ params, searchParams }: PageProps<"/seller/products/[id]">) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const productId = /^[0-9]{1,15}$/.test(id) ? Number(id) : NaN;
  const p = Number.isSafeInteger(productId) ? await getProduct(scope, productId) : null;
  if (!p) notFound();
  const [images, history] = await Promise.all([listProductMedia(scope, p.id), listCatalogHistory(scope, p.id)]);
  const url = `${storeBaseUrl(scope.storeSlug)}/products/${canonicalSlug(p)}`;
  // Shown as a path; the link and the copy button carry the absolute URL (host mode or path mode, DOM-3).
  const path = new URL(url).pathname;

  return (
    <section className="grid max-w-3xl gap-8">
      <div className="grid gap-4">
        <PageHeader back={{ href: "/seller/products", label: "Semua produk" }} title={p.title} badge={<StatusBadge label={productStatusLabel[p.status]} tone={productStatusTone[p.status]} />} />
        {/* PR-12: the stable product (catalog) id and URL are visible and copyable; neither changes with title, slug, theme or domain. */}
        <dl className="grid gap-x-4 gap-y-2 rounded-lg border px-4 py-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-muted-foreground">ID produk</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span className="font-mono tabular-nums" data-testid="product-id">{p.catalogId}</span>
            <CopyButton value={p.catalogId} label="ID produk" />
          </dd>
          <dt className="text-muted-foreground">URL</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-2">
            {p.status === "active" ? (
              <a href={url} className="break-all underline underline-offset-4" data-testid="product-url">{path}</a>
            ) : (
              <span className="break-all" data-testid="product-url">{path} <span className="text-muted-foreground">(belum aktif)</span></span>
            )}
            <CopyButton value={url} label="URL produk" />
          </dd>
        </dl>
      </div>
      <Notice error={error} saved={saved} />
      <form action={updateProductAction.bind(null, p.id)} className="grid gap-4">
        <CsrfField />
        <ProductFields d={p} idHint={p.catalogId} />
        <div>
          <SubmitButton>Simpan produk</SubmitButton>
        </div>
      </form>

      <ProductImages productId={p.id} images={images} />

      <section aria-labelledby="variants" className="grid gap-4">
        <div>
          <h2 id="variants" className="text-lg font-semibold">Varian</h2>
          <p className="text-sm text-muted-foreground">Harga dan stok hidup di varian. Stok harian diubah lewat Inventaris agar tercatat alasannya.</p>
        </div>
        {p.variants.map((v) => (
          <form key={v.id} action={updateVariantAction.bind(null, p.id, v.id)} className="grid gap-3 rounded-lg border p-4">
        <CsrfField />
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              ID varian <span className="font-mono tabular-nums text-foreground" data-testid="variant-catalog-id">{v.catalogId}</span>
              <CopyButton value={v.catalogId} label={`ID varian ${v.title}`} />
            </p>
            <VariantFields prefix={`v${v.id}_`} d={v} />
            <div>
              <SubmitButton variant="outline" size="sm">Simpan varian</SubmitButton>
            </div>
          </form>
        ))}
        <form action={addVariantAction.bind(null, p.id)} className="grid gap-3 rounded-lg border border-dashed p-4">
        <CsrfField />
          <h3 className="text-sm font-medium">Tambah varian</h3>
          <VariantFields prefix="new_" />
          <div>
            <SubmitButton variant="outline" size="sm" pendingText="Menambahkan…">Tambah varian</SubmitButton>
          </div>
        </form>
      </section>

      <ProductHistory rows={history} />
    </section>
  );
}
