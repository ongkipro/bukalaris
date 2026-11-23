import { CsrfField } from "@/lib/auth-csrf-form";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { sellerScope } from "@/lib/context";
import { can, DomainError, getPickupArea, PROVINCES, searchPickupAreas, sellerShippingAccounts, sellerShippingRules, shippingReadiness, SUGGESTED_COD_BLOCKED, type Area, type ReadinessGap } from "@bukalaris/db";
import Link from "next/link";
import { saveCourierRulesAction, saveShippingSettingsAction, setPickupAddressAction, setPickupAreaAction } from "./actions";

export const metadata = { title: "Pengiriman — Bukalaris" };

/** T-105: what still stops a store on its own courier account from shipping (ADR-0013 decision 12). */
const gapText: Partial<Record<ReadinessGap, string>> = {
  key: "Kunci akun kurir belum terhubung (Akun penyedia).",
  check: "Pengecekan kunci terakhir gagal (Akun penyedia).",
  dedicated: "Akun kurir belum dikonfirmasi sebagai akun baru yang khusus untuk toko ini (Akun kurir toko).",
  pickup_area: "Area pickup belum dipilih.",
  pickup_registered: "Alamat pickup belum terdaftar di akun kurir Anda: simpan alamat lengkap di bawah.",
};
const checkboxClass = "size-4 shrink-0 accent-foreground";

