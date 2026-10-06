import { fieldClass } from "@/components/notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Product = { id: number; title: string; status: "draft" | "active" | "archived" };
type Defaults = { title?: string; slug?: string; description?: string; status?: string; productIds?: number[] };

export function CollectionFields({ d = {}, products }: { d?: Defaults; products: Product[] }) {
  const order = new Map((d.productIds ?? []).map((id, i) => [id, i + 1]));
  const sorted = [...products].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || b.id - a.id);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="title">Judul koleksi</Label>
          <Input id="title" name="title" required maxLength={200} defaultValue={d.title} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="slug">Slug URL</Label>
          <Input id="slug" name="slug" required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" defaultValue={d.slug} aria-describedby="slug-help" />
          <p id="slug-help" className="text-xs text-muted-foreground">Huruf kecil, angka, tanda hubung. Alamat: /collections/&lt;slug&gt;.</p>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="description">Deskripsi (opsional)</Label>
        <Textarea id="description" name="description" rows={2} maxLength={2000} defaultValue={d.description} />
      </div>
      <div className="grid gap-2 sm:max-w-xs">
        <Label htmlFor="status">Status</Label>
        <select id="status" name="status" defaultValue={d.status ?? "draft"} className={fieldClass}>
          <option value="draft">Draf (tersembunyi)</option>
          <option value="published">Dipublikasikan</option>
        </select>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Produk dalam koleksi</legend>
        <p className="text-xs text-muted-foreground">Centang produk dan beri nomor urut. Hanya produk aktif yang tampil di toko.</p>
        {products.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada produk di toko ini.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {sorted.map((p) => (
              <li key={p.id} className="flex items-center gap-3 p-3">
                <input id={`p-${p.id}`} type="checkbox" name="productIds" value={p.id} defaultChecked={order.has(p.id)} className="size-4 accent-foreground" />
                <label htmlFor={`p-${p.id}`} className="flex-1 text-sm">
                  {p.title} {p.status !== "active" && <span className="text-muted-foreground">({p.status === "draft" ? "draf" : "arsip"})</span>}
                </label>
                <label htmlFor={`order_${p.id}`} className="sr-only">Urutan {p.title}</label>
                <input id={`order_${p.id}`} name={`order_${p.id}`} type="number" inputMode="numeric" min={1} max={999} defaultValue={order.get(p.id) ?? ""} placeholder="urut" className={`${fieldClass} w-20`} />
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </>
  );
}
