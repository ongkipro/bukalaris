import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { ledgerStatusLabel, ledgerStatusTone, releaseBasisLabel } from "@/lib/finance";
import { rupiah, tanggal } from "@/lib/format";
import { SELLER_KIND_LABEL, storeLedger } from "@bukalaris/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessDenied } from "../../../access-denied";

export const metadata = { title: "Buku besar toko" };

export default async function StoreLedgerPage({ params, searchParams }: PageProps<"/admin/stores/[id]/ledger">) {
  const g = await consoleGate("/admin/stores/[id]/ledger");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { id } = await params;
  const { cursor: rawCursor } = await searchParams;
  const storeId = /^[0-9]{1,15}$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(storeId)) notFound();
  const cursor = typeof rawCursor === "string" && /^[0-9]{1,15}$/.test(rawCursor) ? Number(rawCursor) : undefined;
  const v = await allowed(storeLedger(g.op, storeId, { ...(cursor ? { cursor } : {}) }));
  if (v === undefined) return <AccessDenied capability="finance.read" />;
  if (!v) notFound();
  return (
    <section className="grid gap-6">
      <PageHeader back={{ href: `/admin/stores/${v.store.id}`, label: v.store.name }} title={`Buku besar · ${v.store.name}`} description="Mutasi tidak pernah diubah atau dihapus, dan halaman ini tidak punya kontrol tulis. Penyesuaian dibuat di Ringkasan keuangan dengan persetujuan orang kedua." />
      <dl className="grid gap-3 sm:grid-cols-2" data-testid="store-balances">
        <div className="rounded-lg border p-4"><dt className="text-xs text-muted-foreground">Saldo Tersedia</dt><dd className="text-xl font-semibold tabular-nums" data-testid="ledger-available">{rupiah(v.balance.availableIdr)}</dd></div>
        <div className="rounded-lg border p-4"><dt className="text-xs text-muted-foreground">Dana dalam Proses</dt><dd className="text-xl font-semibold tabular-nums" data-testid="ledger-pending">{rupiah(v.balance.pendingIdr)}</dd></div>
      </dl>
      {v.rows.length === 0 ? (
        <EmptyState title="Belum ada mutasi">Penjualan, potongan ongkir, penarikan dan penyesuaian toko ini tercatat di sini.</EmptyState>
      ) : (
        <ul className="grid gap-2" aria-label="Mutasi buku besar" data-testid="store-ledger">
          {v.rows.map((e) => (
            <li key={e.id} className="grid gap-1 rounded-lg border p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center" data-testid={`entry-${e.kind}`}>
              <div className="min-w-0 grid gap-0.5">
                <span>#{e.id} · {SELLER_KIND_LABEL[e.kind]}{e.orderId ? <> · pesanan #{e.orderId}</> : null}{e.payoutId ? <> · <Link href={`/admin/payouts/payout/${e.payoutId}`} className="underline underline-offset-4">penarikan #{e.payoutId}</Link></> : null}</span>
                <span className="text-muted-foreground"><time dateTime={e.createdAt.toISOString()}>{tanggal(e.createdAt)}</time>{e.releaseBasis ? <> · {releaseBasisLabel[e.releaseBasis]}</> : null}{e.note ? <> · {e.note}</> : null}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <span className={`tabular-nums ${e.amountIdr < 0 ? "text-destructive" : ""}`}>{rupiah(e.amountIdr)}</span>
                <StatusBadge label={ledgerStatusLabel[e.status] ?? e.status} tone={ledgerStatusTone[e.status] ?? "secondary"} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {v.next && <Link href={`/admin/stores/${v.store.id}/ledger?cursor=${v.next}`} className="text-sm underline underline-offset-4">Mutasi lebih lama</Link>}
    </section>
  );
}
