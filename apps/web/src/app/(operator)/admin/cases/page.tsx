import { CsrfField } from "@/lib/auth-csrf-form";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { savedText } from "@/lib/governance";
import { CASE_KINDS, CASE_STATUSES, hasPlatformCap, listCases } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../access-denied";
import { openCaseAction } from "./actions";

export const metadata = { title: "Kasus" };
const STATUS_LABEL: Record<string, string> = { open: "Terbuka", in_progress: "Dikerjakan", waiting: "Menunggu", resolved: "Selesai", closed: "Ditutup" };
const KIND_LABEL: Record<string, string> = { support: "Dukungan", verification: "Verifikasi", risk: "Risiko", merge_request: "Permintaan merge", tax_correction: "Koreksi pajak" };
const STATUS_TONE: Record<string, "default" | "secondary" | "outline" | "destructive" | "success" | "warning"> = {
  open: "warning",
  in_progress: "default",
  waiting: "secondary",
  resolved: "success",
  closed: "outline",
};

export default async function CasesPage({ searchParams }: PageProps<"/admin/cases">) {
  const g = await consoleGate("/admin/cases");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { error, saved, status: rawStatus, cursor } = await searchParams;
  const status = typeof rawStatus === "string" && (CASE_STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : undefined;
  const list = await allowed(listCases(g.op, { status, cursor: typeof cursor === "string" ? cursor : undefined }));
  if (list === undefined) return <AccessDenied capability="cases.read" />;
  const canWrite = await hasPlatformCap(g.op, "cases.write");
  return (
    <section className="grid gap-6">
      <PageHeader title="Kasus" description="Setiap tindakan akun, pengungkapan data dan peninjauan verifikasi merujuk ke satu kasus yang masih terbuka. Catatan dibersihkan dari kontak, tautan dan nomor." />
      <Notice error={error} saved={saved} savedText={savedText(saved)} />
      <nav aria-label="Filter status kasus" className="flex flex-wrap gap-x-4 border-b">
        {[["", "Semua"], ...CASE_STATUSES.map((s) => [s, STATUS_LABEL[s]!])].map(([s, label]) => (
          <Link key={s} href={s ? `/admin/cases?status=${s}` : "/admin/cases"} aria-current={(status ?? "") === s ? "page" : undefined} className={`inline-flex min-h-10 items-center border-b-2 px-1 text-sm ${(status ?? "") === s ? "border-current font-medium" : "border-transparent opacity-70 hover:opacity-100"}`}>
            {label}
          </Link>
        ))}
      </nav>
      {canWrite && (
        <form action={openCaseAction} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2" aria-labelledby="buka-kasus">
        <CsrfField />
          <h2 id="buka-kasus" className="text-base font-semibold sm:col-span-2">Buka kasus</h2>
          <div className="grid gap-1.5">
            <Label htmlFor="kind">Jenis</Label>
            <NativeSelect id="kind" name="kind" defaultValue="support">{CASE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="priority">Prioritas</Label>
            <NativeSelect id="priority" name="priority" defaultValue="normal"><option value="low">Rendah</option><option value="normal">Normal</option><option value="high">Tinggi</option><option value="urgent">Mendesak</option></NativeSelect>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="title">Judul</Label>
            <Input id="title" name="title" required minLength={3} maxLength={200} aria-describedby="title-help" />
            <p id="title-help" className="text-xs text-muted-foreground">Jangan menulis email, telepon, tautan atau kata sandi: bagian itu dihapus saat disimpan.</p>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="reason">Alasan membuka kasus</Label>
            <Input id="reason" name="reason" required minLength={5} maxLength={500} />
          </div>
          <div><SubmitButton pendingText="Membuka…">Buka kasus</SubmitButton></div>
        </form>
      )}
      {list.items.length === 0 ? (
        <EmptyState title={status ? "Tidak ada kasus dengan status ini" : "Belum ada kasus"}>{status ? "Ubah filter untuk melihat kasus lain." : "Kasus dibuat dari layar ini, dari detail akun atau dari detail toko."}</EmptyState>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {list.items.map((c) => (
            <li key={c.id} className="grid gap-1 p-3 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
              <Link href={`/admin/cases/${c.id}`} className="font-mono underline underline-offset-4">{c.caseNumber}</Link>
              <span className="min-w-0 break-words">{c.title} <span className="text-muted-foreground">· {KIND_LABEL[c.kind] ?? c.kind} · <time dateTime={c.createdAt.toISOString()}>{tanggal(c.createdAt)}</time></span></span>
              <span className="flex flex-wrap gap-1.5">
                <StatusBadge label={STATUS_LABEL[c.status] ?? c.status} tone={STATUS_TONE[c.status] ?? "outline"} />
                {c.overdue && <Badge variant="destructive">Lewat tenggat</Badge>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {list.nextCursor && <Link href={`/admin/cases?${status ? `status=${status}&` : ""}cursor=${list.nextCursor}`} className={buttonVariants({ variant: "outline" }) + " w-fit"}>Kasus lebih lama</Link>}
    </section>
  );
}
