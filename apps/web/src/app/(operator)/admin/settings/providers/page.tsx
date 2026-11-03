import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { consoleGate } from "@/lib/console-gate";
import { tanggal } from "@/lib/format";
import { consoleProviderHealth } from "@bukalaris/db";
import { AccessDenied } from "../../access-denied";

export const metadata = { title: "Kesehatan provider" };

export default async function ProvidersPage() {
  const g = await consoleGate("/admin/settings/providers");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const h = await consoleProviderHealth(g.op);
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader title="Kesehatan provider" description="Hasil terakhir yang tercatat di Log System. Konsol ini tidak membaca atau menampilkan kredensial; rotasi dilakukan di penyimpanan rahasia. Provider tanpa catatan berstatus tidak diketahui, bukan sehat." />
      <Table>
        <caption className="sr-only">Provider</caption>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>Kejadian terakhir</TableHead>
            <TableHead>Gagal terakhir</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {h.providers.map((p) => (
            <TableRow key={p.provider} data-testid={`provider-${p.provider}`}>
              <TableCell className="font-mono">{p.provider}</TableCell>
              <TableCell className="whitespace-normal">{p.lastEventAt ? <time dateTime={p.lastEventAt.toISOString()}>{tanggal(p.lastEventAt)}</time> : "—"}</TableCell>
              <TableCell className="whitespace-normal">{p.lastFailureAt ? <time dateTime={p.lastFailureAt.toISOString()}>{tanggal(p.lastFailureAt)}</time> : "—"}</TableCell>
              <TableCell>{p.lastEventAt === null ? <StatusBadge label="Tidak diketahui" tone="secondary" /> : p.lastFailureAt && p.lastFailureAt >= p.lastEventAt ? <StatusBadge label="Gagal terakhir" tone="destructive" /> : <StatusBadge label="Ada catatan, tanpa gagal terakhir" tone="success" />}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <section aria-labelledby="gates" className="grid gap-2">
        <h2 id="gates" className="text-lg font-semibold">Saklar live (hanya baca, diatur lewat environment)</h2>
        <ul className="divide-y rounded-lg border text-sm">
          {h.liveGates.map((x) => (
            <li key={x.name} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span><span className="font-mono">{x.name}</span> · {x.on ? "menyala" : "mati"}</span>
              <StatusBadge label={x.on ? "Menyala" : "Mati"} tone={x.on ? "success" : "secondary"} />
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
