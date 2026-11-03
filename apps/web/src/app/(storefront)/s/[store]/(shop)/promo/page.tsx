import { CopyButton } from "@/components/copy-button";
import { buttonVariants } from "@/components/ui/button";
import { rupiah, tanggal } from "@/lib/format";
import { coverImages, storefrontPromotions } from "@bukalaris/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, ProductGrid } from "../_components/product-grid";
import { StoreImage } from "../_components/store-image";
import { storeShell } from "../_lib";
import { Countdown } from "./countdown";

export async function generateMetadata({ params }: PageProps<"/s/[store]/promo">): Promise<Metadata> {
  const { store } = await params;
  const { scope } = await storeShell(store);
  const promo = await storefrontPromotions(scope);
  return { title: promo ? `${promo.hub.title} — ${scope.storeName}` : scope.storeName };
}

const voucherText = (v: { kind: "percent" | "fixed" | "free_shipping"; value: number; maxDiscountIdr: number | null }) =>
  v.kind === "free_shipping" ? "Gratis ongkir kurir" : v.kind === "fixed" ? `Potongan ${rupiah(v.value)}` : `Diskon ${(v.value / 100).toLocaleString("id-ID")}%${v.maxDiscountIdr ? `, maksimal ${rupiah(v.maxDiscountIdr)}` : ""}`;

export default async function PromoPage({ params }: PageProps<"/s/[store]/promo">) {
  const { store } = await params;
  const { scope, base } = await storeShell(store);
  const promo = await storefrontPromotions(scope);
  if (!promo) notFound();
  const covers = await coverImages(scope, promo.products.map((p) => p.id));
  const empty = promo.vouchers.length === 0 && promo.flashes.length === 0 && promo.products.length === 0;
  return (
    <section className="grid gap-8">
      <header className="grid gap-2">
        {promo.banner && <StoreImage base={base} image={promo.banner} priority className="mb-2 aspect-[3/1] w-full rounded-lg" />}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{promo.hub.title}</h1>
        {promo.hub.subtitle && <p className="max-w-prose text-pretty text-muted-foreground">{promo.hub.subtitle}</p>}
        {promo.hub.bannerCtaLabel && promo.hub.bannerCtaHref && <Link href={`${base}${promo.hub.bannerCtaHref}`} className="inline-flex h-10 w-fit items-center rounded-full border px-4 text-sm font-medium hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">{promo.hub.bannerCtaLabel}</Link>}
      </header>
      {empty && (
        <EmptyState
          title="Belum ada promo yang berlaku."
          hint="Cek lagi nanti atau lihat semua produk toko."
          action={<Link href={base || "/"} className={buttonVariants({ variant: "outline" })}>Lihat semua produk</Link>}
        />
      )}
      {promo.flashes.length > 0 && (
        <section aria-labelledby="flash" className="grid gap-3">
          <h2 id="flash" className="text-lg font-semibold">Flash sale</h2>
          <ul className="grid gap-3 @2xl:grid-cols-2">
            {promo.flashes.map((f) => {
              const left = f.stockCap === null ? null : f.stockCap - f.soldCount;
              return <li key={f.id} className="grid gap-1.5 rounded-xl border p-4 text-sm" data-testid="flash-item">
                <Link href={`${base}/products/${f.productSlug ?? f.productCatalogId}`} className="inline-flex min-h-6 w-fit items-center rounded-sm py-0.5 font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">{f.productTitle} · {f.variantTitle}</Link>
                <p className="flex items-baseline gap-2"><strong className="text-base tabular-nums">{rupiah(f.salePrice)}</strong> <s className="text-muted-foreground tabular-nums">{rupiah(f.basePrice)}</s></p>
                <p className="text-muted-foreground tabular-nums">Berakhir {tanggal(f.endsAt)}{left !== null && f.stockCap ? ` · sisa ${left} dari ${f.stockCap} unit` : ""}</p>
                <p className="text-muted-foreground"><Countdown endsAtIso={f.endsAt.toISOString()} /></p>
                {f.stockCap !== null && <progress className="mt-1 h-2 w-full appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-foreground [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-foreground" max={f.stockCap} value={f.soldCount} aria-label={`Kuota terpakai ${f.soldCount} dari ${f.stockCap}`} />}
              </li>;
            })}
          </ul>
        </section>
      )}
      {promo.vouchers.length > 0 && (
        <section aria-labelledby="voucher" className="grid gap-3">
          <h2 id="voucher" className="text-lg font-semibold">Voucher toko</h2>
          <ul className="grid gap-3 @2xl:grid-cols-2">
            {promo.vouchers.map((v) => <li key={v.code} className="grid content-between gap-2 rounded-xl border p-4 text-sm" data-testid="promo-voucher">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="break-all font-mono text-base tracking-tight">{v.code}</strong>
                <CopyButton value={v.code} label={`kode ${v.code}`} />
              </div>
              <p className="font-medium tabular-nums">{voucherText(v)}{v.minPurchaseIdr > 0 ? ` · minimum belanja ${rupiah(v.minPurchaseIdr)}` : ""}</p>
              <p className="text-xs text-muted-foreground tabular-nums">Berlaku sampai {tanggal(v.endsAt)}. Masukkan kode di checkout; kuota dicek saat pesanan dibuat.</p>
            </li>)}
          </ul>
        </section>
      )}
      {promo.featured.length > 0 && <nav aria-label="Koleksi promo"><ul className="flex flex-wrap gap-2">{promo.featured.map((c) => <li key={c.id}><Link href={`${base}/collections/${c.slug}`} className="inline-block rounded-full border px-3 py-1.5 text-sm hover:bg-muted">{c.title}</Link></li>)}</ul></nav>}
      {promo.products.length > 0 && <section aria-labelledby="discounted" className="grid gap-3"><h2 id="discounted" className="text-lg font-semibold">Produk dengan voucher</h2><ProductGrid base={base} products={promo.products} covers={covers} /></section>}
    </section>
  );
}
