import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { operatorOrDeny } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { applyMargin, db, getMarginRule, marginRuleAudit, ROUND_TO_OPTIONS } from "@bukalaris/db";
import { setMarginRuleAction } from "./actions";

export const metadata = { title: "Margin ongkir — Super Admin" };

/** Provider costs observed on a Jakarta → Bandung 1 kg route (docs/tracks/shipping.md) for the preview. */
const SAMPLE_COSTS = [9_000, 10_500, 15_494, 22_320];

export default async function AdminShippingPage({ searchParams }: PageProps<"/admin/shipping">) {
  const { error, saved } = await searchParams;
  const op = await operatorOrDeny();
  const [rule, audit] = await Promise.all([getMarginRule(db()), marginRuleAudit(op)]);
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader title="Margin ongkir" description="Biaya kirim pembeli = biaya kurir (akun Mengantar platform) + margin, dibulatkan ke atas. Berlaku untuk semua toko dan pesanan baru." />
      <Notice error={error} saved={saved} />

      <form action={setMarginRuleAction} className="grid gap-4 rounded-lg border p-4 md:grid-cols-3">
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
        <div className="md:col-span-3">
          <SubmitButton>Simpan aturan</SubmitButton>
        </div>
      </form>

      <section aria-labelledby="simulasi" className="grid gap-2">
        <div>
          <h2 id="simulasi" className="text-lg font-semibold">Simulasi aturan saat ini</h2>
          <p className="text-sm text-muted-foreground">Contoh biaya kurir rute Jakarta → Bandung 1 kg; hasil mengikuti aturan yang tersimpan.</p>
        </div>
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
