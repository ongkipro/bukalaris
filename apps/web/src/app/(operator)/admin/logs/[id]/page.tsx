import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { operatorOrDeny } from "@/lib/context";
import { log } from "@/lib/log";
import { DomainError, getSystemLog } from "@bukalaris/db";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { fmtTime, LevelBadge, safeBack } from "../shared";

export const metadata = { title: "Detail log — Bukalaris Owner" };

// Keys already projected into their own rows above are not repeated here.
const PROJECTED = new Set(["code", "route", "store_id", "operation", "request_id", "module", "page_id", "digest"]);
function extraFields(fields: Record<string, string | number | boolean>) {
  const rest = Object.entries(fields).filter(([k]) => !PROJECTED.has(k));
  return rest.length ? rest.map(([k, v]) => `${k}=${String(v)}`).join(" · ") : "—";
}

export default async function LogDetailPage({ params, searchParams }: PageProps<"/admin/logs/[id]">) {
  const op = await operatorOrDeny();
  const { id: rawId } = await params;
  const backHref = safeBack((await searchParams).back);
  const id = /^\d{1,16}$/.test(rawId) ? Number(rawId) : -1;

  let detail: Awaited<ReturnType<typeof getSystemLog>> | undefined;
  let state: "ok" | "denied" | "unavailable" = "ok";
  try {
    detail = await getSystemLog(op, id);
  } catch (err) {
    if (err instanceof DomainError && err.code === "forbidden") state = "denied";
    else {
      await log("error", "log source unavailable", { module: "admin.logs.detail", operation: "getSystemLog", error_name: err instanceof Error ? err.name : "unknown" });
      state = "unavailable";
    }
  }

  return (
    <section className="grid gap-6">
      <PageHeader back={{ href: backHref, label: "Kembali ke daftar" }} title="Detail kejadian" description={detail ? `Modul ${detail.event.module} · ${fmtTime(detail.event.time)}` : undefined} />
      {state === "denied" && (
        <div role="alert" className="rounded-lg border p-6">
          <p className="font-medium">Akses ditolak.</p>
          <p className="mt-1 text-sm text-muted-foreground">Melihat Log System butuh izin platform <code>logs.read</code>; minta operator lain memberikannya.</p>
        </div>
      )}
      {state === "unavailable" && (
        <p role="alert" className="rounded-lg border border-destructive/40 p-6">
          <strong className="block">Sumber log tidak tersedia.</strong>Detail tidak bisa dimuat saat ini. Coba lagi beberapa saat lagi.
        </p>
      )}
      {state === "ok" && !detail && (
        <div role="alert" className="rounded-lg border border-dashed p-6">
          <p className="font-medium">Kejadian tidak ditemukan atau sudah melewati masa simpan.</p>
          <Link href={backHref} className={`${buttonVariants({ variant: "outline", size: "sm" })} mt-3`}>Kembali ke daftar</Link>
        </div>
      )}
      {state === "ok" && detail && (
        <>
          <dl className="grid gap-x-6 gap-y-3 rounded-lg border p-4 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted-foreground">ID kejadian</dt>
            <dd className="flex flex-wrap items-center gap-2 font-mono break-all">
              {detail.event.id} <CopyButton value={String(detail.event.id)} label="ID kejadian" />
            </dd>
            <dt className="text-muted-foreground">Waktu</dt>
            <dd><time dateTime={detail.event.time.toISOString()}>{fmtTime(detail.event.time)}</time></dd>
            <dt className="text-muted-foreground">Level</dt>
            <dd><LevelBadge level={detail.event.level} /></dd>
            <dt className="text-muted-foreground">Pesan</dt>
            <dd className="break-words" data-testid="message">{detail.event.message}</dd>
            <dt className="text-muted-foreground">Kode</dt>
            <dd className="font-mono break-all">{detail.event.code ?? "—"}</dd>
            <dt className="text-muted-foreground">Modul / operasi</dt>
            <dd className="font-mono break-all">
              {detail.event.module}
              {detail.event.operation ? ` · ${detail.event.operation}` : ""}
            </dd>
            <dt className="text-muted-foreground">Rute</dt>
            <dd className="font-mono break-all">{detail.event.route ?? "—"}</dd>
            <dt className="text-muted-foreground">Request ID</dt>
            <dd className="flex flex-wrap items-center gap-2 font-mono break-all" data-testid="request-id">
              {detail.event.requestId ?? "—"}
              {detail.event.requestId && <CopyButton value={detail.event.requestId} label="Request ID" />}
            </dd>
            <dt className="text-muted-foreground">Toko</dt>
            <dd>{detail.event.storeId ?? "—"}</dd>
            <dt className="text-muted-foreground">Lingkungan / rilis</dt>
            <dd className="font-mono break-all">
              {detail.event.environment} · {detail.event.release ?? "rilis tidak diketahui"}
            </dd>
            <dt className="text-muted-foreground">Field tambahan</dt>
            <dd className="font-mono text-xs break-all">{extraFields(detail.event.fields)}</dd>
          </dl>

          <section aria-labelledby="map-heading" className="rounded-lg border p-4 text-sm">
            <h2 id="map-heading" className="mb-1 font-medium">Peta halaman / modul</h2>
            {detail.mapping ? (
              <p>
                <span className="font-mono">{detail.event.pageId ?? detail.mapping.pageId}</span> · {detail.mapping.label}
              </p>
            ) : (
              <p className="text-muted-foreground">Pemetaan tidak tersedia untuk modul <span className="font-mono">{detail.event.module}</span>.</p>
            )}
          </section>

          <section aria-labelledby="related-heading" className="grid gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="related-heading" className="font-medium">Kejadian terkait (request ID sama)</h2>
              {detail.event.requestId && (
                <Link href={`/admin/logs?requestId=${encodeURIComponent(detail.event.requestId)}&range=24h`} className="text-sm underline underline-offset-4">
                  Lihat di daftar
                </Link>
              )}
            </div>
            {!detail.event.requestId ? (
              <p className="rounded-lg border p-4 text-sm text-muted-foreground">Kejadian ini tidak membawa request ID, jadi korelasi tidak tersedia.</p>
            ) : detail.related.length === 0 ? (
              <p className="rounded-lg border p-4 text-sm text-muted-foreground">Tidak ada kejadian lain dengan request ID ini.</p>
            ) : (
              <Table>
                <caption className="sr-only">Kejadian terkait</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Waktu</TableHead>
                    <TableHead>Level</TableHead>
                    <TableHead className="hidden md:table-cell">Modul</TableHead>
                    <TableHead>Pesan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.related.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-normal text-xs text-muted-foreground">
                        <time dateTime={e.time.toISOString()}>{fmtTime(e.time)}</time>
                      </TableCell>
                      <TableCell><LevelBadge level={e.level} /></TableCell>
                      <TableCell className="hidden md:table-cell font-mono text-xs">{e.module}</TableCell>
                      <TableCell className="max-w-[12rem] whitespace-normal sm:max-w-md">
                        <Link href={`/admin/logs/${e.id}?back=${encodeURIComponent(backHref.slice("/admin/logs".length))}`} className="font-medium underline-offset-4 hover:underline">
                          {e.message.length > 90 ? `${e.message.slice(0, 90)}…` : e.message}
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </>
      )}
    </section>
  );
}
