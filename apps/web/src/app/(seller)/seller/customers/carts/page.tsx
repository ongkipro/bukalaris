import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { allowed, sellerScope } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { can, getAbandonedCarts, REDACTED } from "@bukalaris/db";
import { openWhatsApp } from "./actions";

export const metadata = { title: "Keranjang tertinggal — Bukalaris" };

const percent = (bps: number | null) => (bps === null ? "—" : `${(bps / 100).toLocaleString("id-ID", { minimumFractionDigits: 0, maximumFractionDigits: 1 })}%`);

// T-45 (SC-26, UX-15): who left checkout after typing contact details, ranked by phone presence and time-decayed value. Both roles read it (it is the
// contact the order screens already show); opening WhatsApp stamps the row, so it is a write and follows the subscription's read-only state.
export default async function AbandonedCartsPage({ searchParams }: PageProps<"/seller/customers/carts">) {
  const { error } = await searchParams;
  const scope = await sellerScope();
  const view = await allowed(getAbandonedCarts(scope));
  if (!view) return <p role="alert" className="rounded-lg border bg-background p-6">Akses ditolak.</p>;
  const canRecover = can(scope, "carts.recover") && scope.billing.writable;
  const { counts, rates } = view;

  return (
    <section className="grid max-w-4xl gap-6">
      <PageHeader title="Keranjang tertinggal" description="Pembeli yang sudah mengisi data di checkout tetapi belum memesan. Hubungi lewat WhatsApp dengan tautan untuk melanjutkan checkout." />
      <Notice error={error} />
      {!canRecover && <p role="note" className="rounded-lg border bg-muted/30 p-3 text-sm">{can(scope, "carts.recover") ? "Langganan belum aktif: daftar ini hanya bisa dibaca, tombol WhatsApp dinonaktifkan." : "Akun ini tidak dapat menghubungi pembeli."}</p>}

      <section aria-labelledby="ringkasan" className="grid gap-3">
        <h2 id="ringkasan" className="text-base font-semibold">{view.sinceDays} hari terakhir</h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border p-4" data-testid="abandon-rate">
            <dt className="text-sm text-muted-foreground">Tingkat ditinggalkan</dt>
            <dd className="text-2xl font-semibold tabular-nums">{percent(rates.abandonBps)}</dd>
            <dd className="text-xs text-muted-foreground">{counts.abandoned} ditinggalkan dari {counts.abandoned + counts.orders} (ditinggalkan + pesanan)</dd>
          </div>
          <div className="rounded-lg border p-4" data-testid="recovery-rate">
            <dt className="text-sm text-muted-foreground">Tingkat pulih</dt>
            <dd className="text-2xl font-semibold tabular-nums">{percent(rates.recoveryBps)}</dd>
            <dd className="text-xs text-muted-foreground">{counts.rescued} pesanan dibuat dari {counts.rescued + counts.abandoned} checkout yang sempat ditinggalkan</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">Checkout yang masih berjalan tidak dihitung. Pesanan biasa tanpa jeda tidak menaikkan tingkat pulih.</p>
      </section>

      <section aria-labelledby="antrean" className="grid gap-3">
        <h2 id="antrean" className="text-base font-semibold">Perlu dihubungi</h2>
        {view.queue.length === 0 ? (
          <EmptyState title="Belum ada keranjang tertinggal">Checkout yang tidak dilanjutkan selama 60 menit muncul di sini, lengkap dengan nomor HP yang diisi pembeli.</EmptyState>
        ) : (
          <ul className="divide-y rounded-lg border" data-testid="queue">
            {view.queue.map((c) => {
              const redacted = c.buyerName === REDACTED || c.buyerPhone === REDACTED;
              return (
                <li key={c.id} className="grid gap-2 p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" data-testid="queue-row">
                  <div className="grid min-w-0 gap-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <strong className="break-words">{redacted ? "Data dihapus" : (c.buyerName ?? "Tanpa nama")}</strong>
                      <span className="tabular-nums">{rupiah(c.subtotalIdr)}</span>
                      {c.waOpenedAt && <StatusBadge label={`WA dibuka ${tanggal(c.waOpenedAt)}`} tone="secondary" />}
                    </div>
                    <p className="break-all text-muted-foreground">
                      {c.hasPhone ? c.buyerPhone : redacted ? "Nomor dihapus atas permintaan pembeli" : (c.buyerEmail ?? "Belum mengisi nomor HP")}
                      {" · "}terakhir aktif {tanggal(c.lastActivityAt)}
                    </p>
                    {c.items.length > 0 && <p className="text-muted-foreground">{c.items.map((i) => `${i.title} · ${i.variant} × ${i.quantity}`).join("; ")}</p>}
                  </div>
                  <form action={openWhatsApp}>
                    <input type="hidden" name="id" value={c.id} />
                    <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={!c.hasPhone || !canRecover} title={c.hasPhone ? undefined : "Pembeli belum mengisi nomor HP yang valid"}>
                      {c.waOpenedAt ? "Hubungi lagi" : "Hubungi lewat WhatsApp"}
                    </Button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
        {view.truncated && <p className="text-xs text-muted-foreground">Menampilkan {view.queue.length} keranjang dengan prioritas tertinggi.</p>}
      </section>
    </section>
  );
}
