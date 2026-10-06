import { rupiah } from "@/lib/format";
import { storeOr404 } from "@/lib/storefront";
import { canonicalSlug, listPublishedProducts } from "@bukalaris/db";
import Link from "next/link";

export default async function StoreHome({ params }: PageProps<"/s/[store]">) {
  const { scope, base } = await storeOr404((await params).store);
  const products = await listPublishedProducts(scope);
  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">Produk</h1>
      {products.length === 0 ? (
        <p className="text-muted-foreground">Belum ada produk yang dijual.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {products.map((p) => (
            <li key={p.id}>
              <Link href={`${base}/products/${canonicalSlug(p)}`} className="group block rounded-lg border p-4 hover:border-foreground/40">
                <div className="mb-3 aspect-square rounded-md bg-muted" aria-hidden />
                <h2 className="font-medium group-hover:underline">{p.title}</h2>
                <p className="text-sm text-muted-foreground">{rupiah(p.minPrice)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
