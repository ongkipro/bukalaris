import { MarkdownLite } from "@/app/(storefront)/s/[store]/(shop)/_components/markdown-lite";
import type { BrowserSignals, LandingBlock, ResolvedLanding, StoreMedia } from "@bukalaris/db";
import { ImageIcon } from "lucide-react";
import Link from "next/link";
import "../lp.css";
import { OrderForm } from "./order-form";

/**
 * Independent LP renderer (ARCH-4 "Independent LP Renderer", UI-6): one reading column, its
 * own tokens from the document's design settings, no storefront header/footer/theme. Used by
 * the public route (published revision) and the seller preview (draft) with different image
 * resolvers and order-form modes, so what the seller previews is what buyers get.
 */
export function LandingRenderer({
  lp,
  storeName,
  storeHome,
  imageSrc,
  order,
  error,
}: {
  lp: ResolvedLanding;
  storeName: string;
  /** Link back to the store (host root or /s/<slug>). */
  storeHome: string;
  imageSrc: (m: StoreMedia) => string;
  order: { store: string; signals: BrowserSignals | null } & ({ action: (f: FormData) => Promise<void>; preview?: false } | { action?: undefined; preview: true });
  error?: string | string[];
}) {
  const { design, blocks } = lp.document;
  const hasOrder = blocks.some((b) => b.type === "order") && lp.product !== null;
  const img = (id: number | null) => (id ? lp.media.get(id) : undefined);
  const Img = ({ media, label, priority }: { media: StoreMedia | undefined; label: string; priority?: boolean }) =>
    media ? (
      // eslint-disable-next-line @next/next/no-img-element -- local-disk media, no optimizer in this build
      <img src={imageSrc(media)} alt={media.alt} width={media.width} height={media.height} loading={priority ? "eager" : "lazy"} decoding="async" fetchPriority={priority ? "high" : "auto"} className="lp-img" />
    ) : (
      <div role="img" aria-label={label} className="lp-img flex aspect-[4/3] items-center justify-center">
        <ImageIcon className="size-8 opacity-40" aria-hidden />
      </div>
    );

  return (
    <div className="lp flex flex-1 flex-col" data-accent={design.accent} data-scale={design.fontScale} data-testid="lp-root">
      <a href="#lp-main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2">Langsung ke konten</a>
      <header className="lp-wrap flex items-center justify-between gap-3 py-4">
        <Link href={storeHome} className="lp-link lp-sm inline-flex min-h-7 items-center py-1 font-semibold no-underline">{storeName}</Link>
        {hasOrder && <a href="#order" className="lp-btn lp-sm min-h-[2.5em] px-4">Pesan</a>}
      </header>
      <main id="lp-main" tabIndex={-1} className="flex-1">
        {error && (
          <div className="lp-wrap">
            <p role="alert" className="lp-sm rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-red-800">{typeof error === "string" ? error : error[0]}</p>
          </div>
        )}
        {blocks.map((b, i) => (
          <Block key={b.id} block={b} first={i === 0} hasOrder={hasOrder} img={img} Img={Img} lp={lp} order={order} />
        ))}
      </main>
      <footer className="lp-wrap lp-xs lp-muted flex flex-wrap items-center justify-between gap-2 border-t py-6">
        <Link href={storeHome} className="lp-link inline-flex min-h-6 items-center py-1">{storeName}</Link>
        <span>Ditenagai Bukalaris</span>
      </footer>
    </div>
  );
}

type ImgFn = (p: { media: StoreMedia | undefined; label: string; priority?: boolean }) => React.ReactNode;

