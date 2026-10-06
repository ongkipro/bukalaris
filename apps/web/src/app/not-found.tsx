import { buttonVariants } from "@/components/ui/button";
import { REQUEST_ID_HEADER } from "@/lib/request-id";
import { headers } from "next/headers";
import Link from "next/link";

export const metadata = { title: "Halaman tidak ditemukan — Bukalaris" };

/** Root 404 for unmatched URLs and `notFound()` (unknown/suspended store, missing product). */
export default async function NotFound() {
  const requestId = (await headers()).get(REQUEST_ID_HEADER);
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Halaman tidak ditemukan</h1>
      <p className="text-muted-foreground">Alamat yang Anda buka tidak ada, sudah dipindahkan, atau toko ini sedang tidak tersedia.</p>
      <dl className="rounded-lg border p-4 text-sm">
        <dt className="text-muted-foreground">Kode permintaan</dt>
        <dd className="font-mono break-all" data-testid="request-id">{requestId ?? "—"}</dd>
      </dl>
      <Link href="/" className={buttonVariants({ variant: "outline" }) + " w-fit"}>Ke beranda</Link>
    </main>
  );
}
