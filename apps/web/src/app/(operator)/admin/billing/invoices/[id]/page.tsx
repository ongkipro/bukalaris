import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { attemptStatusLabel, bpsPercent, channelName, invoiceKindLabel, invoiceStatusLabel, invoiceStatusTone, settlementLabel, voidReasonLabel } from "@/lib/billing";
import { consoleGate } from "@/lib/console-gate";
import { rupiah, tanggal } from "@/lib/format";
import { billingInvoiceDetail, DomainError, type InvoiceDetail } from "@bukalaris/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessDenied } from "../../../access-denied";
import { failUnknownAttemptAction, markPaidAction, requestMarkPaidAction, voidInvoiceAction } from "./actions";

export const metadata = { title: "Tagihan" };

export default async function AdminInvoicePage({ params, searchParams }: PageProps<"/admin/billing/invoices/[id]">) {
  const g = await consoleGate("/admin/billing/invoices/[id]");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { id } = await params;
  const { error, saved, requested } = await searchParams;
  let d: InvoiceDetail;
  try {
    d = await billingInvoiceDetail(g.op, id);
  } catch (err) {
    if (err instanceof DomainError && err.code === "not_found") notFound();
    throw err;
  }
  const { invoice: i } = d;
  const manage = g.caps.includes("billing.manage");
  return (
    <section className="grid max-w-4xl gap-6">
      <PageHeader
        title={<span className="break-all font-mono text-lg sm:text-xl">{i.number}</span>}
        badge={<StatusBadge label={invoiceStatusLabel[i.status]} tone={invoiceStatusTone[i.status]} />}
        description={`${d.store.name} · ${invoiceKindLabel[i.kind]} · periode ${i.periodStart} sampai ${i.periodEnd} (tanggal akhir tidak termasuk) · dibuat oleh ${i.source}`}
        back={{ href: "/admin/billing", label: "Kembali ke langganan" }}
      />
      <Notice error={error} saved={saved} />
      {typeof requested === "string" && <p role="note" className="rounded-lg border px-3 py-2.5 text-sm">Permintaan persetujuan #{requested} dikirim; setelah orang kedua menyetujuinya di <Link href="/admin/approvals" className="underline underline-offset-4">Persetujuan</Link>, jalankan di bawah.</p>}

      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-lg border p-4 text-sm tabular-nums" data-testid="admin-invoice-amounts">
        <dt>DPP</dt><dd>{rupiah(i.dppIdr)}</dd>
        <dt>PPN{i.ppnRateBps !== null ? ` (${bpsPercent(i.ppnRateBps)}, kebijakan pajak #${i.taxPolicyVersionId})` : ""}</dt><dd>{i.ppnEnabled ? rupiah(i.ppnIdr) : "Rp0 (PPN mati saat tagihan dibuat)"}</dd>
        <dt className="font-medium">Total</dt><dd className="font-medium">{rupiah(i.totalIdr)}</dd>
      </dl>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Dibuat</dt><dd>{tanggal(i.createdAt)} oleh {i.createdBy}</dd>
        {i.settlementSource && (<><dt className="text-muted-foreground">Pelunasan</dt><dd data-testid="admin-invoice-source">{settlementLabel[i.settlementSource]}{i.settlementRef ? ` · ${i.settlementRef}` : ""}</dd></>)}
        <dt className="text-muted-foreground">Masa aktif</dt>
        <dd data-testid="admin-invoice-coverage">{i.coverageAppliedAt ? `Diberikan ${tanggal(i.coverageAppliedAt)}` : i.settlementSource === "bookkeeping" ? "Tidak ada: pencatatan manual tidak memberi masa aktif" : "Belum diberikan"}</dd>
        {i.status === "void" && (<><dt className="text-muted-foreground">Dibatalkan</dt><dd>{voidReasonLabel(i.voidReason)}</dd></>)}
      </dl>

      <section aria-labelledby="percobaan" className="grid gap-2">
        <h2 id="percobaan" className="text-lg font-semibold">Percobaan pembayaran</h2>
        {d.attempts.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada percobaan pembayaran.</p> : (
          <ul className="grid gap-2">
            {d.attempts.map((a) => (
              <li key={a.id} className="grid gap-1 rounded-lg border p-3 text-sm" data-testid="admin-attempt">
                <span className="break-all font-mono">{a.localReference}</span>
                <span>{channelName(a.channelCode)} · {rupiah(a.totalIdr)} · {attemptStatusLabel(a)} · berlaku sampai {tanggal(a.expiresAt)}</span>
                {manage && a.requestState === "unknown" && a.status !== "paid" && (
                  <form action={failUnknownAttemptAction.bind(null, i.id, i.storeId, a.id)} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <div className="grid gap-1.5"><Label htmlFor={`fu-${a.id}`}>Alasan (setelah memeriksa catatan penyedia: tidak ada tagihan)</Label><Input id={`fu-${a.id}`} name="reason" required minLength={5} maxLength={500} /></div>
                    <ConfirmSubmit message="Keluarkan percobaan ini dari yang aktif? Lakukan hanya setelah memastikan penyedia tidak membuat tagihan." variant="outline">Tandai gagal</ConfirmSubmit>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {manage && i.kind === "subscription" && i.status === "pending" && (
        <section aria-labelledby="aksi" className="grid gap-3">
          <h2 id="aksi" className="text-lg font-semibold">Tindakan</h2>
          <form action={voidInvoiceAction.bind(null, i.id, i.storeId)} className="grid gap-2 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" aria-label="Batalkan tagihan">
            <div className="grid gap-1.5"><Label htmlFor="void-reason">Batalkan tagihan (agar bisa diterbitkan ulang untuk periode yang sama)</Label><Input id="void-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <ConfirmSubmit message="Batalkan tagihan ini?" variant="outline">Batalkan</ConfirmSubmit>
          </form>
          <div className="grid gap-3 rounded-lg border p-4">
            <h3 className="font-medium">Tandai sudah dibayar (pencatatan saja)</h3>
            <p className="text-sm text-muted-foreground">Mencatat siapa, kenapa dan bukti. Tidak menambah masa aktif dan bukan comp; masa aktif hanya datang dari pembayaran terverifikasi atau comp. Butuh persetujuan orang kedua.</p>
            <form action={requestMarkPaidAction.bind(null, i.id, i.storeId)} className="grid gap-3 md:grid-cols-2" aria-label="Ajukan pencatatan lunas">
              <div className="grid gap-1.5"><Label htmlFor="mp-evidence">Bukti (rujukan transfer)</Label><Input id="mp-evidence" name="evidence" required minLength={5} maxLength={200} /></div>
              <div className="grid gap-1.5"><Label htmlFor="mp-reason">Alasan</Label><Input id="mp-reason" name="reason" required minLength={5} maxLength={500} /></div>
              <div className="md:col-span-2"><SubmitButton>Ajukan pencatatan</SubmitButton></div>
            </form>
            <form action={markPaidAction.bind(null, i.id, i.storeId)} className="grid gap-3 md:grid-cols-3" aria-label="Jalankan pencatatan lunas yang disetujui">
              <div className="grid gap-1.5"><Label htmlFor="mpx-approval">Nomor persetujuan</Label><Input id="mpx-approval" name="approvalId" type="number" min={1} required /></div>
              <div className="grid gap-1.5"><Label htmlFor="mpx-evidence">Bukti (sama dengan yang diajukan)</Label><Input id="mpx-evidence" name="evidence" required minLength={5} maxLength={200} /></div>
              <div className="grid gap-1.5"><Label htmlFor="mpx-reason">Alasan</Label><Input id="mpx-reason" name="reason" required minLength={5} maxLength={500} /></div>
              <div className="md:col-span-3"><ConfirmSubmit message="Catat tagihan ini sebagai lunas? Ini hanya pencatatan dan tidak memberi masa aktif." variant="outline">Jalankan pencatatan</ConfirmSubmit></div>
            </form>
          </div>
        </section>
      )}

      <section aria-labelledby="riwayat" className="grid gap-2">
        <h2 id="riwayat" className="text-lg font-semibold">Riwayat</h2>
        <ol className="divide-y rounded-lg border text-sm">
          {d.events.map((e) => (
            <li key={e.id} className="grid gap-0.5 p-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
              <time dateTime={e.createdAt.toISOString()} className="text-muted-foreground">{tanggal(e.createdAt)}</time>
              <span className="break-all"><code>{e.kind}</code> · {e.actor}</span>
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}
