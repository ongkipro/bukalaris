import { coverImages, getPublishedCollection } from "@bukalaris/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmptyState, ProductGrid } from "../../_components/product-grid";
import { storeShell } from "../../_lib";

export async function generateMetadata({ params }: PageProps<"/s/[store]/collections/[slug]">): Promise<Metadata> {
  const { store, slug } = await params;
  const { scope } = await storeShell(store);
  const c = await getPublishedCollection(scope, slug);
  return { title: c ? `${c.title} — ${scope.storeName}` : scope.storeName };
}

export default async function CollectionPage({ params }: PageProps<"/s/[store]/collections/[slug]">) {
  const { store, slug } = await params;
  const { scope, base } = await storeShell(store);
  const c = await getPublishedCollection(scope, slug);
  if (!c) notFound();
  const covers = await coverImages(scope, c.products.map((p) => p.id));
  return (
    <section className="grid gap-5">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{c.title}</h1>
        {c.description && <p className="max-w-prose text-pretty text-muted-foreground">{c.description}</p>}
        <p className="text-sm text-muted-foreground">{c.products.length} produk</p>
      </header>
      {c.products.length === 0 ? (
        <EmptyState title="Koleksi ini belum berisi produk yang dijual." />
      ) : (
        <ProductGrid base={base} products={c.products} covers={covers} />
      )}
    </section>
  );
}
