import { CsrfField } from "@/lib/auth-csrf-form";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { savedText } from "@/lib/governance";
import { accessReviewList, breakGlassReviewQueue, hasPlatformCap } from "@bukalaris/db";
import { AccessDenied } from "../../access-denied";
import { reviewBreakGlassAction, reviewGrantAction } from "./actions";

export const metadata = { title: "Review akses" };

export default async function AccessReviewsPage({ searchParams }: PageProps<"/admin/staff/access-reviews">) {
  const g = await consoleGate("/admin/staff/access-reviews");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { error, saved } = await searchParams;
  const rows = await allowed(accessReviewList(g.op));
  if (rows === undefined) return <AccessDenied capability="access.review" />;
  const ended = await allowed(breakGlassReviewQueue(g.op));
  const canRevoke = await hasPlatformCap(g.op, "staff.manage");
  return (
    <section className="grid gap-6">
      <PageHeader back={{ href: "/admin/staff", label: "Staf dan izin" }} title="Review akses" description="Setiap izin staf aktif dengan waktu terakhir dipakai (dicatat saat izin itu lolos pemeriksaan di console). Tandai tetap berlaku atau cabut. Izin Anda sendiri tidak bisa Anda tinjau." />
      <Notice error={error} saved={saved} savedText={savedText(saved)} />
      {rows.length === 0 ? <EmptyState title="Tidak ada izin untuk ditinjau">Belum ada staf aktif dengan izin.</EmptyState> : (
        <ul className="grid gap-3" aria-label="Izin untuk ditinjau">
          {rows.map((r) => (
            <li key={`${r.operatorUserId}-${r.capability}`} className="grid gap-2 rounded-lg border p-3 text-sm" data-testid={`izin-${r.capability}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p><span className="break-all font-medium">{r.email}</span> · <code>{r.capability}</code> <span className="text-muted-foreground">· diberikan {tanggal(r.grantedAt)} ({r.source === "product" ? "lewat produk" : r.source ?? "?"}) · terakhir dipakai {r.lastUsedAt ? tanggal(r.lastUsedAt) : "belum pernah"}{r.lastDecision ? ` · ditinjau ${tanggal(r.lastDecision.at)} (${r.lastDecision.decision === "confirmed" ? "tetap" : "dicabut"})` : ""}</span></p>
                <StatusBadge label={r.lastDecision ? (r.lastDecision.decision === "confirmed" ? "Tetap berlaku" : "Dicabut") : "Belum ditinjau"} tone={r.lastDecision ? (r.lastDecision.decision === "confirmed" ? "success" : "destructive") : "warning"} />
              </div>
              {r.own ? <p className="text-xs text-muted-foreground">Izin Anda sendiri: ditinjau oleh orang lain.</p> : (
                <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <CsrfField />
                  <div className="grid gap-1.5"><Label htmlFor={`alasan-${r.operatorUserId}-${r.capability}`}>Alasan</Label><Input id={`alasan-${r.operatorUserId}-${r.capability}`} name="reason" required minLength={5} maxLength={500} /></div>
                  <div className="flex flex-wrap gap-2">
                    <SubmitButton formAction={reviewGrantAction.bind(null, r.operatorUserId, r.capability, "confirmed")} variant="outline" pendingText="Menyimpan…">Tetap berlaku</SubmitButton>
                    {canRevoke && <SubmitButton formAction={reviewGrantAction.bind(null, r.operatorUserId, r.capability, "revoked")} variant="destructive" pendingText="Mencabut…">Cabut</SubmitButton>}
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <section aria-labelledby="darurat" className="grid gap-2">
        <h2 id="darurat" className="text-lg font-semibold">Akses darurat yang sudah berakhir</h2>
        {!ended || ended.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Tidak ada yang menunggu tinjauan.</p> : (
          <ul className="divide-y rounded-lg border text-sm">
            {ended.map((e) => (
              <li key={e.id} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <span>#{e.id} · kasus <span className="font-mono">{e.caseId}</span> · {e.capabilities.join(", ")} · berakhir <time dateTime={e.expiresAt.toISOString()}>{tanggal(e.expiresAt)}</time>{e.state === "revoked" ? " (dicabut)" : ""}</span>
                {e.requestedBy !== g.userId ? <form action={reviewBreakGlassAction.bind(null, e.id)}>
        <CsrfField /><SubmitButton variant="outline" pendingText="Menyimpan…">Tandai ditinjau</SubmitButton></form> : <span className="text-xs text-muted-foreground">Peminta tidak meninjau sendiri.</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
