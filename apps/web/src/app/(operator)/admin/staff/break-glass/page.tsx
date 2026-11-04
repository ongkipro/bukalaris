import { CsrfField } from "@/lib/auth-csrf-form";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { StatusBadge } from "@/components/status-badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { savedText } from "@/lib/governance";
import { BREAK_GLASS_ALLOWLIST, listBreakGlass } from "@bukalaris/db";
import { AccessDenied } from "../../access-denied";
import { activateBreakGlassAction, requestBreakGlassAction, revokeBreakGlassAction } from "./actions";

export const metadata = { title: "Akses darurat" };

export default async function BreakGlassPage({ searchParams }: PageProps<"/admin/staff/break-glass">) {
  const g = await consoleGate("/admin/staff/break-glass");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { error, saved } = await searchParams;
  const grants = await allowed(listBreakGlass(g.op));
  if (grants === undefined) return <AccessDenied capability="break_glass.approve" />;
  return (
    <section className="grid gap-6">
      <PageHeader back={{ href: "/admin/staff", label: "Staf dan izin" }} title="Akses darurat" description="Peningkatan akses baca dan ungkap yang dibatasi waktu untuk satu akun dan satu kasus, disetujui staf kedua (halaman Persetujuan). Berakhir sendiri, tidak pernah memberi izin tulis, dan semua pemegang audit.read diberi tahu saat diberikan." />
      <Notice error={error} saved={saved} savedText={savedText(saved)} />
      <form action={requestBreakGlassAction} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2" aria-labelledby="minta">
        <CsrfField />
        <h2 id="minta" className="text-base font-semibold sm:col-span-2">Minta akses darurat</h2>
        <div className="grid gap-1.5"><Label htmlFor="userId">ID akun seller</Label><Input id="userId" name="userId" required pattern="[A-Za-z0-9_-]{8,64}" /></div>
        <div className="grid gap-1.5"><Label htmlFor="caseRef">Nomor kasus terbuka</Label><Input id="caseRef" name="caseRef" required placeholder="C-000123" pattern="C-\d{6,}" /></div>
        <fieldset className="grid gap-1.5 sm:col-span-2"><legend className="text-sm font-medium">Izin yang dipinjam</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">{BREAK_GLASS_ALLOWLIST.map((c) => <label key={c} className="inline-flex items-center gap-1.5"><input type="checkbox" name="capabilities" value={c} defaultChecked={c === "accounts.reveal"} /> <code>{c}</code></label>)}</div>
        </fieldset>
        <div className="grid gap-1.5"><Label htmlFor="minutes">Lama (menit)</Label><Input id="minutes" name="minutes" type="number" min={1} defaultValue={30} required /></div>
        <div className="grid gap-1.5"><Label htmlFor="reason">Alasan</Label><Input id="reason" name="reason" required minLength={5} maxLength={500} /></div>
        <div><SubmitButton pendingText="Meminta…">Minta persetujuan</SubmitButton></div>
      </form>
      <form action={activateBreakGlassAction} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" aria-labelledby="aktif">
        <CsrfField />
        <h2 id="aktif" className="text-base font-semibold sm:col-span-2">Jalankan permintaan yang disetujui</h2>
        <div className="grid gap-1.5"><Label htmlFor="approvalId">ID persetujuan</Label><Input id="approvalId" name="approvalId" type="number" min={1} required /></div>
        <SubmitButton pendingText="Memberikan…">Mulai akses darurat</SubmitButton>
      </form>
      <section aria-labelledby="daftar" className="grid gap-2">
        <h2 id="daftar" className="text-lg font-semibold">Akses darurat</h2>
        {grants.length === 0 ? <EmptyState title="Belum ada akses darurat">Permintaan yang disetujui dan dijalankan muncul di sini.</EmptyState> : (
          <ul className="divide-y rounded-lg border text-sm">
            {grants.map((e) => (
              <li key={e.id} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" data-testid={`bg-${e.id}`}>
                <span className="flex flex-wrap items-center gap-2">
                  <span>#{e.id} · kasus <span className="font-mono">{e.caseId}</span> · <span className="break-all font-mono">{e.targetId}</span> · {e.capabilities.join(", ")} · <time dateTime={e.expiresAt.toISOString()}>{tanggal(e.startsAt)} — {tanggal(e.expiresAt)}</time> ({Math.max(1, Math.round((e.expiresAt.getTime() - e.startsAt.getTime()) / 60_000))} mnt){e.reviewedAt ? " · ditinjau" : ""}</span>
                  <StatusBadge label={e.state === "active" ? "Aktif" : e.state === "revoked" ? "Dicabut" : "Berakhir"} tone={e.state === "active" ? "warning" : e.state === "revoked" ? "destructive" : "secondary"} />
                </span>
                {e.state === "active" && <form action={revokeBreakGlassAction.bind(null, e.id)}>
        <CsrfField /><SubmitButton variant="outline" pendingText="Mencabut…">Cabut</SubmitButton></form>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
