import { Pixels } from "@/components/pixels/pixels";
import { cartCsrfToken } from "@/lib/auth-csrf";
import { CsrfProvider } from "@/lib/auth-csrf-form";
import { MessageCircleIcon, ShoppingBagIcon } from "lucide-react";
import Link from "next/link";
import { SearchForm } from "./_components/search-form";
import { storeShell, waLink } from "./_lib";

/**
 * Storefront shell (SF-01..06). The seller's theme only changes presentation:
 * `data-theme="mobile"` constrains the whole shell to a 480 CSS px column (PR-8, UI-5);
 * the responsive theme uses the wide product-first layout. Pages adapt through
 * container queries on <main>, so no page knows which theme is active.
 */
export default async function StoreLayout({ children, params }: LayoutProps<"/s/[store]">) {
  const { scope, base, profile, collections, pages, promo } = await storeShell((await params).store);
  const home = base || "/";
  const nav = [
    ...(promo ? [{ href: `${base}/promo`, label: "Promo" }] : []),
    ...collections.map((c) => ({ href: `${base}/collections/${c.slug}`, label: c.title })),
    ...pages.map((p) => ({ href: `${base}/pages/${p.slug}`, label: p.title })),
  ];
  return (
    <CsrfProvider token={await cartCsrfToken(scope)}>
    <div data-theme={profile.theme} className="sf flex flex-1 flex-col">
      <Pixels storeId={scope.storeId} />
      <a href="#sf-main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:ring-3 focus:ring-ring/50">
        Langsung ke konten
      </a>
      <div className="sf-shell flex min-h-dvh w-full flex-col bg-background">
        <header className="sf-header sticky top-0 z-20 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
          <div className="sf-wrap flex items-center gap-3 py-3">
            <Link href={home} className="min-w-0 truncate rounded-md text-lg font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              {scope.storeName}
            </Link>
            <div className="flex flex-1 justify-end">
              <SearchForm base={base} className="sf-search-top w-full max-w-xs" />
            </div>
            <Link
              href={`${base}/cart`}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ShoppingBagIcon className="size-4" aria-hidden />
              Keranjang
            </Link>
          </div>
          {nav.length > 0 && (
            <nav aria-label="Navigasi toko" className="sf-wrap -mt-1 overflow-x-auto pb-2 [scrollbar-width:none]">
              <ul className="flex gap-1 text-sm">
                {nav.map((item) => (
                  <li key={item.href} className="shrink-0">
                    <Link href={item.href} className="inline-block rounded-full px-3 py-1.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </header>
        <main id="sf-main" tabIndex={-1} className="sf-wrap @container flex-1 py-6 outline-none">{children}</main>
        <footer className="border-t bg-muted/30">
          <div className="sf-wrap grid gap-4 py-6 text-sm text-muted-foreground">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-medium text-foreground">{scope.storeName}</p>
              {profile.whatsapp && (
                <a
                  href={waLink(profile.whatsapp, scope.storeName)}
                  rel="noopener noreferrer"
                  target="_blank"
                  className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <MessageCircleIcon className="size-4" aria-hidden />
                  Tanya via WhatsApp
                </a>
              )}
            </div>
            {pages.length > 0 && (
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {pages.map((p) => (
                  <li key={p.id}>
                    <Link href={`${base}/pages/${p.slug}`} className="inline-flex min-h-6 items-center rounded-sm py-1 underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">{p.title}</Link>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs">Ditenagai Bukalaris</p>
          </div>
        </footer>
      </div>
    </div>
    </CsrfProvider>
  );
}
