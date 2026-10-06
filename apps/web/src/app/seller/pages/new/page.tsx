import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { createPageAction } from "../actions";
import { PageFields } from "../page-fields";

export default async function NewPagePage({ searchParams }: PageProps<"/seller/pages/new">) {
  const { error } = await searchParams;
  return (
    <section className="max-w-3xl">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Tambah halaman</h1>
      <Notice error={error} />
      <form action={createPageAction} className="grid gap-6">
        <PageFields />
        <div>
          <Button type="submit">Simpan halaman</Button>
        </div>
      </form>
    </section>
  );
}