function Block({
  block: b,
  first,
  hasOrder,
  img,
  Img,
  lp,
  order,
}: {
  block: LandingBlock;
  first: boolean;
  hasOrder: boolean;
  img: (id: number | null) => StoreMedia | undefined;
  Img: ImgFn;
  lp: ResolvedLanding;
  order: Parameters<typeof LandingRenderer>[0]["order"];
}) {
  switch (b.type) {
    case "hero":
      return (
        <section className="lp-wrap grid gap-6 py-8" aria-labelledby={`h-${b.id}`}>
          <div className="grid gap-4">
            <h1 id={`h-${b.id}`} className="lp-h1">{b.headline}</h1>
            {b.subheadline && <p className="lp-lead">{b.subheadline}</p>}
            {hasOrder && b.ctaLabel && (
              <div>
                <a href="#order" className="lp-btn">{b.ctaLabel}</a>
              </div>
            )}
          </div>
          {b.mediaId && <Img media={img(b.mediaId)} label="Gambar utama belum tersedia" priority={first} />}
        </section>
      );
    case "text":
      return (
        <section className="lp-wrap py-6">
          <MarkdownLite body={b.body} />
        </section>
      );
    case "image":
      return (
        <figure className="lp-wrap grid gap-2 py-6">
          <Img media={img(b.mediaId)} label={b.caption || "Gambar belum tersedia"} />
          {b.caption && <figcaption className="lp-sm lp-muted">{b.caption}</figcaption>}
        </figure>
      );
    case "benefits":
      return (
        <section className="lp-wrap grid gap-5 py-8" aria-labelledby={b.title ? `h-${b.id}` : undefined}>
          {b.title && <h2 id={`h-${b.id}`} className="lp-h2">{b.title}</h2>}
          <ul className="grid gap-3 sm:grid-cols-2">
            {b.items.map((it, i) => (
              <li key={i} className="lp-card grid gap-1 p-4">
                <span className="lp-eyebrow">{String(i + 1).padStart(2, "0")}</span>
                <strong>{it.title}</strong>
                {it.body && <p className="lp-sm lp-muted">{it.body}</p>}
              </li>
            ))}
          </ul>
        </section>
      );
    case "testimonials":
      return (
        <section className="lp-soft py-8" aria-labelledby={b.title ? `h-${b.id}` : undefined}>
          <div className="lp-wrap grid gap-5">
            {b.title && <h2 id={`h-${b.id}`} className="lp-h2">{b.title}</h2>}
            <ul className="grid gap-3">
              {b.items.map((it, i) => (
                <li key={i} className="lp-card grid gap-2 p-4">
                  <blockquote className="text-pretty">“{it.quote}”</blockquote>
                  {(it.name || it.note) && (
                    <p className="lp-sm lp-muted">
                      {it.name && <strong className="font-semibold text-current">{it.name}</strong>}
                      {it.name && it.note && " · "}
                      {it.note}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>
      );
    case "faq":
      return (
        <section className="lp-wrap grid gap-4 py-8" aria-labelledby={b.title ? `h-${b.id}` : undefined}>
          {b.title && <h2 id={`h-${b.id}`} className="lp-h2">{b.title}</h2>}
          <div className="lp-faq">
            {b.items.map((it, i) => (
              <details key={i}>
                <summary>{it.q}</summary>
                <MarkdownLite body={it.a} className="lp-sm" />
              </details>
            ))}
          </div>
        </section>
      );
    case "cta":
      return (
        <section className="lp-wrap grid justify-items-start gap-3 py-8">
          {b.note && <p className="lp-lead">{b.note}</p>}
          {hasOrder ? <a href="#order" className="lp-btn">{b.label}</a> : <span className="lp-btn" aria-disabled="true">{b.label}</span>}
        </section>
      );
    case "order": {
      const p = lp.product;
      return (
        <section id="order" className="lp-wrap scroll-mt-4 py-8" aria-labelledby={`h-${b.id}`}>
          <div className="lp-card lp-accent-border grid gap-5 border-2 p-5 sm:p-6">
            <div className="grid gap-1">
              <p className="lp-eyebrow">Pemesanan</p>
              <h2 id={`h-${b.id}`} className="lp-h2">{b.title}</h2>
              {p && <p className="lp-muted">{p.title}</p>}
              {b.note && <p className="lp-sm lp-muted">{b.note}</p>}
            </div>
            {!p || p.status !== "active" ? (
              <p role="status" className="lp-soft rounded-xl p-4 font-medium">Produk ini sedang tidak tersedia.</p>
            ) : order.preview ? (
              <>
                <OrderForm store={order.store} variants={p.variants} signals={null} preview />
                <p id="lp-preview-note" className="lp-xs lp-muted">Pratinjau: tombol pemesanan nonaktif.</p>
              </>
            ) : (
              <OrderForm action={order.action} store={order.store} variants={p.variants} signals={order.signals} />
            )}
          </div>
        </section>
      );
    }
  }
}
