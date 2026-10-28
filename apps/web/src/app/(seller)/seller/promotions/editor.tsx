"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { savePromotionAction, type PromotionFormState } from "./actions";

type Choice = { value: string; label: string };
type Props = {
  type: "voucher" | "flash" | "hub"; initial: Record<string, string>; id?: number;
  products: Choice[]; collections: Choice[]; variants: Choice[]; images: Choice[];
  items?: { variantId: number; salePriceIdr: number; stockCap: number | null }[];
  featured?: number[];
};
export function PromotionEditor(p: Props) {
  const [state, action, pending] = useActionState(savePromotionAction, {} as PromotionFormState);
  const [rows, setRows] = useState(p.items?.length ? p.items : [{ variantId: 0, salePriceIdr: 0, stockCap: null }]);
  const initial = { ...p.initial, ...state.values };
  const prefix = `${p.type}-${p.id ?? "new"}`;
  const field = (name: string, label: string, type = "text", options?: Choice[]) => {
    const id = `${prefix}-${name}`, error = state.errors?.[name];
    return <div className="grid min-w-0 gap-2" key={name}>
      <Label htmlFor={id}>{label}</Label>
      {options ? <NativeSelect id={id} name={name} defaultValue={initial[name] ?? ""} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</NativeSelect>
        : <Input id={id} name={name} type={type} defaultValue={initial[name] ?? ""} min={type === "number" ? 0 : undefined} step={type === "number" ? 1 : undefined} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />}
      {error && <p id={`${id}-error`} className="text-sm text-destructive">{error}</p>}
    </div>;
  };
  const check = (name: string, label: string) => <label className="flex min-h-9 items-center gap-2"><input type="checkbox" name={name} defaultChecked={initial[name] === "true"} />{label}</label>;
  return <form action={action} className="grid max-w-4xl gap-4 text-sm" aria-label={p.type === "voucher" ? "Aturan voucher" : p.type === "flash" ? "Aturan flash sale" : "Pengaturan hub promo"}>
    <input type="hidden" name="type" value={p.type} />
    {p.id && <input type="hidden" name="id" value={p.id} />}
    {state.error && <p role="alert" className="text-destructive">{state.error}</p>}
    {state.saved && <p role="status">Promo disimpan.{state.code && <> Kode: <strong className="break-all font-mono">{state.code}</strong></>}</p>}
    {p.type === "voucher" && <>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("kind", "Jenis voucher", "text", [{ value: "percent", label: "Persen (basis poin)" }, { value: "fixed", label: "Potongan tetap (IDR)" }, { value: "free_shipping", label: "Gratis ongkir kurir" }])}
        {field("value", "Nilai (persen: 100 bp = 1%; gratis ongkir: 0)", "number")}
        {field("scope", "Cakupan", "text", [{ value: "all", label: "Semua barang" }, { value: "collection", label: "Koleksi" }, { value: "product", label: "Produk" }])}
        {field("productId", "Target produk (jika cakupan Produk)", "text", [{ value: "", label: "Pilih produk" }, ...p.products])}
        {field("collectionId", "Target koleksi (jika cakupan Koleksi)", "text", [{ value: "", label: "Pilih koleksi" }, ...p.collections])}
        {field("minPurchaseIdr", "Minimum belanja dalam cakupan (IDR)", "number")}
        {field("maxDiscountIdr", "Maksimum potongan (IDR, kosong = tanpa batas)", "number")}
        {field("usageLimit", "Kuota voucher (kosong = tanpa batas)", "number")}
        {field("buyerUsageLimit", "Kuota per nomor HP (kosong = tanpa batas)", "number")}
      </div>
      {check("public", "Tampilkan kode di hub promo saat aktif")}
      <p className="text-muted-foreground">Kode acak dibuat otomatis. Kuota dihitung saat pesanan dibuat dan tidak dikembalikan oleh pembatalan.</p>
    </>}
    {(p.type === "voucher" || p.type === "flash") && <>
      {p.type === "flash" && field("title", "Judul flash sale")}
      <div className="grid gap-4 sm:grid-cols-2">{field("startsAt", "Mulai (WIB / Asia/Jakarta)", "datetime-local")}{field("endsAt", "Selesai (WIB / Asia/Jakarta)", "datetime-local")}</div>
      {field("status", "Status", "text", [{ value: "active", label: "Aktif sesuai jadwal" }, { value: "disabled", label: "Nonaktif" }])}
    </>}
    {p.type === "flash" && <fieldset className="grid gap-4">
      <legend className="mb-2 font-medium">Varian dan kuota flash sale</legend>
      {state.errors?.items && <p role="alert" className="text-destructive">{state.errors.items}</p>}
      {rows.map((row, i) => <div key={i} className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-2"><Label htmlFor={`${prefix}-variant-${i}`}>Varian {i + 1}</Label><NativeSelect id={`${prefix}-variant-${i}`} name="variantId" defaultValue={row.variantId || ""} required><option value="">Pilih varian</option>{p.variants.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}</NativeSelect></div>
        <div className="grid gap-2"><Label htmlFor={`${prefix}-price-${i}`}>Harga flash sale {i + 1} (IDR)</Label><Input id={`${prefix}-price-${i}`} name={`salePriceIdr_${i}`} type="number" min={0} step={1} required defaultValue={initial[`salePriceIdr_${i}`] ?? row.salePriceIdr} /></div>
        <div className="grid gap-2"><Label htmlFor={`${prefix}-cap-${i}`}>Batas unit {i + 1} (opsional)</Label><Input id={`${prefix}-cap-${i}`} name={`stockCap_${i}`} type="number" min={1} step={1} defaultValue={initial[`stockCap_${i}`] ?? row.stockCap ?? ""} /></div>
      </div>)}
      {!p.id && <Button type="button" variant="outline" className="justify-self-start" onClick={() => setRows([...rows, { variantId: 0, salePriceIdr: 0, stockCap: null }])}>Tambah varian</Button>}
      <p className="text-muted-foreground">Harga dasar tidak berubah. Flash sale berakhir otomatis; kuota barang yang sudah terjual tidak dapat direset.</p>
    </fieldset>}
    {p.type === "hub" && <>
      {check("enabled", "Aktifkan halaman /promo")}
      <div className="grid gap-4 sm:grid-cols-2">
        {field("title", "Judul hub promo")}{field("subtitle", "Keterangan promo")}
        {field("bannerMediaId", "Gambar banner (media toko)", "text", [{ value: "", label: "Tanpa gambar" }, ...p.images])}
        {field("bannerCtaLabel", "Label tombol banner")}{field("bannerCtaHref", "Tujuan tombol (/products/… atau /collections/…)")}
        {field("percentRounding", "Pembulatan diskon persen", "text", [{ value: "floor", label: "Ke bawah (default konservatif)" }, { value: "half_up", label: "Setengah ke atas" }, { value: "ceil", label: "Ke atas" }])}
        {field("freeShipThresholdIdr", "Ambang belanja bersih untuk gratis ongkir (IDR)", "number")}
      </div>
      {check("freeShipEnabled", "Aktifkan gratis ongkir kurir otomatis")}
      <fieldset className="grid gap-2"><legend className="mb-2 font-medium">Koleksi unggulan</legend>{p.collections.length ? p.collections.map((c) => <label key={c.value} className="flex min-h-9 items-center gap-2"><input type="checkbox" name="featuredCollectionIds" value={c.value} defaultChecked={p.featured?.includes(Number(c.value))} />{c.label}</label>) : <p className="text-muted-foreground">Buat koleksi untuk ditampilkan di sini.</p>}</fieldset>
    </>}
    <p className="text-muted-foreground">Diskon ongkir dibiayai penjual, hanya atas biaya kurir. Margin layanan platform tetap dibayar pembeli. Promo ditolak bila hasil bersih penjual menjadi negatif.</p>
    <Button type="submit" disabled={pending} className="justify-self-start">{pending ? "Menyimpan…" : p.type === "voucher" ? "Simpan voucher" : p.type === "flash" ? "Simpan flash sale" : "Simpan hub promo"}</Button>
  </form>;
}
