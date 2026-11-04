import { CsrfField } from "@/lib/auth-csrf-form";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { BATCH_STATUS_LABEL, BATCH_STATUS_TONE } from "@/lib/finance";
import { rupiah, tanggal } from "@/lib/format";
import { codAwaitingReconciliation, manualCompletionCandidates, reconciliationBatches, shippingReconciliationByAccount } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../../access-denied";
import { applyManualCompleteAction, prepareBatchAction, requestManualCompleteAction } from "./actions";

export const metadata = { title: "Rekonsiliasi COD" };

const SAVED: Record<string, string> = { manual_requested: "Permintaan penyelesaian manual dikirim. Orang kedua memutuskan di Persetujuan.", manual_done: "Pesanan diselesaikan manual; penjualan COD dicatat sebagai dana dalam proses." };

export default async function CodReconciliationPage({ searchParams }: PageProps<"/admin/money/cod-reconciliation">) {
  const g = await consoleGate("/admin/money/cod-reconciliation");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { error, saved } = await searchParams;
  const canReconcile = g.caps.includes("payouts.reconcile");
  const canComplete = g.caps.includes("payouts.process");
  const [awaiting, batches, candidates, accounts] = await Promise.all([
    canReconcile ? allowed(codAwaitingReconciliation(g.op)) : undefined,
    canReconcile ? allowed(reconciliationBatches(g.op)) : undefined,
    canComplete ? allowed(manualCompletionCandidates(g.op)) : undefined,
    canReconcile ? allowed(shippingReconciliationByAccount(g.op)) : undefined,
  ]);
  return (
    <section className="grid gap-6">
      <PageHeader title="Rekonsiliasi COD" description="Uang COD baru menjadi Saldo Tersedia seller setelah paketnya diterima dan uangnya cocok dengan laporan kurir. Satu staf menyiapkan batch, staf lain menyetujui teks persisnya." />
      <Notice error={error} saved={typeof saved === "string" ? saved : undefined} savedText={typeof saved === "string" ? SAVED[saved] : undefined} />
      {!canReconcile ? (
        <AccessDenied capability="payouts.reconcile" />
      ) : (
        <>
          <section aria-labelledby="awaiting" className="grid gap-2" data-testid="cod-awaiting">
            <h2 id="awaiting" className="text-lg font-semibold">Terkirim, belum direkonsiliasi</h2>
            {!awaiting || awaiting.length === 0 ? (
              <EmptyState title="Tidak ada pesanan COD yang menunggu">Pesanan COD yang dilaporkan terkirim oleh kurir muncul di sini sampai masuk batch yang diterapkan.</EmptyState>
            ) : (
              <ul className="grid gap-2">
                {awaiting.map((a) => (
                  <li key={a.orderId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm" data-testid={`awaiting-${a.orderId}`}>
                    <span>Pesanan <span className="font-mono">#{a.orderId}</span> · {a.storeName} · terkirim {tanggal(new Date(a.deliveredAt))}</span>
                    <span className="tabular-nums">
                      {rupiah(a.payableIdr)} diharapkan · {a.inBatch ? <Link href={`/admin/money/cod-reconciliation/${a.inBatch}`} className="underline underline-offset-4">dalam batch #{a.inBatch}</Link> : "belum dalam batch"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="per-akun" className="grid gap-2" data-testid="cod-accounts">
            <h2 id="per-akun" className="text-lg font-semibold">Per akun pengiriman</h2>
            <p className="text-sm text-muted-foreground">Satu batch hanya memuat bukti satu akun pengiriman; uang akun lain tidak ikut direkonsiliasi.</p>
            {!accounts || accounts.length === 0 ? (
              <EmptyState title="Belum ada pesanan per akun">Akun yang sudah dipakai pesanan tampil di sini dengan jumlah COD yang menunggu.</EmptyState>
            ) : (
              <ul className="grid gap-1 text-sm">
                {accounts.map((a) => (
                  <li key={a.accountId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2" data-testid={`cod-account-${a.accountId}`}>
                    <span>Akun #{a.accountId} · {a.kind === "partner_managed" ? "mitra toko" : "induk"} · {a.storeName}</span>
                    <span className="tabular-nums">{a.awaitingOrders} menunggu ({rupiah(a.awaitingCodIdr)}) · {a.openBatches} batch terbuka · {a.appliedBatches} diterapkan</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="prepare" className="grid gap-3">
            <h2 id="prepare" className="text-lg font-semibold">Siapkan batch</h2>
            <form action={prepareBatchAction} className="grid gap-3 rounded-lg border p-4" aria-label="Siapkan batch rekonsiliasi">
        <CsrfField />
              <div className="grid gap-1.5">
                <Label htmlFor="evidenceRef">Referensi invoice atau laporan kurir</Label>
                <Input id="evidenceRef" name="evidenceRef" required minLength={3} maxLength={160} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lines">Baris bukti (satu per baris: id pesanan; referensi baris kurir; jumlah; tanggal YYYY-MM-DD)</Label>
                <Textarea id="lines" name="lines" rows={5} required placeholder="101; MGT-LINE-001; 125000; 2026-10-28" className="font-mono" />
              </div>
              <p className="text-xs text-muted-foreground">Jumlah yang diharapkan dibaca dari angka COD pesanan, bukan dari isian ini. Baris yang berbeda adalah selisih dan menahan pengajuan sampai diselesaikan atau dihapus.</p>
              <div><SubmitButton pendingText="Menyiapkan…">Siapkan batch</SubmitButton></div>
            </form>
          </section>

          <section aria-labelledby="batches" className="grid gap-2" data-testid="cod-batches">
            <h2 id="batches" className="text-lg font-semibold">Batch</h2>
            {!batches || batches.length === 0 ? (
              <EmptyState title="Belum ada batch">Batch yang Anda siapkan atau yang disiapkan staf lain tampil di sini.</EmptyState>
            ) : (
              <ul className="grid gap-2">
                {batches.map((b) => (
                  <li key={b.id} className="grid gap-1 rounded-lg border p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center" data-testid={`batch-${b.id}`}>
                    <div className="min-w-0 grid gap-0.5">
                      <Link href={`/admin/money/cod-reconciliation/${b.id}`} className="font-medium underline underline-offset-4">Batch #{b.id} · {b.evidenceRef}{b.shippingAccountId ? ` · akun #${b.shippingAccountId}` : ""}</Link>
                      <span className="text-muted-foreground">{b.itemCount} baris · disiapkan {b.preparedBy === g.userId ? "Anda" : b.preparedBy}{b.approvedBy ? ` · disetujui ${b.approvedBy}` : ""} · {tanggal(new Date(b.createdAt))}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      <span className="tabular-nums">{rupiah(b.evidenceTotalIdr)}</span>
                      <StatusBadge label={BATCH_STATUS_LABEL[b.status] ?? b.status} tone={BATCH_STATUS_TONE[b.status] ?? "secondary"} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {canComplete && (
        <section aria-labelledby="manual" className="grid gap-3" data-testid="manual-completion">
          <h2 id="manual" className="text-lg font-semibold">Penyelesaian manual (empat mata)</h2>
          <p className="text-sm text-muted-foreground">Pesanan dalam pengiriman yang diklaim seller telah diterima tetapi tidak dilaporkan DELIVERED oleh kurir. Hanya bisa diselesaikan dengan bukti kurir dan orang kedua; seller sendiri tidak pernah bisa menyelesaikan pesanan untuk kredit.</p>
          {!candidates || candidates.length === 0 ? (
            <EmptyState title="Tidak ada klaim penerimaan">Klaim seller muncul di sini; klaim itu hanya catatan, bukan kredit.</EmptyState>
          ) : (
            <ul className="grid gap-1 text-sm">{candidates.map((c) => <li key={c.orderId} className="rounded-lg border p-2">Pesanan <span className="font-mono">#{c.orderId}</span> · {c.storeName} · {c.method} · diklaim {tanggal(new Date(c.claimedAt))}</li>)}</ul>
          )}
          <form className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2" aria-label="Penyelesaian manual">
        <CsrfField />
            <div className="grid gap-1.5"><Label htmlFor="mc-order">ID pesanan</Label><Input id="mc-order" name="orderId" inputMode="numeric" required /></div>
            <div className="grid gap-1.5"><Label htmlFor="mc-ref">Referensi bukti kurir</Label><Input id="mc-ref" name="evidenceRef" required minLength={4} maxLength={160} /></div>
            <div className="grid gap-1.5"><Label htmlFor="mc-reason">Alasan</Label><Input id="mc-reason" name="reason" minLength={5} maxLength={500} /></div>
            <div className="grid gap-1.5"><Label htmlFor="mc-approval">ID persetujuan (untuk menerapkan)</Label><Input id="mc-approval" name="approvalId" inputMode="numeric" /></div>
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
              <SubmitButton formAction={requestManualCompleteAction} variant="outline" pendingText="Mengirim…">Minta persetujuan</SubmitButton>
              <SubmitButton formAction={applyManualCompleteAction} pendingText="Menerapkan…">Terapkan yang disetujui</SubmitButton>
            </div>
          </form>
        </section>
      )}
    </section>
  );
}
