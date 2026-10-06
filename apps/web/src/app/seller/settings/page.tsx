import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sellerScope } from "@/lib/context";
import { getStoreSettings } from "@bukalaris/db";
import { updateSettingsAction } from "./actions";

export const metadata = { title: "Pengaturan toko — Bukalaris" };

const themes = [
  { value: "responsive", label: "Responsif (bawaan)", hint: "Tata letak lebar di desktop, mengecil rapi di HP. Fokus pada produk." },
  { value: "mobile", label: "Mobile", hint: "Satu kolom maksimal 480 px, ditengahkan di layar lebar. Cocok untuk toko yang pembelinya dari HP." },
] as const;

export default async function SettingsPage({ searchParams }: PageProps<"/seller/settings">) {
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const s = await getStoreSettings(scope);
  const owner = scope.role === "owner";
  return (
    <section className="grid max-w-2xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pengaturan toko</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Alamat toko: <span className="font-mono">/s/{s.slug}</span>. {owner ? "" : "Hanya pemilik toko yang dapat mengubah pengaturan."}
        </p>
      </div>
      <Notice error={error} saved={saved} />
      <form action={updateSettingsAction} className="grid gap-6">
        <fieldset disabled={!owner} className="grid gap-4">
          <legend className="sr-only">Profil toko</legend>
          <div className="grid gap-2">
            <Label htmlFor="name">Nama toko</Label>
            <Input id="name" name="name" required maxLength={200} defaultValue={s.name} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Deskripsi singkat</Label>
            <Textarea id="description" name="description" rows={3} maxLength={2000} defaultValue={s.description} aria-describedby="description-help" />
            <p id="description-help" className="text-xs text-muted-foreground">Tampil di beranda toko, di atas daftar produk.</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="whatsapp">Nomor WhatsApp (opsional)</Label>
            <Input id="whatsapp" name="whatsapp" type="tel" inputMode="tel" placeholder="0812xxxxxxxx" defaultValue={s.whatsapp ?? ""} aria-describedby="whatsapp-help" />
            <p id="whatsapp-help" className="text-xs text-muted-foreground">Pembeli dapat tombol “Tanya via WhatsApp” di toko. Nomor Indonesia saja.</p>
          </div>
        </fieldset>
        <fieldset disabled={!owner} className="grid gap-3">
          <legend className="mb-1 text-sm font-medium">Tema toko</legend>
          {themes.map((t) => (
            <label key={t.value} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-checked:border-foreground has-checked:bg-muted/40 has-disabled:cursor-not-allowed has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
              <input type="radio" name="theme" value={t.value} defaultChecked={s.theme === t.value} className="mt-1 accent-foreground" />
              <span className="grid gap-0.5">
                <span className="font-medium">{t.label}</span>
                <span className="text-sm text-muted-foreground">{t.hint}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">Ganti tema hanya mengubah tampilan; produk, koleksi, halaman dan checkout tidak berubah.</p>
        </fieldset>
        {owner && (
          <div>
            <Button type="submit">Simpan pengaturan</Button>
          </div>
        )}
      </form>
    </section>
  );
}
