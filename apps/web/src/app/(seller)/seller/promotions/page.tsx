import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { bpsPercent } from "@/lib/billing";
import { sellerScope } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { can, sellerPromotions } from "@bukalaris/db";
import { PromotionEditor } from "./editor";

export const metadata = { title: "Promosi — Bukalaris" };
const wib = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 16);
const kindLabel = { percent: "Persen", fixed: "Potongan tetap", free_shipping: "Gratis ongkir kurir" } as const;
const scopeLabel = { all: "Semua barang", collection: "Koleksi", product: "Produk" } as const;
export default async function PromotionsPage() {
  const scope = await sellerScope();
  const data = await sellerPromotions(scope);
  const writable = can(scope, "promotions.manage") && scope.billing.writable;
  const products = data.products.map((p) => ({ value: String(p.id), label: p.title }));
  const collections = data.collections.map((c) => ({ value: String(c.id), label: c.title }));
  const variants = data.variants.map((v) => ({ value: String(v.id), label: `${data.products.find((p) => p.id === v.productId)?.title ?? "Produk"} · ${v.title} · ${rupiah(v.price)}` }));
  const images = data.images.map((i) => ({ value: String(i.id), label: i.alt || `Gambar ${i.id}` }));
  const common = { products, collections, variants, images };
  const hub = data.hub;
  return (
    <section className="grid max-w-4xl gap-8">
      <PageHeader title="Promosi" description="Voucher, flash sale, gratis ongkir otomatis, dan halaman /promo toko. Semua aturan dicek ulang server saat pesanan dibuat." />
      {!writable && <p role="note" className="rounded-lg border bg-muted/30 p-3 text-sm">{can(scope, "promotions.manage") ? "Langganan belum aktif: promosi hanya bisa dibaca." : "Hanya pemilik toko yang dapat mengubah promosi."}</p>}

      <section aria-labelledby="hub" className="grid gap-3">
        <h2 id="hub" className="text-base font-semibold">Hub promo dan gratis ongkir</h2>
        <div className="rounded-lg border p-4">
          {writable ? <PromotionEditor type="hub" {...common} initial={{ enabled: String(hub?.enabled ?? false), title: hub?.title ?? "Promo toko", subtitle: hub?.subtitle ?? "", bannerMediaId: String(hub?.bannerMediaId ?? ""), bannerCtaLabel: hub?.bannerCtaLabel ?? "", bannerCtaHref: hub?.bannerCtaHref ?? "", freeShipEnabled: String(hub?.freeShipEnabled ?? false), freeShipThresholdIdr: String(hub?.freeShipThresholdIdr ?? 0), percentRounding: hub?.percentRounding ?? "floor" }} featured={data.featured.map((f) => f.collectionId)} />
            : <p className="text-sm text-muted-foreground">{hub?.enabled ? "Hub aktif" : "Hub belum aktif"} · pembulatan persen {hub?.percentRounding ?? "floor"} · gratis ongkir otomatis {hub?.freeShipEnabled ? `mulai ${rupiah(hub.freeShipThresholdIdr)}` : "nonaktif"}.</p>}
        </div>
      </section>

      <section aria-labelledby="vouchers" className="grid gap-3">
        <h2 id="vouchers" className="text-base font-semibold">Voucher</h2>
        {data.vouchers.length === 0 ? <EmptyState title="Belum ada voucher">Buat voucher dengan cakupan, batas pakai, dan jadwal WIB.</EmptyState> : (
          <ul className="divide-y rounded-lg border">
            {data.vouchers.map((v) => (
              <li key={v.id} className="grid gap-2 p-3 text-sm" data-testid="voucher-row">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <strong className="break-all font-mono">{v.code}</strong>
                  <CopyButton value={v.code} label={`kode voucher ${v.code}`} />
                  <StatusBadge label={v.status === "active" ? "Aktif" : "Nonaktif"} tone={v.status === "active" ? "success" : "secondary"} />
                  {v.public && <StatusBadge label="Tampil di /promo" tone="outline" />}
                </div>
                <p className="text-muted-foreground tabular-nums">{v.kind === "percent" ? `Diskon ${bpsPercent(v.value)} (${kindLabel.percent})${v.maxDiscountIdr ? ` maks. ${rupiah(v.maxDiscountIdr)}` : ""}` : v.kind === "fixed" ? `Potongan ${rupiah(v.value)} (${kindLabel.fixed})` : kindLabel.free_shipping} · {scopeLabel[v.scope]} · terpakai {v.usedCount}{v.usageLimit ? `/${v.usageLimit}` : ""} · <time dateTime={v.startsAt.toISOString()}>{tanggal(v.startsAt)}</time> sampai <time dateTime={v.endsAt.toISOString()}>{tanggal(v.endsAt)}</time> · minimum {rupiah(v.minPurchaseIdr)}</p>
                {writable && <details><summary className="cursor-pointer font-medium underline underline-offset-4">Ubah aturan</summary><div className="mt-3 border-t pt-3"><PromotionEditor type="voucher" id={v.id} {...common} initial={{ kind: v.kind, value: String(v.value), scope: v.scope, productId: String(v.productId ?? ""), collectionId: String(v.collectionId ?? ""), minPurchaseIdr: String(v.minPurchaseIdr), maxDiscountIdr: String(v.maxDiscountIdr ?? ""), usageLimit: String(v.usageLimit ?? ""), buyerUsageLimit: String(v.buyerUsageLimit ?? ""), public: String(v.public), startsAt: wib(v.startsAt), endsAt: wib(v.endsAt), status: v.status }} /></div></details>}
              </li>
            ))}
          </ul>
        )}
        {writable && <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">Tambah voucher</summary><div className="mt-4"><PromotionEditor type="voucher" {...common} initial={{ kind: "percent", value: "1000", scope: "all", minPurchaseIdr: "0", public: "true", status: "active" }} /></div></details>}
      </section>

      <section aria-labelledby="flash" className="grid gap-4">
        <h2 id="flash" className="text-base font-semibold">Flash sale</h2>
        {data.sales.length === 0 ? <EmptyState title="Belum ada flash sale">Pilih varian, harga sementara, dan batas unit. Harga dasar produk tidak berubah.</EmptyState> : (
          <ul className="divide-y rounded-lg border">
            {data.sales.map((s) => {
              const items = data.items.filter((i) => i.flashSaleId === s.id);
              return <li key={s.id} className="grid gap-3 p-3 text-sm" data-testid="flash-row">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><strong>{s.title}</strong><StatusBadge label={s.status === "active" ? "Aktif sesuai jadwal" : "Nonaktif"} tone={s.status === "active" ? "success" : "secondary"} /></div>
                <p className="text-muted-foreground">{tanggal(s.startsAt)} sampai {tanggal(s.endsAt)} · {items.map((i) => `${variants.find((v) => v.value === String(i.variantId))?.label ?? i.variantId}: ${rupiah(i.salePriceIdr)}, terjual ${i.soldCount}${i.stockCap ? `/${i.stockCap}` : ""}`).join("; ")}</p>
                {writable && <details><summary className="cursor-pointer underline underline-offset-4">Ubah flash sale</summary><div className="mt-3"><PromotionEditor type="flash" id={s.id} {...common} items={items.map((i) => ({ variantId: i.variantId, salePriceIdr: i.salePriceIdr, stockCap: i.stockCap }))} initial={{ title: s.title, startsAt: wib(s.startsAt), endsAt: wib(s.endsAt), status: s.status }} /></div></details>}
              </li>;
            })}
          </ul>
        )}
        {writable && <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">Tambah flash sale</summary><div className="mt-4"><PromotionEditor type="flash" {...common} initial={{ status: "active" }} /></div></details>}
      </section>
    </section>
  );
}
