import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { rupiah } from "@/lib/format";
import { listOrders, ORDER_STATUSES, type OrderStatus } from "@bukalaris/db";
import Link from "next/link";
import { parseId, statusLabel, statusVariant, tanggal } from "./status";

const isStatus = (s: unknown): s is OrderStatus => typeof s === "string" && (ORDER_STATUSES as readonly string[]).includes(s);

export default async function OrdersPage({ searchParams }: PageProps<"/seller/orders">) {
  const sp = await searchParams;
  const status = isStatus(sp.status) ? sp.status : undefined;
  const cursor = typeof sp.cursor === "string" ? parseId(sp.cursor) : NaN;
  const scope = await sellerScope();
  const { orders, nextCursor } = await listOrders(scope, { status, cursor: Number.isSafeInteger(cursor) ? cursor : undefined });
  const href = (s?: OrderStatus, c?: number) => `/seller/orders${s ? `?status=${s}` : ""}${c ? `${s ? "&" : "?"}cursor=${c}` : ""}`;

  return (
    <section>
      <h1 className="mb-1 text-2xl font-semibold">Pesanan</h1>
      <p className="mb-4 text-sm text-muted-foreground">Pesanan terbaru di atas. Buka pesanan untuk memproses, mengirim, atau membatalkan.</p>
      <nav aria-label="Filter status" className="mb-4 flex flex-wrap gap-2 text-sm">
        {[undefined, ...ORDER_STATUSES].map((s) => (
          <Link
            key={s ?? "all"}
            href={href(s)}
            aria-current={s === status ? "page" : undefined}
            className={buttonVariants({ variant: s === status ? "default" : "outline", size: "sm" })}
          >
            {s ? statusLabel[s] : "Semua"}
          </Link>
        ))}
      </nav>
      {orders.length === 0 ? (
        <p className="rounded-lg border p-6 text-sm text-muted-foreground">
          {status ? `Tidak ada pesanan berstatus "${statusLabel[status]}".` : "Belum ada pesanan. Pesanan dari toko Anda akan muncul di sini."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>No.</TableHead>
              <TableHead>Waktu</TableHead>
              <TableHead>Pembeli</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Pembayaran</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o) => (
              <TableRow key={o.id}>
                <TableCell>
                  <Link href={`/seller/orders/${o.id}`} className="font-mono text-xs font-medium hover:underline">#{o.id}</Link>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{tanggal(o.createdAt)}</TableCell>
                <TableCell>
                  <Link href={`/seller/orders/${o.id}`} className="font-medium hover:underline">{o.buyerName}</Link>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant[o.status]}>{statusLabel[o.status]}</Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap">{o.paymentMethod === "cod" ? "COD" : "Transfer"}</TableCell>
                <TableCell className="whitespace-nowrap text-right">{rupiah(o.total)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {nextCursor && (
        <div className="mt-4">
          <Link href={href(status, nextCursor)} className={buttonVariants({ variant: "outline", size: "sm" })} rel="next">
            Pesanan lebih lama
          </Link>
        </div>
      )}
    </section>
  );
}
