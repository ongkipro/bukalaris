import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { createProductAction } from "../../actions";
import { ProductFields, VariantFields } from "../product-fields";

export const metadata = { title: "Tambah produk — Bukalaris" };

export default async function NewProductPage({ searchParams }: PageProps<"/seller/products/new">) {
  const { error } = await searchParams;
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader
        back={{ href: "/seller/products", label: "Semua produk" }}
        title="Tambah produk"
        description="Simpan sebagai Draf dulu jika belum siap dijual; varian dan gambar lain bisa ditambah setelah produk dibuat."
      />
      <Notice error={error} />
      <form action={createProductAction} className="grid gap-6">
        <ProductFields />
        <fieldset className="grid gap-3 rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">Varian pertama</legend>
          <VariantFields prefix="variant_" />
        </fieldset>
        <div>
          <SubmitButton>Simpan produk</SubmitButton>
        </div>
      </form>
    </section>
  );
}
