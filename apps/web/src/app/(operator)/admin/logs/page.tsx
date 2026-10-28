import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { consoleGate } from "@/lib/console-gate";
import { AccessDenied } from "../access-denied";
import { log } from "@/lib/log";
import { DomainError, listSystemLogs, LOG_LEVELS, MODULE_MAP } from "@bukalaris/db";
import Link from "next/link";
import { ZodError } from "zod";
import { fmtTime, LEVEL_LABEL, LevelBadge } from "./shared";

export const metadata = { title: "Log System" };

const RANGES = { "15m": ["15 menit terakhir", 15], "1h": ["1 jam terakhir", 60], "6h": ["6 jam terakhir", 360], "24h": ["24 jam terakhir", 1440] } as const;
type RangeKey = keyof typeof RANGES;
const FILTER_KEYS = ["level", "module", "requestId", "storeId", "range", "from", "to", "cursor"] as const;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
/** Explicit from/to freeze the window while paginating; otherwise the window is "now minus range". */
function timeWindow(from: string, to: string, range: RangeKey) {
  if (from && to) return { from, to };
  const now = Date.now();
  return { from: new Date(now - RANGES[range][1] * 60_000).toISOString(), to: new Date(now).toISOString() };
}

export default async function LogsPage({ searchParams }: PageProps<"/admin/logs">) {
  const g = await consoleGate("/admin/logs");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const op = g.op;
  const sp = await searchParams;
  const q = Object.fromEntries(FILTER_KEYS.map((k) => [k, first(sp[k])])) as Record<(typeof FILTER_KEYS)[number], string>;
  const range: RangeKey = q.range in RANGES ? (q.range as RangeKey) : "1h";
  const { from, to } = timeWindow(q.from, q.to, range);
  const hasFilter = Boolean(q.level || q.module || q.requestId || q.storeId);

  type State =
    | { kind: "ok"; data: Awaited<ReturnType<typeof listSystemLogs>> }
    | { kind: "denied" }
    | { kind: "invalid"; message: string }
    | { kind: "unavailable" };
  let state: State;
  try {
    state = { kind: "ok", data: await listSystemLogs(op, { ...q, from, to, limit: 50 }) };
  } catch (err) {
    if (err instanceof DomainError && err.code === "forbidden") state = { kind: "denied" };
    else if (err instanceof DomainError) state = { kind: "invalid", message: err.message };
    else if (err instanceof ZodError) state = { kind: "invalid", message: err.issues[0]?.message ?? "Filter tidak valid." };
    else {
      // A failing source is reported as such, never as "no events" (PR-11, OBS-5).
      await log("error", "log source unavailable", { module: "admin.logs", operation: "listSystemLogs", error_name: err instanceof Error ? err.name : "unknown" });
      state = { kind: "unavailable" };
    }
  }

  const qs = (over: Partial<Record<(typeof FILTER_KEYS)[number], string | undefined>>) => {
    const p = new URLSearchParams();
    for (const k of FILTER_KEYS) {
      const v = k in over ? over[k] : q[k];
      if (v) p.set(k, v);
    }
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  const back = encodeURIComponent(qs({}));

  return (
    <section className="grid gap-6">
      <PageHeader title="Log System" description="Kejadian peringatan dan error yang sudah disanitasi, lingkungan saat ini, waktu WIB. Buka kejadian untuk detail dan korelasi request ID." />

      {state.kind === "denied" ? (
        <div role="alert" className="rounded-lg border p-6">
          <p className="font-medium">Akses ditolak.</p>
          <p className="mt-1 text-sm text-muted-foreground">Melihat Log System butuh izin platform <code>logs.read</code>; minta operator lain memberikannya.</p>
        </div>
      ) : (
        <>
          <form method="get" action="/admin/logs" aria-label="Filter log" className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="grid gap-1.5">
              <Label htmlFor="f-level">Level</Label>
              <NativeSelect id="f-level" name="level" defaultValue={q.level}>
                <option value="">Semua level</option>
                {LOG_LEVELS.map((l) => (
                  <option key={l} value={l}>{LEVEL_LABEL[l]}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-module">Modul</Label>
              <NativeSelect id="f-module" name="module" defaultValue={q.module}>
                <option value="">Semua modul</option>
                {[...Object.keys(MODULE_MAP), "unknown"].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-range">Rentang waktu</Label>
              <NativeSelect id="f-range" name="range" defaultValue={range}>
                {Object.entries(RANGES).map(([k, [label]]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-request">Request ID</Label>
              <Input id="f-request" name="requestId" defaultValue={q.requestId} placeholder="mis. 7f3c…" pattern="[A-Za-z0-9_-]{1,128}" className="font-mono" aria-describedby="f-request-help" />
              <p id="f-request-help" className="text-xs text-muted-foreground">Nilai header x-request-id, utuh.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-store">Store ID</Label>
              <Input id="f-store" name="storeId" defaultValue={q.storeId} inputMode="numeric" pattern="[0-9]{1,16}" className="tabular-nums" />
            </div>
            <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-5">
              <Button type="submit">Terapkan</Button>
              <Link href="/admin/logs" className={buttonVariants({ variant: "outline" })}>Reset</Link>
              <Link href={`/admin/logs${qs({ from: undefined, to: undefined, cursor: undefined })}`} className={buttonVariants({ variant: "ghost" })}>Segarkan</Link>
            </div>
          </form>

          {state.kind === "invalid" && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">{state.message}</p>
          )}
          {state.kind === "unavailable" && (
            <p role="alert" className="rounded-lg border border-destructive/40 p-6">
              <strong className="block">Sumber log tidak tersedia.</strong>
              Daftar tidak bisa dimuat dari penyimpanan log, jadi ini bukan berarti tidak ada kejadian. Coba segarkan beberapa saat lagi.
            </p>
          )}
          {state.kind === "ok" && (
            <>
              <p className="text-sm text-muted-foreground" data-testid="freshness">
                Jendela {fmtTime(state.data.from)} – {fmtTime(state.data.to)}
                {" · "}
                {state.data.items[0] ? `Terakhir diamati ${fmtTime(state.data.items[0].time)}` : "Kesegaran tidak tersedia"}
              </p>
              {state.data.items.length === 0 ? (
                hasFilter ? (
                  <EmptyState title="Tidak ada kejadian yang cocok dengan filter pada rentang ini." data-testid="empty" action={<Link href="/admin/logs" className={buttonVariants({ variant: "outline", size: "sm" })}>Hapus filter</Link>}>
                    Sumber log tersedia; coba rentang waktu lebih panjang atau filter lain.
                  </EmptyState>
                ) : (
                  <EmptyState title="Tidak ada kejadian peringatan/error pada rentang ini." data-testid="empty">
                    Sumber log tersedia dan dibaca; sistem tenang pada rentang ini.
                  </EmptyState>
                )
              ) : (
                <Table stickyHeader>
                  <caption className="sr-only">Daftar kejadian log</caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Waktu</TableHead>
                      <TableHead className="hidden sm:table-cell">Level</TableHead>
                      <TableHead className="hidden md:table-cell">Modul</TableHead>
                      <TableHead>Pesan</TableHead>
                      <TableHead className="hidden lg:table-cell">Request ID</TableHead>
                      <TableHead numeric className="hidden md:table-cell">Toko</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {state.data.items.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="whitespace-normal text-xs text-muted-foreground">
                          <time dateTime={e.time.toISOString()}>{fmtTime(e.time)}</time>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell"><LevelBadge level={e.level} /></TableCell>
                        <TableCell className="hidden md:table-cell font-mono text-xs">{e.module}</TableCell>
                        <TableCell className="max-w-[11rem] whitespace-normal sm:max-w-xs lg:max-w-md">
                          {/* Narrow screens: severity rides with the summary so time + summary stay readable without scrolling (UX-9). */}
                          <span className="mb-1 block sm:hidden"><LevelBadge level={e.level} /></span>
                          <Link href={`/admin/logs/${e.id}?back=${back}`} className="font-medium underline-offset-4 hover:underline" aria-label={`Detail kejadian ${e.id}: ${e.message.slice(0, 60)}`}>
                            {e.message.length > 90 ? `${e.message.slice(0, 90)}…` : e.message}
                          </Link>
                          {e.code && <span className="ml-1 font-mono text-xs text-muted-foreground">{e.code}</span>}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell font-mono text-xs">{e.requestId ?? "—"}</TableCell>
                        <TableCell numeric className="hidden md:table-cell">{e.storeId ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {state.data.nextCursor && (
                <Link
                  href={`/admin/logs${qs({ cursor: state.data.nextCursor, from: state.data.from.toISOString(), to: state.data.to.toISOString() })}`}
                  className={buttonVariants({ variant: "outline" }) + " w-fit"}
                >
                  Muat lebih lama
                </Link>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
