/** Skeleton for the storefront main column while a page streams. */
export default function StoreLoading() {
  return (
    <div role="status" aria-live="polite" aria-label="Memuat" className="grid gap-6">
      <div className="h-7 w-40 animate-pulse rounded-md bg-muted" />
      <ul className="grid grid-cols-2 gap-x-3 gap-y-6 @2xl:grid-cols-3 @5xl:grid-cols-4" aria-hidden>
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i} className="grid gap-3">
            <div className="aspect-square animate-pulse rounded-lg bg-muted" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
          </li>
        ))}
      </ul>
    </div>
  );
}
