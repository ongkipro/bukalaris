import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { operatorOrDeny } from "@/lib/context";
import { createStoreAction } from "../actions";

export const metadata = { title: "Buat toko — Super Admin" };

export default async function NewStorePage({ searchParams }: PageProps<"/admin/stores/new">) {
  const { error } = await searchParams;
  await operatorOrDeny();
  return (
    <section className="grid max-w-xl gap-6">
      <PageHeader back={{ href: "/admin", label: "Semua toko" }} title="Buat toko" description="Pemilik pertama dipilih dari akun yang sudah ada (undangan menyusul). Toko langsung aktif setelah dibuat." />
      <Notice error={error} />
      <form action={createStoreAction} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="name">Nama toko</Label>
          <Input id="name" name="name" required maxLength={200} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="slug">Slug</Label>
          <Input id="slug" name="slug" required maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" aria-describedby="slug-help" placeholder="toko-c" />
          <p id="slug-help" className="text-xs text-muted-foreground">Huruf kecil, angka, tanda hubung. Alamat toko: /s/&lt;slug&gt; atau &lt;slug&gt;.domain.</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="ownerEmail">Email pemilik</Label>
          <Input id="ownerEmail" name="ownerEmail" type="email" required autoComplete="off" aria-describedby="owner-help" />
          <p id="owner-help" className="text-xs text-muted-foreground">Harus akun yang sudah terdaftar; akun ini menjadi pemilik pertama toko.</p>
        </div>
        <div>
          <SubmitButton pendingText="Membuat…">Buat toko</SubmitButton>
        </div>
      </form>
    </section>
  );
}
