import { CsrfField } from "@/lib/auth-csrf-form";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { savedText } from "@/lib/governance";
import { CASE_TRANSITIONS, getCase, hasPlatformCap, type CaseStatus } from "@bukalaris/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessDenied } from "../../access-denied";
import { addNoteAction, moveCaseAction } from "../actions";

const STATUS_LABEL: Record<string, string> = { open: "Terbuka", in_progress: "Dikerjakan", waiting: "Menunggu", resolved: "Selesai", closed: "Ditutup" };
const MOVE_LABEL: Record<string, string> = { in_progress: "Kerjakan", waiting: "Tandai menunggu", resolved: "Selesaikan", closed: "Tutup kasus", open: "Buka kembali" };
const STATUS_TONE: Record<string, "default" | "secondary" | "outline" | "destructive" | "success" | "warning"> = {
  open: "warning",
  in_progress: "default",
  waiting: "secondary",
  resolved: "success",
  closed: "outline",
};

export default async function CaseDetailPage({ params, searchParams }: PageProps<"/admin/cases/[id]">) {
  const g = await consoleGate("/admin/cases/[id]");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { id } = await params;
  const { error, saved } = await searchParams;
  const caseId = /^[0-9]{1,15}$/.test(id) ? Number(id) : NaN;
  const c = Number.isSafeInteger(caseId) ? await allowed(getCase(g.op, caseId)) : null;
  if (c === undefined) return <AccessDenied capability="cases.read" />;
  if (!c) notFound();
  const canWrite = await hasPlatformCap(g.op, "cases.write");
  const moves = CASE_TRANSITIONS[c.status as CaseStatus];
  return (
    <section className="grid gap-6">
      <PageHeader
        back={{ href: "/admin/cases", label: "Semua kasus" }}
        title={<span><span className="font-mono">{c.caseNumber}</span> · {c.title}</span>}
        badge={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge label={STATUS_LABEL[c.status] ?? c.status} tone={STATUS_TONE[c.status] ?? "outline"} />
            {c.overdue && <Badge variant="destructive">Lewat tenggat</Badge>}
          </span>
        }
        description={<>Dibuka <time dateTime={c.createdAt.toISOString()}>{tanggal(c.createdAt)}</time>{c.subjectKind ? <> · subjek {c.subjectKind} {c.subjectKind === "store" && c.subjectId ? <Link href={`/admin/stores/${c.subjectId}`} className="font-mono underline underline-offset-4">{c.subjectId}</Link> : c.subjectKind === "user" && c.subjectId ? <Link href={`/admin/accounts/seller/${c.subjectId}`} className="font-mono underline underline-offset-4">{c.subjectId}</Link> : <span className="font-mono">{c.subjectId}</span>}</> : null}{c.overdue ? " · lewat tenggat" : ""}</>}
      />
      <Notice error={error} saved={saved} savedText={savedText(saved)} />
      {canWrite && moves.length > 0 && (
        <form className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" aria-label="Ubah status kasus">
        <CsrfField />
          <div className="grid gap-1.5"><Label htmlFor="reason">Alasan perubahan</Label><Input id="reason" name="reason" required minLength={5} maxLength={500} /></div>
          <div className="grid gap-1.5"><Label htmlFor="resolutionCode">Kode penyelesaian (untuk Selesaikan)</Label><Input id="resolutionCode" name="resolutionCode" maxLength={64} placeholder="answered" /></div>
          <div className="flex flex-wrap gap-2">
            {moves.map((to) => <SubmitButton key={to} formAction={moveCaseAction.bind(null, c.id, c.status as CaseStatus, to)} variant={to === "closed" ? "outline" : "default"} pendingText="Menyimpan…">{MOVE_LABEL[to]}</SubmitButton>)}
          </div>
        </form>
      )}
      <section aria-labelledby="catatan" className="grid gap-2">
        <h2 id="catatan" className="text-lg font-semibold">Catatan</h2>
        {c.notes.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada catatan.</p> : (
          <ol className="divide-y rounded-lg border text-sm">
            {c.notes.map((n) => (
              <li key={n.id} className="grid gap-0.5 p-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
                <time dateTime={n.createdAt.toISOString()} className="text-muted-foreground">{tanggal(n.createdAt)}</time>
                <span className="min-w-0 break-words">{n.kind === "system" ? <em>{n.body}</em> : n.body}</span>
              </li>
            ))}
          </ol>
        )}
        {canWrite && c.status !== "closed" && (
          <form action={addNoteAction.bind(null, c.id)} className="grid gap-2">
        <CsrfField />
            <Label htmlFor="body">Tambah catatan</Label>
            <Textarea id="body" name="body" required maxLength={2000} rows={3} aria-describedby="body-help" />
            <p id="body-help" className="text-xs text-muted-foreground">Rujuk data sensitif dengan ID saja. Email, nomor telepon, tautan, token dan nomor panjang dihapus saat disimpan. Catatan tidak bisa diubah atau dihapus.</p>
            <div><SubmitButton pendingText="Menyimpan…">Simpan catatan</SubmitButton></div>
          </form>
        )}
      </section>
      <section aria-labelledby="tindakan" className="grid gap-2">
        <h2 id="tindakan" className="text-lg font-semibold">Tindakan dan perubahan status</h2>
        {c.actions.length + c.events.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada tindakan yang merujuk kasus ini.</p> : (
          <ul className="divide-y rounded-lg border text-sm">
            {c.actions.map((a) => <li key={`a${a.id}`} className="p-3">Tindakan <span className="font-mono">{a.actionKind}</span> · {a.status}{a.resultCode ? ` (${a.resultCode})` : ""} · <time dateTime={a.createdAt.toISOString()}>{tanggal(a.createdAt)}</time></li>)}
            {c.events.map((e) => <li key={`e${e.id}`} className="p-3">{e.subjectKind} <span className="font-mono">{e.subjectId}</span>: {e.fromStatus ?? "—"} → {e.toStatus} ({e.reasonCode}) · <time dateTime={e.createdAt.toISOString()}>{tanggal(e.createdAt)}</time></li>)}
          </ul>
        )}
      </section>
    </section>
  );
}
