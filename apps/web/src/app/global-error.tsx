"use client";

import "./globals.css";
import { useRequestId } from "@/lib/use-request-id";
import Link from "next/link";

/** Replaces the root layout when it fails itself; must render its own <html>/<body>. */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const requestId = useRequestId();
  return (
    <html lang="id" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <title>Terjadi gangguan — Bukalaris</title>
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 p-6">
          <h1 className="text-2xl font-semibold">Terjadi gangguan</h1>
          <p className="text-muted-foreground">Bukalaris sedang tidak bisa menampilkan halaman ini. Coba lagi beberapa saat lagi dan sebutkan kode di bawah ke dukungan.</p>
          <dl className="rounded-lg border p-4 text-sm">
            <dt className="text-muted-foreground">Kode permintaan</dt>
            <dd className="font-mono break-all">{requestId ?? "—"}</dd>
            {error.digest && (
              <>
                <dt className="mt-2 text-muted-foreground">Kode kesalahan</dt>
                <dd className="font-mono break-all">{error.digest}</dd>
              </>
            )}
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => retry()} className="inline-flex h-9 w-fit items-center rounded-md bg-foreground px-4 text-sm font-medium text-background outline-none hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50">
              Coba lagi
            </button>
            <Link href="/" className="inline-flex h-9 w-fit items-center rounded-md border bg-background px-4 text-sm font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
              Ke beranda
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
