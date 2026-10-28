import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { bpsPercent, invoiceKindLabel, invoiceStatusLabel, invoiceStatusTone, settlementLabel, voidReasonLabel } from "@/lib/billing";
import { sellerScope } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { can, defaultProviders, DomainError, getInvoice, invoiceAttempts, paymentView, subscriptionChannels } from "@bukalaris/db";
import { notFound } from "next/navigation";
import { Instruction, PayForm } from "../../_payment";

export const metadata = { title: "Tagihan — Bukalaris" };

export default async function InvoicePage({ params, searchParams }: PageProps<"/seller/billing/invoices/[id]">) {
  const scope = await sellerScope();
  const { id } = await params;
  const { error, saved, returned, status } = await searchParams;
  // The store is the scope's; another store's invoice id is invisible (row-level security) and filtered again in the query: not found, never "forbidden".
  const invoice = await getInvoice(scope.exec, scope.storeId, id);
  if (!invoice) notFound();
  const attempts = invoice.status === "pending" ? await invoiceAttempts(scope.exec, scope.storeId, invoice.id) : [];
  const attempt = attempts.find((a) => a.requestState !== "failed" && (a.status === "pending" || a.status === "unknown")) ?? null;
  const pay = can(scope, "billing.pay") && invoice.kind === "subscription" && invoice.status === "pending";
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
  const back = typeof status === "string" && ["pending", "paid", "void"].includes(status) ? `/seller/billing?status=${status}` : "/seller/billing";
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader
        title={<span className="break-all font-mono text-lg sm:text-xl">{invoice.number}</span>}
        badge={<StatusBadge label={invoiceStatusLabel[invoice.status]} tone={invoiceStatusTone[invoice.status]} data-testid="invoice-status" />}
        description={`${invoiceKindLabel[invoice.kind]} · periode ${invoice.periodStart} sampai ${invoice.periodEnd} (tanggal akhir tidak termasuk)`}
        back={{ href: back, label: "Kembali ke langganan" }}
      />
      <Notice error={error} saved={saved} />
      {returned && invoice.status === "pending" && (
        <p role="status" className="rounded-lg border px-3 py-2.5 text-sm" data-testid="billing-returned">Menunggu verifikasi pembayaran. Tagihan baru berubah menjadi lunas setelah Bukalaris memeriksanya ke penyedia pembayaran; kembali dari halaman bank belum berarti lunas.</p>
      )}

      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-lg border p-4 text-sm tabular-nums" data-testid="invoice-amounts">
        <dt>DPP (dasar pengenaan pajak)</dt>
        <dd data-testid="invoice-dpp">{rupiah(invoice.dppIdr)}</dd>
        <dt>PPN{invoice.ppnRateBps !== null ? ` (${bpsPercent(invoice.ppnRateBps)})` : ""}</dt>
        <dd data-testid="invoice-ppn">{invoice.ppnEnabled ? rupiah(invoice.ppnIdr) : "Rp0 — belum dipungut"}</dd>
        <dt className="font-medium">Total</dt>
        <dd className="font-medium" data-testid="invoice-total">{rupiah(invoice.totalIdr)}</dd>
      </dl>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Dibuat</dt>
        <dd>{tanggal(invoice.createdAt)}</dd>
        <dt className="text-muted-foreground">Jatuh tempo</dt>
        <dd>{tanggal(invoice.dueAt)}</dd>
        {invoice.paidAt && (
          <>
            <dt className="text-muted-foreground">{invoice.settlementSource === "provider" ? "Lunas" : "Dicatat"}</dt>
            <dd>{tanggal(invoice.paidAt)}</dd>
          </>
        )}
        {invoice.settlementSource && (
          <>
            <dt className="text-muted-foreground">Sumber</dt>
            <dd data-testid="invoice-source">{settlementLabel[invoice.settlementSource]}</dd>
          </>
        )}
        {invoice.status === "void" && (
          <>
            <dt className="text-muted-foreground">Dibatalkan</dt>
            <dd>{voidReasonLabel(invoice.voidReason)}</dd>
          </>
        )}
      </dl>

      {invoice.status === "pending" && invoice.kind === "subscription" && (
        <div className="grid gap-3">
          {attempt && <Instruction view={paymentView(attempt)} />}
          {!pay ? <p role="note" className="text-sm text-muted-foreground">Hanya pemilik toko yang dapat membayar.</p> : channelError ? <p role="alert" className="text-sm text-destructive">{channelError}</p> : <PayForm channels={channels} invoiceId={invoice.id} label={attempt ? "Buat instruksi baru" : "Bayar sekarang"} />}
        </div>
      )}
    </section>
  );
}
