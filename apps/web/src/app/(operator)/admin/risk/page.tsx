import { CsrfField } from "@/lib/auth-csrf-form";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { savedText } from "@/lib/governance";
import { hasPlatformCap, riskQueue } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../access-denied";
import { acknowledgeRiskAction } from "./actions";

export const metadata = { title: "Risiko toko" };

export default async function RiskPage({ searchParams }: PageProps<"/admin/risk">) {
  const g = await consoleGate("/admin/risk");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { error, saved, ack } = await searchParams;
  const q = await allowed(riskQueue(g.op, { showAcknowledged: ack === "1" }));
  if (q === undefined) return <AccessDenied capability="tenants.read" />;
  const canAck = await hasPlatformCap(g.op, "tenants.manage");
  const ruleOf = (key: string) => q.rules.find((r) => r.key === key);
  return (
    <section className="grid gap-6">
      <PageHeader title="Risiko toko" description={<>Tanda diturunkan saat dibaca dari status yang sebenarnya, bukan disimpan. Data per {tanggal(q.asOf)}. Tidak ada data pribadi di layar ini.</>} />
      <Notice error={error} saved={saved} savedText={savedText(saved)} />
      <p className="text-sm text-muted-foreground">
        {q.hiddenAcknowledged > 0 && ack !== "1" ? <>{q.hiddenAcknowledged} tanda disembunyikan karena diakui. <Link href="/admin/risk?ack=1" className="underline underline-offset-4">Tampilkan</Link></> : ack === "1" ? <Link href="/admin/risk" className="underline underline-offset-4">Sembunyikan tanda yang diakui</Link> : "Tidak ada tanda yang diakui."}
      </p>
      {q.flags.length === 0 ? <EmptyState title="Tidak ada tanda risiko dari sumber yang tersedia">Ini bukan jaminan: sumber di bawah yang belum tersedia tidak ikut dihitung.</EmptyState> : (
        <ul className="grid gap-3">
          {q.flags.map((f) => (
            <li key={`${f.storeId}-${f.key}`} className="grid gap-2 rounded-lg border p-4 text-sm" data-testid={`risk-${f.storeId}-${f.key}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <Link href={`/admin/stores/${f.storeId}`} className="font-semibold underline underline-offset-4">{f.storeName}</Link>
                  <span>{ruleOf(f.key)?.rule ?? f.key}</span>
                  <span className="tabular-nums font-medium">{f.count} kasus</span>
                </div>
                <StatusBadge label={f.acknowledged ? "Diakui sementara" : "Perlu tinjauan"} tone={f.acknowledged ? "secondary" : "warning"} />
              </div>
              <p className="text-xs text-muted-foreground">Sumber: {ruleOf(f.key)?.source}{f.oldestAt ? <> · tertua <time dateTime={f.oldestAt.toISOString()}>{tanggal(f.oldestAt)}</time></> : null}{f.acknowledged ? <> · diakui sampai <time dateTime={f.acknowledged.until.toISOString()}>{tanggal(f.acknowledged.until)}</time></> : null}</p>
              {canAck && !f.acknowledged && (
                <form action={acknowledgeRiskAction.bind(null, f.storeId, f.key)} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-end">
        <CsrfField />
                  <div className="grid gap-1.5"><Label htmlFor={`alasan-${f.storeId}-${f.key}`}>Alasan pengakuan</Label><Input id={`alasan-${f.storeId}-${f.key}`} name="reason" required minLength={5} maxLength={500} /></div>
                  <div className="grid gap-1.5"><Label htmlFor={`jam-${f.storeId}-${f.key}`}>Jam</Label><Input id={`jam-${f.storeId}-${f.key}`} name="hours" type="number" min={1} max={2160} defaultValue={24} required /></div>
                  <SubmitButton variant="outline" pendingText="Menyimpan…">Akui</SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <section aria-labelledby="belum" className="grid gap-2">
        <h2 id="belum" className="text-lg font-semibold">Sumber yang belum tersedia</h2>
        <ul className="divide-y rounded-lg border text-sm">
          {q.unavailableRules.map((r) => <li key={r.key} className="p-3">{r.rule} <span className="text-muted-foreground">· belum tersedia ({r.source})</span></li>)}
        </ul>
      </section>
    </section>
  );
}
