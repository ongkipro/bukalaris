import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Buat toko</h1>
        <p className="mt-1 text-sm text-muted-foreground">Pemilik pertama dipilih dari akun yang sudah ada (undangan menyusul).</p>
      </div>
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
          <Input id="ownerEmail" name="ownerEmail" type="email" required autoComplete="off" />
        </div>
        <div>
          <Button type="submit">Buat toko</Button>
        </div>
      </form>
    </section>
  );
}
