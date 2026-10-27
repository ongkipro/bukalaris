import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { seller } from "@/lib/context";
import { rupiah, tanggalSaja } from "@/lib/format";
import { PERIODS, sellerDashboard, type Period, type SignalEventName } from "@bukalaris/db";
import Link from "next/link";
import { Bar } from "./_dashboard/bar";
import { angka, Kpi, rate } from "./_dashboard/kpi";
import { PERIOD_LABEL, PeriodSwitcher } from "./_dashboard/period-switcher";

export const metadata = { title: "Ringkasan — Bukalaris" };

const isPeriod = (p: unknown): p is Period => typeof p === "string" && (PERIODS as readonly string[]).includes(p);
const FUNNEL_LABEL: Record<SignalEventName, string> = { ViewContent: "Lihat produk", AddToCart: "Tambah ke keranjang", InitiateCheckout: "Mulai checkout", Purchase: "Pembelian" };
const AWAITING_HREF = "/seller/orders?status=awaiting_confirmation";

/** Seller overview (SC-01, T-41): store-scoped performance for a Jakarta-time period. Owner and staff. */
export default async function SellerHome({ searchParams }: PageProps<"/seller">) {
  const { ctx } = await seller();
  if (!ctx.ok) return null; // the layout renders the denial
  const sp = await searchParams;
  const period = isPeriod(sp.period) ? sp.period : "today";
  const d = await sellerDashboard(ctx.scope, period);
  const { kpi, funnel } = d;
  // `to` is exclusive (tomorrow 00:00 WIB): the last day shown is the day before it.
  const lastDay = new Date(d.range.to.getTime() - 1);
  const rangeText = period === "today" ? `${tanggalSaja(d.range.from)} (WIB)` : `${tanggalSaja(d.range.from)} – ${tanggalSaja(lastDay)} (WIB)`;
  const funnelMax = Math.max(...funnel.steps.map((s) => s.count));
  const topMax = d.topProducts[0]?.revenue ?? 0;

  return (
    <section className="grid gap-6">
      <PageHeader title="Ringkasan" description={`Kinerja ${ctx.scope.storeName}. Semua angka dihitung per hari kalender Asia/Jakarta (WIB); uang dalam rupiah bulat.`} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <PeriodSwitcher period={period} />
        <p className="text-sm text-muted-foreground" data-testid="period-range">
          {PERIOD_LABEL[period]}: {rangeText}
        </p>
      </div>

      {/* The work queue is not period-bound: an old unanswered COD order must never hide behind "today". */}
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          testId="kpi-awaiting"
          label="Menunggu konfirmasi COD"
          tone={d.awaiting > 0 ? "warning" : undefined}
          value={angka(d.awaiting)}
          hint={
            d.awaiting > 0 ? (
              <Link href={AWAITING_HREF} className="font-medium text-foreground underline underline-offset-4">
                Konfirmasi sekarang
              </Link>
            ) : (
              "Semua pesanan COD sudah ditanggapi (semua periode)."
            )
          }
        />
      </dl>

      {kpi.total === 0 ? (
        <EmptyState
          title={`Belum ada pesanan ${PERIOD_LABEL[period] === "Hari ini" ? "hari ini" : `dalam ${PERIOD_LABEL[period]} terakhir`}`}
          action={
            period !== "30d" ? (
              <Link href="/seller?period=30d" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Lihat 30 hari
              </Link>
            ) : (
              <Link href="/seller/orders" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Buka daftar pesanan
              </Link>
            )
          }
        >
          Angka pesanan, pendapatan, dan produk terlaris muncul begitu ada pesanan pada periode ini.
        </EmptyState>
      ) : (
        <>
          <section aria-labelledby="kpi-heading" className="grid gap-3">
            <h2 id="kpi-heading" className="text-base font-semibold">
              Pesanan dan pendapatan
            </h2>
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Kpi testId="kpi-orders" label="Pesanan" value={angka(kpi.orders)} hint={kpi.cancelled > 0 ? `${angka(kpi.cancelled)} dibatalkan/ditolak tidak dihitung.` : "Tidak ada yang dibatalkan."} />
              <Kpi testId="kpi-goods" label="Pendapatan barang" value={rupiah(kpi.goodsRevenue)} hint="Subtotal barang dari pesanan yang dihitung, tanpa ongkir." />
              <Kpi testId="kpi-shipping" label="Ongkir dibayar pembeli" value={rupiah(kpi.shippingCollected)} hint="Diteruskan ke kurir dan platform — bukan pendapatan toko." />
              <Kpi testId="kpi-aov" label="Rata-rata nilai pesanan" value={rupiah(kpi.averageOrderValue)} hint="Pendapatan barang dibagi jumlah pesanan." />
              <Kpi
                testId="kpi-cod-confirmed"
                label="COD terkonfirmasi"
                value={rate(kpi.cod.confirmed, kpi.cod.total)}
                hint={kpi.cod.total > 0 ? `${angka(kpi.cod.confirmed)} dari ${angka(kpi.cod.total)} pesanan COD.` : "Tidak ada pesanan COD pada periode ini."}
              />
              <Kpi
                testId="kpi-cod-cancelled"
                label="COD ditolak/dibatalkan"
                value={rate(kpi.cod.cancelled, kpi.cod.total)}
                hint={kpi.cod.total > 0 ? `${angka(kpi.cod.cancelled)} dari ${angka(kpi.cod.total)} pesanan COD.` : "Tidak ada pesanan COD pada periode ini."}
              />
            </dl>
          </section>

          <section aria-labelledby="top-heading" className="grid gap-3">
            <h2 id="top-heading" className="text-base font-semibold">
              Produk terlaris
            </h2>
            <Table>
              <caption className="sr-only">Lima produk dengan pendapatan tertinggi pada periode ini</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Produk</TableHead>
                  <TableHead numeric>Unit</TableHead>
                  <TableHead numeric>Pendapatan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.topProducts.map((p) => (
                  <TableRow key={p.productId}>
                    <TableCell className="w-full whitespace-normal">
                      <Link href={`/seller/products/${p.productId}`} className="font-medium underline-offset-4 hover:underline">
                        {p.title}
                      </Link>
                      <span className="mt-1.5 block">
                        <Bar value={p.revenue} max={topMax} />
                      </span>
                    </TableCell>
                    <TableCell numeric>{angka(p.units)}</TableCell>
                    <TableCell numeric>{rupiah(p.revenue)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </>
      )}

      <section aria-labelledby="funnel-heading" className="grid gap-3">
        <div className="grid gap-1">
          <h2 id="funnel-heading" className="text-base font-semibold">
            Corong konversi
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground text-pretty">
            Dari event sinyal iklan (Pemasaran). Pembelian dihitung dari event, jadi bisa berbeda dari jumlah pesanan di atas.
          </p>
        </div>
        {!funnel.enabled ? (
          <p role="note" data-testid="funnel-disabled" className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
            Sinyal iklan belum aktif untuk toko ini, jadi corong kosong. Aktifkan tujuan iklan dengan token di{" "}
            <Link href="/seller/marketing" className="font-medium text-foreground underline underline-offset-4">
              Pemasaran
            </Link>{" "}
            agar event pembeli tercatat.
          </p>
        ) : funnelMax === 0 ? (
          <p role="note" className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
            Belum ada event sinyal pada periode ini.
          </p>
        ) : (
          <ol className="grid gap-3" data-testid="funnel">
            {funnel.steps.map((s, i) => {
              const prev = funnel.steps[i - 1];
              return (
                <li key={s.event} className="grid gap-1">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span>{FUNNEL_LABEL[s.event]}</span>
                    <span className="tabular-nums">
                      <span className="font-semibold">{angka(s.count)}</span>
                      {prev && <span className="text-muted-foreground"> · {rate(s.count, prev.count)} dari langkah sebelumnya</span>}
                    </span>
                  </div>
                  <Bar value={s.count} max={funnelMax} />
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </section>
  );
}
