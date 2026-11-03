import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { rupiah } from "@/lib/format";
import { productStatusLabel, productStatusTone } from "@/lib/status";
import { listProducts } from "@bukalaris/db";
import Link from "next/link";

export const metadata = { title: "Produk — Bukalaris" };

export default async function ProductsPage() {
  const products = await listProducts(await sellerScope());
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Produk"
        description="Katalog toko Anda. Hanya produk berstatus Aktif yang tampil dan bisa dibeli di toko."
        action={<Link href="/seller/products/new" className={buttonVariants()}>Tambah produk</Link>}
      />
      {products.length === 0 ? (
        <EmptyState title="Belum ada produk" action={<Link href="/seller/products/new" className={buttonVariants({ variant: "outline" })}>Tambah produk pertama</Link>}>
          Produk pertama Anda akan muncul di sini dan di toko begitu statusnya Aktif.
        </EmptyState>
      ) : (
        <Table stickyHeader>
          <caption className="sr-only">Daftar produk</caption>
          <TableHeader>
            <TableRow>
              <TableHead className="max-sm:hidden">ID produk</TableHead>
              <TableHead>Produk</TableHead>
              <TableHead>Status</TableHead>
              <TableHead numeric className="max-sm:hidden">Varian</TableHead>
              <TableHead numeric>Stok</TableHead>
              <TableHead numeric>Harga mulai</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="max-sm:hidden"><span className="font-mono text-xs tabular-nums text-muted-foreground">{p.catalogId}</span></TableCell>
                <TableCell className="max-w-[14rem] whitespace-normal sm:max-w-xs">
                  <Link href={`/seller/products/${p.id}`} className="font-medium underline-offset-4 hover:underline">{p.title}</Link>
                  <span className="mt-0.5 block font-mono text-xs tabular-nums text-muted-foreground sm:hidden">{p.catalogId} · {p.variants} varian</span>
                </TableCell>
                <TableCell>
                  <StatusBadge label={productStatusLabel[p.status]} tone={productStatusTone[p.status]} />
                </TableCell>
                <TableCell numeric className="max-sm:hidden">{p.variants}</TableCell>
                <TableCell numeric className={p.stock ? undefined : "text-destructive"}>{p.stock ?? 0}</TableCell>
                <TableCell numeric>{rupiah(p.minPrice)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
