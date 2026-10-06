import { Notice } from "@/components/notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sellerScope } from "@/lib/context";
import { can, listInventory, listStockAdjustments } from "@bukalaris/db";
import Link from "next/link";
import { tanggal } from "../orders/status";
import { adjustStockAction } from "./actions";

export default async function InventoryPage({ searchParams }: PageProps<"/seller/inventory">) {
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const [rows, log] = await Promise.all([listInventory(scope), listStockAdjustments(scope)]);
  const write = can(scope, "inventory.write");

  return (
    <section className="grid gap-8">
      <div>
        <h1 className="mb-1 text-2xl font-semibold">Inventaris</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          Stok per varian. Masukkan perubahan bertanda (misalnya <span className="font-mono">+10</span> atau <span className="font-mono">-2</span>) dengan alasan; stok tidak pernah negatif.
        </p>
        <Notice error={error} saved={saved} />
        {rows.length === 0 ? (
          <p className="rounded-lg border p-6 text-sm text-muted-foreground">
            Belum ada varian. <Link href="/seller/products/new" className="underline">Tambahkan produk</Link> terlebih dahulu.
          </p>
        ) : (
          <ul className="grid gap-3">
            {rows.map((v) => (
              <li key={v.variantId} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[1fr_auto] md:items-center" data-testid={`variant-${v.variantId}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/seller/products/${v.productId}`} className="font-medium hover:underline">{v.productTitle}</Link>
                    <span className="text-muted-foreground">· {v.variantTitle}</span>
                    {v.productStatus !== "active" && <Badge variant="secondary">{v.productStatus === "draft" ? "Draf" : "Diarsipkan"}</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {v.sku ? <>SKU <span className="font-mono">{v.sku}</span> · </> : null}
                    Stok <strong className="text-foreground" data-testid="stock">{v.stock}</strong>
                  </p>
                </div>
                {write && (
                  <form action={adjustStockAction.bind(null, v.variantId)} className="grid grid-cols-[5.5rem_1fr] gap-2 sm:flex sm:flex-wrap sm:items-center">
                    <label htmlFor={`delta-${v.variantId}`} className="sr-only">Perubahan stok {v.productTitle} {v.variantTitle}</label>
                    <Input id={`delta-${v.variantId}`} name="delta" type="number" inputMode="numeric" step={1} required placeholder="+/-" className="sm:w-24" />
                    <label htmlFor={`reason-${v.variantId}`} className="sr-only">Alasan perubahan {v.productTitle} {v.variantTitle}</label>
                    <Input id={`reason-${v.variantId}`} name="reason" required minLength={3} maxLength={300} placeholder="Alasan (wajib)" className="sm:w-56" />
                    <Button type="submit" size="sm" variant="outline" className="col-span-2">Sesuaikan</Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <section aria-labelledby="log" className="grid gap-2">
        <h2 id="log" className="text-lg font-semibold">Riwayat penyesuaian</h2>
        {log.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada penyesuaian stok.</p>
        ) : (
          <ol className="divide-y rounded-lg border text-sm">
            {log.map((l) => (
              <li key={l.id} className="grid gap-1 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <span>{l.productTitle} · {l.variantTitle}</span>
                  <strong className={l.delta < 0 ? "text-destructive" : "text-emerald-700 dark:text-emerald-300"}>
                    {l.delta > 0 ? `+${l.delta}` : l.delta}
                  </strong>
                </div>
                <p className="break-words text-muted-foreground">
                  {l.reason}
                  {l.orderId && <> · <Link href={`/seller/orders/${l.orderId}`} className="underline">pesanan #{l.orderId}</Link></>}
                </p>
                <p className="text-xs text-muted-foreground">{tanggal(l.createdAt)} · {l.actorName ?? "—"}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
