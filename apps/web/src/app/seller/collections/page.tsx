import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { listCollections } from "@bukalaris/db";
import Link from "next/link";

export const metadata = { title: "Koleksi — Bukalaris" };

export default async function CollectionsPage() {
  const scope = await sellerScope();
  const collections = await listCollections(scope);
  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Koleksi</h1>
        <Link href="/seller/collections/new" className={buttonVariants()}>Tambah koleksi</Link>
      </div>
      {collections.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          Belum ada koleksi. Koleksi mengelompokkan produk (mis. “Terlaris”, “Promo”) dan tampil di navigasi toko saat dipublikasikan.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Koleksi</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Produk</TableHead>
              <TableHead className="max-sm:hidden">Alamat</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collections.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link href={`/seller/collections/${c.id}`} className="font-medium hover:underline">{c.title}</Link>
                </TableCell>
                <TableCell>
                  <Badge variant={c.status === "published" ? "default" : "secondary"}>{c.status === "published" ? "Publik" : "Draf"}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{c.products}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground max-sm:hidden">
                  {c.status === "published" ? <a href={`/s/${scope.storeSlug}/collections/${c.slug}`} className="underline">/collections/{c.slug}</a> : `/collections/${c.slug}`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
