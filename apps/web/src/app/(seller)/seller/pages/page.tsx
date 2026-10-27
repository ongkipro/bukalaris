import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { tanggalSaja } from "@/lib/format";
import { publishStatusLabel, publishStatusTone } from "@/lib/status";
import { listPages } from "@bukalaris/db";
import Link from "next/link";

export const metadata = { title: "Halaman — Bukalaris" };

export default async function PagesPage() {
  const scope = await sellerScope();
  const pages = await listPages(scope);
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Halaman"
        description="Halaman informasi toko seperti “Tentang kami” atau “Cara pemesanan”. Halaman publik tampil di navigasi dan footer toko."
        action={<Link href="/seller/pages/new" className={buttonVariants()}>Tambah halaman</Link>}
      />
      {pages.length === 0 ? (
        <EmptyState title="Belum ada halaman" action={<Link href="/seller/pages/new" className={buttonVariants({ variant: "outline" })}>Buat halaman pertama</Link>}>
          Mulai dari “Tentang kami” atau “Cara pemesanan” agar pembeli percaya pada toko Anda.
        </EmptyState>
      ) : (
        <Table>
          <caption className="sr-only">Daftar halaman</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Halaman</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="max-sm:hidden">Alamat</TableHead>
              <TableHead numeric className="max-sm:hidden">Diubah</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pages.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="max-w-[14rem] whitespace-normal sm:max-w-xs">
                  <Link href={`/seller/pages/${p.id}`} className="font-medium underline-offset-4 hover:underline">{p.title}</Link>
                </TableCell>
                <TableCell>
                  <StatusBadge label={publishStatusLabel[p.status]} tone={publishStatusTone[p.status]} />
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground max-sm:hidden">
                  {p.status === "published" ? <a href={`/s/${scope.storeSlug}/pages/${p.slug}`} className="underline underline-offset-4">/pages/{p.slug}</a> : `/pages/${p.slug}`}
                </TableCell>
                <TableCell numeric className="text-muted-foreground max-sm:hidden">
                  <time dateTime={p.updatedAt.toISOString()}>{tanggalSaja(p.updatedAt)}</time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
