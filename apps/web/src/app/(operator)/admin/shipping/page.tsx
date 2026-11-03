import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { applyMargin, db, getMarginRule, marginRuleAudit, ROUND_TO_OPTIONS, shippingAccountHealth, shippingPolicyOverview } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../access-denied";
import { applyMarginAction, applySettingsAction, recoverAccountAction, requestMarginAction, requestSettingsAction, saveCashbackRuleAction, setCourierPolicyAction } from "./actions";

export const metadata = { title: "Margin ongkir dan akun pengiriman" };

/** Provider costs observed on a Jakarta → Bandung 1 kg route (docs/tracks/shipping.md) for the preview. */
const SAMPLE_COSTS = [9_000, 10_500, 15_494, 22_320];
const SAVED: Record<string, string> = {
  margin_requested: "Perubahan margin diajukan. Orang kedua menyetujuinya di Persetujuan, lalu Anda menerapkannya di sini dengan ID persetujuan.",
  margin_applied: "Tersimpan.",
  settings_requested: "Perubahan kebijakan diajukan. Orang kedua menyetujuinya di Persetujuan, lalu Anda menerapkannya di sini dengan ID persetujuan.",
  settings_applied: "Tersimpan.",
  cashback_saved: "Aturan cashback tersimpan sebagai draf. Cashback tetap mati: belum ada aturan yang berlaku.",
  courier_saved: "Kebijakan layanan kurir tersimpan; hanya berlaku untuk pesanan baru.",
  recovery_queued: "Pemulihan akun dijadwalkan. Hasilnya muncul di kolom Hasil terakhir.",
};
const STATUS_LABEL: Record<string, string> = { pending: "Menunggu pembuatan", active: "Aktif", needs_key: "Perlu pemulihan kunci", disabled: "Dinonaktifkan" };
const STATUS_TONE: Record<string, "success" | "warning" | "destructive" | "secondary"> = { pending: "warning", active: "success", needs_key: "warning", disabled: "destructive" };
const KIND_LABEL: Record<string, string> = { partner_managed: "Akun mitra toko", platform_master: "Akun induk" };

