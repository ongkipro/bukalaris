"use client";

import { Button, buttonVariants } from "@/components/ui/button";
import { useRequestId } from "@/lib/use-request-id";
import Link from "next/link";

/** Friendly failure page: the support reference is the request id (from proxy) plus React's digest; never internals. */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const requestId = useRequestId();
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Terjadi gangguan</h1>
      <p className="text-muted-foreground">
        Halaman ini sedang tidak bisa ditampilkan. Coba lagi beberapa saat lagi. Jika masih gagal, hubungi dukungan dan sebutkan kode di bawah.
      </p>
      <dl className="rounded-lg border p-4 text-sm">
        <dt className="text-muted-foreground">Kode permintaan</dt>
        <dd className="font-mono break-all" data-testid="request-id">{requestId ?? "—"}</dd>
        {error.digest && (
          <>
            <dt className="mt-2 text-muted-foreground">Kode kesalahan</dt>
            <dd className="font-mono break-all">{error.digest}</dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => retry()}>Coba lagi</Button>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>Ke beranda</Link>
      </div>
    </main>
  );
}