export default async function SellerShippingPage({ searchParams }: PageProps<"/seller/shipping">) {
  const { error, saved, q } = await searchParams;
  const scope = await sellerScope();
  const manage = can(scope, "shipping.manage");
  const keyword = typeof q === "string" ? q : "";
  const current = await getPickupArea(scope);
  const shipping = await sellerShippingAccounts(scope);
  const rules = await sellerShippingRules(scope);
  const own = rules.ownAccount;
  const ready = own ? await shippingReadiness(scope) : null;
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1.5 rounded-lg border p-4" data-testid="pickup-area">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-muted-foreground">Area pickup saat ini</h2>
            <StatusBadge label={current ? "Diatur" : "Belum diatur"} tone={current ? "success" : "warning"} />
          </div>
          {current ? (
            <>
              <p className="font-medium">{current.areaLabel}</p>
              <p className="text-sm text-muted-foreground">{current.addressText || "Alamat lengkap belum diisi."}</p>
            </>
          ) : (
            <p className="text-sm" role="note">Belum diatur — pembeli belum bisa melihat ongkir.</p>
          )}
        </div>

        {own ? (
          <div className="grid content-start gap-1.5 rounded-lg border p-4" data-testid="shipping-account">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-muted-foreground">Akun kurir milik toko</h2>
              <StatusBadge label={ready?.ready ? "Siap kirim" : "Belum siap"} tone={ready?.ready ? "success" : "warning"} data-testid="shipping-ready" />
            </div>
            <p className="font-medium" data-testid="shipping-account-kind">Pesanan dikirim dengan akun kurir Anda sendiri</p>
            {ready?.ready ? (
              <p className="text-sm text-muted-foreground">Pembeli melihat tarif umum kurir yang Anda aktifkan; ongkos kirim dan COD diselesaikan langsung antara Anda dan Mengantar.</p>
            ) : (
              <ul className="list-disc space-y-0.5 pl-5 text-sm" data-testid="shipping-gaps">
                {ready?.missing.map((g) => <li key={g}>{gapText[g] ?? g}</li>)}
              </ul>
            )}
            <p className="text-xs text-muted-foreground" data-testid="shipping-money-notice">
              Uang pengiriman (ongkos kirim, saldo dan isi ulang akun, pencairan COD, biaya COD, retur, cashback, dan klaim) diselesaikan langsung antara Anda dan Mengantar; Bukalaris tidak memegang uang pengiriman dan tidak mencocokkan akun Mengantar Anda.
            </p>
          </div>
        ) : (
          <div className="grid content-start gap-1.5 rounded-lg border p-4" data-testid="shipping-account">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-muted-foreground">Akun Bukalaris Kirim yang dipakai</h2>
              <StatusBadge
                label={!shipping.selected ? "Dipulihkan" : shipping.selected.kind === "partner_managed" ? "Aktif" : "Sementara"}
                tone={!shipping.selected ? "warning" : shipping.selected.kind === "partner_managed" ? "success" : "secondary"}
              />
            </div>
            {shipping.selected ? (
              <>
                <p className="font-medium" data-testid="shipping-account-kind">{shipping.selected.kind === "partner_managed" ? "Akun khusus toko Anda" : "Akun induk Bukalaris Kirim (sementara)"}</p>
                <p className="text-sm text-muted-foreground">{shipping.selected.kind === "partner_managed" ? "Dibuat dan dikelola otomatis oleh Bukalaris. Anda tidak perlu mengisi kunci apa pun." : "Akun khusus toko Anda sedang disiapkan. Pesanan tetap dikirim lewat akun induk; Anda tidak perlu melakukan apa pun."}</p>
              </>
            ) : (
              <p className="text-sm" role="note" data-testid="shipping-account-waiting">Akun pengiriman sedang dipulihkan oleh Bukalaris. Pesanan baru menunggu sampai akun siap; tidak ada tindakan dari Anda.</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">COD ditawarkan hanya untuk layanan: {shipping.services.filter((s) => s.codAllowed && s.returnFree).map((s) => s.courierCode).join(", ") || "belum ada"}.</p>
          </div>
        )}
      </div>

      {manage && (
        <p className="text-sm text-muted-foreground" data-testid="own-account-link">
          Akun kurir milik toko Anda sendiri dihubungkan di <Link href="/seller/payments" className="font-medium text-foreground underline underline-offset-4">Akun penyedia</Link>.
          {own && (
            <>
              {" "}Konfirmasi akun khusus, webhook, sinkronisasi paket, saldo dan tagihan ada di{" "}
              <Link href="/seller/shipping/account" className="font-medium text-foreground underline underline-offset-4" data-testid="own-account-sync-link">Akun kurir toko</Link>.
            </>
          )}
        </p>
      )}

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
            <ul aria-label="Hasil pencarian area" className={results.length > 0 ? "divide-y rounded-lg border" : "grid gap-2"}>
              {results.length === 0 && <li className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Area tidak ditemukan untuk “{keyword}”. Coba nama kecamatan atau kode pos.</li>}
              {results.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                  <span className="min-w-0 break-words">{a.label}</span>
                  <form action={setPickupAreaAction}>
                    <CsrfField />
                    <input type="hidden" name="areaId" value={a.id} />
                    <input type="hidden" name="areaLabel" value={a.label} />
                    <SubmitButton size="sm" aria-label={`Pilih ${a.label}`} pendingText="Memilih…">Pilih</SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          )}

          <form action={setPickupAddressAction} className="grid gap-3" aria-label="Alamat pickup">
            <CsrfField />
            <div className="grid gap-2">
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
              <p id="address-help" className="text-xs text-muted-foreground">
                Dipakai kurir saat penjemputan paket; minimal 10 karakter.{own ? " Alamat ini didaftarkan ke akun kurir Anda saat disimpan; bila penyedia menolak, tidak ada yang berubah." : ""}
              </p>
            </div>
            {own && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="contactName">Nama penanggung jawab pickup</Label>
                  <Input id="contactName" name="contactName" required minLength={2} maxLength={120} autoComplete="name" disabled={!current} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="contactPhone">Nomor HP penanggung jawab</Label>
                  <Input id="contactPhone" name="contactPhone" type="tel" inputMode="tel" required pattern="\+?[0-9]{10,15}" autoComplete="tel" disabled={!current} aria-describedby="contact-help" />
                  <p id="contact-help" className="text-xs text-muted-foreground">Angka saja, 10–15 digit. Dihubungi kurir saat menjemput.</p>
                </div>
              </div>
            )}
            <SubmitButton disabled={!current} className="justify-self-start">{own ? "Simpan dan daftarkan alamat" : "Simpan alamat"}</SubmitButton>
          </form>
        </>
      )}

      {own && (
        <section aria-labelledby="couriers" className="grid gap-3 rounded-lg border p-4" data-testid="courier-rules">
          <div className="grid gap-1">
            <h2 id="couriers" className="text-base font-semibold">Kurir dan COD</h2>
            <p className="text-sm text-muted-foreground">Pembeli hanya melihat kurir yang Anda aktifkan; kurir yang belum diatur tidak ditawarkan. COD hanya untuk kurir yang COD-nya Anda nyalakan.</p>
          </div>
          <form action={saveCourierRulesAction} className="grid gap-3" aria-label="Kurir dan COD">
            <CsrfField />
            <fieldset className="grid gap-0 divide-y rounded-lg border" disabled={!manage}>
              <legend className="sr-only">Kurir yang ditawarkan</legend>
              {rules.couriers.map((c) => (
                <div key={c.courierCode} className="grid gap-2 px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4" data-testid={`courier-${c.courierCode}`}>
                  <span className="min-w-0 break-words font-medium">{c.label}</span>
                  <label className="flex min-h-6 items-center gap-2">
                    <input type="checkbox" name={`enabled:${c.courierCode}`} defaultChecked={c.enabled} className={checkboxClass} aria-label={`Aktifkan ${c.label}`} />
                    Aktif
                  </label>
                  <label className="flex min-h-6 items-center gap-2">
                    <input type="checkbox" name={`cod:${c.courierCode}`} defaultChecked={c.codEnabled} className={checkboxClass} aria-label={`COD ${c.label}`} />
                    COD
                  </label>
                  {c.codRefusedAt && <input type="hidden" name={`refused:${c.courierCode}`} value="1" />}
                  {c.codRefusedAt && (
                    <p className="text-xs text-destructive sm:col-span-3" data-testid={`courier-${c.courierCode}-refused`}>
                      Penyedia menolak COD untuk akun Anda pada kurir ini; COD dimatikan otomatis. Nyalakan lagi hanya bila penyedia sudah membukanya.
                    </p>
                  )}
                </div>
              ))}
            </fieldset>
            {manage && <SubmitButton className="justify-self-start">Simpan kurir</SubmitButton>}
          </form>
        </section>
      )}

      {own && (
        <section aria-labelledby="cod" className="grid gap-3 rounded-lg border p-4" data-testid="cod-settings">
          <h2 id="cod" className="text-base font-semibold">COD toko</h2>
          <form action={saveShippingSettingsAction} className="grid gap-4" aria-label="COD toko">
            <CsrfField />
            <input type="hidden" name="revision" value={rules.settings.revision} />
            <fieldset className="grid gap-4" disabled={!manage}>
              <label className="flex min-h-6 items-start gap-2 text-sm">
                <input type="checkbox" name="codEnabled" defaultChecked={rules.settings.codEnabled} className={`${checkboxClass} mt-0.5`} />
                <span>Terima COD (bayar di tempat). Dicek lagi saat pesanan dibuat.</span>
              </label>
              <div className="grid gap-2 sm:max-w-xs">
                <Label htmlFor="codFeeBearer">Biaya COD ditanggung</Label>
                <NativeSelect id="codFeeBearer" name="codFeeBearer" defaultValue={rules.settings.codFeeBearer} aria-describedby="bearer-help">
                  <option value="buyer">Pembeli</option>
                  <option value="seller">Toko</option>
                </NativeSelect>
                <p id="bearer-help" className="text-xs text-muted-foreground" data-testid="bearer-help">Pembeli: biaya COD ditambahkan ke tagihan dan ditagih kurir. Toko: tagihan sama dengan total pesanan dan biaya COD Anda tanggung sendiri di akun Mengantar.</p>
              </div>
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">Provinsi tanpa COD</legend>
                <p className="text-xs text-muted-foreground">
                  COD ditolak ke provinsi yang dicentang, dan juga bila provinsi tujuan tidak bisa dipastikan. Tanda “disarankan” hanya saran; tidak ada yang diblokir sebelum Anda menyimpannya.
                </p>
                <div className="grid gap-1 rounded-lg border p-3 sm:grid-cols-2">
                  {PROVINCES.map(([code, name]) => (
                    <label key={code} className="flex min-h-6 items-center gap-2 text-sm">
                      <input type="checkbox" name="blocked" value={code} defaultChecked={rules.settings.codBlockedProvinces.includes(code)} className={checkboxClass} />
                      <span className="min-w-0 break-words">
                        {name}
                        {SUGGESTED_COD_BLOCKED.includes(code) && <span className="text-xs text-muted-foreground"> (disarankan)</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </fieldset>
            {manage && <SubmitButton className="justify-self-start">Simpan COD</SubmitButton>}
          </form>
        </section>
      )}
    </section>
  );
}
