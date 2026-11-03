import { coverImages, listPublishedProducts } from "@bukalaris/db";
import Link from "next/link";
import { EmptyState, ProductGrid } from "./_components/product-grid";
import { SearchForm } from "./_components/search-form";
import { storeShell } from "./_lib";

export default async function StoreHome({ params }: PageProps<"/s/[store]">) {
  const { scope, base, profile, collections } = await storeShell((await params).store);
  const products = await listPublishedProducts(scope);
  const covers = await coverImages(scope, products.map((p) => p.id));
  return (
    <div className="grid gap-8">
      <section className="grid gap-3">
        {profile.description && <p className="max-w-prose text-pretty text-muted-foreground @2xl:text-lg">{profile.description}</p>}
        <SearchForm base={base} className="sf-search-inline max-w-md" />
      </section>
      {collections.length > 0 && (
        <section aria-labelledby="koleksi" className="grid gap-3">
          <h2 id="koleksi" className="text-sm font-semibold text-muted-foreground">Koleksi</h2>
          <ul className="flex flex-wrap gap-2">
            {collections.map((c) => (
              <li key={c.id}>
                <Link href={`${base}/collections/${c.slug}`} className="inline-block rounded-full border px-3.5 py-1.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
                  {c.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="produk" className="grid gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <h1 id="produk" className="text-2xl font-semibold tracking-tight">Produk</h1>
          {products.length > 0 && <p className="text-sm tabular-nums text-muted-foreground">{products.length} produk</p>}
        </div>
        {products.length === 0 ? (
          <EmptyState title="Belum ada produk yang dijual." hint="Toko ini sedang menyiapkan katalognya." />
        ) : (
          <ProductGrid base={base} products={products} covers={covers} />
        )}
      </section>
    </div>
  );
}
