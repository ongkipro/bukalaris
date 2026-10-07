import { SearchIcon } from "lucide-react";

/** Plain GET form: works without JavaScript and keeps the query in the URL (SF-03). */
export function SearchForm({ base, q = "", className = "", autoFocus = false }: { base: string; q?: string; className?: string; autoFocus?: boolean }) {
  return (
    <form role="search" action={`${base}/search`} className={`relative ${className}`}>
      <label htmlFor="sf-q" className="sr-only">Cari produk</label>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        id="sf-q"
        name="q"
        type="search"
        defaultValue={q}
        placeholder="Cari produk"
        maxLength={100}
        autoFocus={autoFocus}
        className="h-10 w-full rounded-full border border-input bg-background pr-4 pl-9 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
      />
    </form>
  );
}
