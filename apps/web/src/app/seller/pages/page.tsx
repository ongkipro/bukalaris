import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { listPages } from "@bukalaris/db";
import Link from "next/link";

export const metadata = { title: "Halaman — Bukalaris" };
const date = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" });

export default async function PagesPage() {
  const scope = await sellerScope();
  const pages = await listPages(scope);
  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Halaman</h1>
        <Link href="/seller/pages/new" className={buttonVariants()}>Tambah halaman</Link>
      </div>
      {pages.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          Belum ada halaman. Buat halaman seperti “Tentang kami” atau “Cara pemesanan”; halaman publik tampil di navigasi dan footer toko.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Halaman</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="max-sm:hidden">Alamat</TableHead>
              <TableHead className="text-right max-sm:hidden">Diubah</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pages.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <Link href={`/seller/pages/${p.id}`} className="font-medium hover:underline">{p.title}</Link>
                </TableCell>
                <TableCell>
                  <Badge variant={p.status === "published" ? "default" : "secondary"}>{p.status === "published" ? "Publik" : "Draf"}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground max-sm:hidden">
                  {p.status === "published" ? <a href={`/s/${scope.storeSlug}/pages/${p.slug}`} className="underline">/pages/{p.slug}</a> : `/pages/${p.slug}`}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground max-sm:hidden">{date.format(p.updatedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
