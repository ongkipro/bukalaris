import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { consoleGate } from "@/lib/console-gate";
import { tanggal } from "@/lib/format";
import { consoleIssues, ISSUE_TRANSITIONS, type IssueStatus } from "@bukalaris/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessDenied } from "../../access-denied";
import { assignIssueAction, transitionIssueAction } from "../actions";
import { ISSUE_CATEGORY_LABEL, ISSUE_SEVERITY_LABEL, ISSUE_SEVERITY_TONE, ISSUE_STATUS_LABEL, ISSUE_STATUS_TONE } from "@/lib/governance";

export const metadata = { title: "Detail laporan" };

const EVENT_KIND_LABEL: Record<string, string> = {
  created: "Laporan dibuat",
  status_changed: "Status diubah",
  assigned: "Penugasan diubah",
  unassigned: "Penugasan dilepas",
};

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
      <PageHeader
        back={{ href: "/admin/issues", label: "Semua laporan" }}
        title={`Laporan #${r.id}`}
        badge={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge label={ISSUE_SEVERITY_LABEL[r.severity] ?? r.severity} tone={ISSUE_SEVERITY_TONE[r.severity] ?? "secondary"} />
            <StatusBadge label={ISSUE_STATUS_LABEL[r.status] ?? r.status} tone={ISSUE_STATUS_TONE[r.status] ?? "secondary"} />
          </span>
        }
        description={<>Halaman <span className="font-mono">{r.pageId === "unmapped" ? "tidak terpetakan" : r.pageId}</span> · rute <span className="font-mono">{r.route}</span> · <time dateTime={r.createdAt.toISOString()}>{tanggal(r.createdAt)}</time></>}
      />
      <Notice error={error} saved={saved} savedText="Perubahan tersimpan dan tercatat di audit." />
      <p className="text-sm font-medium">{r.pageTitle} · {r.pageTask}</p>
      <dl className="grid gap-x-6 gap-y-2 rounded-lg border p-4 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">Jenis / tingkat</dt>
        <dd>
          {ISSUE_CATEGORY_LABEL[r.category] ?? r.category} (<span className="font-mono text-xs">{r.category}</span>) · {ISSUE_SEVERITY_LABEL[r.severity] ?? r.severity} (<span className="font-mono text-xs">{r.severity}</span>)
        </dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <StatusBadge label={ISSUE_STATUS_LABEL[r.status] ?? r.status} tone={ISSUE_STATUS_TONE[r.status] ?? "secondary"} />
          <span className="font-mono text-xs text-muted-foreground">{r.status}</span>
        </dd>
        <dt className="text-muted-foreground">Kontrol</dt>
        <dd className="font-mono break-all">{r.controlId ?? (c.controlName ? `${c.controlRole ?? ""} ${c.controlName}` : "—")}</dd>
        <dt className="text-muted-foreground">Deskripsi{r.scrubbed ? " (sudah dibersihkan)" : ""}</dt>
        <dd className="break-words whitespace-pre-wrap" data-testid="description">{r.description}</dd>
        <dt className="text-muted-foreground">Rilis</dt>
        <dd className="font-mono break-all">{c.release ?? "—"}</dd>
        <dt className="text-muted-foreground">Viewport</dt>
        <dd className="tabular-nums">{c.viewport ? `${c.viewport.width} × ${c.viewport.height}` : "—"}</dd>
        <dt className="text-muted-foreground">Event log terkait</dt>
        <dd className="flex flex-wrap gap-2">{r.linkedLogEventIds.length ? r.linkedLogEventIds.map((id) => g.caps.includes("logs.read") ? <Link className="underline underline-offset-4" href={`/admin/logs/${id}`} key={id}>Event #{id}</Link> : <span key={id}>Event #{id}</span>) : "—"}</dd>
        <dt className="text-muted-foreground">Catatan penyelesaian</dt>
        <dd className="break-words">{r.resolutionNote ?? "—"}</dd>
        <dt className="text-muted-foreground">Duplikat dari</dt>
        <dd>{r.duplicateOf ? <Link className="underline underline-offset-4" href={`/admin/issues/${r.duplicateOf}`}>#{r.duplicateOf}</Link> : "—"}</dd>
        <dt className="text-muted-foreground">User agent / konteks parsial</dt>
        <dd className="break-all">{c.userAgent || "—"} · Parsial: {c.partial ? "Ya" : "Tidak"}</dd>
      </dl>
      <section aria-labelledby="req" className="grid gap-2">
        <h2 id="req" className="text-lg font-semibold">Permintaan terakhir</h2>
        {c.recentRequests.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Tidak dikirim.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {c.recentRequests.map((q, i) => (
              <li key={i} className="p-3 font-mono text-xs [overflow-wrap:anywhere]" data-testid="request-entry">{q.method} {q.route} → {q.status} · {g.caps.includes("logs.read") ? <Link className="underline underline-offset-4" href={`/admin/logs?requestId=${encodeURIComponent(q.requestId)}`}>{q.requestId}</Link> : q.requestId}</li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="err" className="grid gap-2">
        <h2 id="err" className="text-lg font-semibold">Error klien dan aksi gagal</h2>
        {c.recentClientErrors.length + c.failedActions.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Tidak dikirim.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {c.recentClientErrors.map((e, i) => <li key={`e${i}`} className="p-3 text-xs [overflow-wrap:anywhere]">{e.name}: {e.message}</li>)}
            {c.failedActions.map((a, i) => <li key={`a${i}`} className="p-3 font-mono text-xs">{a.name} → {a.code}</li>)}
          </ul>
        )}
      </section>
      <section className="grid min-w-0 gap-4 lg:grid-cols-2" aria-labelledby="triage">
        <h2 id="triage" className="text-lg font-semibold lg:col-span-2">Triage dan penugasan</h2>
        <form action={assignIssueAction.bind(null, r.id, r.assigneeId)} className="grid min-w-0 content-start gap-3 rounded-lg border p-4">
          <div className="grid gap-1.5">
            <Label htmlFor="issue-assignee">ID penanggung jawab</Label>
            <Input id="issue-assignee" name="assigneeId" defaultValue={r.assigneeId ?? ""} maxLength={128} aria-describedby="assignee-help" />
          </div>
          <p id="assignee-help" className="text-xs text-muted-foreground">Harus memegang ops.issues.manage. Kosongkan untuk melepas penugasan. ID saya: <span className="font-mono break-all">{g.userId}</span></p>
          <div><SubmitButton variant="outline" pendingText="Menyimpan…">Simpan penugasan</SubmitButton></div>
        </form>
        <form action={transitionIssueAction.bind(null, r.id, r.status as IssueStatus)} className="grid min-w-0 content-start gap-3 rounded-lg border p-4">
          <div className="grid gap-1.5">
            <Label htmlFor="issue-status-next">Status berikut</Label>
            <NativeSelect id="issue-status-next" name="to">
              {ISSUE_TRANSITIONS[r.status as IssueStatus].map((s) => (
                <option key={s} value={s}>{ISSUE_STATUS_LABEL[s] ? `${ISSUE_STATUS_LABEL[s]} (${s})` : s}</option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="issue-note">Catatan penyelesaian</Label>
            <Textarea id="issue-note" name="note" maxLength={2000} rows={3} aria-describedby="note-help" />
          </div>
          <p id="note-help" className="text-xs text-muted-foreground">Wajib untuk resolved, wont_fix dan duplicate. Jangan tulis data pribadi atau kredensial.</p>
          <div className="grid gap-1.5">
            <Label htmlFor="issue-dup">Nomor target duplikat</Label>
            <Input id="issue-dup" type="number" min={1} name="duplicateOf" />
          </div>
          <div><SubmitButton pendingText="Menyimpan…">Simpan status</SubmitButton></div>
        </form>
      </section>
      <section className="grid gap-2" aria-labelledby="duplikat">
        <h2 id="duplikat" className="text-lg font-semibold">Kemungkinan duplikat</h2>
        {data!.duplicates.length ? (
          <ul className="divide-y rounded-lg border text-sm">
            {data!.duplicates.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <Link className="font-medium underline underline-offset-4" href={`/admin/issues/${d.id}`}>#{d.id}</Link>
                <StatusBadge label={ISSUE_STATUS_LABEL[d.status] ?? d.status} tone={ISSUE_STATUS_TONE[d.status] ?? "secondary"} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Tidak ada dengan kunci yang sama.</p>
        )}
      </section>
      <section className="grid gap-2" aria-labelledby="peristiwa">
        <h2 id="peristiwa" className="text-lg font-semibold">Riwayat peristiwa</h2>
        <ol className="divide-y rounded-lg border text-sm">
          {data!.events.map((e) => (
            <li key={e.id} className="grid gap-0.5 p-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4 [overflow-wrap:anywhere]">
              <time dateTime={e.createdAt.toISOString()} className="text-muted-foreground">{tanggal(e.createdAt)}</time>
              <span>
                {EVENT_KIND_LABEL[e.kind] ? `${EVENT_KIND_LABEL[e.kind]} · ` : ""}<span className="font-mono text-xs">{e.kind}</span> · {e.fromValue ?? "—"} → {e.toValue ?? "—"}{e.reason ? ` · ${e.reason}` : ""}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}
