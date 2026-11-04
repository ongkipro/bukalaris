import { CsrfField } from "@/lib/auth-csrf-form";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { createPageAction } from "../actions";
import { PageFields } from "../page-fields";

export const metadata = { title: "Tambah halaman — Bukalaris" };

export default async function NewPagePage({ searchParams }: PageProps<"/seller/pages/new">) {
  const { error } = await searchParams;
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader back={{ href: "/seller/pages", label: "Semua halaman" }} title="Tambah halaman" description="Teks biasa dengan format ringan; simpan sebagai draf sampai siap dipublikasikan." />
      <Notice error={error} />
      <form action={createPageAction} className="grid gap-6">
        <CsrfField />
        <PageFields />
        <div>
          <SubmitButton>Simpan halaman</SubmitButton>
        </div>
      </form>
    </section>
  );
}
