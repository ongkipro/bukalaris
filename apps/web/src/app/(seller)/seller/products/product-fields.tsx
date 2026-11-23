import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { productStatusLabel } from "@/lib/status";
import Link from "next/link";

type Defaults = { title?: string; description?: string; kind?: "physical" | "digital"; kindLocked?: boolean; status?: string; slug?: string | null };

export function ProductFields({ d = {}, idHint }: { d?: Defaults; idHint?: string }) {
  const currentKind = d.kind ?? "physical";
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
          <Label htmlFor="kind">Jenis produk</Label>
          {d.kindLocked && <input type="hidden" name="kind" value={currentKind} />}
          <NativeSelect id="kind" name={d.kindLocked ? "kind_locked" : "kind"} defaultValue={currentKind} disabled={d.kindLocked} aria-describedby="kind-help">
            <option value="physical">Produk fisik (butuh pengiriman)</option>
            <option value="digital">Produk digital (tanpa pengiriman, prabayar)</option>
          </NativeSelect>
          <p id="kind-help" className="text-xs text-muted-foreground">
            {d.kindLocked ? "Jenis produk dikunci karena sudah ada pesanan." : "Berlaku untuk semua varian produk ini. Tidak bisa diubah setelah ada pesanan."}
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="status">Status</Label>
          <NativeSelect id="status" name="status" defaultValue={d.status ?? "draft"} aria-describedby="status-help">
            <option value="draft">{productStatusLabel.draft}</option>
            <option value="active">{productStatusLabel.active} (dijual)</option>
            <option value="archived">{productStatusLabel.archived}</option>
          </NativeSelect>
          <p id="status-help" className="text-xs text-muted-foreground">Hanya Aktif yang tampil di toko. Produk digital butuh metode bayar prabayar siap.</p>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="slug">Slug URL (opsional)</Label>
        <Input id="slug" name="slug" placeholder={idHint ?? "otomatis: ID produk"} defaultValue={d.slug ?? ""} aria-describedby="slug-help" />
        <p id="slug-help" className="text-xs text-muted-foreground">Kosongkan saat buat produk untuk memakai ID produk numerik; isi slug rapi untuk output URL SEO-friendly.</p>
      </div>
    </>
  );
}

export function VariantFields({
  prefix = "",
  productKind,
  d,
}: {
  prefix?: string;
  /** Known kind on edit/add-variant; omitted on /new where the seller picks kind in the same form. */
  productKind?: "physical" | "digital";
  d?: { title: string; sku: string | null; price: number; stock: number; trackStock: boolean; weightGrams: number | null };
}) {
  const id = (k: string) => `${prefix}${k}`;
  const isDigital = productKind === "digital";
  const isCreateForm = productKind === undefined;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <div className="grid content-start gap-2">
        <Label htmlFor={id("title")}>Nama varian</Label>
        <Input id={id("title")} name={id("title")} required maxLength={120} defaultValue={d?.title ?? "Default"} />
      </div>
      <div className="grid content-start gap-2">
        <Label htmlFor={id("price")}>Harga (Rp)</Label>
        <Input id={id("price")} name={id("price")} type="number" inputMode="numeric" min={0} step={1} required defaultValue={d?.price} className="tabular-nums" />
      </div>
      <div className="grid content-start gap-2">
        {d ? (
          <>
            <span className="text-sm font-medium">Stok saat ini</span>
            <p className="tabular-nums" data-testid="variant-stock">{d.trackStock ? d.stock : "Tak terbatas"}</p>
            {d.trackStock && <Link href="/seller/inventory" className="inline-flex min-h-6 items-center text-xs underline underline-offset-4">Ubah di Inventaris</Link>}
            {isDigital ? (
              <label className="flex min-h-6 items-center gap-2 text-xs">
                <input type="checkbox" name={id("trackStock")} defaultChecked={d.trackStock} className="size-4 accent-foreground" />
                <span>Hitung kuota edisi terbatas</span>
              </label>
            ) : (
              <input type="hidden" name={id("trackStock")} value="on" />
            )}
          </>
        ) : (
          <>
            <Label htmlFor={id("stock")}>Stok</Label>
            <Input id={id("stock")} name={id("stock")} type="number" inputMode="numeric" min={0} step={1} required={!isDigital && !isCreateForm} defaultValue={0} aria-describedby={id("stock-help")} className="tabular-nums" />
            <p id={id("stock-help")} className="text-xs text-muted-foreground">{isDigital ? "Dipakai hanya bila kuota edisi terbatas dicentang." : "Stok awal. Selanjutnya ubah lewat Inventaris."}</p>
            {(isDigital || isCreateForm) ? (
              <label className="flex min-h-6 items-center gap-2 text-xs">
                <input type="checkbox" name={id("trackStock")} defaultChecked={false} className="size-4 accent-foreground" />
                <span>Hitung kuota edisi terbatas (khusus digital)</span>
              </label>
            ) : (
              <input type="hidden" name={id("trackStock")} value="on" />
            )}
          </>
        )}
      </div>
      <div className="grid content-start gap-2">
        <Label htmlFor={id("sku")}>SKU (opsional)</Label>
        <Input id={id("sku")} name={id("sku")} maxLength={64} defaultValue={d?.sku ?? ""} />
      </div>
      {!isDigital && (
        <div className="grid content-start gap-2">
          <Label htmlFor={id("weightGrams")}>Berat (gram)</Label>
          <Input id={id("weightGrams")} name={id("weightGrams")} type="number" inputMode="numeric" min={1} step={1} required={!isCreateForm} aria-describedby={id("weight-help")} defaultValue={d?.weightGrams ?? undefined} className="tabular-nums" />
          <p id={id("weight-help")} className="text-xs text-muted-foreground">{isCreateForm ? "Wajib untuk produk fisik; kosongkan bila digital." : "Per satuan; dasar ongkir."}</p>
        </div>
      )}
    </div>
  );
}
