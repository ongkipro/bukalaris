import { fieldClass, Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { operatorOrDeny } from "@/lib/context";
import { rupiah } from "@/lib/format";
import { applyMargin, db, getMarginRule, marginRuleAudit, ROUND_TO_OPTIONS } from "@bukalaris/db";
import { setMarginRuleAction } from "./actions";

/** Provider costs observed on a Jakarta → Bandung 1 kg route (docs/tracks/shipping.md) for the preview. */
const SAMPLE_COSTS = [9_000, 10_500, 15_494, 22_320];

export default async function AdminShippingPage({ searchParams }: PageProps<"/admin/shipping">) {
  const { error, saved } = await searchParams;
  const op = await operatorOrDeny();
  const [rule, audit] = await Promise.all([getMarginRule(db()), marginRuleAudit(op)]);
  return (
    <section className="grid gap-6">
      <div>
        <h1 className="mb-1 text-2xl font-semibold">Margin ongkir</h1>
        <p className="text-sm text-muted-foreground">
          Biaya kirim pembeli = biaya kurir (akun Mengantar platform) + margin, dibulatkan ke atas. Berlaku untuk semua toko.
        </p>
      </div>
      <Notice error={error} saved={saved} />

      <form action={setMarginRuleAction} className="grid gap-4 rounded-lg border p-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
        <div className="grid min-w-0 gap-1.5">
          <label htmlFor="fixedIdr" className="text-sm font-medium">Margin tetap (Rp)</label>
          <Input id="fixedIdr" name="fixedIdr" type="number" inputMode="numeric" min={0} max={100000} step={1} defaultValue={rule.fixedIdr} required />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <label htmlFor="percent" className="text-sm font-medium">Margin persen (%)</label>
          <Input id="percent" name="percent" type="number" inputMode="decimal" min={0} max={100} step={0.01} defaultValue={rule.percentBps / 100} required />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <label htmlFor="roundTo" className="text-sm font-medium">Pembulatan ke atas</label>
          <select id="roundTo" name="roundTo" defaultValue={rule.roundTo} className={fieldClass}>
            {ROUND_TO_OPTIONS.map((r) => (
              <option key={r} value={r}>{r === 1 ? "Tanpa pembulatan" : `Rp ${r.toLocaleString("id-ID")}`}</option>
            ))}
          </select>
        </div>
        <Button type="submit">Simpan aturan</Button>
      </form>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Simulasi aturan saat ini</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Biaya kurir</TableHead>
              <TableHead>Margin</TableHead>
              <TableHead>Biaya pembeli</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SAMPLE_COSTS.map((cost) => {
              const fee = applyMargin(cost, rule);
              return (
                <TableRow key={cost} data-testid="margin-preview">
                  <TableCell>{rupiah(fee.providerCost)}</TableCell>
                  <TableCell>{rupiah(fee.margin)}</TableCell>
                  <TableCell className="font-medium">{rupiah(fee.buyerFee)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <section aria-labelledby="audit-heading">
        <h2 id="audit-heading" className="mb-2 text-lg font-semibold">Riwayat perubahan</h2>
        {audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum pernah diubah; aturan bawaan berlaku.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {audit.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-3 text-muted-foreground">
                <time dateTime={a.createdAt.toISOString()}>{a.createdAt.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}</time>
                <code className="text-foreground">{a.reason}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
