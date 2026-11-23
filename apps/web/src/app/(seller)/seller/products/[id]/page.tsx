import { CsrfField } from "@/lib/auth-csrf-form";
import { CopyButton } from "@/components/copy-button";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sellerScope } from "@/lib/context";
import { productStatusLabel, productStatusTone } from "@/lib/status";
import { ACCESS_LINKS_MAX, canonicalSlug, getProduct, getProductAccessContent, listCatalogHistory, listProductMedia, storeBaseUrl } from "@bukalaris/db";
import { notFound } from "next/navigation";
import { addVariantAction, updateProductAction, updateVariantAction } from "../../actions";
import { addAccessLinkAction, removeAccessLinkAction, reorderAccessLinkAction, saveAccessNoteAction } from "../digital-actions";
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
  const [images, history, access] = await Promise.all([
    listProductMedia(scope, p.id),
    listCatalogHistory(scope, p.id),
    p.kind === "digital" ? getProductAccessContent(scope, p.id) : Promise.resolve(null),
  ]);
  const url = `${storeBaseUrl(scope.storeSlug)}/products/${canonicalSlug(p)}`;
  // Shown as a path; the link and the copy button carry the absolute URL (host mode or path mode, DOM-3).
  const path = new URL(url).pathname;

  return (
    <section className="grid max-w-3xl gap-8">
      <div className="grid gap-4">
        <PageHeader
          back={{ href: "/seller/products", label: "Semua produk" }}
          title={p.title}
          badge={
            <span className="flex flex-wrap gap-1.5">
              {p.kind === "digital" && <StatusBadge label="Produk digital" tone="secondary" data-testid="product-kind-badge" />}
              <StatusBadge label={productStatusLabel[p.status]} tone={productStatusTone[p.status]} />
            </span>
          }
        />
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

      {p.kind === "digital" && access && (
        <section id="akses-digital" aria-labelledby="digital-access-heading" className="grid gap-4 rounded-lg border p-4" data-testid="digital-access-section">
          <div className="grid gap-1">
            <h2 id="digital-access-heading" className="text-lg font-semibold">Tautan & catatan akses produk digital</h2>
            <p className="text-sm text-muted-foreground">
              Bukalaris tidak menyimpan file Anda dan tidak pernah mengakses tautan yang Anda masukkan. Izin berbagi dan akses file tetap diatur di host penyimpanan Anda (misalnya Google Drive). Tautan dan catatan ini hanya tampil ke pembeli di halaman status pesanan setelah pembayaran terverifikasi.
            </p>
          </div>
          {access.items.length > 0 ? (
            <ol className="grid gap-2" data-testid="access-links-list">
              {access.items.map((item, idx) => (
                <li key={item.id} className="grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="font-medium">{item.label}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{item.host} · {item.url}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {idx > 0 && (
                      <form action={reorderAccessLinkAction.bind(null, p.id, item.id, "up")}>
                        <CsrfField />
                        <SubmitButton variant="outline" size="sm" aria-label={`Naikkan ${item.label}`}>Naik</SubmitButton>
                      </form>
                    )}
                    {idx < access.items.length - 1 && (
                      <form action={reorderAccessLinkAction.bind(null, p.id, item.id, "down")}>
                        <CsrfField />
                        <SubmitButton variant="outline" size="sm" aria-label={`Turunkan ${item.label}`}>Turun</SubmitButton>
                      </form>
                    )}
                    <form action={removeAccessLinkAction.bind(null, p.id, item.id)}>
                      <CsrfField />
                      <SubmitButton variant="outline" size="sm">Hapus</SubmitButton>
                    </form>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="access-links-empty">
              Belum ada tautan akses. Tambahkan minimal satu tautan atau catatan akses agar produk digital dapat diaktifkan.
            </p>
          )}
          {access.items.length < ACCESS_LINKS_MAX && (
            <form action={addAccessLinkAction.bind(null, p.id)} className="grid gap-3 rounded-md border bg-muted/20 p-3" aria-label="Tambah tautan akses">
              <CsrfField />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="access-label">Label tautan</Label>
                  <Input id="access-label" name="label" required maxLength={120} placeholder="mis. Unduh E-Book (PDF)" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="access-url">Tautan https://</Label>
                  <Input id="access-url" name="url" type="url" required maxLength={2000} placeholder="https://drive.google.com/..." />
                </div>
              </div>
              <SubmitButton variant="outline" size="sm" className="justify-self-start" pendingText="Menambahkan…">Tambah tautan</SubmitButton>
            </form>
          )}
          <form action={saveAccessNoteAction.bind(null, p.id)} className="grid gap-2" aria-label="Catatan akses produk digital">
            <CsrfField />
            <Label htmlFor="access-note">Catatan akses (opsional, teks polos)</Label>
            <Textarea id="access-note" name="note" rows={3} maxLength={5000} defaultValue={access.note} placeholder="Petunjuk membuka file atau mengakses konten. Ditampilkan sebagai teks biasa, bukan HTML." />
            <SubmitButton variant="outline" size="sm" className="justify-self-start" pendingText="Menyimpan…">Simpan catatan akses</SubmitButton>
          </form>
        </section>
      )}

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
            <VariantFields prefix={`v${v.id}_`} productKind={p.kind} d={v} />
            <div>
              <SubmitButton variant="outline" size="sm">Simpan varian</SubmitButton>
            </div>
          </form>
        ))}
        <form action={addVariantAction.bind(null, p.id)} className="grid gap-3 rounded-lg border border-dashed p-4">
        <CsrfField />
          <h3 className="text-sm font-medium">Tambah varian</h3>
          <VariantFields prefix="new_" productKind={p.kind} />
          <div>
            <SubmitButton variant="outline" size="sm" pendingText="Menambahkan…">Tambah varian</SubmitButton>
          </div>
        </form>
      </section>

      <ProductHistory rows={history} />
    </section>
  );
}
