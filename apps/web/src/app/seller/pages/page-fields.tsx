import { fieldClass } from "@/components/notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Defaults = { title?: string; slug?: string; body?: string; status?: string };

export function PageFields({ d = {} }: { d?: Defaults }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="title">Judul halaman</Label>
          <Input id="title" name="title" required maxLength={200} defaultValue={d.title} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="slug">Slug URL</Label>
          <Input id="slug" name="slug" required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" defaultValue={d.slug} aria-describedby="slug-help" />
          <p id="slug-help" className="text-xs text-muted-foreground">Alamat: /pages/&lt;slug&gt;. Nama rute toko (products, cart, search, …) tidak bisa dipakai.</p>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="body">Isi</Label>
        <Textarea id="body" name="body" rows={12} maxLength={50000} defaultValue={d.body} aria-describedby="body-help" className="font-mono text-sm" />
        <p id="body-help" className="text-xs text-muted-foreground">
          Teks biasa. Format ringan: <code># Judul</code>, <code>- daftar</code>, <code>**tebal**</code>, <code>[tautan](https://…)</code>. HTML tidak dijalankan.
        </p>
      </div>
      <div className="grid gap-2 sm:max-w-xs">
        <Label htmlFor="status">Status</Label>
        <select id="status" name="status" defaultValue={d.status ?? "draft"} className={fieldClass}>
          <option value="draft">Draf (tersembunyi)</option>
          <option value="published">Dipublikasikan</option>
        </select>
      </div>
    </>
  );
}
