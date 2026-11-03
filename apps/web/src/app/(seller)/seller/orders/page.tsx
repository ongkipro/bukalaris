import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { orderStatusLabel, orderStatusTone, paymentShortLabel } from "@/lib/status";
import { listOrders, ORDER_STATUSES, type OrderStatus } from "@bukalaris/db";
import Link from "next/link";
import { parseId } from "./status";

export const metadata = { title: "Pesanan — Bukalaris" };

const isStatus = (s: unknown): s is OrderStatus => typeof s === "string" && (ORDER_STATUSES as readonly string[]).includes(s);

/** Separate payment axis from fulfilment/order status: a confirmed or shipped COD order is not paid yet (admin-dashboard §8). */
function paymentAxisNote(method: "cod" | "manual_transfer", status: OrderStatus): string {
  if (method === "cod") {
    if (status === "cancelled" || status === "returned") return "Tidak tertagih";
    if (status === "completed") return "Diterima kurir";
    return "Bayar saat terima";
  }
  if (status === "awaiting_payment") return "Belum dibayar";
  if (status === "cancelled") return "Dibatalkan";
  return "Sudah dibayar";
}
export default async function OrdersPage({ searchParams }: PageProps<"/seller/orders">) {
  const sp = await searchParams;
  const status = isStatus(sp.status) ? sp.status : undefined;
  const cursor = typeof sp.cursor === "string" ? parseId(sp.cursor) : NaN;
  const scope = await sellerScope();
  const { orders, nextCursor } = await listOrders(scope, { status, cursor: Number.isSafeInteger(cursor) ? cursor : undefined });
  const href = (s?: OrderStatus, c?: number) => `/seller/orders${s ? `?status=${s}` : ""}${c ? `${s ? "&" : "?"}cursor=${c}` : ""}`;

  return (
    <section className="grid gap-6">
      <PageHeader title="Pesanan" description="Pesanan terbaru di atas. Buka pesanan untuk mengonfirmasi, memproses, mengirim, atau membatalkan." />
      {/* Status is the primary axis of the queue (UI-7), so it is a URL-addressable filter strip, not a dropdown. */}
      <nav aria-label="Filter status" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {[undefined, ...ORDER_STATUSES].map((s) => (
          <Link
            key={s ?? "all"}
            href={href(s)}
            aria-current={s === status ? "page" : undefined}
            className={buttonVariants({ variant: s === status ? "default" : "outline", size: "sm" })}
          >
            {s ? orderStatusLabel[s] : "Semua"}
          </Link>
        ))}
      </nav>
      {orders.length === 0 ? (
        status ? (
          <EmptyState title={`Tidak ada pesanan berstatus "${orderStatusLabel[status]}"`} action={<Link href="/seller/orders" className={buttonVariants({ variant: "outline", size: "sm" })}>Hapus filter</Link>}>
            Filter aktif menyembunyikan pesanan lain.
          </EmptyState>
        ) : (
          <EmptyState title="Belum ada pesanan">Pesanan dari toko Anda akan muncul di sini begitu pembeli menyelesaikan checkout.</EmptyState>
        )
      ) : (
        <Table stickyHeader>
          <caption className="sr-only">Daftar pesanan</caption>
          <TableHeader>
            <TableRow>
              <TableHead>No.</TableHead>
              <TableHead className="max-md:hidden">Waktu</TableHead>
              <TableHead>Pembeli</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="max-md:hidden">Pembayaran</TableHead>
              <TableHead numeric className="max-sm:hidden">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o) => (
              <TableRow key={o.id}>
                <TableCell>
                  <Link href={`/seller/orders/${o.id}`} className="font-mono text-xs font-medium tabular-nums underline-offset-4 hover:underline">#{o.id}</Link>
                </TableCell>
                <TableCell className="text-muted-foreground max-md:hidden">
                  <time dateTime={o.createdAt.toISOString()}>{tanggal(o.createdAt)}</time>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <Link href={`/seller/orders/${o.id}`} className="font-medium underline-offset-4 hover:underline">{o.buyerName}</Link>
                  <span className="mt-0.5 block text-xs text-muted-foreground md:hidden">
                    <span className="font-medium text-foreground tabular-nums sm:hidden">{rupiah(o.total)} · </span>
                    {paymentShortLabel[o.paymentMethod]} ({paymentAxisNote(o.paymentMethod, o.status).toLowerCase()}) · <time dateTime={o.createdAt.toISOString()}>{tanggal(o.createdAt)}</time>
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge label={orderStatusLabel[o.status]} tone={orderStatusTone[o.status]} />
                </TableCell>
                <TableCell className="max-md:hidden">
                  <span>{paymentShortLabel[o.paymentMethod]}</span>
                  <span className="block text-xs text-muted-foreground">{paymentAxisNote(o.paymentMethod, o.status)}</span>
                </TableCell>
                <TableCell numeric className="max-sm:hidden">{rupiah(o.total)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {nextCursor && (
        <div>
          <Link href={href(status, nextCursor)} className={buttonVariants({ variant: "outline", size: "sm" })} rel="next">
            Pesanan lebih lama
          </Link>
        </div>
      )}
    </section>
  );
}
