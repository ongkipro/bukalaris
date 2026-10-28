import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sellerScope } from "@/lib/context";
import { can, DomainError, getPickupArea, searchPickupAreas, sellerShippingAccounts, type Area } from "@bukalaris/db";
import { setPickupAddressAction, setPickupAreaAction } from "./actions";

export const metadata = { title: "Pengiriman — Bukalaris" };

export default async function SellerShippingPage({ searchParams }: PageProps<"/seller/shipping">) {
  const { error, saved, q } = await searchParams;
  const scope = await sellerScope();
  const manage = can(scope, "shipping.manage");
  const keyword = typeof q === "string" ? q : "";
  const current = await getPickupArea(scope);
  const shipping = await sellerShippingAccounts(scope);
  let results: Area[] = [];
  let searchError: string | undefined;
  if (manage && keyword) {
    try {
      results = await searchPickupAreas(scope, keyword);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      searchError = err.message;
    }
  }
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader
        title="Pengiriman"
        description={`Area pickup menentukan ongkir yang dilihat pembeli. ${manage ? "Cari kelurahan/kecamatan toko Anda, lalu pilih." : "Hanya pemilik toko yang dapat mengubahnya."}`}
      />
      <Notice error={error} saved={saved} />

      <div className="rounded-lg border p-4" data-testid="pickup-area">
        <h2 className="text-sm font-medium text-muted-foreground">Area pickup saat ini</h2>
        {current ? (
          <>
            <p className="mt-1 font-medium">{current.areaLabel}</p>
            <p className="text-sm text-muted-foreground">{current.addressText || "Alamat lengkap belum diisi."}</p>
          </>
        ) : (
          <p className="mt-1 text-sm" role="note">Belum diatur — pembeli belum bisa melihat ongkir.</p>
        )}
      </div>

      <div className="rounded-lg border p-4" data-testid="shipping-account">
        <h2 className="text-sm font-medium text-muted-foreground">Akun Bukalaris Kirim yang dipakai</h2>
        {shipping.selected ? (
          <>
            <p className="mt-1 font-medium" data-testid="shipping-account-kind">{shipping.selected.kind === "partner_managed" ? "Akun khusus toko Anda" : "Akun induk Bukalaris Kirim (sementara)"}</p>
            <p className="text-sm text-muted-foreground">{shipping.selected.kind === "partner_managed" ? "Dibuat dan dikelola otomatis oleh Bukalaris. Anda tidak perlu mengisi kunci apa pun." : "Akun khusus toko Anda sedang disiapkan. Pesanan tetap dikirim lewat akun induk; Anda tidak perlu melakukan apa pun."}</p>
          </>
        ) : (
          <p className="mt-1 text-sm" role="note" data-testid="shipping-account-waiting">Akun pengiriman sedang dipulihkan oleh Bukalaris. Pesanan baru menunggu sampai akun siap; tidak ada tindakan dari Anda.</p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">COD ditawarkan hanya untuk layanan: {shipping.services.filter((s) => s.codAllowed && s.returnFree).map((s) => s.courierCode).join(", ") || "belum ada"}.</p>
      </div>

      {manage && (
        <>
          <form method="get" action="/seller/shipping" className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor="q">Cari area (kelurahan, kecamatan, kota atau kode pos)</Label>
              <Input id="q" name="q" defaultValue={keyword} minLength={3} required placeholder="mis. Braga" aria-describedby={searchError ? "q-error" : undefined} aria-invalid={searchError ? true : undefined} />
            </div>
            <Button type="submit" variant="outline">Cari</Button>
          </form>
          {searchError && <p id="q-error" role="alert" className="text-sm text-destructive">{searchError}</p>}
          {keyword && !searchError && (
            <ul aria-label="Hasil pencarian area" className="grid gap-2">
              {results.length === 0 && <li className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Area tidak ditemukan untuk “{keyword}”. Coba nama kecamatan atau kode pos.</li>}
              {results.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <span>{a.label}</span>
                  <form action={setPickupAreaAction}>
                    <input type="hidden" name="areaId" value={a.id} />
                    <input type="hidden" name="areaLabel" value={a.label} />
                    <SubmitButton size="sm" aria-label={`Pilih ${a.label}`} pendingText="Memilih…">Pilih</SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          )}

          <form action={setPickupAddressAction} className="grid gap-2">
            <Label htmlFor="addressText">Alamat lengkap pickup</Label>
            <Textarea
              id="addressText"
              name="addressText"
              rows={3}
              minLength={10}
              maxLength={500}
              required
              disabled={!current}
              defaultValue={current?.addressText ?? ""}
              placeholder={current ? "Nama jalan, nomor, patokan" : "Pilih area terlebih dahulu"}
              aria-describedby="address-help"
            />
            <p id="address-help" className="text-xs text-muted-foreground">Dipakai kurir saat penjemputan paket; minimal 10 karakter.</p>
            <SubmitButton disabled={!current} className="justify-self-start">Simpan alamat</SubmitButton>
          </form>
        </>
      )}
    </section>
  );
}
