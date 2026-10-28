import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { consoleGate } from "@/lib/console-gate";
import { tanggal } from "@/lib/format";
import { log } from "@/lib/log";
import { consoleAccessEvents, consoleAudit, DomainError, PLATFORM_CAPABILITIES, type AuditPage, type AccessEventView } from "@bukalaris/db";
import Link from "next/link";
import { ZodError } from "zod";
import { AccessDenied } from "../access-denied";

export const metadata = { title: "Audit" };

const KEYS = ["actor", "capability", "subjectKind", "subjectId", "caseId", "outcome", "from", "to", "cursor"] as const;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  const g = await consoleGate("/admin/audit");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const sp = await searchParams;
  const q = Object.fromEntries(KEYS.map((k) => [k, first(sp[k])])) as Record<(typeof KEYS)[number], string>;
  let page: AuditPage | null = null;
  let access: AccessEventView[] | null = null;
  let invalid: string | null = null;
  try {
    page = await consoleAudit(g.op, { ...q, limit: 50 });
    access = q.cursor ? null : await consoleAccessEvents(g.op, { limit: 20 });
  } catch (err) {
    if (err instanceof DomainError && err.code !== "forbidden") invalid = err.message;
    else if (err instanceof ZodError) invalid = err.issues[0]?.message ?? "Filter tidak valid.";
    else await log("error", "audit source unavailable", { module: "admin.audit", operation: "consoleAudit", error_name: err instanceof Error ? err.name : "unknown" });
  }
  const next = page?.nextCursor ? new URLSearchParams({ ...Object.fromEntries(KEYS.filter((k) => q[k] && k !== "cursor").map((k) => [k, q[k]])), from: page.from.toISOString(), to: page.to.toISOString(), cursor: page.nextCursor }).toString() : null;
  return (
    <section className="grid gap-6">
      <PageHeader title="Audit" description="Jejak tindakan staf. Nilai disamarkan menurut daftar yang diizinkan per tindakan; membaca halaman ini juga tercatat. Tidak ada ubah atau hapus." />
      <form method="get" action="/admin/audit" aria-label="Filter audit" className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="grid gap-1.5">
          <Label htmlFor="a-actor">Aktor (ID pengguna)</Label>
          <Input id="a-actor" name="actor" defaultValue={q.actor} className="font-mono" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="a-cap">Izin</Label>
          <NativeSelect id="a-cap" name="capability" defaultValue={q.capability}>
            <option value="">Semua</option>
            {PLATFORM_CAPABILITIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="a-kind">Jenis target</Label>
          <Input id="a-kind" name="subjectKind" defaultValue={q.subjectKind} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="a-id">ID target</Label>
          <Input id="a-id" name="subjectId" defaultValue={q.subjectId} className="font-mono" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="a-case">Kasus</Label>
          <Input id="a-case" name="caseId" defaultValue={q.caseId} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="a-outcome">Hasil</Label>
          <NativeSelect id="a-outcome" name="outcome" defaultValue={q.outcome}>
            <option value="">Semua</option>
            <option value="allowed">Diizinkan</option>
            <option value="denied">Ditolak</option>
          </NativeSelect>
        </div>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
          <Button type="submit">Terapkan</Button>
          <Link href="/admin/audit" className={buttonVariants({ variant: "outline" })}>Reset</Link>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">Bawaan 24 jam terakhir, maksimal 7 hari.</p>
      </form>
      {invalid && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">{invalid}</p>}
      {page === null && !invalid ? (
        <p role="alert" className="rounded-lg border border-destructive/40 p-6">
          <strong className="block">Sumber audit tidak tersedia.</strong>Ini bukan berarti tidak ada tindakan. Coba muat ulang.
        </p>
      ) : page ? (
        <>
          <p className="text-sm text-muted-foreground" data-testid="freshness">Jendela <time dateTime={page.from.toISOString()}>{tanggal(page.from)}</time> – <time dateTime={page.to.toISOString()}>{tanggal(page.to)}</time></p>
          {page.items.length === 0 ? (
            <EmptyState title="Tidak ada baris">Tidak ada tindakan yang cocok pada jendela ini.</EmptyState>
          ) : (
            <Table>
              <caption className="sr-only">Baris audit</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Waktu</TableHead>
                  <TableHead>Aktor</TableHead>
                  <TableHead>Tindakan</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Hasil</TableHead>
                  <TableHead>Rincian</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.items.map((r) => (
                  <TableRow key={r.id} data-testid="audit-row">
                    <TableCell className="whitespace-normal text-xs"><time dateTime={r.createdAt.toISOString()}>{tanggal(r.createdAt)}</time></TableCell>
                    <TableCell className="font-mono text-xs break-all whitespace-normal">{r.actorUserId}</TableCell>
                    <TableCell className="whitespace-normal"><span className="font-mono text-xs">{r.action}</span>{r.actorCapability && <span className="block text-xs text-muted-foreground">{r.actorCapability}</span>}</TableCell>
                    <TableCell className="font-mono text-xs break-all whitespace-normal">{r.subjectKind ? `${r.subjectKind}:${r.subjectId ?? ""}` : r.storeId ? `toko:${r.storeId}` : "—"}{r.caseId && <span className="block">kasus {r.caseId}</span>}</TableCell>
                    <TableCell className="whitespace-normal text-xs">{r.outcome ?? "—"}{r.accessLevel && <span className="block text-muted-foreground">{r.accessLevel}</span>}</TableCell>
                    <TableCell className="max-w-[16rem] whitespace-normal text-xs [overflow-wrap:anywhere]">
                      {Object.entries(r.fields).map(([k, v]) => <span key={k} className="block font-mono">{k}={v}</span>)}
                      {r.reason ?? (Object.keys(r.fields).length === 0 ? "disamarkan" : null)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {next && <Link href={`/admin/audit?${next}`} className={buttonVariants({ variant: "outline" })}>Muat lebih lama</Link>}
        </>
      ) : null}
      {access && (
        <section aria-labelledby="access" className="grid gap-2">
          <h2 id="access" className="text-lg font-semibold">Akses data pribadi</h2>
          {access.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada nilai pribadi yang dibuka.</p>
          ) : (
            <ul className="text-sm">
              {access.map((e) => (
                <li key={e.id}><time dateTime={e.createdAt.toISOString()}>{tanggal(e.createdAt)}</time> · {e.accessLevel} · {e.fieldClass} · {e.purposeCode} · <span className="font-mono">{e.targetKind}:{e.targetId}</span></li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
