import { CsrfField } from "@/lib/auth-csrf-form";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { payoutStatusLabel, payoutStatusTone, refundReasonLabel, refundStatusLabel, refundStatusTone } from "@/lib/finance";
import { rupiah, tanggal } from "@/lib/format";
import { transferDetail, type PlatformCapability, type TransferDetail } from "@bukalaris/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessDenied } from "../../../access-denied";
import { claimAction, completeAction, executeApprovalAction, executeRejectAction, rejectDirectAction, reopenRefundAction, requestApprovalAction, requestRejectAction, unknownAction } from "./actions";

export const metadata = { title: "Rincian pencairan" };

const SAVED: Record<string, string> = {
  requested: "Permintaan persetujuan dikirim. Orang kedua memutuskan di Persetujuan; Anda menjalankannya di sini setelah disetujui.",
  approved: "Disetujui untuk transfer. Klaim transfer ini sebelum mengirim uang.",
  claimed: "Klaim aktif 30 menit atas nama Anda. Lakukan transfer manual, lalu catat buktinya.",
  unknown: "Hasil transfer dicatat TIDAK DIKETAHUI. Dana tetap dialokasikan; jangan kirim ulang.",
  done: "Bukti transfer dicatat. Transfer selesai.",
  rejected: "Keputusan dijalankan. Untuk penarikan, dana seller dikembalikan tepat sebesar yang dipotong.",
  reject_requested: "Permintaan persetujuan penolakan dikirim. Orang kedua memutuskan di Persetujuan.",
  reopened: "Refund dibuka kembali sebagai permintaan baru. Pembeli mengisi rekening, lalu diajukan seperti biasa.",
};
const REJECT_ACTION = { payout: "payout.reject_processing", refund: "refund.fail" } as const;
const APPROVE_ACTION = { payout: "payout.approve_transfer", refund: "refund.approve_transfer" } as const;
const APPROVAL_STATUS_LABEL: Record<string, string> = {
  pending: "Menunggu orang kedua",
  approved: "Disetujui",
  executed: "Sudah dijalankan",
  rejected: "Ditolak",
  expired: "Kedaluwarsa",
  cancelled: "Dibatalkan",
};
export default async function TransferDetailPage({ params, searchParams }: PageProps<"/admin/payouts/[kind]/[id]">) {
  const g = await consoleGate("/admin/payouts/[kind]/[id]");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { kind: rawKind, id: rawId } = await params;
  const { error, saved } = await searchParams;
  if ((rawKind !== "payout" && rawKind !== "refund") || !/^[0-9]{1,15}$/.test(rawId)) notFound();
  const kind = rawKind;
  const id = Number(rawId);
  const needed: PlatformCapability = kind === "payout" ? "payouts.process" : "refunds.process";
  if (!g.caps.includes(needed)) return <AccessDenied capability={needed} />;
  // The whole page is one disclosure of bank values (the snapshot and the approval text that embeds it): the service records it as a `full` access event before it returns.
  let d: TransferDetail | null | undefined;
  try {
    d = await allowed(transferDetail(g.op, kind, id));
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "not_found") notFound();
    throw err;
  }
  if (!d) return <AccessDenied capability={needed} />;
  const mine = (key: string, status: string) => d.approvals.find((a) => a.actionKey === key && a.status === status && a.requestedBy === g.userId);
  const waitingApprove = d.approvals.find((a) => a.actionKey === APPROVE_ACTION[kind] && a.status === "pending");
  const readyApprove = mine(APPROVE_ACTION[kind], "approved");
  const waitingReject = d.approvals.find((a) => a.actionKey === REJECT_ACTION[kind] && a.status === "pending");
  const readyReject = mine(REJECT_ACTION[kind], "approved");
  const initial = kind === "payout" ? "requested" : "pending";
  const claimLive = d.claimedBy === g.userId && d.claimExpiresAt !== null && new Date(d.claimExpiresAt) > new Date();
  const iAmReporter = d.claimedBy === g.userId && d.transferUnknownAt !== null;
  const label = kind === "payout" ? payoutStatusLabel : refundStatusLabel;
  const tone = kind === "payout" ? payoutStatusTone : refundStatusTone;
  return (
    <section className="grid gap-6">
      <PageHeader
        back={{ href: `/admin/payouts?kind=${kind}`, label: "Antrean" }}
        title={`${kind === "payout" ? "Penarikan" : "Refund"} #${d.id}`}
        badge={<StatusBadge label={label[d.status] ?? d.status} tone={tone[d.status] ?? "secondary"} data-testid="transfer-status" />}
        description={<>Toko <Link href={`/admin/stores/${d.storeId}/ledger`} className="underline underline-offset-4">{d.storeName}</Link> · {rupiah(d.amountIdr)}{d.orderId ? <> · pesanan #{d.orderId}</> : null}</>}
      />
      <Notice error={error} saved={typeof saved === "string" ? saved : undefined} savedText={typeof saved === "string" ? SAVED[saved] : undefined} />
      <p className="rounded-lg border border-amber-600/40 bg-amber-500/5 px-3 py-2 text-sm">Rekening di bawah adalah data pribadi. Tampilan halaman ini tercatat sebagai akses penuh (kasus <span className="font-mono">{kind}:{d.id}</span>, berlaku 10 menit).</p>

      <dl className="grid gap-x-6 gap-y-1 rounded-lg border p-4 text-sm sm:grid-cols-[max-content_1fr]" data-testid="transfer-snapshot">
        <dt className="text-muted-foreground">Bank</dt><dd data-testid="snap-bank">{d.bank ?? "belum diisi"}</dd>
        <dt className="text-muted-foreground">Nomor rekening</dt><dd className="font-mono" data-testid="snap-account">{d.account ?? "belum diisi"}</dd>
        <dt className="text-muted-foreground">Nama pemilik</dt><dd data-testid="snap-holder">{d.holder ?? "belum diisi"}</dd>
        <dt className="text-muted-foreground">{kind === "payout" ? "Nama vs pemilik akun toko" : "Nama vs nama pembeli"}</dt>
        <dd data-testid="snap-check" className={d.holderCheck === "mismatch" ? "font-semibold text-destructive" : undefined}>{d.holderCheck === "match" ? "Cocok" : d.holderCheck === "mismatch" ? "BERBEDA: periksa sebelum menyetujui" : "Belum diperiksa"}</dd>
        {d.composition && (
          <>
            <dt className="text-muted-foreground">Komposisi refund</dt>
            <dd className="tabular-nums">Barang {rupiah(d.composition.goodsIdr)} + ongkir {rupiah(d.composition.shippingIdr)} + biaya admin {rupiah(d.composition.feeIdr)} · {d.reason ? refundReasonLabel[d.reason] ?? d.reason : null}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Dibuat</dt><dd>{tanggal(new Date(d.createdAt))}</dd>
        {d.claimedBy && (<><dt className="text-muted-foreground">Klaim</dt><dd className="font-mono break-all">{d.claimedBy === g.userId ? "Anda" : d.claimedBy} sampai {d.claimExpiresAt ? tanggal(new Date(d.claimExpiresAt)) : "-"}</dd></>)}
        {d.transferUnknownAt && (<><dt className="text-muted-foreground">Hasil transfer</dt><dd className="font-semibold text-destructive" data-testid="unknown-flag">TIDAK DIKETAHUI sejak {tanggal(new Date(d.transferUnknownAt))}: dana tetap dialokasikan, jangan kirim ulang.</dd></>)}
        {d.evidenceRef && (<><dt className="text-muted-foreground">Referensi bukti</dt><dd className="font-mono break-all" data-testid="evidence-ref">{d.evidenceRef}</dd></>)}
        {d.rejectionReason && (<><dt className="text-muted-foreground">Alasan keputusan</dt><dd className="break-words">{d.rejectionReason}</dd></>)}
      </dl>

      <section aria-labelledby="persetujuan" className="grid gap-3">
        <h2 id="persetujuan" className="text-base font-semibold">Persetujuan untuk transaksi ini</h2>
        {d.approvals.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada permintaan persetujuan.</p>
        ) : (
          <ul className="grid gap-3">
            {d.approvals.map((a) => (
              <li key={a.id} className="grid gap-2 rounded-lg border p-3 text-sm" data-testid={`approval-${a.id}`}>
                <p className="flex flex-wrap items-center gap-2"><span className="font-mono">{a.actionKey}</span> <StatusBadge label={APPROVAL_STATUS_LABEL[a.status] ?? a.status} tone={a.status === "approved" || a.status === "executed" ? "success" : a.status === "pending" ? "warning" : "secondary"} /> <span className="text-muted-foreground">oleh {a.requestedBy === g.userId ? "Anda" : a.requestedBy}{a.decidedBy ? `, diputuskan ${a.decidedBy === g.userId ? "Anda" : a.decidedBy}` : ""}</span></p>
                <p className="break-words text-muted-foreground">Alasan: {a.reason}</p>
                <pre data-testid="payload" className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{a.payloadCanonical}</pre>
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">SHA-256: <span className="font-mono" data-testid="payload-sha">{a.payloadSha256}</span></p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">Orang kedua memutuskan di <Link href="/admin/approvals" className="underline underline-offset-4">Persetujuan</Link> setelah membaca teks persis di atas; pemohon tidak bisa menyetujui permintaannya sendiri.</p>
      </section>

      <section aria-labelledby="tindakan" className="grid gap-4">
        <h2 id="tindakan" className="text-base font-semibold">Tindakan</h2>
        {d.status === initial && (
          <>
            {readyApprove ? (
              <form action={executeApprovalAction.bind(null, kind, id)} className="grid gap-2 rounded-lg border p-4" data-testid="execute-approval">
        <CsrfField />
                <p className="text-sm">Persetujuan orang kedua sudah ada. Jalankan: pindahkan ke <strong>sedang ditransfer</strong>.</p>
                <div><SubmitButton pendingText="Menjalankan…">Setujui untuk transfer</SubmitButton></div>
              </form>
            ) : waitingApprove ? (
              <p className="rounded-lg border p-4 text-sm text-muted-foreground" data-testid="waiting-approval">Menunggu persetujuan orang kedua di Persetujuan.</p>
            ) : (
              <form action={requestApprovalAction.bind(null, kind, id)} className="grid gap-2 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" data-testid="request-approval">
        <CsrfField />
                <div className="grid gap-1.5">
                  <Label htmlFor="approve-reason">Alasan permintaan persetujuan transfer</Label>
                  <Input id="approve-reason" name="reason" required minLength={5} maxLength={500} />
                </div>
                <SubmitButton pendingText="Mengirim…" disabled={kind === "refund" && !d.account}>Minta persetujuan transfer</SubmitButton>
                {kind === "refund" && !d.account && <p className="text-xs text-muted-foreground sm:col-span-2">Pembeli belum mengisi rekening tujuan di halaman status pesanan.</p>}
              </form>
            )}
            {kind === "payout" && (
              <form action={rejectDirectAction.bind(null, kind, id)} className="grid gap-2 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" data-testid="reject-direct">
        <CsrfField />
                <div className="grid gap-1.5">
                  <Label htmlFor="reject-reason">Tolak penarikan (alasan wajib; dana seller dikembalikan tepat)</Label>
                  <Input id="reject-reason" name="reason" required minLength={5} maxLength={500} />
                </div>
                <SubmitButton variant="outline" pendingText="Menolak…">Tolak penarikan</SubmitButton>
              </form>
            )}
          </>
        )}

        {d.status === "processing" && (
          <>
            {!claimLive && !d.transferUnknownAt && (
              <form action={claimAction.bind(null, kind, id)} className="grid gap-2 rounded-lg border p-4" data-testid="claim">
        <CsrfField />
                <p className="text-sm">Klaim eksklusif 30 menit (butuh verifikasi dua langkah di sesi ini dalam 5 menit terakhir) sebelum Anda mentransfer.</p>
                <div><SubmitButton pendingText="Mengklaim…">Klaim transfer ini</SubmitButton></div>
              </form>
            )}
            {(claimLive || iAmReporter) && (
              <form action={completeAction.bind(null, kind, id)} encType="multipart/form-data" className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2" data-testid="complete">
        <CsrfField />
                <div className="grid gap-1.5">
                  <Label htmlFor="evidenceRef">Referensi transfer bank</Label>
                  <Input id="evidenceRef" name="evidenceRef" required minLength={6} maxLength={120} autoComplete="off" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="receipt">Bukti transfer (PNG, JPEG, WebP, PDF, maks. 10 MB)</Label>
                  <Input id="receipt" name="receipt" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" required />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">Referensi dan berkas tidak boleh pernah dipakai pada transfer lain. Mencatat bukti tidak menulis baris di buku besar seller.</p>
                <div className="sm:col-span-2"><SubmitButton pendingText="Mencatat…">Catat transfer selesai</SubmitButton></div>
              </form>
            )}
            {claimLive && !d.transferUnknownAt && (
              <form action={unknownAction.bind(null, kind, id)} className="grid gap-2 rounded-lg border p-4" data-testid="unknown">
        <CsrfField />
                <p className="text-sm">Bank timeout atau layar ambigu? Catat hasil <strong>tidak diketahui</strong>. Dana tetap dialokasikan dan transfer ini tidak bisa diklaim lagi atau dikirim ulang.</p>
                <div><SubmitButton variant="outline" pendingText="Mencatat…">Hasil transfer tidak diketahui</SubmitButton></div>
              </form>
            )}
            {readyReject ? (
              <form action={executeRejectAction.bind(null, kind, id)} className="grid gap-2 rounded-lg border p-4" data-testid="execute-reject">
                <CsrfField />
                <input type="hidden" name="approvalId" value={readyReject.id} />
                <p className="text-sm">Orang kedua menyetujui pernyataan <em>tidak ada transfer yang terkirim</em>. Jalankan penolakan{kind === "payout" ? "; dana seller dikembalikan tepat sekali." : "."}</p>
                <div><SubmitButton variant="destructive" pendingText="Menjalankan…">Jalankan penolakan</SubmitButton></div>
              </form>
            ) : waitingReject ? (
              <p className="rounded-lg border p-4 text-sm text-muted-foreground">Penolakan menunggu persetujuan orang kedua di Persetujuan.</p>
            ) : (
              <form action={requestRejectAction.bind(null, kind, id)} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2" data-testid="request-reject">
        <CsrfField />
                <p className="text-sm sm:col-span-2">Menolak setelah disetujui berarti menyatakan bahwa <strong>tidak ada transfer yang terkirim</strong>. Itu butuh bukti bank dan persetujuan orang kedua.</p>
                <div className="grid gap-1.5"><Label htmlFor="rej-reason">Alasan</Label><Input id="rej-reason" name="reason" required minLength={5} maxLength={500} /></div>
                <div className="grid gap-1.5"><Label htmlFor="rej-ref">Referensi bukti bank (tidak ada transfer)</Label><Input id="rej-ref" name="noTransferEvidenceRef" required minLength={6} maxLength={120} autoComplete="off" /></div>
                <div className="sm:col-span-2"><SubmitButton variant="outline" pendingText="Mengirim…">Minta persetujuan penolakan</SubmitButton></div>
              </form>
            )}
          </>
        )}

        {kind === "refund" && d.status === "pending" && (
          readyReject ? (
            <form action={executeRejectAction.bind(null, kind, id)} className="grid gap-2 rounded-lg border p-4" data-testid="execute-reject">
              <CsrfField />
              <input type="hidden" name="approvalId" value={readyReject.id} />
              <p className="text-sm">Orang kedua menyetujui kegagalan refund ini. Dana pembeli tetap tercatat sebagai kewajiban (refund gagal) sampai dibuka kembali.</p>
              <div><SubmitButton variant="destructive" pendingText="Menjalankan…">Jalankan: refund gagal</SubmitButton></div>
            </form>
          ) : waitingReject ? (
            <p className="rounded-lg border p-4 text-sm text-muted-foreground">Kegagalan refund menunggu persetujuan orang kedua di Persetujuan.</p>
          ) : (
            <form action={requestRejectAction.bind(null, kind, id)} className="grid gap-2 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" data-testid="request-reject">
        <CsrfField />
              <div className="grid gap-1.5"><Label htmlFor="fail-reason">Nyatakan refund gagal (alasan; butuh orang kedua)</Label><Input id="fail-reason" name="reason" required minLength={5} maxLength={500} /></div>
              <SubmitButton variant="outline" pendingText="Mengirim…">Minta persetujuan gagal</SubmitButton>
            </form>
          )
        )}

        {kind === "refund" && d.status === "failed" && (
          <form action={reopenRefundAction.bind(null, id)} className="grid gap-2 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" data-testid="reopen">
        <CsrfField />
            <div className="grid gap-1.5"><Label htmlFor="reopen-reason">Buka kembali refund ini (pembeli tetap berhak atas dananya)</Label><Input id="reopen-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <SubmitButton pendingText="Membuka…">Buka kembali</SubmitButton>
          </form>
        )}
        {(d.status === "paid" || d.status === "completed" || d.status === "rejected") && <p className="text-sm text-muted-foreground">Keputusan ini final dan tidak bisa diubah.</p>}
      </section>
    </section>
  );
}
