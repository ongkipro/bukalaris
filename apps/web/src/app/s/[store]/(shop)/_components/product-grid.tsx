import { rupiah } from "@/lib/format";
import { canonicalSlug, type Cover } from "@bukalaris/db";
import Link from "next/link";
import { StoreImage } from "./store-image";

export type CardProduct = { id: number; catalogId: string; title: string; slug: string | null; minPrice: number | null };

/** Container-query grid: 2 columns in the 480px mobile theme, up to 4 in the responsive theme. */
export function ProductGrid({ base, products, covers, priorityCount = 4 }: { base: string; products: CardProduct[]; covers: Map<number, Cover>; priorityCount?: number }) {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-6 @2xl:grid-cols-3 @2xl:gap-x-5 @5xl:grid-cols-4" data-testid="product-grid">
      {products.map((p, i) => (
        <li key={p.id}>
          <Link
            href={`${base}/products/${canonicalSlug(p)}`}
            className="group block rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <StoreImage base={base} image={covers.get(p.id)} priority={i < priorityCount} className="aspect-square w-full rounded-lg" />
            <h3 className="mt-3 line-clamp-2 text-sm leading-snug font-medium text-balance group-hover:underline @2xl:text-base">{p.title}</h3>
            <p className="mt-1 text-sm tabular-nums text-foreground/80">{rupiah(p.minPrice)}</p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
