"use client";

import { Button } from "@/components/ui/button";
import { useRequestId } from "@/lib/use-request-id";

/**
 * In-shell error boundary for seller/admin segments: the navigation stays usable, the operator gets the
 * support reference (request id + digest) and a retry. Never prints internals.
 */
export function RouteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const requestId = useRequestId();
  return (
    <div role="alert" className="mx-auto grid max-w-xl gap-4 rounded-lg border p-6">
      <div>
        <h1 className="text-lg font-semibold">Halaman ini sedang tidak bisa ditampilkan</h1>
        <p className="mt-1 text-sm text-muted-foreground">Coba lagi beberapa saat lagi. Jika masih gagal, hubungi dukungan dan sebutkan kode di bawah.</p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Kode permintaan</dt>
        <dd className="font-mono break-all" data-testid="request-id">{requestId ?? "—"}</dd>
        {error.digest && (
          <>
            <dt className="text-muted-foreground">Kode kesalahan</dt>
            <dd className="font-mono break-all">{error.digest}</dd>
          </>
        )}
      </dl>
      <div>
        <Button type="button" onClick={() => retry()}>Coba lagi</Button>
      </div>
    </div>
  );
}
