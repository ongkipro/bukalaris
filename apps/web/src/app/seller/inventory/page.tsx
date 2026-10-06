import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sellerScope } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { productStatusLabel, productStatusTone } from "@/lib/status";
import { can, listInventory, listStockAdjustments } from "@bukalaris/db";
import Link from "next/link";
import { adjustStockAction } from "./actions";

export const metadata = { title: "Inventaris — Bukalaris" };

export default async function InventoryPage({ searchParams }: PageProps<"/seller/inventory">) {
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const [rows, log] = await Promise.all([listInventory(scope), listStockAdjustments(scope)]);
  const write = can(scope, "inventory.write");

  return (
    <section className="grid gap-8">
      <div className="grid gap-6">
        <PageHeader
          title="Inventaris"
          description={
            <>
              Stok per varian. Masukkan perubahan bertanda (misalnya <span className="font-mono">+10</span> atau <span className="font-mono">-2</span>) dengan alasan; stok tidak pernah negatif.
            </>
          }
        />
        <Notice error={error} saved={saved} />
        {rows.length === 0 ? (
          <EmptyState title="Belum ada varian" action={<Link href="/seller/products/new" className={buttonVariants({ variant: "outline", size: "sm" })}>Tambah produk</Link>}>
            Stok mengikuti varian produk. Tambahkan produk dulu, lalu sesuaikan stoknya di sini.
          </EmptyState>
        ) : (
          <ul className="grid gap-3">
            {rows.map((v) => (
              <li key={v.variantId} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center" data-testid={`variant-${v.variantId}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/seller/products/${v.productId}`} className="font-medium underline-offset-4 hover:underline">{v.productTitle}</Link>
                    <span className="text-muted-foreground">· {v.variantTitle}</span>
                    {v.productStatus !== "active" && <StatusBadge label={productStatusLabel[v.productStatus]} tone={productStatusTone[v.productStatus]} />}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {v.sku ? <>SKU <span className="font-mono">{v.sku}</span> · </> : null}
                    Stok <strong className={`tabular-nums ${v.stock === 0 ? "text-destructive" : "text-foreground"}`} data-testid="stock">{v.stock}</strong>
                    {v.stock === 0 && <span className="text-destructive"> (habis)</span>}
                  </p>
                </div>
                {write && (
                  <form action={adjustStockAction.bind(null, v.variantId)} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 sm:flex sm:flex-wrap sm:items-center">
                    <label htmlFor={`delta-${v.variantId}`} className="sr-only">Perubahan stok {v.productTitle} {v.variantTitle}</label>
                    <Input id={`delta-${v.variantId}`} name="delta" type="number" inputMode="numeric" step={1} required placeholder="+/-" className="tabular-nums sm:w-24" aria-describedby={`delta-help-${v.variantId}`} />
                    <label htmlFor={`reason-${v.variantId}`} className="sr-only">Alasan perubahan {v.productTitle} {v.variantTitle}</label>
                    <Input id={`reason-${v.variantId}`} name="reason" required minLength={3} maxLength={300} placeholder="Alasan (wajib)" className="sm:w-56" />
                    <SubmitButton size="sm" variant="outline" className="col-span-2" pendingText="Menyesuaikan…">Sesuaikan</SubmitButton>
                    <span id={`delta-help-${v.variantId}`} className="sr-only">Angka bertanda, misalnya +10 atau -2; hasil tidak boleh di bawah nol.</span>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <section aria-labelledby="log" className="grid gap-3">
        <div>
          <h2 id="log" className="text-lg font-semibold">Riwayat penyesuaian</h2>
          <p className="text-sm text-muted-foreground">Penyesuaian manual dan pengembalian stok dari pesanan yang dibatalkan, beserta siapa yang melakukannya.</p>
        </div>
        {log.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada penyesuaian stok.</p>
        ) : (
          <ol className="divide-y rounded-lg border text-sm">
            {log.map((l) => (
              <li key={l.id} className="grid gap-1 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <span>{l.productTitle} · {l.variantTitle}</span>
                  <strong className={`tabular-nums ${l.delta < 0 ? "text-destructive" : "text-emerald-700 dark:text-emerald-300"}`}>
                    {l.delta > 0 ? `+${l.delta}` : l.delta}
                  </strong>
                </div>
                <p className="break-words text-muted-foreground">
                  {l.reason}
                  {l.orderId && <> · <Link href={`/seller/orders/${l.orderId}`} className="underline underline-offset-4">pesanan #{l.orderId}</Link></>}
                </p>
                <p className="text-xs text-muted-foreground">
                  <time dateTime={l.createdAt.toISOString()}>{tanggal(l.createdAt)}</time> · {l.actorName ?? "—"}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