export default async function AdminShippingPage({ searchParams }: PageProps<"/admin/shipping">) {
  const g = await consoleGate("/admin/shipping");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { error, saved, after } = await searchParams;
  const cursor = typeof after === "string" && /^\d{1,15}$/.test(after) ? Number(after) : 0;
  const audit = await allowed(marginRuleAudit(g.op));
  if (audit === undefined) return <AccessDenied capability="shipping.manage" />;
  const [rule, policy, health] = await Promise.all([getMarginRule(db()), shippingPolicyOverview(g.op), shippingAccountHealth(g.op, cursor)]);
  const { settings } = policy;
  const nextCursor = health.accounts.length === 100 ? health.accounts[99]!.id : null;
  return (
    <section className="grid max-w-5xl gap-8">
      <PageHeader title="Margin ongkir dan akun pengiriman" description="Biaya kirim pembeli = biaya kurir + margin, dibulatkan ke atas. Semua perubahan harga memerlukan persetujuan orang kedua dan hanya berlaku untuk pesanan baru." />
      <Notice error={error} saved={saved} savedText={typeof saved === "string" ? SAVED[saved] : undefined} />

      <section aria-labelledby="gerbang" className="grid gap-2 rounded-lg border p-4" data-testid="provider-gate">
        <h2 id="gerbang" className="text-lg font-semibold">Gerbang akses penyedia</h2>
        <p className="text-sm" data-testid="gate-state">{health.rotationRecorded ? "Rotasi Partner Secret tercatat. Panggilan penyedia diizinkan oleh gerbang ini." : "Terkunci: rotasi Partner Secret belum dicatat. Tidak ada panggilan ke penyedia (termasuk sandbox) yang dapat dilakukan; adaptor simulasi tetap berjalan."}</p>
        <p className="text-xs text-muted-foreground">Gerbang dibuka oleh pemilik lewat secret store dan RUNBOOK (tanpa nilai secret di layar ini). Akun mitra di bawah baru dipakai untuk pengiriman nyata setelah settlement mitra (OPEN-F9) terverifikasi.</p>
      </section>

      <section aria-labelledby="margin" className="grid gap-3">
        <h2 id="margin" className="text-lg font-semibold">Margin</h2>
        <form className="grid gap-4 rounded-lg border p-4 md:grid-cols-3" aria-label="Aturan margin">
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="fixedIdr">Margin tetap (Rp)</Label>
            <Input id="fixedIdr" name="fixedIdr" type="number" inputMode="numeric" min={0} max={100000} step={1} defaultValue={rule.fixedIdr} required className="tabular-nums" aria-describedby="fixed-help" />
            <p id="fixed-help" className="text-xs text-muted-foreground">0–100.000, bilangan bulat.</p>
          </div>
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="percent">Margin persen (%)</Label>
            <Input id="percent" name="percent" type="number" inputMode="decimal" min={0} max={100} step={0.01} defaultValue={rule.percentBps / 100} required className="tabular-nums" aria-describedby="percent-help" />
            <p id="percent-help" className="text-xs text-muted-foreground">Dari biaya kurir, maksimal 2 desimal.</p>
          </div>
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="roundTo">Pembulatan ke atas</Label>
            <NativeSelect id="roundTo" name="roundTo" defaultValue={rule.roundTo} aria-describedby="round-help">
              {ROUND_TO_OPTIONS.map((r) => (
                <option key={r} value={r}>{r === 1 ? "Tanpa pembulatan" : `Rp ${r.toLocaleString("id-ID")}`}</option>
              ))}
            </NativeSelect>
            <p id="round-help" className="text-xs text-muted-foreground">Kelipatan biaya akhir pembeli.</p>
          </div>
          <div className="grid gap-2 md:col-span-3 md:grid-cols-[12rem_minmax(0,1fr)] md:items-end">
            <div className="grid gap-2">
              <Label htmlFor="margin-approval">ID persetujuan (untuk menerapkan)</Label>
              <Input id="margin-approval" name="approvalId" inputMode="numeric" className="tabular-nums" />
            </div>
            <div className="flex flex-wrap gap-2">
              <SubmitButton formAction={requestMarginAction} variant="outline" pendingText="Mengajukan…">Ajukan perubahan</SubmitButton>
              <SubmitButton formAction={applyMarginAction} pendingText="Menerapkan…">Simpan aturan</SubmitButton>
            </div>
          </div>
        </form>
        <Table>
          <caption className="sr-only">Simulasi margin</caption>
          <TableHeader>
            <TableRow>
              <TableHead numeric>Biaya kurir</TableHead>
              <TableHead numeric>Margin</TableHead>
              <TableHead numeric>Biaya pembeli</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SAMPLE_COSTS.map((cost) => {
              const fee = applyMargin(cost, rule);
              return (
                <TableRow key={cost} data-testid="margin-preview">
                  <TableCell numeric>{rupiah(fee.providerCost)}</TableCell>
                  <TableCell numeric className="text-muted-foreground">{rupiah(fee.margin)}</TableCell>
                  <TableCell numeric className="font-medium">{rupiah(fee.buyerFee)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <section aria-labelledby="kebijakan" className="grid gap-3">
        <h2 id="kebijakan" className="text-lg font-semibold">Diskon ongkir dan rute akun</h2>
        <form className="grid gap-4 rounded-lg border p-4 md:grid-cols-3" aria-label="Kebijakan pengiriman">
          <input type="hidden" name="revision" value={settings.revision} />
          <div className="grid gap-2">
            <Label htmlFor="discountIdr">Diskon ongkir tetap (Rp)</Label>
            <Input id="discountIdr" name="discountIdr" type="number" inputMode="numeric" min={0} max={100000} step={1} defaultValue={settings.discountIdr} required className="tabular-nums" aria-describedby="discount-help" />
            <p id="discount-help" className="text-xs text-muted-foreground">Dibiayai dari margin platform, tidak pernah dari saldo seller (kenaikan tarif kurir lebih dulu ditanggung margin penuh); nilai bawaan 0.</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="discountPercent">Diskon ongkir persen (%)</Label>
            <Input id="discountPercent" name="discountPercent" type="number" inputMode="decimal" min={0} max={100} step={0.01} defaultValue={settings.discountBps / 100} required className="tabular-nums" />
          </div>
          <div className="flex items-end gap-2 pb-2">
            <input id="preferPartner" name="preferPartner" type="checkbox" defaultChecked={settings.preferPartner} className="size-4" />
            <Label htmlFor="preferPartner">Pakai akun mitra toko bila aktif (selain itu akun induk). Mati sampai settlement mitra (OPEN-F9) terverifikasi.</Label>
          </div>
          <div className="grid gap-2 md:col-span-3 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="settings-reason">Alasan</Label>
              <Input id="settings-reason" name="reason" minLength={5} maxLength={300} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="settings-approval">ID persetujuan (untuk menerapkan)</Label>
              <Input id="settings-approval" name="approvalId" inputMode="numeric" className="tabular-nums" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 md:col-span-3">
            <SubmitButton formAction={requestSettingsAction} variant="outline" pendingText="Mengajukan…">Ajukan perubahan</SubmitButton>
            <SubmitButton formAction={applySettingsAction} pendingText="Menerapkan…">Terapkan yang disetujui</SubmitButton>
          </div>
        </form>
      </section>

      <section aria-labelledby="cashback" className="grid gap-3" data-testid="cashback">
        <h2 id="cashback" className="text-lg font-semibold">Pembagian cashback ongkir</h2>
        <p className="text-sm text-muted-foreground" data-testid="cashback-state">Cashback mati: belum ada aturan yang berlaku. Aturan di bawah hanya draf; pembagian seller/platform dan bukti rebate penyedia (OPEN-F9) belum diputuskan.</p>
        {policy.cashbackRules.length === 0 ? (
          <EmptyState title="Belum ada draf aturan">Draf yang Anda simpan muncul di sini dan tidak mengubah saldo siapa pun.</EmptyState>
        ) : (
          <ul className="grid gap-1 text-sm">
            {policy.cashbackRules.map((r) => (
              <li key={r.id} className="rounded-lg border p-2" data-testid={`cashback-rule-${r.id}`}>
                {r.courierCode || "semua kurir"} / {r.serviceCode || "semua layanan"} · seller {r.sellerShareBps / 100}% + {rupiah(r.fixedSellerBonusIdr)} · <StatusBadge label="Draf, tidak berlaku" tone="secondary" />
              </li>
            ))}
          </ul>
        )}
        <form action={saveCashbackRuleAction} className="grid gap-3 rounded-lg border p-4 md:grid-cols-3" aria-label="Draf aturan cashback">
          <div className="grid gap-2"><Label htmlFor="cb-courier">Kode kurir (kosong = semua)</Label><Input id="cb-courier" name="courierCode" maxLength={40} /></div>
          <div className="grid gap-2"><Label htmlFor="cb-service">Kode layanan (kosong = semua)</Label><Input id="cb-service" name="serviceCode" maxLength={40} /></div>
          <div className="grid gap-2"><Label htmlFor="cb-share">Bagian seller (%)</Label><Input id="cb-share" name="sellerSharePercent" type="number" min={0} max={100} step={0.01} defaultValue={0} className="tabular-nums" /></div>
          <div className="grid gap-2"><Label htmlFor="cb-fixed">Bonus tetap seller (Rp)</Label><Input id="cb-fixed" name="fixedSellerBonusIdr" type="number" min={0} max={100000} step={1} defaultValue={0} className="tabular-nums" /></div>
          <div className="grid gap-2"><Label htmlFor="cb-revision">Revisi draf yang diubah (0 = baru)</Label><Input id="cb-revision" name="revision" type="number" min={0} defaultValue={0} className="tabular-nums" /></div>
          <div className="grid gap-2"><Label htmlFor="cb-reason">Alasan</Label><Input id="cb-reason" name="reason" minLength={5} maxLength={300} required /></div>
          <div className="md:col-span-3"><SubmitButton pendingText="Menyimpan…">Simpan draf</SubmitButton></div>
        </form>
      </section>

      <section aria-labelledby="layanan" className="grid gap-3" data-testid="courier-policy">
        <h2 id="layanan" className="text-lg font-semibold">Layanan kurir: COD dan retur gratis</h2>
        <p className="text-sm text-muted-foreground">COD hanya ditawarkan untuk layanan aktif yang COD diizinkan dan retur gratis. Klaim retur gratis belum terverifikasi (OPEN-F7); nilai yang ada tidak diubah oleh pengaturan lain.</p>
        {policy.services.length === 0 ? (
          <EmptyState title="Belum ada kebijakan layanan">Tanpa baris aktif, COD tidak ditawarkan di checkout.</EmptyState>
        ) : (
          <ul className="grid gap-1 text-sm">
            {policy.services.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2" data-testid={`service-${s.courierCode}`}>
                <span className="font-medium">{s.courierCode}{s.serviceCode ? ` / ${s.serviceCode}` : ""}</span>
                <StatusBadge label={s.codAllowed ? "COD diizinkan" : "COD tidak"} tone={s.codAllowed ? "success" : "secondary"} />
                <StatusBadge label={s.returnFree ? "Retur gratis" : "Retur berbayar"} tone={s.returnFree ? "success" : "secondary"} />
                <StatusBadge label={s.status === "active" ? "Aktif" : "Nonaktif"} tone={s.status === "active" ? "success" : "warning"} />
              </li>
            ))}
          </ul>
        )}
        <form action={setCourierPolicyAction} className="grid gap-3 rounded-lg border p-4 md:grid-cols-3" aria-label="Kebijakan layanan kurir">
          <div className="grid gap-2"><Label htmlFor="cp-courier">Kode kurir</Label><Input id="cp-courier" name="courierCode" required maxLength={40} /></div>
          <div className="grid gap-2"><Label htmlFor="cp-service">Kode layanan (kunci estimasi persis, mis. SAPLite; kosong = kurir itu sendiri). Aturan layanan mengalahkan aturan kurir.</Label><Input id="cp-service" name="serviceCode" maxLength={40} /></div>
          <div className="grid gap-2"><Label htmlFor="cp-status">Status</Label><NativeSelect id="cp-status" name="status" defaultValue="active"><option value="active">Aktif</option><option value="disabled">Nonaktif</option></NativeSelect></div>
          <div className="flex items-center gap-2"><input id="cp-cod" name="codAllowed" type="checkbox" className="size-4" /><Label htmlFor="cp-cod">COD diizinkan</Label></div>
          <div className="flex items-center gap-2"><input id="cp-free" name="returnFree" type="checkbox" className="size-4" /><Label htmlFor="cp-free">Retur gratis</Label></div>
          <div className="grid gap-2"><Label htmlFor="cp-reason">Alasan</Label><Input id="cp-reason" name="reason" minLength={5} maxLength={300} required /></div>
          <div className="md:col-span-3"><SubmitButton pendingText="Menyimpan…">Simpan kebijakan</SubmitButton></div>
        </form>
      </section>

      <section aria-labelledby="akun" className="grid gap-3" data-testid="shipping-accounts">
        <h2 id="akun" className="text-lg font-semibold">Kesehatan akun pengiriman</h2>
        <p className="text-sm text-muted-foreground">Status dan hasil terakhir saja. Kunci akun disimpan tersegel dan tidak pernah ditampilkan.</p>
        {health.accounts.length === 0 ? (
          <EmptyState title="Belum ada akun">Setiap toko baru otomatis mendapat akun induk dan akun mitra.</EmptyState>
        ) : (
          <Table>
            <caption className="sr-only">Akun pengiriman per toko</caption>
            <TableHeader>
              <TableRow><TableHead>Akun</TableHead><TableHead>Toko</TableHead><TableHead>Jenis</TableHead><TableHead>Status</TableHead><TableHead>Hasil terakhir</TableHead><TableHead>Aksi</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {health.accounts.map((a) => (
                <TableRow key={a.id} data-testid={`account-${a.id}`}>
                  <TableCell className="tabular-nums">#{a.id}</TableCell>
                  <TableCell className="tabular-nums">{a.storeId}</TableCell>
                  <TableCell>{KIND_LABEL[a.kind] ?? a.kind}</TableCell>
                  <TableCell><StatusBadge label={STATUS_LABEL[a.status] ?? a.status} tone={STATUS_TONE[a.status] ?? "secondary"} /></TableCell>
                  <TableCell>{a.lastResult ?? "—"}{a.lastCheckedAt ? ` · ${tanggal(new Date(a.lastCheckedAt))}` : ""}{a.registrationAttempts > 0 ? ` · gagal ${a.registrationAttempts}×` : ""}{a.autoRetryStopped ? <span className="block text-xs text-destructive">Percobaan otomatis dihentikan (email terdaftar berulang). Pulihkan manual untuk mencoba lagi.</span> : null}</TableCell>
                  <TableCell>
                    {a.kind === "partner_managed" && a.status !== "disabled" ? (
                      <form action={recoverAccountAction} className="flex flex-wrap items-center gap-1">
                        <input type="hidden" name="accountId" value={a.id} />
                        <input type="hidden" name="revision" value={a.revision} />
                        <Input name="reason" aria-label={`Alasan pemulihan akun ${a.id}`} minLength={5} maxLength={300} required placeholder="Alasan" className="h-8 w-32" />
                        <SubmitButton variant="outline" pendingText="…">Pulihkan</SubmitButton>
                      </form>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {nextCursor ? <Link href={`/admin/shipping?after=${nextCursor}`} className={buttonVariants({ variant: "outline" }) + " w-fit"}>Akun berikutnya</Link> : null}
      </section>

      <section aria-labelledby="audit-heading" className="grid gap-2">
        <h2 id="audit-heading" className="text-lg font-semibold">Riwayat perubahan</h2>
        {audit.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum pernah diubah; aturan bawaan berlaku.</p>
        ) : (
          <ol className="divide-y rounded-lg border text-sm">
            {audit.map((a) => (
              <li key={a.id} className="grid gap-0.5 p-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
                <time dateTime={a.createdAt.toISOString()} className="text-muted-foreground">{tanggal(a.createdAt)}</time>
                <code className="break-all">{a.reason}</code>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
