import { Notice } from "@/components/notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { operatorOrDeny } from "@/lib/context";
import { getStoreDetail } from "@bukalaris/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { setStoreStatusDetailAction } from "../actions";

const when = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });

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
      <div>
        <Link href="/admin" className="text-sm text-muted-foreground underline-offset-4 hover:underline">← Semua toko</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{s.name}</h1>
          <Badge variant={s.status === "active" ? "default" : "destructive"}>{s.status === "active" ? "Aktif" : "Ditangguhkan"}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          ID <span className="font-mono">{s.id}</span> · <a href={`/s/${s.slug}`} className="underline">/s/{s.slug}</a> · tema {s.theme} · dibuat {when.format(s.createdAt)}
        </p>
      </div>
      <Notice error={error} saved={saved} />

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {counts.map(([label, n]) => (
          <div key={label} className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="anggota" className="grid gap-2">
        <h2 id="anggota" className="font-medium">Anggota</h2>
        <ul className="divide-y rounded-lg border text-sm">
          {s.members.map((m) => (
            <li key={m.email} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span>{m.name} <span className="text-muted-foreground">· {m.email}</span></span>
              <Badge variant="outline">{m.role === "owner" ? "Pemilik" : "Staf"}</Badge>
            </li>
          ))}
        </ul>
      </section>

      <form action={setStoreStatusDetailAction.bind(null, s.id, next)} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="grid gap-2">
          <label htmlFor="reason" className="text-sm font-medium">Alasan {next === "suspended" ? "penangguhan" : "pengaktifan kembali"} (tercatat di audit)</label>
          <Input id="reason" name="reason" required minLength={5} maxLength={500} />
        </div>
        <Button type="submit" variant={next === "suspended" ? "destructive" : "default"}>
          {next === "suspended" ? "Tangguhkan toko" : "Aktifkan kembali"}
        </Button>
      </form>

      <section aria-labelledby="audit" className="grid gap-2">
        <h2 id="audit" className="font-medium">Audit terbaru</h2>
        {s.audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada catatan.</p>
        ) : (
          <ol className="divide-y rounded-lg border text-sm">
            {s.audit.map((a) => (
              <li key={a.id} className="grid gap-0.5 p-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
                <time dateTime={a.createdAt.toISOString()} className="text-muted-foreground tabular-nums">{when.format(a.createdAt)}</time>
                <span>
                  <span className="font-mono text-xs">{a.action}</span>
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
