import { CsrfField } from "@/lib/auth-csrf-form";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { consoleMoneyPosition, latePaymentObligations, unknownTransfers } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../access-denied";
import { applyAdjustmentAction, requestAdjustmentAction } from "./actions";

export const metadata = { title: "Ringkasan keuangan" };

// Liability classes of `platform_money_position` (DATA-7): a float owed to others is never shown as revenue.
const CLASS_LABEL: Record<string, [string, "owed" | "platform"]> = {
  seller_pending: ["Dana seller dalam proses", "owed"],
  seller_available: ["Saldo seller tersedia", "owed"],
  payouts_requested: ["Penarikan menunggu persetujuan", "owed"],
  payouts_processing: ["Penarikan sedang ditransfer", "owed"],
  refunds_open: ["Refund pembeli terbuka", "owed"],
  refunds_failed: ["Refund gagal (masih terutang ke pembeli)", "owed"],
  platform_shipping_margin: ["Margin ongkir platform", "platform"],
  platform_shipping_cashback: ["Cashback ongkir platform", "platform"],
  platform_cod_fee: ["Biaya COD platform", "platform"],
  platform_cod_fee_vat: ["PPN biaya COD", "platform"],
  platform_payment_fee_margin: ["Margin biaya pembayaran", "platform"],
};
const SAVED: Record<string, string> = { adjust_requested: "Permintaan penyesuaian dikirim. Orang kedua memutuskan di Persetujuan; Anda menerapkannya di sini.", adjust_applied: "Penyesuaian diterapkan sebagai baris buku besar." };

