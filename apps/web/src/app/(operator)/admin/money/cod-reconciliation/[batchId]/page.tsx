import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { consoleGate } from "@/lib/console-gate";
import { BATCH_STATUS_LABEL, BATCH_STATUS_TONE } from "@/lib/finance";
import { rupiah, tanggal } from "@/lib/format";
import { reconciliationBatchDetail } from "@bukalaris/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessDenied } from "../../../access-denied";
import { applyBatchAction, submitBatchAction, voidBatchAction, voidItemAction, voidStaleBatchAction } from "./actions";

export const metadata = { title: "Batch rekonsiliasi COD" };

const SAVED: Record<string, string> = {
  prepared: "Batch disiapkan sebagai draf. Selesaikan selisih (jika ada), lalu ajukan.",
  submitted: "Batch diajukan. Orang kedua memutuskan di Persetujuan; Anda menerapkannya di sini setelah disetujui.",
  stale_voided: "Batch lama dibatalkan dan baris-barisnya dibebaskan. Siapkan ulang batch dari bukti yang sama.",
  applied: "Batch diterapkan. Pesanan di dalamnya dilepas ke Saldo Tersedia seller oleh pekerjaan pelepasan berikutnya.",
  item_voided: "Baris dihapus dari batch draf; pesanannya tetap belum direkonsiliasi.",
  voided: "Batch dibatalkan.",
};

export default async function BatchPage({ params, searchParams }: PageProps<"/admin/money/cod-reconciliation/[batchId]">) {
  const g = await consoleGate("/admin/money/cod-reconciliation/[batchId]");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { batchId: raw } = await params;
  const { error, saved } = await searchParams;
  if (!/^[0-9]{1,15}$/.test(raw)) notFound();
  const id = Number(raw);
  const d = await reconciliationBatchDetail(g.op, id);
  if (!d) notFound();
  const { batch, items, stale } = d;
  const live = items.filter((i) => !i.voided);
  const breaks = live.filter((i) => i.brk);
  const mine = batch.preparedBy === g.userId;
  return (
    <section className="grid gap-6">
      <PageHeader
        back={{ href: "/admin/money/cod-reconciliation", label: "Rekonsiliasi COD" }}
        title={`Batch #${batch.id}`}
        badge={<StatusBadge label={BATCH_STATUS_LABEL[batch.status] ?? batch.status} tone={BATCH_STATUS_TONE[batch.status] ?? "secondary"} data-testid="batch-status" />}
        description={<>Referensi <span className="font-mono">{batch.evidenceRef}</span> · disiapkan {mine ? "Anda" : batch.preparedBy} · {tanggal(new Date(batch.createdAt))}{batch.approvedBy ? <> · disetujui {batch.approvedBy}</> : null}</>}
      />
      <Notice error={error} saved={typeof saved === "string" ? saved : undefined} savedText={typeof saved === "string" ? SAVED[saved] : undefined} />
      {breaks.length > 0 && batch.status === "draft" && <p role="note" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm" data-testid="batch-breaks"><strong>{breaks.length} selisih:</strong> jumlah di laporan kurir berbeda dari angka COD pesanan. Hapus barisnya dari batch atau perbaiki bukti sebelum mengajukan; selisih tidak pernah dilepas otomatis.</p>}

      <ul className="grid gap-2" aria-label="Baris batch" data-testid="batch-items">
        {items.map((i) => (
          <li key={i.id} className={`grid gap-1 rounded-lg border p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center ${i.voided ? "opacity-60" : ""} ${i.brk && !i.voided ? "border-destructive/50" : ""}`} data-testid={`item-${i.orderId}`}>
            <div className="min-w-0 grid gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <span>Pesanan <span className="font-mono">#{i.orderId}</span> · toko {i.storeId} · baris kurir <span className="font-mono">{i.evidenceLineRef}</span> · {i.evidenceDate}</span>
                {i.brk && !i.voided && <StatusBadge label="Selisih nominal" tone="destructive" />}
              </span>
              <span className="tabular-nums text-muted-foreground">Diharapkan (COD pesanan) {rupiah(i.codAmountIdr)} · bukti {rupiah(i.evidenceAmountIdr)}{i.brk && !i.voided ? " · SELISIH" : ""}{i.voided ? " · dihapus" : ""}{i.reconciledAt ? " · direkonsiliasi" : ""}</span>
            </div>
            {batch.status === "draft" && mine && !i.voided && (
              <form action={voidItemAction.bind(null, id, i.id)}><SubmitButton variant="outline" pendingText="Menghapus…">Hapus baris</SubmitButton></form>
            )}
          </li>
        ))}
      </ul>
      <p className="text-sm tabular-nums" data-testid="batch-total">Total bukti baris aktif: <strong>{rupiah(live.reduce((s, i) => s + i.evidenceAmountIdr, 0))}</strong> · {live.length} baris</p>

      {batch.status === "draft" && mine && (
        <form action={submitBatchAction.bind(null, id)} className="grid gap-2 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" data-testid="submit-batch">
          <div className="grid gap-1.5"><Label htmlFor="submit-reason">Alasan pengajuan</Label><Input id="submit-reason" name="reason" required minLength={5} maxLength={500} /></div>
          <SubmitButton pendingText="Mengajukan…" disabled={breaks.length > 0 || live.length === 0}>Ajukan untuk persetujuan</SubmitButton>
        </form>
      )}
      {batch.status === "pending_approval" && (
        <div className="grid gap-2 rounded-lg border p-4" data-testid="pending-batch">
          <p className="text-sm">Menunggu persetujuan orang kedua di <Link href="/admin/approvals" className="underline underline-offset-4">Persetujuan</Link> (permintaan #{batch.approvalRequestId}). Penyiap batch tidak bisa menyetujui batchnya sendiri.</p>
          {mine && (
            <form action={applyBatchAction.bind(null, id)}><SubmitButton pendingText="Menerapkan…">Terapkan batch yang disetujui</SubmitButton></form>
          )}
        </div>
      )}
      {stale && (
        <form action={voidStaleBatchAction.bind(null, id)} className="grid gap-2 rounded-lg border border-destructive/40 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" data-testid="void-stale-batch">
          <p className="text-sm sm:col-span-2">
            Batch ini dibuat sebelum akun pengiriman dicatat per batch dan tidak bisa diterapkan lagi ({stale === "no_account" ? "tanpa akun pengiriman" : "isinya tidak cocok lagi dengan persetujuan"}). Siapa pun pemegang izin rekonsiliasi dapat membatalkannya tanpa persetujuan orang kedua (tidak ada uang yang bergerak); lalu siapkan ulang dari bukti yang sama.
          </p>
          <div className="grid gap-1.5"><Label htmlFor="stale-reason">Alasan pembatalan</Label><Input id="stale-reason" name="reason" required minLength={5} maxLength={300} /></div>
          <SubmitButton variant="outline" pendingText="Membatalkan…">Batalkan batch lama</SubmitButton>
        </form>
      )}
      {(batch.status === "draft" || batch.status === "pending_approval") && mine && (
        <form action={voidBatchAction.bind(null, id)} className="grid gap-2 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="grid gap-1.5"><Label htmlFor="void-reason">Batalkan batch (alasan)</Label><Input id="void-reason" name="reason" required minLength={5} maxLength={500} /></div>
          <SubmitButton variant="outline" pendingText="Membatalkan…">Batalkan batch</SubmitButton>
        </form>
      )}
    </section>
  );
}
