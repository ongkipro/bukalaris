import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { createProductAction } from "../../actions";
import { ProductFields, VariantFields } from "../product-fields";

export default async function NewProductPage({ searchParams }: PageProps<"/seller/products/new">) {
  const { error } = await searchParams;
  return (
    <section className="max-w-3xl">
      <h1 className="mb-4 text-2xl font-semibold">Tambah produk</h1>
      <Notice error={error} />
      <form action={createProductAction} className="grid gap-6">
        <ProductFields />
        <fieldset className="grid gap-3 rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">Varian pertama</legend>
          <VariantFields prefix="variant_" />
        </fieldset>
        <div>
          <Button type="submit">Simpan produk</Button>
        </div>
      </form>
    </section>
  );
}
