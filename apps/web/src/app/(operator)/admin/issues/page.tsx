import { PageHeader } from "@/components/page-header";
import { consoleGate } from "@/lib/console-gate";
import { consoleIssues, ISSUE_STATUSES, ISSUE_CATEGORIES, ISSUE_SEVERITIES, type IssuePage } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../access-denied";

export const metadata = { title: "Laporan masalah" };
export default async function IssuesPage({ searchParams }: PageProps<"/admin/issues">) {
  const g = await consoleGate("/admin/issues");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const sp = await searchParams;
  const values = Object.fromEntries(Object.entries(sp).filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1] !== ""));
  let data: IssuePage | undefined;
  let error: string | undefined;
  try { data = await consoleIssues(g.op, values); } catch { error = "Filter tidak valid atau sumber laporan tidak tersedia. Periksa filter lalu coba lagi; ini bukan berarti antrean kosong."; }
  const params = new URLSearchParams(values); params.delete("cursor");
  const select = (name: string, label: string, options: readonly string[]) => <label className="grid gap-1 text-sm" key={name}>{label}<select name={name} defaultValue={values[name] ?? ""} className="min-w-0 rounded-md border bg-background p-2"><option value="">Semua</option>{options.map((v) => <option key={v}>{v}</option>)}</select></label>;
  return <section className="grid min-w-0 gap-6">
    <PageHeader title="Laporan masalah" description="Antrean staf. Teks sudah dibersihkan; tanpa tangkapan layar. Setiap pembacaan dan ekspor tercatat di audit." />
    <form className="grid min-w-0 gap-3 sm:grid-cols-3" action="/admin/issues">
      {select("status", "Status", ISSUE_STATUSES)}{select("category", "Jenis", ISSUE_CATEGORIES)}{select("severity", "Tingkat", ISSUE_SEVERITIES)}
      {[["pageId", "ARCH-5 halaman"], ["assigneeId", "ID penanggung jawab (unassigned = belum ditugaskan)"], ["q", "Cari deskripsi"]].map(([name, label]) => <label className="grid min-w-0 gap-1 text-sm" key={name}>{label}<input className="min-w-0 rounded-md border p-2" name={name} defaultValue={values[name]} maxLength={name === "q" ? 120 : 128} /></label>)}
      {[["from", "Sejak"], ["to", "Sampai"]].map(([name, label]) => <label className="grid gap-1 text-sm" key={name}>{label}<input className="min-w-0 rounded-md border p-2" type="date" name={name} defaultValue={values[name]} /></label>)}
      {select("hasLog", "Punya tautan log", ["yes", "no"])}{select("sort", "Urutkan", ["newest", "severity"])}
      <button className="rounded-md border px-3 py-2" type="submit">Terapkan filter</button><Link href="/admin/issues" className="p-2 underline">Hapus filter</Link>
    </form>
    {error && <p role="alert">{error}</p>}
    {data && <>
      <p aria-label="Jumlah per status" className="text-sm">{ISSUE_STATUSES.map((s) => `${s}: ${data.counts.find((r) => r.status === s)?.count ?? 0}`).join(" · ")}</p>
      <div className="flex flex-wrap gap-4">{["json", "csv"].map((format) => <a className="underline" key={format} href={`/admin/issues/export?${params}&format=${format}`}>Ekspor {format.toUpperCase()}</a>)}</div>
      {data.items.length === 0 ? <p>Belum ada laporan yang cocok.</p> : <ul className="grid gap-3">{data.items.map((r) => <li key={r.id} data-testid="issue-row" className="grid min-w-0 gap-1 border-t pt-3 text-sm [overflow-wrap:anywhere]">
        <Link className="font-semibold underline" href={`/admin/issues/${r.id}`}>#{r.id} · {r.pageId} · {r.pageTitle}</Link><p>{r.category} · {r.severity} · {r.status}</p><p>{r.description}</p><p>Penanggung jawab: {r.assigneeId ?? "Belum ditugaskan"}</p>
      </li>)}</ul>}
      {data.nextCursor !== null && <Link className="underline" href={`/admin/issues?${params}&cursor=${data.nextCursor}`}>Muat lebih lama</Link>}
    </>}
  </section>;
}
