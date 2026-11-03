import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { StatusBadge } from "@/components/status-badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { consoleGate } from "@/lib/console-gate";
import { tanggal } from "@/lib/format";
import { REASON_CODES, savedText } from "@/lib/governance";
import { accountDiagnostics, DomainError, hasPlatformCap, type AccountDiagnostics } from "@bukalaris/db";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AccessDenied } from "../../../access-denied";
import { openCaseAction } from "../../../cases/actions";
import { executeMfaResetAction, requestMfaResetAction, revealAction, revokeSessionsAction, startRecoveryAction, suspendAction } from "../../actions";

export const metadata = { title: "Detail akun" };

const ACTION_STATUS_LABEL: Record<string, string> = {
  awaiting_approval: "Menunggu persetujuan",
  approved: "Disetujui",
  executed: "Dijalankan",
  cancelled: "Dibatalkan",
};

/** The reason and case fields every action form shares (UX-22: each action needs a case and a reason). */
function Common({ d, prefix }: { d: AccountDiagnostics; prefix: string }) {
  return (
    <>
      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
      <div className="grid gap-1.5">
        <Label htmlFor={`${prefix}-case`}>Kasus terbuka</Label>
        {d.openCases.length > 0 ? (
          <NativeSelect id={`${prefix}-case`} name="caseRef" required>{d.openCases.map((c) => <option key={c.id} value={c.caseNumber}>{c.caseNumber} · {c.title}</option>)}</NativeSelect>
        ) : (
          <Input id={`${prefix}-case`} name="caseRef" required placeholder="C-000123" pattern="C-\d{6,}" aria-describedby={`${prefix}-case-help`} />
        )}
        {d.openCases.length === 0 && <p id={`${prefix}-case-help`} className="text-xs text-muted-foreground">Belum ada kasus terbuka untuk akun ini: buka satu di bawah.</p>}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${prefix}-code`}>Kode alasan</Label>
        <NativeSelect id={`${prefix}-code`} name="reasonCode">{REASON_CODES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</NativeSelect>
      </div>
      <div className="grid gap-1.5 sm:col-span-2">
        <Label htmlFor={`${prefix}-reason`}>Alasan</Label>
        <Input id={`${prefix}-reason`} name="reason" required minLength={5} maxLength={500} />
      </div>
    </>
  );
}
const Card = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section aria-labelledby={id} className="grid gap-3 rounded-lg border p-4">
    <h2 id={id} className="text-base font-semibold">{title}</h2>
    {children}
  </section>
);

export default async function AccountDetailPage({ params, searchParams }: PageProps<"/admin/accounts/[kind]/[id]">) {
  const g = await consoleGate("/admin/accounts/[kind]/[id]");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { kind, id } = await params;
  const { error, saved } = await searchParams;
  let d: AccountDiagnostics;
  try {
    d = await accountDiagnostics(g.op, kind, id);
  } catch (err) {
    if (err instanceof DomainError && err.code === "forbidden") return <AccessDenied capability="accounts.read" />;
    if (err instanceof DomainError && err.code === "not_found") notFound(); // unknown account, staff identity or unsupported kind: no existence hint
    throw err;
  }
  const [canSupport, canSuspend, canReveal, canCase] = await Promise.all([hasPlatformCap(g.op, "accounts.support"), hasPlatformCap(g.op, "accounts.suspend"), hasPlatformCap(g.op, "accounts.reveal"), hasPlatformCap(g.op, "cases.write")]);
  const waiting = d.actions.filter((a) => a.actionKind === "reset_mfa" && ["awaiting_approval", "approved"].includes(a.status));
  const here = `/admin/accounts/seller/${d.id}`;
  const shown = (f: "email" | "name") => d.revealed.find((r) => r.field === f);
  return (
    <section className="grid gap-6">
      <PageHeader back={{ href: "/admin/accounts", label: "Cari akun" }} title="Akun seller" badge={<StatusBadge label={d.status === "suspended" ? "Ditangguhkan" : "Aktif"} tone={d.status === "suspended" ? "destructive" : "success"} />}
        description={<>Referensi <span className="font-mono">{d.id}</span>. Kontak disamarkan; tidak ada kata sandi, tautan, token, kode atau kunci yang pernah ditampilkan di sini.</>} />
      <Notice error={error} saved={saved} savedText={savedText(saved)} />
      <dl className="grid gap-x-6 gap-y-2 rounded-lg border p-4 text-sm sm:grid-cols-[max-content_1fr]" data-testid="diagnostik">
        <dt className="text-muted-foreground">Nama</dt><dd data-testid="nama">{shown("name")?.value ?? d.maskedName}</dd>
        <dt className="text-muted-foreground">Email</dt><dd data-testid="email">{shown("email")?.value ?? d.maskedEmail}{d.emailVerified ? "" : " (belum terverifikasi)"}</dd>
        <dt className="text-muted-foreground">Verifikasi dua langkah</dt><dd>{d.mfaEnrolled ? "Ya" : "Tidak"}</dd>
        <dt className="text-muted-foreground">Sesi aktif</dt><dd className="tabular-nums" data-testid="sesi">{d.activeSessions}</dd>
        <dt className="text-muted-foreground">Sesi terbaru</dt><dd>{d.lastSessionAt ? <time dateTime={d.lastSessionAt.toISOString()}>{tanggal(d.lastSessionAt)}</time> : "—"}</dd>
        <dt className="text-muted-foreground">Peran toko</dt><dd>{d.storeOwner ? "Pemilik toko" : "Anggota tim"}</dd>
      </dl>
      {d.revealed.length > 0 ? (
        <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-200">
          <strong>Data pribadi sedang diungkap ({d.revealed.map((r) => r.field === "email" ? "Email" : "Nama").join(", ")})</strong> — nilai asli terbuka sampai <time dateTime={d.revealed[0]!.expiresAt.toISOString()}>{tanggal(d.revealed[0]!.expiresAt)}</time> (jendela pengungkapan 5 menit), lalu tersamarkan lagi. Setiap pembacaan tercatat.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Nilai identitas di atas saat ini disamarkan. Untuk mengungkap nilai asli sementara, gunakan formulir Ungkap nilai asli di bawah dengan merujuk kasus terbuka dan tujuan pemeriksaan.</p>
      )}
      <section aria-labelledby="toko" className="grid gap-2">
        <h2 id="toko" className="text-lg font-semibold">Toko</h2>
        <ul className="divide-y rounded-lg border text-sm">
          {d.memberships.map((m) => <li key={m.storeId} className="flex flex-wrap items-center justify-between gap-2 p-3"><Link href={`/admin/stores/${m.storeId}`} className="underline underline-offset-4">{m.storeName}</Link><span className="text-muted-foreground">{m.role === "owner" ? "Pemilik" : "Staf"} · {m.storeStatus === "active" ? "aktif" : "ditangguhkan"}</span></li>)}
        </ul>
      </section>

      <section aria-labelledby="kasus" className="grid gap-2">
        <h2 id="kasus" className="text-lg font-semibold">Kasus terbuka</h2>
        {d.openCases.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Tidak ada kasus terbuka untuk akun ini. Tindakan di bawah butuh satu.</p> : (
          <ul className="divide-y rounded-lg border text-sm">{d.openCases.map((c) => <li key={c.id} className="p-3"><Link href={`/admin/cases/${c.id}`} className="font-mono underline underline-offset-4">{c.caseNumber}</Link> · {c.title}</li>)}</ul>
        )}
        {canCase && (
          <form action={openCaseAction} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" aria-label="Buka kasus untuk akun ini">
            <input type="hidden" name="subjectKind" value="user" /><input type="hidden" name="subjectId" value={d.id} /><input type="hidden" name="back" value={here} />
            <div className="grid gap-1.5"><Label htmlFor="case-title">Judul kasus</Label><Input id="case-title" name="title" required minLength={3} maxLength={200} /></div>
            <div className="grid gap-1.5"><Label htmlFor="case-reason">Alasan</Label><Input id="case-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <SubmitButton variant="outline" pendingText="Membuka…">Buka kasus</SubmitButton>
          </form>
        )}
      </section>

      {waiting.length > 0 && (
        <Card id="menunggu" title="Reset verifikasi dua langkah menunggu">
          {waiting.map((a) => (
            <div key={a.id} className="grid gap-2 text-sm" data-testid={`menunggu-${a.id}`}>
              <p>{a.status === "approved" ? "Disetujui oleh penyetuju kedua. Pemohon asli menjalankannya." : "Menunggu penyetuju kedua di halaman Persetujuan. Belum ada yang direset."}</p>
              {a.status === "approved" && canSupport && <form action={executeMfaResetAction.bind(null, d.id, a.id)}><SubmitButton pendingText="Menjalankan…">Jalankan reset</SubmitButton></form>}
            </div>
          ))}
        </Card>
      )}

      {canSupport && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card id="sesi-h" title="Akhiri semua sesi">
            <form action={revokeSessionsAction.bind(null, d.id)} className="grid gap-3 sm:grid-cols-2"><Common d={d} prefix="sesi" /><div><ConfirmSubmit variant="outline" message="Akhiri semua sesi akun ini?">Akhiri sesi</ConfirmSubmit></div></form>
          </Card>
          <Card id="pulih" title="Kirim tautan pemulihan">
            <p className="text-xs text-muted-foreground">Dikirim ke kontak yang tercatat. Anda tidak akan melihat tautannya.</p>
            <form action={startRecoveryAction.bind(null, d.id)} className="grid gap-3 sm:grid-cols-2"><Common d={d} prefix="pulih" /><div><SubmitButton variant="outline" pendingText="Mengantre…" disabled={d.status === "suspended"}>Kirim tautan</SubmitButton></div></form>
          </Card>
          <Card id="mfa" title="Reset verifikasi dua langkah">
            <p className="text-xs text-muted-foreground">{d.storeOwner ? "Pemilik toko: butuh persetujuan staf kedua sebelum dijalankan." : "Anggota tim: dijalankan segera dengan kasus, alasan dan pemberitahuan ke kontak."}</p>
            <form action={requestMfaResetAction.bind(null, d.id)} className="grid gap-3 sm:grid-cols-2"><Common d={d} prefix="mfa" /><div><ConfirmSubmit variant="outline" message="Reset verifikasi dua langkah akun ini?">{d.storeOwner ? "Minta reset" : "Reset"}</ConfirmSubmit></div></form>
          </Card>
        </div>
      )}
      {canSuspend && (
        <Card id="tangguh" title={d.status === "suspended" ? "Pulihkan akun" : "Tangguhkan akun"}>
          <p className="text-xs text-muted-foreground">{d.status === "suspended" ? "Akun bisa masuk lagi; sesi lama tidak kembali." : "Semua sesi diakhiri dan akun tidak bisa masuk atau mengubah data. Keanggotaan toko tidak berubah."}</p>
          <form action={suspendAction.bind(null, d.id, d.status !== "suspended")} className="grid gap-3 sm:grid-cols-2"><Common d={d} prefix="tangguh" /><div>{d.status === "suspended" ? <SubmitButton pendingText="Memulihkan…">Pulihkan akun</SubmitButton> : <ConfirmSubmit variant="destructive" message="Tangguhkan akun ini dan akhiri semua sesinya?">Tangguhkan akun</ConfirmSubmit>}</div></form>
        </Card>
      )}
      {canReveal && (
        <Card id="ungkap" title="Ungkap nilai asli">
          <p className="text-xs text-muted-foreground">Butuh kasus terbuka, tujuan dan alasan. Nilai tampil selama jendela pengungkapan lalu tersamarkan lagi; pengungkapan dicatat sebelum nilai ditampilkan.</p>
          <form action={revealAction.bind(null, d.id)} className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label htmlFor="ungkap-field">Kolom</Label><NativeSelect id="ungkap-field" name="field"><option value="email">Email</option><option value="name">Nama</option></NativeSelect></div>
            <div className="grid gap-1.5"><Label htmlFor="ungkap-tujuan">Tujuan</Label><NativeSelect id="ungkap-tujuan" name="purposeCode"><option value="support_case">Kasus dukungan</option><option value="fraud_or_abuse_review">Tinjauan penipuan atau penyalahgunaan</option><option value="verification_review">Tinjauan verifikasi</option></NativeSelect></div>
            <div className="grid gap-1.5"><Label htmlFor="ungkap-case">Nomor kasus terbuka</Label><Input id="ungkap-case" name="caseRef" required placeholder="C-000123" pattern="C-\d{6,}" defaultValue={d.openCases[0]?.caseNumber} /></div>
            <div className="grid gap-1.5"><Label htmlFor="ungkap-reason">Alasan</Label><Input id="ungkap-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <div><SubmitButton variant="outline" pendingText="Mengungkap…">Ungkap</SubmitButton></div>
          </form>
        </Card>
      )}

      <section aria-labelledby="riwayat" className="grid gap-2">
        <h2 id="riwayat" className="text-lg font-semibold">Riwayat status dan tindakan</h2>
        {d.history.length + d.actions.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada.</p> : (
          <ul className="divide-y rounded-lg border text-sm">
            {d.history.map((h) => <li key={`h${h.id}`} className="p-3">{h.fromStatus ?? "—"} → {h.toStatus} ({h.reasonCode}) · <time dateTime={h.createdAt.toISOString()}>{tanggal(h.createdAt)}</time></li>)}
            {d.actions.map((a) => <li key={`a${a.id}`} className="p-3"><span className="font-mono">{a.actionKind}</span> · {ACTION_STATUS_LABEL[a.status] ?? a.status} ({a.status}){a.resultCode ? ` · ${a.resultCode}` : ""} · <time dateTime={a.createdAt.toISOString()}>{tanggal(a.createdAt)}</time></li>)}
          </ul>
        )}
      </section>
    </section>
  );
}
