import { CsrfField } from "@/lib/auth-csrf-form";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { StatusBadge } from "@/components/status-badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { savedText } from "@/lib/governance";
import { activeVerificationReveals, hasPlatformCap, listVerifications } from "@bukalaris/db";
import { notFound } from "next/navigation";
import { AccessDenied } from "../../../access-denied";
import { reviewVerificationAction, revealVerificationAction, submitVerificationAction } from "./actions";

export const metadata = { title: "Verifikasi toko" };
const STATUS_LABEL: Record<string, string> = { submitted: "Diajukan", in_review: "Ditinjau", verified: "Terverifikasi", rejected: "Ditolak", revoked: "Dicabut", expired: "Kedaluwarsa", not_started: "Belum dimulai" };
const STATUS_TONE: Record<string, "default" | "secondary" | "outline" | "destructive" | "success" | "warning"> = {
  submitted: "warning",
  in_review: "default",
  verified: "success",
  rejected: "destructive",
  revoked: "outline",
  expired: "secondary",
  not_started: "secondary",
};
const NEXT: Record<string, readonly [string, string][]> = {
  submitted: [["in_review", "Mulai tinjau"], ["verified", "Verifikasi"], ["rejected", "Tolak"]],
  in_review: [["verified", "Verifikasi"], ["rejected", "Tolak"]],
  verified: [["revoked", "Cabut"]],
};
const FIELD_LABEL = { verifiedName: "Nama", contactEmail: "Email kontak", contactPhone: "Telepon kontak" } as const;

