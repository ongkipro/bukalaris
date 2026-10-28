import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import Link from "next/link";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { auditAction, roleLabel, storeStatusLabel, storeStatusTone, themeName } from "@/lib/status";
import { savedText } from "@/lib/governance";
import { REASON_CODES } from "@/lib/governance";
import { getStoreDetail, hasPlatformCap, storeCases, storeStatusHistory } from "@bukalaris/db";
import { notFound } from "next/navigation";
import { AccessDenied } from "../../access-denied";
import { openCaseAction } from "../../cases/actions";
import { setStoreStatusDetailAction } from "../actions";

export default async function StoreDetailPage({ params, searchParams }: PageProps<"/admin/stores/[id]">) {
  const g = await consoleGate("/admin/stores/[id]");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { id } = await params;
  const { error, saved } = await searchParams;
  const storeId = /^[0-9]{1,15}$/.test(id) ? Number(id) : NaN;
  const s = Number.isSafeInteger(storeId) ? await allowed(getStoreDetail(g.op, storeId)) : null;
  if (s === undefined) return <AccessDenied capability="tenants.read" />;
  if (!s) notFound();
  const next = s.status === "active" ? "suspended" : "active";
  const [history, cases, canVerify, canCase] = await Promise.all([allowed(storeStatusHistory(g.op, storeId)), allowed(storeCases(g.op, storeId)), hasPlatformCap(g.op, "tenants.verify"), hasPlatformCap(g.op, "cases.write")]);
  const counts = [
    ["Produk", s.counts.products],
    ["Pesanan", s.counts.orders],
    ["Anggota", s.counts.members],
    ["Koleksi", s.counts.collections],
    ["Halaman", s.counts.pages],
    ["Gambar", s.counts.images],
  ] as const;
  return (
    <section className="grid gap-6">
      <PageHeader
        back={{ href: "/admin/stores", label: "Semua toko" }}
        title={s.name}
        badge={<StatusBadge label={storeStatusLabel[s.status]} tone={storeStatusTone[s.status]} />}
        description={
          <>
            ID <span className="font-mono">{s.id}</span> · <a href={`/s/${s.slug}`} className="underline underline-offset-4">/s/{s.slug}</a> · tema {themeName(s.theme)} · dibuat{" "}
            <time dateTime={s.createdAt.toISOString()}>{tanggal(s.createdAt)}</time>
          </>
        }
      />
      <Notice error={error} saved={saved} savedText={savedText(saved)} />

      {/* Inventory counts, not KPIs: no period, no trend, nothing to misread (UI-7). */}
      <dl className="grid grid-cols-2 divide-x divide-y rounded-lg border sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6">
        {counts.map(([label, n]) => (
          <div key={label} className="p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="anggota" className="grid gap-2">
        <h2 id="anggota" className="text-lg font-semibold">Anggota</h2>
        {s.members.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Toko ini belum punya anggota.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {s.members.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span className="min-w-0 break-words">{m.name} <span className="text-muted-foreground">· {m.email}</span> <Link href={`/admin/accounts/seller/${m.userId}`} className="underline underline-offset-4">Lihat akun</Link></span>
                <Badge variant="outline">{roleLabel[m.role]}</Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">Kontak disamarkan. Mengungkap nilai asli butuh kasus terbuka, tujuan dan izin khusus (halaman akun).</p>
      </section>

      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {canVerify && <Link href={`/admin/stores/${s.id}/verification`} className="underline underline-offset-4">Catatan verifikasi (opsional)</Link>}
        <Link href="/admin/risk" className="underline underline-offset-4">Tanda risiko</Link>
        {g.caps.includes("finance.read") ? <Link href={`/admin/stores/${s.id}/ledger`} className="underline underline-offset-4" data-testid="ledger-link">Buku besar toko</Link> : <span className="text-muted-foreground" data-testid="ledger-denied">Buku besar toko butuh izin <code>finance.read</code>.</span>}
      </p>

      <form action={setStoreStatusDetailAction.bind(null, s.id, next)} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="reasonCode">Kode alasan</Label>
          <NativeSelect id="reasonCode" name="reasonCode" defaultValue="operator_decision">{REASON_CODES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</NativeSelect>
          <Label htmlFor="reason">Alasan {next === "suspended" ? "penangguhan" : "pengaktifan kembali"}</Label>
          <Input id="reason" name="reason" required minLength={5} maxLength={500} aria-describedby="reason-help" />
          <p id="reason-help" className="text-xs text-muted-foreground">Minimal 5 karakter; tercatat di audit bersama akun Anda. Penangguhan tidak menghapus utang dan pembayaran tidak mencabut penangguhan.</p>
          <Label htmlFor="caseId">Nomor kasus (opsional)</Label>
          <Input id="caseId" name="caseId" placeholder="C-000123" pattern="C-\d{6,}" />
        </div>
        {next === "suspended" ? (
          <ConfirmSubmit variant="destructive" message={`Tangguhkan toko "${s.name}"? Seller Admin dan storefront /${s.slug} langsung tertutup untuk pembeli sampai diaktifkan kembali.`}>
            Tangguhkan toko
          </ConfirmSubmit>
        ) : (
          <SubmitButton pendingText="Mengaktifkan…">Aktifkan kembali</SubmitButton>
        )}
      </form>

      <section aria-labelledby="riwayat" className="grid gap-2">
        <h2 id="riwayat" className="text-lg font-semibold">Riwayat status</h2>
        {!history || history.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{history === undefined ? "Riwayat butuh izin tenants.read." : "Belum ada riwayat."}</p>
        ) : (
          <ol className="divide-y rounded-lg border text-sm">
            {history.map((h) => (
              <li key={h.id} className="grid gap-0.5 p-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
                <time dateTime={h.createdAt.toISOString()} className="text-muted-foreground">{tanggal(h.createdAt)}</time>
                <span className="min-w-0 break-words">{h.fromStatus ?? "—"} → {h.toStatus} <span className="text-muted-foreground">({h.reasonCode}){h.reasonNote ? ` — ${h.reasonNote}` : ""}</span></span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="kasus" className="grid gap-2">
        <h2 id="kasus" className="text-lg font-semibold">Kasus untuk toko ini</h2>
        {cases && cases.length > 0 ? (
          <ul className="divide-y rounded-lg border text-sm">{cases.map((c) => <li key={c.id} className="p-3"><Link href={`/admin/cases/${c.id}`} className="font-mono underline underline-offset-4">{c.caseNumber}</Link> · {c.title} <Badge variant="outline">{c.status}</Badge></li>)}</ul>
        ) : (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{cases === undefined ? "Kasus butuh izin cases.read." : "Belum ada kasus untuk toko ini."}</p>
        )}
        {canCase && (
          <form action={openCaseAction} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" aria-label="Buka kasus untuk toko ini">
            <input type="hidden" name="subjectKind" value="store" /><input type="hidden" name="subjectId" value={s.id} /><input type="hidden" name="back" value={`/admin/stores/${s.id}`} /><input type="hidden" name="kind" value="risk" />
            <div className="grid gap-1.5"><Label htmlFor="case-title">Judul kasus</Label><Input id="case-title" name="title" required minLength={3} maxLength={200} /></div>
            <div className="grid gap-1.5"><Label htmlFor="case-reason">Alasan</Label><Input id="case-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <SubmitButton variant="outline" pendingText="Membuka…">Buka kasus</SubmitButton>
          </form>
        )}
      </section>

      <section aria-labelledby="audit" className="grid gap-2">
        <h2 id="audit" className="text-lg font-semibold">Audit terbaru</h2>
        {s.audit === null ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Riwayat audit butuh izin <code>audit.read</code>.</p>
        ) : s.audit.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada catatan.</p>
        ) : (
          <ol className="divide-y rounded-lg border text-sm">
            {s.audit.map((a) => (
              <li key={a.id} className="grid gap-0.5 p-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
                <time dateTime={a.createdAt.toISOString()} className="text-muted-foreground">{tanggal(a.createdAt)}</time>
                <span className="min-w-0 break-words">
                  {auditAction(a.action)}
                  {a.reason && <span className="text-muted-foreground"> — {a.reason}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
