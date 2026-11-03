import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { staffList } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../access-denied";

export const metadata = { title: "Staf dan izin" };

export default async function StaffPage() {
  const g = await consoleGate("/admin/staff");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const rows = await allowed(staffList(g.op));
  if (rows === undefined) return <AccessDenied capability="staff.read" />;
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Staf dan izin"
        description="Staf Owner console memakai identitas terpisah dan tidak pernah menjadi sasaran tindakan akun. Undangan staf baru menunggu tabel identitas operator terpisah (T-59b); akun pertama dibuat lewat bootstrap RUNBOOK."
        action={
          <>
            <Link href="/admin/staff/access-reviews" className={buttonVariants({ variant: "outline" })}>Review akses</Link>
            <Link href="/admin/staff/break-glass" className={buttonVariants({ variant: "outline" })}>Akses darurat</Link>
          </>
        }
      />
      {rows.length === 0 ? <EmptyState title="Belum ada staf">Staf pertama dibuat lewat perintah bootstrap console (dua orang bernama, tercatat di RUNBOOK).</EmptyState> : (
        <ul className="divide-y rounded-lg border text-sm" aria-label="Daftar staf">
          {rows.map((s) => (
            <li key={s.userId} className="grid gap-1 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4" data-testid={`staf-${s.email}`}>
              <div className="min-w-0">
                <Link href={`/admin/staff/${s.userId}`} className="break-all font-medium underline underline-offset-4">{s.email}</Link>
                <p className="text-xs text-muted-foreground tabular-nums">{s.grants.length} izin · verifikasi dua langkah {s.mfaEnrolled ? "ya" : "tidak"} · sesi terbaru {s.lastSessionAt ? <time dateTime={s.lastSessionAt.toISOString()}>{tanggal(s.lastSessionAt)}</time> : "—"}</p>
              </div>
              <StatusBadge label={s.status === "active" ? "Aktif" : "Dinonaktifkan"} tone={s.status === "active" ? "success" : "destructive"} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
