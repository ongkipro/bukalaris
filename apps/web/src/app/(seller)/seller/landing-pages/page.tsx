import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { tanggalSaja } from "@/lib/format";
import { publishStatusLabel, publishStatusTone } from "@/lib/status";
import { listLandingPages } from "@bukalaris/db";
import Link from "next/link";

export const metadata = { title: "Landing page — Bukalaris" };

/** SC-14: list of the store's landing pages with draft/published state. */
export default async function LandingPagesPage() {
  const scope = await sellerScope();
  const pages = await listLandingPages(scope);
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Landing page"
        description="Halaman promosi satu produk dengan tampilan sendiri, terlepas dari tema toko. Pembeli memesan langsung dari halaman ini lewat checkout Bukalaris."
        action={<Link href="/seller/landing-pages/new" className={buttonVariants()}>Buat landing page</Link>}
      />
      {pages.length === 0 ? (
        <EmptyState title="Belum ada landing page" action={<Link href="/seller/landing-pages/new" className={buttonVariants({ variant: "outline" })}>Buat landing page pertama</Link>}>
          Cocok untuk iklan: satu produk, manfaat, testimoni, FAQ dan tombol pesan di satu halaman ringan.
        </EmptyState>
      ) : (
        <Table>
          <caption className="sr-only">Daftar landing page</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Judul</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="max-sm:hidden">Alamat</TableHead>
              <TableHead numeric className="max-sm:hidden">Diubah</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pages.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="max-w-[14rem] whitespace-normal sm:max-w-xs">
                  <Link href={`/seller/landing-pages/${p.id}`} className="font-medium underline-offset-4 hover:underline">{p.title}</Link>
                  {p.status === "published" && p.publishedRevisionId !== p.draftRevisionId && <span className="block text-xs text-muted-foreground">Ada draf yang belum dipublikasikan</span>}
                </TableCell>
                <TableCell>
                  <StatusBadge label={publishStatusLabel[p.status]} tone={publishStatusTone[p.status]} />
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground max-sm:hidden">
                  {p.status === "published" ? <a href={`/s/${scope.storeSlug}/lp/${p.slug}`} className="underline underline-offset-4">/lp/{p.slug}</a> : `/lp/${p.slug}`}
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