export default async function StoreVerificationPage({ params, searchParams }: PageProps<"/admin/stores/[id]/verification">) {
  const g = await consoleGate("/admin/stores/[id]/verification");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { id } = await params;
  const { error, saved } = await searchParams;
  const storeId = /^[0-9]{1,15}$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(storeId)) notFound();
  const versions = await allowed(listVerifications(g.op, storeId));
  if (versions === undefined) return <AccessDenied capability="tenants.verify" />;
  const canReveal = await hasPlatformCap(g.op, "accounts.reveal");
  const revealed = canReveal ? await allowed(activeVerificationReveals(g.op, storeId)) : [];
  return (
    <section className="grid gap-6">
      <PageHeader back={{ href: `/admin/stores/${storeId}`, label: "Detail toko" }} title="Verifikasi toko" description="Catatan opsional dan informasional: tidak ada status di sini yang menghalangi pembuatan, persetujuan, aktivasi, penagihan atau pencairan toko. Versi yang sudah diajukan tidak bisa diubah; perubahan adalah versi baru." />
      <Notice error={error} saved={saved} savedText={savedText(saved)} />
      <form action={submitVerificationAction.bind(null, storeId)} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2" aria-labelledby="ajukan">
        <CsrfField />
        <h2 id="ajukan" className="text-base font-semibold sm:col-span-2">Ajukan versi baru</h2>
        <div className="grid gap-1.5"><Label htmlFor="kind">Jenis</Label><NativeSelect id="kind" name="kind" defaultValue="identity"><option value="identity">Identitas</option><option value="business">Usaha</option></NativeSelect></div>
        <div className="grid gap-1.5"><Label htmlFor="verifiedName">Nama (opsional)</Label><Input id="verifiedName" name="verifiedName" maxLength={200} autoComplete="off" /></div>
        <div className="grid gap-1.5"><Label htmlFor="contactEmail">Email kontak (opsional)</Label><Input id="contactEmail" name="contactEmail" type="email" maxLength={254} autoComplete="off" /></div>
        <div className="grid gap-1.5"><Label htmlFor="contactPhone">Telepon kontak (opsional)</Label><Input id="contactPhone" name="contactPhone" inputMode="tel" maxLength={32} autoComplete="off" /></div>
        <div className="grid gap-1.5"><Label htmlFor="registrationNumber">Nomor registrasi (opsional)</Label><Input id="registrationNumber" name="registrationNumber" maxLength={64} autoComplete="off" /></div>
        <div className="grid gap-1.5"><Label htmlFor="evidenceRef">Referensi bukti (opsional)</Label><Input id="evidenceRef" name="evidenceRef" maxLength={120} aria-describedby="evidence-help" /><p id="evidence-help" className="text-xs text-muted-foreground">Hanya referensi; gambar dokumen tidak dikumpulkan.</p></div>
        <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="reason">Alasan</Label><Input id="reason" name="reason" required minLength={5} maxLength={500} /></div>
        <div><SubmitButton pendingText="Menyimpan…">Simpan versi</SubmitButton></div>
      </form>
      <section aria-labelledby="versi" className="grid gap-3">
        <h2 id="versi" className="text-lg font-semibold">Versi</h2>
        {versions.length === 0 ? <EmptyState title="Belum ada catatan verifikasi">Itu tidak apa-apa: toko berjalan penuh tanpa catatan ini.</EmptyState> : (
          <ul className="grid gap-3">
            {versions.map((v) => {
              const shown = revealed?.filter((r) => r.versionId === v.id) ?? [];
              return (
                <li key={v.id} className="grid gap-2 rounded-lg border p-4 text-sm" data-testid={`versi-${v.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{v.kind === "identity" ? "Identitas" : "Usaha"} · versi {v.version}</h3>
                    <StatusBadge label={STATUS_LABEL[v.status] ?? v.status} tone={STATUS_TONE[v.status] ?? "outline"} />
                    <time dateTime={v.submittedAt.toISOString()} className="text-muted-foreground">{tanggal(v.submittedAt)}</time>
                  </div>
                  <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
                    <dt className="text-muted-foreground">Nama</dt><dd>{shown.find((r) => r.field === "verifiedName")?.value ?? v.maskedName ?? "—"}</dd>
                    <dt className="text-muted-foreground">Email kontak</dt><dd>{shown.find((r) => r.field === "contactEmail")?.value ?? v.maskedEmail ?? "—"}</dd>
                    <dt className="text-muted-foreground">Telepon kontak</dt><dd>{shown.find((r) => r.field === "contactPhone")?.value ?? v.maskedPhone ?? "—"}</dd>
                    <dt className="text-muted-foreground">Nomor registrasi</dt><dd>{v.hasRegistrationNumber ? "Tersimpan (tidak ditampilkan)" : "—"}</dd>
                    <dt className="text-muted-foreground">Bukti</dt><dd className="font-mono break-all">{v.evidenceRef ?? "—"}</dd>
                  </dl>
                  {shown.length > 0 ? (
                    <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-200">
                      <strong>Data pribadi sedang diungkap</strong> — nilai terbuka sampai <time dateTime={shown[0]!.expiresAt.toISOString()}>{tanggal(shown[0]!.expiresAt)}</time> (jendela pengungkapan 5 menit), lalu tersamarkan lagi. Setiap pembacaan tercatat.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">Nilai kontak disamarkan secara bawaan. Ungkap satu kolom hanya bila diperlukan untuk tinjauan kasus terbuka.</p>
                  )}
                  {NEXT[v.status] && (
                    <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" aria-label={`Keputusan versi ${v.version}`}>
        <CsrfField />
                      <div className="grid gap-1.5"><Label htmlFor={`alasan-${v.id}`}>Alasan keputusan</Label><Input id={`alasan-${v.id}`} name="reason" required minLength={5} maxLength={500} /></div>
                      <div className="flex flex-wrap gap-2">
                        {NEXT[v.status]!.map(([to, label]) => <SubmitButton key={to} formAction={reviewVerificationAction.bind(null, storeId, v.id, to as "verified")} variant={to === "verified" || to === "in_review" ? "default" : "outline"} pendingText="Menyimpan…">{label}</SubmitButton>)}
                      </div>
                    </form>
                  )}
                  {canReveal && (v.maskedName || v.maskedEmail || v.maskedPhone) && (
                    <details className="rounded-md border p-3">
                      <summary className="cursor-pointer text-sm font-medium">Ungkap satu kolom</summary>
                      <form action={revealVerificationAction.bind(null, storeId, v.id)} className="mt-2 grid gap-2 sm:grid-cols-2">
        <CsrfField />
                        <div className="grid gap-1.5"><Label htmlFor={`kolom-${v.id}`}>Kolom</Label><NativeSelect id={`kolom-${v.id}`} name="field">{(Object.keys(FIELD_LABEL) as (keyof typeof FIELD_LABEL)[]).map((k) => <option key={k} value={k}>{FIELD_LABEL[k]}</option>)}</NativeSelect></div>
                        <div className="grid gap-1.5"><Label htmlFor={`kasus-${v.id}`}>Nomor kasus terbuka</Label><Input id={`kasus-${v.id}`} name="caseRef" required placeholder="C-000123" pattern="C-\d{6,}" /></div>
                        <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor={`tujuan-${v.id}`}>Alasan (tujuan: tinjauan verifikasi)</Label><Input id={`tujuan-${v.id}`} name="reason" required minLength={5} maxLength={500} /></div>
                        <div><SubmitButton pendingText="Mengungkap…" variant="outline">Ungkap</SubmitButton></div>
                      </form>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
