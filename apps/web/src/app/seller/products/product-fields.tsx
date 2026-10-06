import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { productStatusLabel } from "@/lib/status";

type Defaults = { title?: string; description?: string; status?: string; slug?: string | null };

export function ProductFields({ d = {}, idHint }: { d?: Defaults; idHint?: string }) {
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor="title">Judul produk</Label>
        <Input id="title" name="title" required maxLength={200} defaultValue={d.title} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="description">Deskripsi</Label>
        <Textarea id="description" name="description" rows={4} maxLength={5000} defaultValue={d.description} aria-describedby="description-help" />
        <p id="description-help" className="text-xs text-muted-foreground">Tampil di halaman produk toko. Maksimal 5.000 karakter.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="status">Status</Label>
          <NativeSelect id="status" name="status" defaultValue={d.status ?? "draft"} aria-describedby="status-help">
            <option value="draft">{productStatusLabel.draft}</option>
            <option value="active">{productStatusLabel.active} (dijual)</option>
            <option value="archived">{productStatusLabel.archived}</option>
          </NativeSelect>
          <p id="status-help" className="text-xs text-muted-foreground">Hanya Aktif yang tampil di toko.</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="slug">Slug URL (opsional)</Label>
          <Input id="slug" name="slug" placeholder={idHint ?? "otomatis: ID produk"} defaultValue={d.slug ?? ""} aria-describedby="slug-help" />
          <p id="slug-help" className="text-xs text-muted-foreground">Kosongkan untuk memakai ID produk.</p>
        </div>
      </div>
    </>
  );
}

export function VariantFields({ prefix = "", d }: { prefix?: string; d?: { title: string; sku: string | null; price: number; stock: number } }) {
  const id = (k: string) => `${prefix}${k}`;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="grid gap-2">
        <Label htmlFor={id("title")}>Nama varian</Label>
        <Input id={id("title")} name={id("title")} required maxLength={120} defaultValue={d?.title ?? "Default"} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={id("price")}>Harga (Rp)</Label>
        <Input id={id("price")} name={id("price")} type="number" inputMode="numeric" min={0} step={1} required defaultValue={d?.price} className="tabular-nums" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={id("stock")}>Stok</Label>
        <Input id={id("stock")} name={id("stock")} type="number" inputMode="numeric" min={0} step={1} required defaultValue={d?.stock ?? 0} className="tabular-nums" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={id("sku")}>SKU (opsional)</Label>
        <Input id={id("sku")} name={id("sku")} maxLength={64} defaultValue={d?.sku ?? ""} />
      </div>
    </div>
  );
}
