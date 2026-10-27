import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { sellerScope } from "@/lib/context";
import { listProducts } from "@bukalaris/db";
import { createCollectionAction } from "../actions";
import { CollectionFields } from "../collection-fields";

export const metadata = { title: "Tambah koleksi — Bukalaris" };

export default async function NewCollectionPage({ searchParams }: PageProps<"/seller/collections/new">) {
  const { error } = await searchParams;
  const products = await listProducts(await sellerScope());
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader back={{ href: "/seller/collections", label: "Semua koleksi" }} title="Tambah koleksi" description="Pilih produk dan urutannya; publikasikan saat siap tampil di toko." />
      <Notice error={error} />
      <form action={createCollectionAction} className="grid gap-6">
        <CollectionFields products={products} />
        <div>
          <SubmitButton>Simpan koleksi</SubmitButton>
        </div>
      </form>
    </section>
  );
}
