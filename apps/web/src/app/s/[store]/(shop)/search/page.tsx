import { coverImages, SEARCH_LIMIT, searchPublishedProducts } from "@bukalaris/db";
import { EmptyState, ProductGrid } from "../_components/product-grid";
import { SearchForm } from "../_components/search-form";
import { storeShell } from "../_lib";

export const metadata = { title: "Cari produk" };

export default async function SearchPage({ params, searchParams }: PageProps<"/s/[store]/search">) {
  const { store } = await params;
  const { q: rawQ } = await searchParams;
  const { scope, base } = await storeShell(store);
  const { q, products } = await searchPublishedProducts(scope, typeof rawQ === "string" ? rawQ.slice(0, 100) : "");
  const covers = await coverImages(scope, products.map((p) => p.id));
  return (
    <section className="grid gap-5">
      <h1 className="text-2xl font-semibold tracking-tight">Cari produk</h1>
      <SearchForm base={base} q={q} className="max-w-md" autoFocus={q === ""} />
      {q === "" ? (
        <p className="text-sm text-muted-foreground">Ketik nama produk, lalu tekan Enter.</p>
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {products.length === 0
              ? <>Tidak ada hasil untuk <q className="text-foreground">{q}</q>.</>
              : <>{products.length}{products.length === SEARCH_LIMIT ? "+" : ""} hasil untuk <q className="text-foreground">{q}</q></>}
          </p>
          {products.length === 0 ? (
            <EmptyState title="Produk tidak ditemukan." hint="Coba kata lain yang lebih singkat." />
          ) : (
            <ProductGrid base={base} products={products} covers={covers} />
          )}
        </>
      )}
    </section>
  );
}
