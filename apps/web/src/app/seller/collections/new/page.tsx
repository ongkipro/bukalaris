import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { sellerScope } from "@/lib/context";
import { listProducts } from "@bukalaris/db";
import { createCollectionAction } from "../actions";
import { CollectionFields } from "../collection-fields";

export default async function NewCollectionPage({ searchParams }: PageProps<"/seller/collections/new">) {
  const { error } = await searchParams;
  const products = await listProducts(await sellerScope());
  return (
    <section className="max-w-3xl">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Tambah koleksi</h1>
      <Notice error={error} />
      <form action={createCollectionAction} className="grid gap-6">
        <CollectionFields products={products} />
        <div>
          <Button type="submit">Simpan koleksi</Button>
        </div>
      </form>
    </section>
  );
}
