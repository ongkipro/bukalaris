import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { operatorOrDeny } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { auditAction, roleLabel, storeStatusLabel, storeStatusTone, themeName } from "@/lib/status";
import { getStoreDetail } from "@bukalaris/db";
import { notFound } from "next/navigation";
import { setStoreStatusDetailAction } from "../actions";

export default async function StoreDetailPage({ params, searchParams }: PageProps<"/admin/stores/[id]">) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const op = await operatorOrDeny();
  const storeId = /^[0-9]{1,15}$/.test(id) ? Number(id) : NaN;
  const s = Number.isSafeInteger(storeId) ? await getStoreDetail(op, storeId) : null;
  if (!s) notFound();
  const next = s.status === "active" ? "suspended" : "active";
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
        back={{ href: "/admin", label: "Semua toko" }}
        title={s.name}
        badge={<StatusBadge label={storeStatusLabel[s.status]} tone={storeStatusTone[s.status]} />}
        description={
          <>
            ID <span className="font-mono">{s.id}</span> · <a href={`/s/${s.slug}`} className="underline underline-offset-4">/s/{s.slug}</a> · tema {themeName(s.theme)} · dibuat{" "}
            <time dateTime={s.createdAt.toISOString()}>{tanggal(s.createdAt)}</time>
          </>
        }
      />
      <Notice error={error} saved={saved} />

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
              <li key={m.email} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span className="min-w-0 break-words">{m.name} <span className="text-muted-foreground">· {m.email}</span></span>
                <Badge variant="outline">{roleLabel[m.role]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action={setStoreStatusDetailAction.bind(null, s.id, next)} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="reason">Alasan {next === "suspended" ? "penangguhan" : "pengaktifan kembali"}</Label>
          <Input id="reason" name="reason" required minLength={5} maxLength={500} aria-describedby="reason-help" />
          <p id="reason-help" className="text-xs text-muted-foreground">Minimal 5 karakter; tercatat di audit bersama akun Anda.</p>
        </div>
        {next === "suspended" ? (
          <ConfirmSubmit variant="destructive" message={`Tangguhkan toko "${s.name}"? Seller Admin dan storefront /${s.slug} langsung tertutup untuk pembeli sampai diaktifkan kembali.`}>
            Tangguhkan toko
          </ConfirmSubmit>
        ) : (
          <SubmitButton pendingText="Mengaktifkan…">Aktifkan kembali</SubmitButton>
        )}
      </form>

      <section aria-labelledby="audit" className="grid gap-2">
        <h2 id="audit" className="text-lg font-semibold">Audit terbaru</h2>
        {s.audit.length === 0 ? (
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
