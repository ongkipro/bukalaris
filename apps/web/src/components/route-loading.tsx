/**
 * Route-level skeleton (`loading.tsx`) shaped like a page header plus a list. Used only in seller/admin
 * segments without a `notFound()`/redirect below them: a Suspense boundary above such a page would turn
 * its 404/308 into a streamed 200 (docs/tracks/catalog.md).
 */
export function RouteLoading({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-live="polite" aria-label="Memuat halaman" className="grid gap-6 motion-safe:animate-pulse">
      <div className="grid gap-2">
        <div className="h-7 w-40 rounded-md bg-muted" />
        <div className="h-4 w-72 max-w-full rounded-md bg-muted" />
      </div>
      <div className="grid gap-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="h-14 rounded-lg bg-muted/70" />
        ))}
      </div>
    </div>
  );
}
