import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { REASON_CODES, savedText } from "@/lib/governance";
import { CAPABILITY_CATALOGUE, hasPlatformCap, SENSITIVE_CAPABILITIES, staffDetail } from "@bukalaris/db";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { AccessDenied } from "../../access-denied";
import { deactivateAction, executeMfaResetAction, grantAction, reactivateAction, requestMfaResetAction, requestSensitiveGrantAction, revokeAction, revokeSessionsAction } from "../actions";

export const metadata = { title: "Detail staf" };

export default async function StaffDetailPage({ params, searchParams }: PageProps<"/admin/staff/[id]">) {
  const g = await consoleGate("/admin/staff/[id]");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { id } = await params;
  const { error, saved } = await searchParams;
  const d = /^[A-Za-z0-9_-]{8,64}$/.test(id) ? await allowed(staffDetail(g.op, id)) : null;
  if (d === undefined) return <AccessDenied capability="staff.read" />;
  if (!d) notFound();
  const manage = await hasPlatformCap(g.op, "staff.manage");
  const own = d.userId === g.userId;
  const grantable = CAPABILITY_CATALOGUE.filter((c) => c.phase !== "P2");
  return (
    <section className="grid gap-6">
      <PageHeader back={{ href: "/admin/staff", label: "Semua staf" }} title={<span className="break-all">{d.email}</span>} badge={<Badge variant={d.status === "active" ? "outline" : "destructive"}>{d.status === "active" ? "Aktif" : "Dinonaktifkan"}</Badge>}
        description={<>Verifikasi dua langkah {d.mfaEnrolled ? "ya" : "tidak"} · sesi terbaru {d.lastSessionAt ? tanggal(d.lastSessionAt) : "—"}{own ? " · ini akun Anda: izin dan status Anda tidak bisa Anda ubah sendiri" : ""}</>} />
      <Notice error={error} saved={saved} savedText={savedText(saved)} />
      <section aria-labelledby="izin" className="grid gap-2">
        <h2 id="izin" className="text-lg font-semibold">Izin</h2>
        {d.grants.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Tidak ada izin: akun ini tidak bisa membuka halaman apa pun.</p> : (
          <ul className="divide-y rounded-lg border text-sm">
            {d.grants.map((gr) => (
              <li key={gr.capability} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <span><code>{gr.capability}</code>{SENSITIVE_CAPABILITIES.includes(gr.capability as never) ? " ◆" : ""} <span className="text-muted-foreground">· terakhir dipakai {gr.lastUsedAt ? tanggal(gr.lastUsedAt) : "belum pernah"}{gr.expiresAt ? ` · berakhir ${tanggal(gr.expiresAt)}` : ""}</span></span>
                {manage && !own && (
                  <form action={revokeAction.bind(null, d.userId, gr.capability)} className="flex flex-wrap items-end gap-2">
                    <div className="grid gap-1"><Label htmlFor={`cabut-${gr.capability}`} className="sr-only">Alasan mencabut {gr.capability}</Label><Input id={`cabut-${gr.capability}`} name="reason" placeholder="Alasan mencabut" required minLength={5} maxLength={500} /></div>
                    <ConfirmSubmit variant="outline" message={`Cabut ${gr.capability}? Semua sesi staf ini berakhir.`}>Cabut</ConfirmSubmit>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {manage && !own && d.status === "active" && (
        <form action={grantAction.bind(null, d.userId)} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2" aria-labelledby="beri">
          <h2 id="beri" className="text-base font-semibold sm:col-span-2">Beri izin</h2>
          <div className="grid gap-1.5"><Label htmlFor="capability">Izin</Label><NativeSelect id="capability" name="capability">{grantable.map((c) => <option key={c.name} value={c.name}>{c.name}{SENSITIVE_CAPABILITIES.includes(c.name as never) ? " ◆ (sensitif)" : ""}</option>)}</NativeSelect></div>
          <div className="grid gap-1.5"><Label htmlFor="hours">Berlaku jam (kosong = tetap)</Label><Input id="hours" name="hours" type="number" min={1} /></div>
          <div className="grid gap-1.5"><Label htmlFor="grant-reason">Alasan</Label><Input id="grant-reason" name="reason" required minLength={5} maxLength={500} /></div>
          <div className="grid gap-1.5"><Label htmlFor="approvalRequestId">ID persetujuan (izin sensitif ◆)</Label><Input id="approvalRequestId" name="approvalRequestId" type="number" min={1} /></div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <SubmitButton pendingText="Memberi…">Beri izin</SubmitButton>
            <SubmitButton formAction={requestSensitiveGrantAction.bind(null, d.userId)} variant="outline" pendingText="Meminta…">Minta persetujuan (izin sensitif)</SubmitButton>
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">Izin sensitif ◆ butuh persetujuan staf pengelola kedua atas isi yang persis sama (halaman Persetujuan); setelah disetujui, beri izin dengan ID persetujuannya.</p>
        </form>
      )}
      {manage && !own && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section aria-labelledby="status" className="grid gap-3 rounded-lg border p-4">
            <h2 id="status" className="text-base font-semibold">{d.status === "active" ? "Nonaktifkan staf" : "Aktifkan kembali"}</h2>
            <form action={(d.status === "active" ? deactivateAction : reactivateAction).bind(null, d.userId)} className="grid gap-3">
              <div className="grid gap-1.5"><Label htmlFor="st-code">Kode alasan</Label><NativeSelect id="st-code" name="reasonCode">{REASON_CODES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</NativeSelect></div>
              <div className="grid gap-1.5"><Label htmlFor="st-reason">Alasan</Label><Input id="st-reason" name="reason" required minLength={5} maxLength={500} /></div>
              <p className="text-xs text-muted-foreground">{d.status === "active" ? "Semua izin, permintaan persetujuan yang masih terbuka dan semua sesi berakhir bersamaan. Pemegang terakhir staff.manage atau break_glass.approve tidak bisa dinonaktifkan." : "Izin tidak dikembalikan otomatis; berikan lagi satu per satu."}</p>
              <div>{d.status === "active" ? <ConfirmSubmit variant="destructive" message="Nonaktifkan staf ini? Izin, permintaan dan sesinya berakhir.">Nonaktifkan</ConfirmSubmit> : <SubmitButton pendingText="Mengaktifkan…">Aktifkan kembali</SubmitButton>}</div>
            </form>
          </section>
          {d.status === "active" && (
            <section aria-labelledby="sesi" className="grid gap-3 rounded-lg border p-4">
              <h2 id="sesi" className="text-base font-semibold">Sesi dan verifikasi dua langkah</h2>
              <form className="grid gap-3">
                <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                <input type="hidden" name="reasonCode" value="staff_change" />
                <div className="grid gap-1.5"><Label htmlFor="se-reason">Alasan</Label><Input id="se-reason" name="reason" required minLength={5} maxLength={500} /></div>
                <div className="flex flex-wrap gap-2">
                  <ConfirmSubmit formAction={revokeSessionsAction.bind(null, d.userId)} variant="outline" message="Akhiri semua sesi staf ini?">Akhiri sesi</ConfirmSubmit>
                  <ConfirmSubmit formAction={requestMfaResetAction.bind(null, d.userId)} variant="outline" message="Minta reset verifikasi dua langkah staf ini? Perlu persetujuan staf pengelola kedua.">Minta reset 2FA</ConfirmSubmit>
                </div>
              </form>
              {d.pendingMfaResets.map((r) => (
                <div key={r.supportActionId} className="grid gap-1 text-sm" data-testid={`reset-${r.supportActionId}`}>
                  <p>{r.approvalStatus === "approved" ? "Reset 2FA disetujui. Pemohon asli menjalankannya." : "Reset 2FA menunggu penyetuju kedua; belum ada yang direset."}</p>
                  {r.approvalStatus === "approved" && r.requestedBy === g.userId && <form action={executeMfaResetAction.bind(null, d.userId, r.supportActionId)}><SubmitButton pendingText="Menjalankan…">Jalankan reset</SubmitButton></form>}
                </div>
              ))}
              {d.openRequests.length > 0 && <p className="text-xs text-muted-foreground">Permintaan terbuka: {d.openRequests.map((r) => `${r.actionKey} (${r.status})`).join(", ")}</p>}
            </section>
          )}
        </div>
      )}
      <section aria-labelledby="riwayat" className="grid gap-2">
        <h2 id="riwayat" className="text-lg font-semibold">Riwayat izin</h2>
        {d.events.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada.</p> : (
          <ol className="divide-y rounded-lg border text-sm">
            {d.events.map((e) => <li key={e.id} className="p-3"><time dateTime={e.createdAt.toISOString()} className="text-muted-foreground">{tanggal(e.createdAt)}</time> · {e.action === "grant" ? "diberikan" : "dicabut"} <code>{e.capability}</code> · {e.source === "product" ? "lewat produk" : e.source}{e.actorUserId ? "" : " (di luar produk)"}</li>)}
          </ol>
        )}
      </section>
    </section>
  );
}
