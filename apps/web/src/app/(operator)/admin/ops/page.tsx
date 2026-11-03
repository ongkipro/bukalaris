import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { consoleGate } from "@/lib/console-gate";
import { tanggal } from "@/lib/format";
import { log } from "@/lib/log";
import { jobStatusLabel, jobStatusTone, type JobStatus } from "@/lib/status";
import { consoleJobHealth, consoleFunctionHealth, type FunctionHealthRow, type ConsoleJobHealth } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../access-denied";
import { requeueJobAction, resolveJobAction } from "./actions";

export const metadata = { title: "Kesehatan sistem" };

const SCHEDULER: Record<string, [string, "success" | "warning" | "destructive"]> = {
  ok: ["Penjadwal berjalan", "success"],
  stale: ["Penjadwal terlambat", "destructive"],
  skewed: ["Jam penjadwal tidak cocok", "warning"],
  absent: ["Penjadwal belum pernah berjalan", "warning"],
};
const age = (ms: number | null) => (ms === null ? "—" : ms < 60_000 ? `${Math.round(ms / 1000)} dtk` : `${Math.round(ms / 60_000)} mnt`);

export default async function OpsPage({ searchParams }: PageProps<"/admin/ops">) {
  const g = await consoleGate("/admin/ops", "ops.read");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { error, saved } = await searchParams;
  const canManage = g.caps.includes("ops.jobs.manage");
  let h: ConsoleJobHealth | null = null;
  try {
    h = await consoleJobHealth(g.op);
  } catch (err) {
    await log("error", "job health source unavailable", { module: "admin.ops", operation: "consoleJobHealth", error_name: err instanceof Error ? err.name : "unknown" });
  }
  const scheduler = h ? (SCHEDULER[h.scheduler.state] ?? [h.scheduler.state, "warning" as const]) : null;
  let functions: FunctionHealthRow[] | null = null;
  if (g.caps.includes("ops.issues.manage")) {
    try { functions = await consoleFunctionHealth(g.op); } catch { /* Source failure is shown separately, never as zero. */ }
  }
  return (
    <section className="grid gap-6">
      <PageHeader title="Kesehatan sistem" description={h ? <>Per <time dateTime={h.asOf.toISOString()}>{tanggal(h.asOf)}</time>. Antrean pekerjaan, pekerjaan gagal, dan penjadwal berkala.</> : "Sumber tidak tersedia."} />
      <Notice error={error} saved={saved} savedText="Perubahan tersimpan dan tercatat di audit." />
      {h === null ? (
        <p role="alert" className="rounded-lg border border-destructive/40 p-6">
          <strong className="block">Sumber kesehatan sistem tidak tersedia.</strong>Ini bukan berarti sistem sehat. Coba muat ulang.
        </p>
      ) : (
        <>
          <section aria-labelledby="scheduler" className="grid gap-2">
            <h2 id="scheduler" className="text-lg font-semibold">Penjadwal</h2>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge label={scheduler![0]} tone={scheduler![1]} data-testid="scheduler-state" />
              {h.scheduler.lastTickAt && <span className="text-muted-foreground">Detak terakhir <time dateTime={h.scheduler.lastTickAt.toISOString()}>{tanggal(h.scheduler.lastTickAt)}</time></span>}
            </div>
          </section>

          <section aria-labelledby="lag" className="grid gap-2">
            <h2 id="lag" className="text-lg font-semibold">Antrean per jenis</h2>
            {h.lag.length === 0 ? (
              <EmptyState title="Tidak ada pekerjaan aktif">Antrean kosong, tidak ada pekerjaan gagal atau belum diketahui hasilnya.</EmptyState>
            ) : (
              <Table>
                <caption className="sr-only">Antrean pekerjaan per jenis</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Jenis</TableHead>
                    <TableHead numeric>Menunggu</TableHead>
                    <TableHead numeric>Berjalan</TableHead>
                    <TableHead numeric>Gagal</TableHead>
                    <TableHead numeric>Belum diketahui</TableHead>
                    <TableHead numeric>Tertua</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {h.lag.map((r) => (
                    <TableRow key={`${r.kind}-${r.priority}`}>
                      <TableCell className="font-mono">{r.kind}</TableCell>
                      <TableCell numeric>{r.pending}</TableCell>
                      <TableCell numeric>{r.running}</TableCell>
                      <TableCell numeric>{r.dead}</TableCell>
                      <TableCell numeric>{r.unknown}</TableCell>
                      <TableCell numeric>{age(r.oldestDueAgeMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <section aria-labelledby="dead" className="grid gap-2">
            <h2 id="dead" className="text-lg font-semibold">Pekerjaan gagal dan belum diketahui hasilnya</h2>
            {h.letters.jobs.length === 0 ? (
              <EmptyState title="Tidak ada pekerjaan gagal">Pekerjaan yang gagal permanen atau belum jelas hasilnya muncul di sini.</EmptyState>
            ) : (
              <ul className="grid gap-3">
                {h.letters.jobs.map((j) => (
                  <li key={j.id} className="grid gap-2 rounded-lg border p-3" data-testid={`job-${j.id}`}>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono">#{j.id} {j.kind}</span>
                      <StatusBadge label={jobStatusLabel[j.status as JobStatus]} tone={jobStatusTone[j.status as JobStatus]} />
                      <span className="text-muted-foreground tabular-nums">{j.attempts} percobaan · <time dateTime={j.updatedAt.toISOString()}>{tanggal(j.updatedAt)}</time></span>
                    </div>
                    {j.lastError && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{j.lastError}</p>}
                    {canManage && j.status === "dead" && (j.requeueable ? (
                      <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                        <div className="grid gap-1.5">
                          <Label htmlFor={`rq-${j.id}`}>Alasan antre ulang (wajib)</Label>
                          <Input id={`rq-${j.id}`} name="reason" required minLength={3} maxLength={400} />
                        </div>
                        <SubmitButton formAction={requeueJobAction.bind(null, j.id)} variant="outline" pendingText="Mengantre…">Antre ulang</SubmitButton>
                      </form>
                    ) : (
                      <p className="text-sm text-muted-foreground">Jenis ini tidak aman diulang buta; layanan pemiliknya yang merekonsiliasi.</p>
                    ))}
                    {canManage && j.status === "unknown" && (
                      <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
                        <div className="grid gap-1.5">
                          <Label htmlFor={`rs-${j.id}`}>Bukti hasil di sistem pemilik (wajib)</Label>
                          <Input id={`rs-${j.id}`} name="evidence" required minLength={3} maxLength={400} />
                        </div>
                        <SubmitButton formAction={resolveJobAction.bind(null, j.id, "effect_confirmed")} variant="outline" pendingText="Menyimpan…">Efek terjadi</SubmitButton>
                        <SubmitButton formAction={resolveJobAction.bind(null, j.id, "effect_absent")} variant="outline" pendingText="Menyimpan…">Efek tidak terjadi</SubmitButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {h.replay && (
            <section aria-labelledby="replay" className="grid gap-2">
              <h2 id="replay" className="text-lg font-semibold">Riwayat antre ulang dan rekonsiliasi</h2>
              {h.replay.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada tindakan.</p>
              ) : (
                <ul className="divide-y rounded-lg border text-sm">
                  {h.replay.map((r) => (
                    <li key={r.id} className="p-3"><time dateTime={r.createdAt.toISOString()} className="text-muted-foreground">{tanggal(r.createdAt)}</time> · <span className="font-mono">{r.action}</span> · <span className="font-mono">{r.actorUserId}</span></li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
      {g.caps.includes("ops.issues.manage") && <section className="grid min-w-0 gap-3" aria-labelledby="function-health">
        <h2 id="function-health" className="text-lg font-semibold">Kesehatan fungsi per halaman</h2>
        {functions === null ? <p role="alert">Sumber kesehatan fungsi tidak tersedia.</p> : <Table>
          <caption className="sr-only">Laporan terbuka per ARCH-5</caption>
          <TableHeader><TableRow><TableHead>Halaman</TableHead>{["Rendah", "Sedang", "Tinggi", "Menghambat", "Tertua", "7 hari", "Error 24 jam"].map((h) => <TableHead key={h} numeric>{h}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{functions.map((r) => <TableRow key={r.pageId} data-testid={`health-${r.pageId}`}>
            <TableCell><Link className="underline underline-offset-4" href={`/admin/issues?pageId=${r.pageId}`}>{r.pageId} · {r.title}</Link></TableCell>
            <TableCell numeric>{r.low}</TableCell><TableCell numeric>{r.medium}</TableCell><TableCell numeric>{r.high}</TableCell><TableCell numeric>{r.blocking}</TableCell><TableCell numeric>{age(r.oldestAgeMs)}</TableCell><TableCell numeric>{r.week}</TableCell><TableCell numeric>{r.errors}</TableCell>
          </TableRow>)}</TableBody>
        </Table>}
      </section>}
    </section>
  );
}