export default async function MoneyPage({ searchParams }: PageProps<"/admin/money">) {
  const g = await consoleGate("/admin/money");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { error, saved } = await searchParams;
  const [position, unknown, late] = await Promise.all([allowed(consoleMoneyPosition(g.op)), allowed(unknownTransfers(g.op)), allowed(latePaymentObligations(g.op))]);
  if (!position || !unknown || !late) return <AccessDenied capability="finance.read" />;
  const owed = position.filter((p) => (CLASS_LABEL[p.class]?.[1] ?? "owed") === "owed");
  const platform = position.filter((p) => CLASS_LABEL[p.class]?.[1] === "platform");
  const canAdjust = g.caps.includes("ledger.adjust");
  return (
    <section className="grid gap-6">
      <PageHeader title="Ringkasan keuangan" description="Posisi uang menurut kelas kewajiban, dihitung dari buku besar (bukan pembukuan kedua). Dana seller dan refund adalah kewajiban, bukan pendapatan." />
      <Notice error={error} saved={typeof saved === "string" ? saved : undefined} savedText={typeof saved === "string" ? SAVED[saved] : undefined} />
      <nav aria-label="Keuangan" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
        <Link href="/admin/payouts" className="font-medium underline underline-offset-4">Pencairan dan refund</Link>
        <Link href="/admin/money/cod-reconciliation" className="font-medium underline underline-offset-4">Rekonsiliasi COD</Link>
      </nav>

      <section aria-labelledby="owed" className="grid gap-2">
        <h2 id="owed" className="text-lg font-semibold">Kewajiban kepada seller dan pembeli</h2>
        <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="money-owed">
          {owed.map((p) => (
            <div key={p.class} className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">{CLASS_LABEL[p.class]?.[0] ?? p.class}</dt>
              <dd className="text-lg font-semibold tabular-nums" data-testid={`class-${p.class}`}>{rupiah(p.amountIdr)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="platform" className="grid gap-2">
        <h2 id="platform" className="text-lg font-semibold">Milik platform (margin dan biaya)</h2>
        <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {platform.map((p) => (
            <div key={p.class} className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">{CLASS_LABEL[p.class]?.[0] ?? p.class}</dt>
              <dd className="text-lg font-semibold tabular-nums">{rupiah(p.amountIdr)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">Saldo di penyedia pembayaran dan pengiriman belum dilaporkan sumbernya: usia datanya &quot;tidak diketahui&quot;.</p>
      </section>

      <section aria-labelledby="unknown" className="grid gap-2" data-testid="unknown-transfers">
        <h2 id="unknown" className="text-lg font-semibold">Transfer dengan hasil tidak diketahui</h2>
        {unknown.length === 0 ? (
          <EmptyState title="Tidak ada">Transfer yang hasilnya belum pasti muncul di sini sampai bukti bank menyelesaikannya. Tidak pernah dikirim ulang.</EmptyState>
        ) : (
          <ul className="grid gap-2">
            {unknown.map((u) => (
              <li key={`${u.kind}-${u.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <Link href={`/admin/payouts/${u.kind}/${u.id}`} className="underline underline-offset-4">{u.kind === "payout" ? "Penarikan" : "Refund"} #{u.id} · {u.storeName}</Link>
                <span className="tabular-nums">{rupiah(u.amountIdr)} · sejak {tanggal(new Date(u.unknownAt))}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="late" className="grid gap-2" data-testid="late-payments">
        <h2 id="late" className="text-lg font-semibold">Pembayaran terlambat (kewajiban refund)</h2>
        {late.length === 0 ? (
          <EmptyState title="Tidak ada">Pembayaran yang terverifikasi setelah pesanan dibatalkan atau dikembalikan muncul di sini dengan refund yang dibuka untuknya.</EmptyState>
        ) : (
          <ul className="grid gap-2">
            {late.map((l) => (
              <li key={l.attemptId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <span>{l.storeName} · pesanan #{l.orderId} · {tanggal(new Date(l.createdAt))}</span>
                <span className="tabular-nums">
                  {rupiah(l.amountIdr)} · {l.refundId ? <Link href={`/admin/payouts/refund/${l.refundId}`} className="underline underline-offset-4">refund #{l.refundId}</Link> : <strong className="text-destructive">BELUM ADA REFUND: periksa</strong>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canAdjust && (
        <section aria-labelledby="adjust" className="grid gap-3">
          <h2 id="adjust" className="text-lg font-semibold">Penyesuaian manual (empat mata)</h2>
          <p className="text-sm text-muted-foreground">Satu baris buku besar dengan referensi bisnis unik. Orang kedua menyetujui jumlah persis di Persetujuan; penyesuaian negatif ditolak bila membuat Saldo Tersedia negatif.</p>
          <form className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2" aria-label="Penyesuaian manual">
        <CsrfField />
            <div className="grid gap-1.5"><Label htmlFor="adj-store">ID toko</Label><Input id="adj-store" name="storeId" inputMode="numeric" required /></div>
            <div className="grid gap-1.5"><Label htmlFor="adj-amount">Jumlah (Rp, boleh negatif)</Label><Input id="adj-amount" name="amountIdr" inputMode="numeric" required /></div>
            <div className="grid gap-1.5"><Label htmlFor="adj-ref">Referensi bisnis (unik)</Label><Input id="adj-ref" name="businessRef" required minLength={4} maxLength={80} /></div>
            <div className="grid gap-1.5"><Label htmlFor="adj-reason">Alasan</Label><Input id="adj-reason" name="reason" required minLength={5} maxLength={500} /></div>
            <div className="grid gap-1.5"><Label htmlFor="adj-approval">ID persetujuan (untuk menerapkan)</Label><Input id="adj-approval" name="approvalId" inputMode="numeric" /></div>
            <div className="flex flex-wrap items-end gap-2">
              <SubmitButton formAction={requestAdjustmentAction} variant="outline" pendingText="Mengirim…">Minta persetujuan</SubmitButton>
              <SubmitButton formAction={applyAdjustmentAction} pendingText="Menerapkan…">Terapkan yang disetujui</SubmitButton>
            </div>
          </form>
        </section>
      )}
    </section>
  );
}
