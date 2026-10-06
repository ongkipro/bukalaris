import { fieldClass, Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sellerScope } from "@/lib/context";
import { can, DomainError, getPickupArea, searchPickupAreas, type Area } from "@bukalaris/db";
import { setPickupAddressAction, setPickupAreaAction } from "./actions";

export default async function SellerShippingPage({ searchParams }: PageProps<"/seller/shipping">) {
  const { error, saved, q } = await searchParams;
  const scope = await sellerScope();
  const manage = can(scope, "shipping.manage");
  const keyword = typeof q === "string" ? q : "";
  const current = await getPickupArea(scope);
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
    <section className="grid gap-6">
      <div>
        <h1 className="mb-1 text-2xl font-semibold">Pengiriman</h1>
        <p className="text-sm text-muted-foreground">
          Area pickup menentukan ongkir yang dilihat pembeli. {manage ? "Cari kelurahan/kecamatan toko Anda, lalu pilih." : "Hanya pemilik toko yang dapat mengubahnya."}
        </p>
      </div>
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

      {manage && (
        <>
          <form method="get" action="/seller/shipping" className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <label htmlFor="q" className="text-sm font-medium">Cari area (kelurahan, kecamatan, kota atau kode pos)</label>
              <Input id="q" name="q" defaultValue={keyword} minLength={3} required placeholder="mis. Braga" />
            </div>
            <Button type="submit" variant="outline">Cari</Button>
          </form>
          {searchError && <p role="alert" className="text-sm text-destructive">{searchError}</p>}
          {keyword && !searchError && (
            <ul aria-label="Hasil pencarian area" className="grid gap-2">
              {results.length === 0 && <li className="text-sm text-muted-foreground">Area tidak ditemukan.</li>}
              {results.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <span>{a.label}</span>
                  <form action={setPickupAreaAction}>
                    <input type="hidden" name="areaId" value={a.id} />
                    <input type="hidden" name="areaLabel" value={a.label} />
                    <Button type="submit" size="sm" aria-label={`Pilih ${a.label}`}>Pilih</Button>
                  </form>
                </li>
              ))}
            </ul>
          )}

          <form action={setPickupAddressAction} className="grid gap-2">
            <label htmlFor="addressText" className="text-sm font-medium">Alamat lengkap pickup</label>
            <textarea
              id="addressText"
              name="addressText"
              rows={3}
              minLength={10}
              maxLength={500}
              required
              disabled={!current}
              defaultValue={current?.addressText ?? ""}
              placeholder={current ? "Nama jalan, nomor, patokan" : "Pilih area terlebih dahulu"}
              className={`${fieldClass} h-auto py-2`}
            />
            <Button type="submit" disabled={!current} className="justify-self-start">Simpan alamat</Button>
          </form>
        </>
      )}
    </section>
  );
}
