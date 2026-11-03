import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { billingStateLabel, billingStateTone, invoiceKindLabel, invoiceStatusLabel, invoiceStatusTone } from "@/lib/billing";
import { sellerScope } from "@/lib/context";
import { rupiah, tanggal, tanggalIso, tanggalSaja } from "@/lib/format";
import { can, defaultProviders, DomainError, effectivePlan, invoiceAttempts, jakartaMidnight, listInvoices, paymentView, subscriptionChannels, type Invoice } from "@bukalaris/db";
import Link from "next/link";
import { Instruction, PayForm } from "./_payment";

export const metadata = { title: "Langganan — Bukalaris" };

const FILTERS = [["", "Semua"], ["pending", "Menunggu pembayaran"], ["paid", "Lunas"], ["void", "Dibatalkan"]] as const;

export default async function BillingPage({ searchParams }: PageProps<"/seller/billing">) {
  const { error, saved, status: rawStatus } = await searchParams;
  const scope = await sellerScope();
  const b = scope.billing;
  const now = new Date();
  const status = FILTERS.some(([v]) => v && v === rawStatus) ? (rawStatus as Invoice["status"]) : undefined;
  const [plan, all, filtered] = await Promise.all([effectivePlan(scope.exec, now), listInvoices(scope.exec, scope.storeId), listInvoices(scope.exec, scope.storeId, status ? { status } : {})]);
  const open = all.filter((i) => i.kind === "subscription" && i.status === "pending" && jakartaMidnight(i.periodEnd) > now).sort((x, y) => x.periodIndex - y.periodIndex)[0] ?? null;
  const attempt = open ? ((await invoiceAttempts(scope.exec, scope.storeId, open.id)).find((a) => a.requestState !== "failed" && (a.status === "pending" || a.status === "unknown")) ?? null) : null;
  const pay = can(scope, "billing.pay");
  let channels: { code: string }[] = [];
  let channelError: string | undefined;
  if (pay) {
    try {
      channels = await subscriptionChannels(defaultProviders().payment);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      channelError = err.message;
    }
  }
  const covered = b.currentPeriodEnd && b.currentPeriodEnd > now;
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader title="Langganan" description="Satu paket semua fitur untuk toko ini. Tagihan Bukalaris terpisah dari pesanan pembeli dan dari dana penjualan Anda." />
      <Notice error={error} saved={saved} />

      <div className="grid gap-2 rounded-lg border p-4" data-testid="billing-status">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Status langganan</h2>
          <StatusBadge label={billingStateLabel[b.state]} tone={billingStateTone[b.state]} data-testid="billing-state" />
        </div>
        <p className="text-sm" data-testid="billing-summary">
          {b.state === "trial" && <>Masa percobaan sampai <strong>{tanggal(b.trialEndsAt)}</strong>. Semua fitur Seller Admin aktif.</>}
          {b.state === "active" && <>Aktif sampai <strong>{tanggal(b.coveredUntil)}</strong>. Semua fitur Seller Admin aktif.</>}
          {b.state === "past_due" && <>Langganan belum dibayar sejak <strong>{tanggal(b.pastDueAt!)}</strong>. Seller Admin hanya bisa dibaca sampai pembayaran selesai; masa tenggang sampai <strong>{tanggal(b.graceEndsAt!)}</strong>.</>}
          {b.state === "suspended" && <>Masa tenggang berakhir <strong>{tanggal(b.graceEndsAt!)}</strong>. Seller Admin hanya bisa dibaca sampai pembayaran selesai.</>}
        </p>
        {!b.writable && <p className="text-sm text-muted-foreground" data-testid="billing-readonly-note">Toko Anda dan checkout pembeli tetap berjalan, dan semua data Anda tersimpan. Tagihan, pembayaran dan ekspor data pembeli tetap bisa dipakai.</p>}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Paket</dt>
          <dd>Semua fitur · {rupiah(plan.monthlyDppIdr)} per toko per bulan (DPP, di luar PPN)</dd>
          <dt className="text-muted-foreground">PPN</dt>
          <dd>{plan.ppnEnabled ? "Dipungut sesuai kebijakan pajak yang berlaku saat tagihan dibuat; rinciannya ada di setiap tagihan." : "Belum dipungut (Rp0)."}</dd>
          {covered && b.currentPeriodStart && (
            <>
              <dt className="text-muted-foreground">Periode terbayar</dt>
              <dd data-testid="billing-period">{tanggalSaja(b.currentPeriodStart)} sampai {tanggalSaja(b.currentPeriodEnd!)} (berikutnya mulai {tanggalSaja(b.currentPeriodEnd!)})</dd>
            </>
          )}
        </dl>
      </div>

      <div className="grid gap-3" data-testid="billing-pay">
        <h2 className="text-base font-semibold">Bayar</h2>
        {open ? (
          <>
            <p className="text-sm">
              Tagihan <Link href={`/seller/billing/invoices/${open.id}`} className="font-mono font-medium underline underline-offset-4">{open.number}</Link> · periode {tanggalIso(open.periodStart)} sampai {tanggalIso(open.periodEnd)} (WIB) · <strong className="tabular-nums">{rupiah(open.totalIdr)}</strong>
            </p>
            {attempt && <Instruction view={paymentView(attempt)} />}
            {!pay ? <p role="note" className="text-sm text-muted-foreground">Hanya pemilik toko yang dapat membayar.</p> : channelError ? <p role="alert" className="text-sm text-destructive">{channelError}</p> : <PayForm channels={channels} invoiceId={open.id} label={attempt ? "Buat instruksi baru" : "Bayar sekarang"} />}
          </>
        ) : covered && b.state === "active" ? (
          <p className="text-sm text-muted-foreground">Periode berjalan sudah lunas. Tagihan periode berikutnya muncul beberapa hari sebelum masa aktif berakhir.</p>
        ) : !pay ? (
          <p role="note" className="text-sm text-muted-foreground">Hanya pemilik toko yang dapat membuat tagihan dan membayar.</p>
        ) : channelError ? (
          <p role="alert" className="text-sm text-destructive">{channelError}</p>
        ) : (
          <PayForm channels={channels} label="Buat tagihan dan bayar" />
        )}
        <p className="text-xs text-muted-foreground">Pembayaran baru dianggap lunas setelah Bukalaris memverifikasinya ke penyedia pembayaran. Kembali dari halaman bank atau e-wallet belum berarti lunas.</p>
      </div>

      <div className="grid gap-3">
        <h2 className="text-base font-semibold">Riwayat tagihan</h2>
        <form method="get" action="/seller/billing" className="grid gap-2 sm:flex sm:flex-wrap sm:items-end">
          <div className="grid gap-1.5 sm:w-64">
            <Label htmlFor="status">Status</Label>
            <NativeSelect id="status" name="status" defaultValue={status ?? ""}>
              {FILTERS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" variant="outline">Terapkan</Button>
        </form>
        {all.length === 0 ? (
          <EmptyState title="Belum ada tagihan">Tagihan pertama dibuat menjelang akhir masa percobaan, atau saat Anda menekan Bayar.</EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState title="Tidak ada tagihan dengan status ini" action={<Link href="/seller/billing" className={buttonVariants({ variant: "outline", size: "sm" })}>Tampilkan semua</Link>}>Ada {all.length} tagihan lain; ubah filter untuk melihatnya.</EmptyState>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="Daftar tagihan" data-testid="billing-invoices">
            {filtered.map((i) => (
              <li key={i.id} className="grid gap-1 p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0 grid gap-0.5">
                  <Link href={`/seller/billing/invoices/${i.id}${status ? `?status=${status}` : ""}`} className="break-all font-mono font-medium underline underline-offset-4">{i.number}</Link>
                  <span className="text-muted-foreground">{invoiceKindLabel[i.kind]} · periode {tanggalIso(i.periodStart)} sampai {tanggalIso(i.periodEnd)} (WIB)</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <span className="font-medium tabular-nums">{rupiah(i.totalIdr)}</span>
                  <StatusBadge label={invoiceStatusLabel[i.status]} tone={invoiceStatusTone[i.status]} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">Ekspor CSV tagihan belum tersedia.</p>
      </div>
    </section>
  );
}
