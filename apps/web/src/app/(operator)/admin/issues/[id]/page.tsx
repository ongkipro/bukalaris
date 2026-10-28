import { PageHeader } from "@/components/page-header";
import { consoleGate } from "@/lib/console-gate";
import { tanggal } from "@/lib/format";
import { consoleIssues, ISSUE_TRANSITIONS, type IssueStatus } from "@bukalaris/db";
import Link from "next/link";
import { Notice } from "@/components/notice";
import { assignIssueAction, transitionIssueAction } from "../actions";
import { notFound } from "next/navigation";
import { AccessDenied } from "../../access-denied";

export const metadata = { title: "Detail laporan" };

/** Text and context render only as text nodes (no HTML, no markdown): `{value}` in JSX is escaped by React. */
export default async function IssueDetailPage({ params, searchParams }: PageProps<"/admin/issues/[id]">) {
  const g = await consoleGate("/admin/issues/[id]");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { id } = await params;
  const n = /^[0-9]{1,15}$/.test(id) ? Number(id) : NaN;
  const data = Number.isSafeInteger(n) && n > 0 ? await consoleIssues(g.op, { id: n }) : undefined;
  const r = data?.items[0];
  if (!r) notFound();
  const c = r.context;
  const { error, saved } = await searchParams;
  return (
    <section className="grid gap-6">
      <PageHeader back={{ href: "/admin/issues", label: "Semua laporan" }} title={`Laporan #${r.id}`} description={<>Halaman <span className="font-mono">{r.pageId === "unmapped" ? "tidak terpetakan" : r.pageId}</span> · rute <span className="font-mono">{r.route}</span> · <time dateTime={r.createdAt.toISOString()}>{tanggal(r.createdAt)}</time></>} />
      <Notice error={error} saved={saved} savedText="Perubahan tersimpan dan tercatat di audit." />
      <p>{r.pageTitle} · {r.pageTask}</p>
      <dl className="grid gap-x-6 gap-y-2 rounded-lg border p-4 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">Jenis / tingkat</dt>
        <dd>{r.category} · {r.severity}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>{r.status}</dd>
        <dt className="text-muted-foreground">Kontrol</dt>
        <dd className="font-mono break-all">{r.controlId ?? (c.controlName ? `${c.controlRole ?? ""} ${c.controlName}` : "—")}</dd>
        <dt className="text-muted-foreground">Deskripsi{r.scrubbed ? " (sudah dibersihkan)" : ""}</dt>
        <dd className="break-words whitespace-pre-wrap" data-testid="description">{r.description}</dd>
        <dt className="text-muted-foreground">Rilis</dt>
        <dd className="font-mono break-all">{c.release ?? "—"}</dd>
        <dt className="text-muted-foreground">Viewport</dt>
        <dd className="tabular-nums">{c.viewport ? `${c.viewport.width} × ${c.viewport.height}` : "—"}</dd>
        <dt className="text-muted-foreground">Event log terkait</dt>
        <dd className="flex flex-wrap gap-2">{r.linkedLogEventIds.length ? r.linkedLogEventIds.map((id) => g.caps.includes("logs.read") ? <Link className="underline" href={`/admin/logs/${id}`} key={id}>Event #{id}</Link> : <span key={id}>Event #{id}</span>) : "—"}</dd>
        <dt className="text-muted-foreground">Catatan penyelesaian</dt><dd className="break-words">{r.resolutionNote ?? "—"}</dd>
        <dt className="text-muted-foreground">Duplikat dari</dt><dd>{r.duplicateOf ? <Link className="underline" href={`/admin/issues/${r.duplicateOf}`}>#{r.duplicateOf}</Link> : "—"}</dd>
        <dt className="text-muted-foreground">User agent / konteks parsial</dt><dd className="break-all">{c.userAgent ?? "—"} · {c.partial ? "Ya" : "Tidak"}</dd>
      </dl>
      <section aria-labelledby="req" className="grid gap-2">
        <h2 id="req" className="text-lg font-semibold">Permintaan terakhir</h2>
        {c.recentRequests.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Tidak dikirim.</p>
        ) : (
          <ul className="text-sm">
            {c.recentRequests.map((q, i) => (
              <li key={i} className="font-mono text-xs [overflow-wrap:anywhere]" data-testid="request-entry">{q.method} {q.route} → {q.status} · {g.caps.includes("logs.read") ? <Link className="underline" href={`/admin/logs?requestId=${encodeURIComponent(q.requestId)}`}>{q.requestId}</Link> : q.requestId}</li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="err" className="grid gap-2">
        <h2 id="err" className="text-lg font-semibold">Error klien dan aksi gagal</h2>
        {c.recentClientErrors.length + c.failedActions.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Tidak dikirim.</p>
        ) : (
          <ul className="text-sm">
            {c.recentClientErrors.map((e, i) => <li key={`e${i}`} className="text-xs [overflow-wrap:anywhere]">{e.name}: {e.message}</li>)}
            {c.failedActions.map((a, i) => <li key={`a${i}`} className="font-mono text-xs">{a.name} → {a.code}</li>)}
          </ul>
        )}
      </section>
      <section className="grid min-w-0 gap-3" aria-labelledby="triage">
        <h2 id="triage" className="text-lg font-semibold">Triage dan penugasan</h2>
        <form action={assignIssueAction.bind(null, r.id, r.assigneeId)} className="grid min-w-0 gap-2">
          <label className="grid gap-1 text-sm">ID penanggung jawab<input name="assigneeId" defaultValue={r.assigneeId ?? ""} maxLength={128} className="min-w-0 rounded-md border p-2" /></label>
          <p className="text-xs text-muted-foreground">Harus memegang ops.issues.manage. Kosongkan untuk melepas penugasan. ID saya: <span className="break-all">{g.userId}</span></p>
          <button className="rounded-md border p-2" type="submit">Simpan penugasan</button>
        </form>
        <form action={transitionIssueAction.bind(null, r.id, r.status as IssueStatus)} className="grid min-w-0 gap-2">
          <label className="grid gap-1 text-sm">Status berikut<select name="to" className="rounded-md border bg-background p-2">{ISSUE_TRANSITIONS[r.status as IssueStatus].map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="grid gap-1 text-sm">Catatan penyelesaian<textarea name="note" maxLength={2000} className="min-w-0 rounded-md border p-2" /></label>
          <p className="text-xs text-muted-foreground">Wajib untuk resolved, wont_fix dan duplicate. Jangan tulis data pribadi atau kredensial.</p>
          <label className="grid gap-1 text-sm">Nomor target duplikat<input type="number" min={1} name="duplicateOf" className="min-w-0 rounded-md border p-2" /></label>
          <button className="rounded-md border p-2" type="submit">Simpan status</button>
        </form>
      </section>
      <section className="grid gap-2"><h2 className="text-lg font-semibold">Kemungkinan duplikat</h2>{data!.duplicates.length ? <ul>{data!.duplicates.map((d) => <li key={d.id}><Link className="underline" href={`/admin/issues/${d.id}`}>#{d.id} · {d.status}</Link></li>)}</ul> : <p>Tidak ada dengan kunci yang sama.</p>}</section>
      <section className="grid gap-2"><h2 className="text-lg font-semibold">Riwayat peristiwa</h2><ul className="grid gap-2 text-sm">{data!.events.map((e) => <li key={e.id} className="[overflow-wrap:anywhere]">{tanggal(e.createdAt)} · {e.kind} · {e.fromValue ?? "—"} → {e.toValue ?? "—"} · {e.reason ?? ""}</li>)}</ul></section>
    </section>
  );
}
