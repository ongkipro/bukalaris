import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { rupiah } from "@/lib/format";
import { listProducts } from "@bukalaris/db";
import Link from "next/link";

const statusLabel = { draft: "Draf", active: "Aktif", archived: "Diarsipkan" } as const;

export default async function ProductsPage() {
  const products = await listProducts(await sellerScope());
  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Produk</h1>
        <Link href="/seller/products/new" className={buttonVariants()}>Tambah produk</Link>
      </div>
      {products.length === 0 ? (
        <p className="rounded-lg border p-6 text-sm text-muted-foreground">Belum ada produk. Tambahkan produk pertama Anda.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID produk</TableHead>
              <TableHead>Produk</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Varian</TableHead>
              <TableHead className="text-right">Stok</TableHead>
              <TableHead className="text-right">Harga mulai</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs tabular-nums">{p.catalogId}</TableCell>
                <TableCell>
                  <Link href={`/seller/products/${p.id}`} className="font-medium hover:underline">{p.title}</Link>
                </TableCell>
                <TableCell>
                  <Badge variant={p.status === "active" ? "default" : "secondary"}>{statusLabel[p.status]}</Badge>
                </TableCell>
                <TableCell className="text-right">{p.variants}</TableCell>
                <TableCell className="text-right">{p.stock ?? 0}</TableCell>
                <TableCell className="text-right">{rupiah(p.minPrice)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
