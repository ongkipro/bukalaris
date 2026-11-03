import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { publishStatusLabel, publishStatusTone } from "@/lib/status";
import { listCollections } from "@bukalaris/db";
import Link from "next/link";

export const metadata = { title: "Koleksi — Bukalaris" };

export default async function CollectionsPage() {
  const scope = await sellerScope();
  const collections = await listCollections(scope);
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Koleksi"
        description="Kelompok produk (mis. “Terlaris”, “Promo”). Koleksi yang dipublikasikan tampil di navigasi toko."
        action={<Link href="/seller/collections/new" className={buttonVariants()}>Tambah koleksi</Link>}
      />
      {collections.length === 0 ? (
        <EmptyState title="Belum ada koleksi" action={<Link href="/seller/collections/new" className={buttonVariants({ variant: "outline" })}>Buat koleksi pertama</Link>}>
          Koleksi membantu pembeli menemukan produk; buat satu untuk produk unggulan Anda.
        </EmptyState>
      ) : (
        <Table>
          <caption className="sr-only">Daftar koleksi</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Koleksi</TableHead>
              <TableHead>Status</TableHead>
              <TableHead numeric>Produk</TableHead>
              <TableHead className="max-sm:hidden">Alamat</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collections.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="max-w-[14rem] whitespace-normal sm:max-w-xs">
                  <Link href={`/seller/collections/${c.id}`} className="font-medium underline-offset-4 hover:underline">{c.title}</Link>
                </TableCell>
                <TableCell>
                  <StatusBadge label={publishStatusLabel[c.status]} tone={publishStatusTone[c.status]} />
                </TableCell>
                <TableCell numeric>{c.products}</TableCell>
                <TableCell className="text-muted-foreground max-sm:hidden">
                  <span className="font-mono text-xs">{c.status === "published" ? <a href={`/s/${scope.storeSlug}/collections/${c.slug}`} className="underline underline-offset-4">/collections/{c.slug}</a> : `/collections/${c.slug}`}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
