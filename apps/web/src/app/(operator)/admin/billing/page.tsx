import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { billingStateLabel, billingStateTone } from "@/lib/billing";
import { consoleGate } from "@/lib/console-gate";
import { rupiah, tanggal } from "@/lib/format";
import { billingOverview } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../access-denied";
import { changeDaysAction, changePriceAction, createInvoiceAction, grantCompAction, requestCompAction, requestPriceAction, setControlsAction, setPpnAction } from "./actions";

export const metadata = { title: "Langganan" };

const field = "grid min-w-0 gap-1.5";

export default async function AdminBillingPage({ searchParams }: PageProps<"/admin/billing">) {
  const g = await consoleGate("/admin/billing");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { error, saved, invoice, created, requested, after } = await searchParams;
  const o = await billingOverview(g.op, { after: typeof after === "string" && /^\d{1,15}$/.test(after) ? Number(after) : undefined });
  const manage = g.caps.includes("billing.manage");
  const tax = g.caps.includes("tax.manage");
  return (
    <section className="grid gap-8">
      <PageHeader title="Langganan dan tagihan" description="Satu paket semua fitur. Cron, tombol Bayar penjual dan formulir di bawah memakai satu pembuat tagihan: periode yang sama selalu menghasilkan tagihan yang sama." />
      <Notice error={error} saved={saved} savedText="Tersimpan." />
      {typeof invoice === "string" && (
        <p role="note" className="rounded-lg border px-3 py-2.5 text-sm" data-testid="billing-created">
          {created === "1" ? "Tagihan dibuat." : "Tagihan periode ini sudah ada; tidak dibuat ganda."} <Link href={`/admin/billing/invoices/${invoice}`} className="underline underline-offset-4">Buka tagihan</Link>
        </p>
      )}
      {typeof requested === "string" && (
        <p role="note" className="rounded-lg border px-3 py-2.5 text-sm" data-testid="billing-requested">Permintaan persetujuan #{requested} dikirim. Orang kedua memutuskannya di <Link href="/admin/approvals" className="underline underline-offset-4">Persetujuan</Link>; setelah disetujui, jalankan di sini dengan nomor persetujuan itu.</p>
      )}

      <section aria-labelledby="paket" className="grid gap-3">
        <h2 id="paket" className="text-lg font-semibold">Paket dan konfigurasi saat ini</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border p-4 text-sm" data-testid="billing-plan">
          <dt className="text-muted-foreground">Versi</dt>
          <dd>{o.plan.version} (berlaku sejak {tanggal(o.plan.effectiveFrom)})</dd>
          <dt className="text-muted-foreground">Harga DPP</dt>
          <dd>{rupiah(o.plan.monthlyDppIdr)} per toko per bulan</dd>
          <dt className="text-muted-foreground">Percobaan / tenggang</dt>
          <dd>{o.plan.trialDays} hari / {o.plan.graceDays} hari</dd>
          <dt className="text-muted-foreground">PPN</dt>
          <dd data-testid="billing-ppn-state">{o.plan.ppnEnabled ? "Menyala (tarif dari kebijakan pajak vat_output yang berlaku)" : "Mati (Rp0 di setiap tagihan baru)"}</dd>
          <dt className="text-muted-foreground">Cron tagihan</dt>
          <dd>{o.controls.jobsFrozen ? "Dibekukan" : "Berjalan"} · pengingat surel {o.controls.dunningEnabled ? "dijadwalkan" : "mati"} (tidak berarti terkirim)</dd>
        </dl>
        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Riwayat versi ({o.plans.length})</summary>
          <ol className="mt-2 grid gap-1">
            {o.plans.map((p) => (
              <li key={p.id} className="grid gap-0.5 border-b py-1.5 last:border-0 sm:grid-cols-[3rem_1fr]">
                <span className="text-muted-foreground">v{p.version}</span>
                <span>{rupiah(p.monthlyDppIdr)} · percobaan {p.trialDays} · tenggang {p.graceDays} · PPN {p.ppnEnabled ? "menyala" : "mati"} · {tanggal(p.effectiveFrom)} · {p.reason}</span>
              </li>
            ))}
          </ol>
        </details>
      </section>

      <section aria-labelledby="toko" className="grid gap-3">
        <h2 id="toko" className="text-lg font-semibold">Toko</h2>
        {o.rows.length === 0 ? (
          <EmptyState title="Belum ada toko">Status langganan toko muncul di sini setelah toko dibuat.</EmptyState>
        ) : (
          <Table>
            <caption className="sr-only">Status langganan per toko</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Toko</TableHead>
                <TableHead>Status tagihan</TableHead>
                <TableHead>Aktif sampai</TableHead>
                <TableHead>Penangguhan operator</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.rows.map((r) => (
                <TableRow key={r.storeId} data-testid="billing-store-row">
                  <TableCell><Link href={`/admin/stores/${r.storeId}`} className="underline underline-offset-4">{r.name}</Link> <span className="text-xs text-muted-foreground">#{r.storeId}</span></TableCell>
                  <TableCell><StatusBadge label={billingStateLabel[r.derivedState]} tone={billingStateTone[r.derivedState]} /></TableCell>
                  <TableCell>{tanggal(r.coveredUntil)}</TableCell>
                  <TableCell>{r.suspendedAt ? `Sejak ${tanggal(r.suspendedAt)}` : "Tidak"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {o.nextAfter !== null && <Link href={`/admin/billing?after=${o.nextAfter}`} className={buttonVariants({ variant: "outline" }) + " w-fit"}>Toko berikutnya</Link>}
      </section>

      {manage && (
        <section aria-labelledby="buat" className="grid gap-3">
          <h2 id="buat" className="text-lg font-semibold">Buat tagihan manual</h2>
          <form action={createInvoiceAction} className="grid gap-3 rounded-lg border p-4 md:grid-cols-3">
            <div className={field}>
              <Label htmlFor="storeId">ID toko</Label>
              <Input id="storeId" name="storeId" type="number" min={1} required />
            </div>
            <div className={field}>
              <Label htmlFor="periodIndex">Periode ke- (kosong = periode berjalan)</Label>
              <Input id="periodIndex" name="periodIndex" type="number" min={0} />
            </div>
            <div className={`${field} md:col-span-3`}>
              <Label htmlFor="reason">Alasan</Label>
              <Input id="reason" name="reason" required minLength={5} maxLength={500} />
            </div>
            <div className="md:col-span-3">
              <SubmitButton>Buat tagihan</SubmitButton>
              <p className="mt-1 text-xs text-muted-foreground">Jika periode itu sudah punya tagihan, tagihan yang ada dikembalikan; tidak pernah dibuat ganda.</p>
            </div>
          </form>
        </section>
      )}

      {manage && (
        <section aria-labelledby="comp" className="grid gap-3">
          <h2 id="comp" className="text-lg font-semibold">Comp (masa aktif gratis)</h2>
          <p className="text-sm text-muted-foreground">Tagihan Rp0 berjenis comp dengan periode tertentu: bukan pendapatan dan tanpa instruksi pembayaran. Butuh persetujuan orang kedua. Tagihan belum dibayar pada periode itu dibatalkan; periode yang sudah dibayar tidak diubah.</p>
          <form action={requestCompAction} className="grid gap-3 rounded-lg border p-4 md:grid-cols-3" aria-label="Ajukan comp">
            <div className={field}><Label htmlFor="comp-store">ID toko</Label><Input id="comp-store" name="storeId" type="number" min={1} required /></div>
            <div className={field}><Label htmlFor="comp-period">Periode ke-</Label><Input id="comp-period" name="periodIndex" type="number" min={0} required /></div>
            <div className={field}><Label htmlFor="comp-reason">Alasan</Label><Input id="comp-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <div className="md:col-span-3"><SubmitButton>Ajukan comp</SubmitButton></div>
          </form>
          <form action={grantCompAction} className="grid gap-3 rounded-lg border p-4 md:grid-cols-4" aria-label="Jalankan comp yang disetujui">
            <div className={field}><Label htmlFor="g-store">ID toko</Label><Input id="g-store" name="storeId" type="number" min={1} required /></div>
            <div className={field}><Label htmlFor="g-period">Periode ke-</Label><Input id="g-period" name="periodIndex" type="number" min={0} required /></div>
            <div className={field}><Label htmlFor="g-approval">Nomor persetujuan</Label><Input id="g-approval" name="approvalId" type="number" min={1} required /></div>
            <div className={field}><Label htmlFor="g-reason">Alasan</Label><Input id="g-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <div className="md:col-span-4"><ConfirmSubmit message="Jalankan comp yang sudah disetujui? Ini memberi masa aktif gratis dan tidak bisa dibatalkan." variant="outline">Jalankan comp</ConfirmSubmit></div>
          </form>
        </section>
      )}

      {manage && (
        <section aria-labelledby="harga" className="grid gap-3">
          <h2 id="harga" className="text-lg font-semibold">Harga paket dan hari percobaan/tenggang</h2>
          <p className="text-sm text-muted-foreground">Perubahan hanya berlaku untuk tagihan yang dibuat sesudahnya; tagihan yang sudah terbit tidak berubah. Harga butuh persetujuan orang kedua.</p>
          <form action={requestPriceAction} className="grid gap-3 rounded-lg border p-4 md:grid-cols-3" aria-label="Ajukan harga baru">
            <div className={field}><Label htmlFor="p-price">Harga DPP baru (Rp)</Label><Input id="p-price" name="monthlyDppIdr" type="number" min={1} step={1} required /></div>
            <div className={`${field} md:col-span-2`}><Label htmlFor="p-reason">Alasan</Label><Input id="p-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <div className="md:col-span-3"><SubmitButton>Ajukan harga</SubmitButton></div>
          </form>
          <form action={changePriceAction} className="grid gap-3 rounded-lg border p-4 md:grid-cols-3" aria-label="Jalankan harga yang disetujui">
            <div className={field}><Label htmlFor="pp-price">Harga DPP (Rp)</Label><Input id="pp-price" name="monthlyDppIdr" type="number" min={1} step={1} required /></div>
            <div className={field}><Label htmlFor="pp-approval">Nomor persetujuan</Label><Input id="pp-approval" name="approvalId" type="number" min={1} required /></div>
            <div className={field}><Label htmlFor="pp-reason">Alasan</Label><Input id="pp-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <div className="md:col-span-3"><ConfirmSubmit message="Terapkan harga baru untuk tagihan berikutnya?" variant="outline">Jalankan perubahan harga</ConfirmSubmit></div>
          </form>
          <form action={changeDaysAction} className="grid gap-3 rounded-lg border p-4 md:grid-cols-3" aria-label="Hari percobaan dan tenggang">
            <div className={field}><Label htmlFor="d-trial">Hari percobaan</Label><Input id="d-trial" name="trialDays" type="number" min={0} max={60} defaultValue={o.plan.trialDays} required /></div>
            <div className={field}><Label htmlFor="d-grace">Hari tenggang</Label><Input id="d-grace" name="graceDays" type="number" min={0} max={60} defaultValue={o.plan.graceDays} required /></div>
            <div className={field}><Label htmlFor="d-reason">Alasan</Label><Input id="d-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <div className="md:col-span-3"><SubmitButton>Simpan hari</SubmitButton><p className="mt-1 text-xs text-muted-foreground">Percobaan berlaku untuk toko yang dibuat sesudahnya; tenggang untuk masa aktif yang berakhir sesudahnya.</p></div>
          </form>
        </section>
      )}

      {tax && (
        <section aria-labelledby="ppn" className="grid gap-3">
          <h2 id="ppn" className="text-lg font-semibold">Saklar PPN</h2>
          <p className="text-sm text-muted-foreground">PPN mati secara bawaan. Menyalakan hanya berlaku untuk tagihan baru dan butuh kebijakan PPN keluaran (vat_output) yang berlaku dan terkonfirmasi; tarifnya selalu nilai kebijakan itu, tidak pernah angka tetap. Dokumen hukum, pajak dan status PKP adalah tanggung jawab pemilik.</p>
          <form action={setPpnAction} className="grid gap-3 rounded-lg border p-4" aria-label="Saklar PPN">
            <input type="hidden" name="enabled" value={o.plan.ppnEnabled ? "0" : "1"} />
            <div className={field}><Label htmlFor="ppn-reason">Alasan</Label><Input id="ppn-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirmed" required className="mt-1" /> <span>Saya paham bahwa dokumen hukum, pajak dan status PKP adalah tanggung jawab pemilik, dan perubahan ini hanya berlaku untuk tagihan baru.</span></label>
            <div><ConfirmSubmit message={o.plan.ppnEnabled ? "Matikan PPN untuk tagihan baru?" : "Nyalakan PPN untuk tagihan baru?"} variant="outline">{o.plan.ppnEnabled ? "Matikan PPN" : "Nyalakan PPN"}</ConfirmSubmit></div>
          </form>
        </section>
      )}

      {manage && (
        <section aria-labelledby="kontrol" className="grid gap-3">
          <h2 id="kontrol" className="text-lg font-semibold">Kontrol cron</h2>
          <form action={setControlsAction} className="grid gap-3 rounded-lg border p-4" aria-label="Kontrol cron tagihan">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="jobsFrozen" defaultChecked={o.controls.jobsFrozen} /> Bekukan cron tagihan (setelah pemulihan basis data)</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="dunningEnabled" defaultChecked={o.controls.dunningEnabled} /> Jadwalkan pengingat surel (butuh pengiriman surel nyata yang terbukti; hingga itu hanya niat di kotak keluar)</label>
            <div className={field}><Label htmlFor="c-reason">Alasan</Label><Input id="c-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <div><SubmitButton>Simpan kontrol</SubmitButton></div>
          </form>
        </section>
      )}
    </section>
  );
}
