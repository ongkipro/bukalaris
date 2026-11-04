import { CsrfField } from "@/lib/auth-csrf-form";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { BANKS, ledgerStatusLabel, ledgerStatusTone, payoutStatusLabel, payoutStatusTone, refundReasonLabel, refundStatusLabel, refundStatusTone, releaseBasisLabel } from "@/lib/finance";
import { sellerScope } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { can, ledgerStatement, SELLER_KIND_LABEL, sellerFinance } from "@bukalaris/db";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { requestPayoutAction, setDestinationAction } from "./actions";

export const metadata = { title: "Keuangan — Bukalaris" };

const SAVED: Record<string, string> = {
  destination: "Rekening tujuan baru tersimpan dan ditahan sebelum bisa dipakai. Pemilik rekening sebelumnya sudah diberi tahu.",
  payout: "Permintaan penarikan tersimpan. Dana langsung dipisahkan dari Saldo Tersedia dan menunggu persetujuan tim Bukalaris.",
  replayed: "Permintaan penarikan yang sama sudah tercatat; tidak ada pemotongan kedua.",
};

export default async function FinancePage({ searchParams }: PageProps<"/seller/finance">) {
  const scope = await sellerScope();
  const { error, saved, cursor: rawCursor } = await searchParams;
  if (!can(scope, "finance.read"))
    return (
      <section className="grid max-w-3xl gap-6">
        <PageHeader title="Keuangan" />
        <p role="note" data-testid="finance-denied" className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">Hanya pemilik toko yang dapat melihat saldo, mutasi dan penarikan dana. Staf toko tidak melihat data keuangan.</p>
      </section>
    );
  const cursor = typeof rawCursor === "string" && /^[0-9]{1,15}$/.test(rawCursor) ? Number(rawCursor) : undefined;
  const [fin, stmt] = await Promise.all([sellerFinance(scope), ledgerStatement(scope, { ...(cursor ? { cursor } : {}) })]);
  const owner = can(scope, "finance.payout");
  // A held destination whose hold elapsed is usable: the payout request promotes it inside its own locked transaction.
  const held = fin.destinations.find((d) => d.status === "held" && d.held);
  const active = fin.destinations.find((d) => d.status === "active") ?? fin.destinations.find((d) => d.status === "held" && !d.held);
  const requestKey = randomUUID();
  const savedKey = typeof saved === "string" ? saved : undefined;
  return (
    <section className="grid max-w-4xl gap-6">
      <PageHeader title="Keuangan" description="Satu saldo Bukalaris untuk toko ini. Dana penjualan baru tersedia setelah paket diterima pembeli dan, untuk COD, uangnya direkonsiliasi." />
      <Notice error={error} saved={savedKey} savedText={savedKey ? SAVED[savedKey] : undefined} />
      {fin.payoutsFrozen && (
        <p role="note" data-testid="payouts-frozen" className="rounded-lg border border-amber-600/40 bg-amber-500/5 px-3 py-2.5 text-sm">
          <strong>Penarikan dana dibekukan sementara</strong> karena pemulihan data. Saldo Anda aman; permintaan baru dan transfer berjalan lagi setelah tim Bukalaris mencabut pembekuan.
        </p>
      )}

      <dl className="grid gap-3 sm:grid-cols-3" data-testid="finance-balances">
        <div className="grid content-start gap-1 rounded-lg border p-4">
          <dt className="text-sm text-muted-foreground">Saldo Tersedia</dt>
          <dd className="text-2xl font-semibold tracking-tight tabular-nums" data-testid="balance-available">{rupiah(fin.balance.availableIdr)}</dd>
          <dd className="text-xs text-muted-foreground">Boleh ditarik ke rekening aktif.</dd>
        </div>
        <div className="grid content-start gap-1 rounded-lg border p-4">
          <dt className="text-sm text-muted-foreground">Dana dalam Proses</dt>
          <dd className="text-2xl font-semibold tracking-tight tabular-nums" data-testid="balance-pending">{rupiah(fin.balance.pendingIdr)}</dd>
          <dd className="text-xs text-muted-foreground">Terjual, belum diterima pembeli atau belum direkonsiliasi.</dd>
        </div>
        <div className="grid content-start gap-1 rounded-lg border p-4">
          <dt className="text-sm text-muted-foreground">Penarikan diproses</dt>
          <dd className="text-2xl font-semibold tracking-tight tabular-nums" data-testid="balance-processing">{rupiah(fin.processingIdr)}</dd>
          <dd className="text-xs text-muted-foreground">Sudah diminta, menunggu persetujuan dan transfer.</dd>
        </div>
      </dl>

      <section aria-labelledby="rekening" className="grid gap-3" data-testid="finance-destination">
        <h2 id="rekening" className="text-base font-semibold">Rekening tujuan</h2>
        {fin.destinations.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada rekening tujuan. Rekening baru ditahan {fin.holdHours} jam sebelum bisa dipakai menarik dana.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {fin.destinations.map((d) => (
              <li key={d.id} className="grid gap-1 p-3 text-sm" data-testid={`destination-${d.status}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.bankCode} ••••{d.last4}</span>
                  <span className="text-muted-foreground">a.n. {d.holder}</span>
                  {d.status === "held" && d.held ? <StatusBadge label="Tujuan baru ditahan" tone="warning" data-testid="destination-held-badge" /> : <StatusBadge label="Aktif" tone="success" />}
                  {d.check === "mismatch" && <StatusBadge label="Nama berbeda dari nama pemilik akun" tone="destructive" />}
                </div>
                {d.status === "held" && d.held && d.holdUntil && <p className="text-muted-foreground" data-testid="hold-until">Ditahan sampai <time dateTime={d.holdUntil.toISOString()}>{tanggal(d.holdUntil)}</time>. Penarikan memakai rekening aktif sebelumnya (jika ada) sampai saat itu.</p>}
              </li>
            ))}
          </ul>
        )}
        {owner && (
          <form action={setDestinationAction} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2" aria-label="Ganti rekening tujuan">
        <CsrfField />
            <div className="grid gap-1.5">
              <Label htmlFor="bankCode">Bank</Label>
              <NativeSelect id="bankCode" name="bankCode" defaultValue="BCA">{BANKS.map((b) => <option key={b} value={b}>{b}</option>)}</NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="accountNumber">Nomor rekening</Label>
              <Input id="accountNumber" name="accountNumber" inputMode="numeric" pattern="[0-9]{5,24}" required autoComplete="off" />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="accountHolderName">Nama pemilik rekening</Label>
              <Input id="accountHolderName" name="accountHolderName" required minLength={2} maxLength={120} autoComplete="off" aria-describedby="holder-help" />
              <p id="holder-help" className="text-xs text-muted-foreground">Dicocokkan dengan nama pemilik akun toko; perbedaan ditandai untuk pemeriksa.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dest-code">Kode verifikasi dua langkah (6 angka)</Label>
              <Input id="dest-code" name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" autoComplete="one-time-code" required aria-describedby="dest-help" />
            </div>
            <div className="flex items-end">
              <SubmitButton variant="outline" pendingText="Menyimpan…">{active || held ? "Ganti rekening" : "Simpan rekening"}</SubmitButton>
            </div>
            <p id="dest-help" className="text-xs text-muted-foreground sm:col-span-2">Rekening baru ditahan {fin.holdHours} jam sebelum bisa dipakai, pemilik sebelumnya diberi tahu lewat email, dan perubahan butuh kode verifikasi dua langkah.</p>
          </form>
        )}
      </section>

      <section aria-labelledby="tarik" className="grid gap-3" data-testid="finance-payout">
        <h2 id="tarik" className="text-base font-semibold">Tarik dana</h2>
        {!owner ? (
          <p role="note" className="text-sm text-muted-foreground">Hanya pemilik toko yang dapat meminta penarikan.</p>
        ) : !scope.billing.writable ? (
          <p role="note" className="text-sm text-muted-foreground">Penarikan dana dijeda selama langganan belum dibayar. <Link href="/seller/billing" className="underline underline-offset-4">Lihat tagihan</Link></p>
        ) : !active ? (
          <p role="note" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground" data-testid="no-active-destination">Belum ada rekening tujuan yang aktif{held ? " (rekening baru masih ditahan)" : ""}. Simpan rekening di atas; penarikan baru bisa diminta setelah masa tahan selesai.</p>
        ) : (
          <form action={requestPayoutAction} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" aria-label="Minta penarikan dana">
        <CsrfField />
            <input type="hidden" name="requestKey" value={requestKey} />
            <div className="grid gap-1.5">
              <Label htmlFor="amountIdr">Jumlah (Rp)</Label>
              <Input id="amountIdr" name="amountIdr" inputMode="numeric" pattern="[0-9.]+" required autoComplete="off" aria-describedby="amount-help" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="payout-code">Kode verifikasi dua langkah (6 angka)</Label>
              <Input id="payout-code" name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" autoComplete="one-time-code" required aria-describedby="amount-help" />
            </div>
            <SubmitButton pendingText="Meminta…" disabled={fin.payoutsFrozen}>Minta penarikan</SubmitButton>
            <p id="amount-help" className="text-xs text-muted-foreground sm:col-span-3">Minimal {rupiah(fin.minPayoutIdr)}; paling banyak Saldo Tersedia. Ditransfer ke {active.bankCode} ••••{active.last4}.</p>
          </form>
        )}
      </section>

      <section aria-labelledby="riwayat" className="grid gap-3" data-testid="finance-payouts">
        <h2 id="riwayat" className="text-base font-semibold">Riwayat penarikan</h2>
        {fin.payouts.length === 0 ? (
          <EmptyState title="Belum ada penarikan">Permintaan penarikan Anda dan statusnya muncul di sini.</EmptyState>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="Daftar penarikan">
            {fin.payouts.map((p) => (
              <li key={p.id} className="grid gap-1 p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center" data-testid={`payout-${p.id}`}>
                <div className="min-w-0 grid gap-0.5">
                  <span className="font-medium">Penarikan #{p.id} · {p.bankCode} ••••{p.last4} · <time dateTime={p.createdAt.toISOString()} className="font-normal text-muted-foreground">{tanggal(p.createdAt)}</time></span>
                  {p.rejectionReason && <span className="text-muted-foreground">Alasan penolakan: {p.rejectionReason}</span>}
                  {p.processedAt && <span className="text-muted-foreground">Diselesaikan <time dateTime={p.processedAt.toISOString()}>{tanggal(p.processedAt)}</time></span>}
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <span className="font-medium tabular-nums">{rupiah(p.amountIdr)}</span>
                  <StatusBadge label={payoutStatusLabel[p.status] ?? p.status} tone={payoutStatusTone[p.status] ?? "secondary"} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {fin.refunds.length > 0 && (
        <section aria-labelledby="refund" className="grid gap-3" data-testid="finance-refunds">
          <div className="grid gap-1">
            <h2 id="refund" className="text-base font-semibold">Refund pembeli</h2>
            <p className="text-xs text-muted-foreground">Refund dibayar dari dana Bukalaris kepada pembeli (penuh: barang, ongkir dan biaya admin); tidak memotong Saldo Anda.</p>
          </div>
          <ul className="divide-y rounded-lg border">
            {fin.refunds.map((r) => (
              <li key={r.id} className="grid gap-1 p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0 grid gap-0.5">
                  <span className="font-medium">Pesanan <Link href={`/seller/orders/${r.orderId}`} className="underline underline-offset-4">#{r.orderId}</Link> · {refundReasonLabel[r.reason] ?? r.reason}</span>
                  <span className="text-muted-foreground tabular-nums">Barang {rupiah(r.goodsRefundIdr)} + ongkir {rupiah(r.shippingRefundIdr)} + biaya admin {rupiah(r.feeRefundIdr)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <span className="font-medium tabular-nums">{rupiah(r.amountIdr)}</span>
                  <StatusBadge label={refundStatusLabel[r.status] ?? r.status} tone={refundStatusTone[r.status] ?? "secondary"} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="mutasi" className="grid gap-3" data-testid="finance-statement">
        <h2 id="mutasi" className="text-base font-semibold">Mutasi saldo</h2>
        {stmt.rows.length === 0 ? (
          <EmptyState title="Belum ada mutasi">Penjualan, potongan ongkir dan penarikan tercatat di sini, tidak pernah diubah atau dihapus.</EmptyState>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="Mutasi saldo">
            {stmt.rows.map((e) => (
              <li key={e.id} className="grid gap-1 p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center" data-testid={`entry-${e.kind}`}>
                <div className="min-w-0 grid gap-0.5">
                  <span className="font-medium">
                    {SELLER_KIND_LABEL[e.kind]}
                    {e.orderId && <> · pesanan <Link href={`/seller/orders/${e.orderId}`} className="underline underline-offset-4">#{e.orderId}</Link></>}
                    {e.payoutId && <> · penarikan #{e.payoutId}</>}
                  </span>
                  <span className="text-muted-foreground">
                    <time dateTime={e.createdAt.toISOString()}>{tanggal(e.createdAt)}</time>
                    {e.releaseBasis && e.releaseBasis !== "direct" && <> · {releaseBasisLabel[e.releaseBasis]}</>}
                    {e.note && <> · {e.note}</>}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <span className={`font-medium tabular-nums ${e.amountIdr < 0 ? "text-destructive" : ""}`}>{rupiah(e.amountIdr)}</span>
                  <StatusBadge label={ledgerStatusLabel[e.status] ?? e.status} tone={ledgerStatusTone[e.status] ?? "secondary"} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {stmt.next && (
          <div>
            <Link href={`/seller/finance?cursor=${stmt.next}`} className={buttonVariants({ variant: "outline", size: "sm" })} rel="next">
              Mutasi lebih lama
            </Link>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Setiap saldo dihitung dari mutasi ini saja. Koreksi manual tampil sebagai baris tersendiri dengan alasannya.</p>
      </section>
    </section>
  );
}
