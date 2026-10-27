import { rupiah, tanggal } from "@/lib/format";
import { productStatusLabel } from "@/lib/status";
import type { listCatalogHistory } from "@bukalaris/db";
import type { CatalogSnapshot } from "@bukalaris/db/schema";

type Row = Awaited<ReturnType<typeof listCatalogHistory>>[number];

const actionLabel: Record<Row["action"], string> = {
  "product.create": "Produk dibuat",
  "product.update": "Produk diubah",
  "variant.create": "Varian ditambahkan",
  "variant.update": "Varian diubah",
};
// Display order (jsonb does not keep key order).
const fieldLabel: Record<string, string> = { title: "judul", slug: "slug", status: "status", sku: "SKU", price: "harga", stock: "stok" };
const FIELDS = Object.keys(fieldLabel);
const statusLabel: Record<string, string> = productStatusLabel;

function show(field: string, v: string | number | null | undefined) {
  if (v == null || v === "") return "—";
  if (field === "price") return rupiah(Number(v));
  if (field === "status") return statusLabel[String(v)] ?? String(v);
  return String(v);
}

/** Changed fields of one audit row as "field: before → after" lines; creations list the initial values. */
function changes(before: CatalogSnapshot | null, after: CatalogSnapshot | null) {
  const keys = Object.keys(after ?? before ?? {})
    .filter((k) => !before || before[k] !== after?.[k])
    .sort((a, b) => FIELDS.indexOf(a) - FIELDS.indexOf(b));
  return keys.map((k) => ({ k, text: before ? `${fieldLabel[k] ?? k}: ${show(k, before[k])} → ${show(k, after?.[k])}` : `${fieldLabel[k] ?? k}: ${show(k, after?.[k])}` }));
}

/** Store-scoped change history of this product and its variants (T-31, SEC-17). */
export function ProductHistory({ rows }: { rows: Row[] }) {
  return (
    <section aria-labelledby="riwayat" className="grid gap-3" data-testid="product-history">
      <div>
        <h2 id="riwayat" className="text-lg font-semibold">Riwayat perubahan</h2>
        <p className="text-sm text-muted-foreground">Setiap perubahan harga, stok, status dan data produk dicatat bersama siapa yang mengubah.</p>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada riwayat. Perubahan pertama akan tercatat di sini.</p>
      ) : (
        <ol className="divide-y rounded-lg border text-sm">
          {rows.map((r) => (
            <li key={r.id} className="grid gap-1 p-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
              <div className="text-xs text-muted-foreground">
                <time dateTime={r.createdAt.toISOString()}>{tanggal(r.createdAt)}</time>
                <div>{r.actorName ?? "—"}</div>
              </div>
              <div>
                <p className="font-medium">
                  {actionLabel[r.action]}
                  {r.variantId != null && <span className="font-normal text-muted-foreground"> · {r.variantTitle ?? `varian #${r.variantId}`}</span>}
                </p>
                <ul className="mt-0.5 text-muted-foreground">
                  {changes(r.before, r.after).map((c) => (
                    <li key={c.k} className="tabular-nums">{c.text}</li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
