import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { consoleGate } from "@/lib/console-gate";
import { tanggal } from "@/lib/format";
import { ISSUE_CATEGORY_LABEL, ISSUE_SEVERITY_LABEL, ISSUE_SEVERITY_TONE, ISSUE_STATUS_LABEL, ISSUE_STATUS_TONE } from "@/lib/governance";
import { consoleIssues, ISSUE_STATUSES, ISSUE_CATEGORIES, ISSUE_SEVERITIES, type IssuePage } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../access-denied";

export const metadata = { title: "Laporan masalah" };
const OPTION_LABEL: Record<string, Record<string, string>> = {
  status: ISSUE_STATUS_LABEL,
  category: ISSUE_CATEGORY_LABEL,
  severity: ISSUE_SEVERITY_LABEL,
  hasLog: { yes: "Ya", no: "Tidak" },
  sort: { newest: "Terbaru", severity: "Tingkat keparahan" },
};

export default async function IssuesPage({ searchParams }: PageProps<"/admin/issues">) {
  const g = await consoleGate("/admin/issues");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const sp = await searchParams;
  const values = Object.fromEntries(Object.entries(sp).filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1] !== ""));
  let data: IssuePage | undefined;
  let error: string | undefined;
  try {
    data = await consoleIssues(g.op, values);
  } catch {
    error = "Filter tidak valid atau sumber laporan tidak tersedia. Periksa filter lalu coba lagi; ini bukan berarti antrean kosong.";
  }
  const params = new URLSearchParams(values);
  params.delete("cursor");
  const hasFilter = Object.keys(values).some((k) => k !== "cursor");
  const select = (name: string, label: string, options: readonly string[]) => (
    <div className="grid gap-1.5" key={name}>
      <Label htmlFor={`f-${name}`}>{label}</Label>
      <NativeSelect id={`f-${name}`} name={name} defaultValue={values[name] ?? ""}>
        <option value="">Semua</option>
        {options.map((v) => (
          <option key={v} value={v}>
            {OPTION_LABEL[name]?.[v] ? `${OPTION_LABEL[name][v]} (${v})` : v}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
  return (
    <section className="grid min-w-0 gap-6">
      <PageHeader title="Laporan masalah" description="Antrean staf. Teks sudah dibersihkan; tanpa tangkapan layar. Setiap pembacaan dan ekspor tercatat di audit." />
      <form className="grid min-w-0 gap-3 rounded-lg border p-4 sm:grid-cols-2 sm:items-end lg:grid-cols-3" action="/admin/issues" aria-label="Filter laporan masalah">
        {select("status", "Status", ISSUE_STATUSES)}
        {select("category", "Jenis", ISSUE_CATEGORIES)}
        {select("severity", "Tingkat", ISSUE_SEVERITIES)}
        {(
          [
            ["pageId", "ARCH-5 halaman"],
            ["assigneeId", "ID penanggung jawab (unassigned = belum ditugaskan)"],
            ["q", "Cari deskripsi"],
          ] as const
        ).map(([name, label]) => (
          <div className="grid min-w-0 gap-1.5" key={name}>
            <Label htmlFor={`f-${name}`}>{label}</Label>
            <Input id={`f-${name}`} name={name} defaultValue={values[name]} maxLength={name === "q" ? 120 : 128} />
          </div>
        ))}
        {(
          [
            ["from", "Sejak"],
            ["to", "Sampai"],
          ] as const
        ).map(([name, label]) => (
          <div className="grid gap-1.5" key={name}>
            <Label htmlFor={`f-${name}`}>{label}</Label>
            <Input id={`f-${name}`} type="date" name={name} defaultValue={values[name]} />
          </div>
        ))}
        {select("hasLog", "Punya tautan log", ["yes", "no"])}
        {select("sort", "Urutkan", ["newest", "severity"])}
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-2">
          <Button type="submit">Terapkan filter</Button>
          <Link href="/admin/issues" className={buttonVariants({ variant: "outline" })}>
            Hapus filter
          </Link>
        </div>
      </form>
      {error && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          {error}
        </p>
      )}
      {data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
            <p aria-label="Jumlah per status" className="tabular-nums text-muted-foreground">
              {ISSUE_STATUSES.map((s) => `${ISSUE_STATUS_LABEL[s] ?? s} (${s}): ${data.counts.find((r) => r.status === s)?.count ?? 0}`).join(" · ")}
            </p>
            <div className="flex flex-wrap gap-2">
              {["json", "csv"].map((format) => (
                <a className={buttonVariants({ variant: "outline", size: "sm" })} key={format} href={`/admin/issues/export?${params}&format=${format}`}>
                  Ekspor {format.toUpperCase()}
                </a>
              ))}
            </div>
          </div>
          {data.items.length === 0 ? (
            <EmptyState
              title={hasFilter ? "Belum ada laporan yang cocok dengan filter" : "Belum ada laporan masalah"}
              action={
                hasFilter ? (
                  <Link href="/admin/issues" className={buttonVariants({ variant: "outline", size: "sm" })}>
                    Hapus filter
                  </Link>
                ) : undefined
              }
            >
              {hasFilter ? "Coba ubah atau hapus filter di atas untuk menampilkan laporan lain." : "Laporan yang dikirim staf melalui tombol Lapor masalah di header akan muncul di sini."}
            </EmptyState>
          ) : (
            <ul className="grid gap-3">
              {data.items.map((r) => (
                <li key={r.id} data-testid="issue-row" className="grid min-w-0 gap-2 rounded-lg border p-4 text-sm [overflow-wrap:anywhere]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link className="font-semibold underline underline-offset-4" href={`/admin/issues/${r.id}`}>
                      #{r.id} · <span className="font-mono">{r.pageId}</span> · {r.pageTitle}
                    </Link>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge label={ISSUE_SEVERITY_LABEL[r.severity] ?? r.severity} tone={ISSUE_SEVERITY_TONE[r.severity] ?? "secondary"} />
                      <StatusBadge label={ISSUE_STATUS_LABEL[r.status] ?? r.status} tone={ISSUE_STATUS_TONE[r.status] ?? "secondary"} />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {ISSUE_CATEGORY_LABEL[r.category] ?? r.category} (<span className="font-mono">{r.category}</span> · <span className="font-mono">{r.severity}</span> · <span className="font-mono">{r.status}</span>) · <time dateTime={r.createdAt.toISOString()}>{tanggal(r.createdAt)}</time>
                  </p>
                  <p>{r.description}</p>
                  <p className="text-xs text-muted-foreground">Penanggung jawab: <span className="font-mono">{r.assigneeId ?? "Belum ditugaskan"}</span></p>
                </li>
              ))}
            </ul>
          )}
          {data.nextCursor !== null && (
            <Link className={buttonVariants({ variant: "outline" }) + " w-fit"} href={`/admin/issues?${params}&cursor=${data.nextCursor}`}>
              Muat lebih lama
            </Link>
          )}
        </>
      )}
    </section>
  );
}
