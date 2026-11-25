import { CsrfField } from "@/lib/auth-csrf-form";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sellerScope } from "@/lib/context";
import { themeLabel } from "@/lib/status";
import { getStoreSettings, sellerTermsStatus } from "@bukalaris/db";
import Link from "next/link";
import { updateSettingsAction } from "./actions";

export const metadata = { title: "Pengaturan toko — Bukalaris" };

const themes = [
  { value: "responsive", label: `${themeLabel.responsive} (bawaan)`, hint: "Tata letak lebar di desktop, mengecil rapi di HP. Fokus pada produk." },
  { value: "mobile", label: themeLabel.mobile, hint: "Satu kolom maksimal 480 px, ditengahkan di layar lebar. Cocok untuk toko yang pembelinya dari HP." },
] as const;

export default async function SettingsPage({ searchParams }: PageProps<"/seller/settings">) {
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const [s, terms] = await Promise.all([getStoreSettings(scope), sellerTermsStatus(scope)]);
  const owner = scope.role === "owner";
  return (
    <section className="grid max-w-2xl gap-6">
      <PageHeader
        title="Pengaturan toko"
        description={
          <>
            Alamat toko: <a href={`/s/${s.slug}`} className="font-mono underline underline-offset-4">/s/{s.slug}</a>. {owner ? "Perubahan langsung tampil di toko." : "Hanya pemilik toko yang dapat mengubah pengaturan."}
          </>
        }
      />
      <Notice error={error} saved={saved} />
      {owner && (
        <p className="text-sm text-muted-foreground">
          <Link href="/seller" className="inline-flex min-h-6 items-center font-medium text-foreground underline underline-offset-4" data-testid="settings-checklist-link">
            Lihat daftar persiapan toko
          </Link>{" "}
          di Ringkasan untuk langkah aktivasi produk dan pembayaran.
        </p>
      )}
      <form action={updateSettingsAction} className="grid gap-6">
        <CsrfField />
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
            <SubmitButton>Simpan pengaturan</SubmitButton>
          </div>
        )}
      </form>
      <section aria-labelledby="settings-terms-heading" className="grid gap-1.5 rounded-lg border p-4 text-sm" data-testid="settings-terms-notice">
        <h2 id="settings-terms-heading" className="font-medium">Syarat penjual (versi {terms.current.version}{terms.current.isDraft ? " · draf" : ""})</h2>
        <p className="text-muted-foreground">
          {terms.acceptedCurrent
            ? `Pemilik toko sudah menyetujui syarat penjual versi ${terms.current.version}.`
            : terms.needsReacceptance
              ? `Versi baru (${terms.current.version}) tersedia. Layanan yang berjalan tidak terganggu; pemilik toko perlu menyetujui versi terbaru sebelum menyimpan kunci penyedia atau rekening bank baru.`
              : `Pemilik toko perlu menyetujui syarat penjual versi ${terms.current.version} sebelum menyimpan kunci penyedia atau rekening bank.`}
        </p>
        {owner && (
          <p>
            <Link href="/seller/payments#syarat-penjual" className="inline-flex min-h-6 items-center font-medium underline underline-offset-4">
              Baca syarat penjual di Akun penyedia
            </Link>
          </p>
        )}
      </section>
    </section>
  );
}
