import { NavLink } from "@/components/nav-link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "cn";
import Link from "next/link";
import type { ReactNode } from "react";

export type NavItem = { href: string; label: string; external?: boolean };

/**
 * Shared operator shell for Seller Admin (`tone="seller"`) and Super Admin (`tone="platform"`, dark header
 * so an operator always knows which console they are in). One layout: skip link → brand + account row →
 * context row (store or platform) + navigation strip → main. The strip scrolls horizontally inside the
 * header on narrow screens, so the page never overflows at 320 CSS px (NFR-3).
 */
export function AdminShell({
  tone,
  brand,
  home,
  nav,
  context,
  email,
  signOut,
  children,
}: {
  tone: "seller" | "platform";
  brand: string;
  home: string;
  nav: NavItem[];
  /** Persistent scope indicator (store name + role, or the platform label), plus the switcher when there is one. */
  context?: ReactNode;
  email: string;
  signOut: (f: FormData) => Promise<void>;
  children: ReactNode;
}) {
  const platform = tone === "platform";
  return (
    <div className="flex flex-1 flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Lewati ke konten utama
      </a>
      <header className={cn("border-b", platform ? "bg-foreground text-background" : "bg-background")}>
        <div className="mx-auto w-full max-w-6xl px-4">
          <div className="flex h-12 items-center gap-3">
            <Link href={home} className="flex min-w-0 items-baseline gap-1.5 rounded-sm font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              Bukalaris
              <span className={cn("truncate text-sm font-normal", platform ? "opacity-70" : "text-muted-foreground")}>{brand}</span>
            </Link>
            <div className="ml-auto flex min-w-0 items-center gap-2 text-sm">
              <span className={cn("truncate max-md:hidden", platform ? "opacity-70" : "text-muted-foreground")}>{email}</span>
              <form action={signOut}>
                <button type="submit" className={cn(buttonVariants({ variant: platform ? "secondary" : "ghost", size: "sm" }))}>
                  Keluar
                </button>
              </form>
            </div>
          </div>
          {(nav.length > 0 || context) && (
            <div className="flex flex-col md:flex-row md:items-center md:gap-6">
              {context && <div className={cn("flex items-center gap-2 py-1.5 text-sm md:order-last md:ml-auto md:py-0", platform && "opacity-90")}>{context}</div>}
              {nav.length > 0 && (
                <nav aria-label={platform ? "Super Admin" : "Seller"} className="relative -mx-4 flex min-w-0 gap-x-4 overflow-x-auto px-4 [scrollbar-width:none] md:flex-wrap md:overflow-visible [&::-webkit-scrollbar]:hidden">
                  {nav.map((item) =>
                    item.external ? (
                      <a key={item.href} href={item.href} className="inline-flex h-10 shrink-0 items-center px-1 text-sm whitespace-nowrap opacity-70 outline-none hover:opacity-100 focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50">
                        {item.label}
                      </a>
                    ) : (
                      <NavLink key={item.href} href={item.href}>
                        {item.label}
                      </NavLink>
                    ),
                  )}
                </nav>
              )}
            </div>
          )}
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none sm:py-8">
        {children}
      </main>
    </div>
  );
}

/** Denial/blocked panel rendered by a layout when the shell has no scope to show pages for. */
export function ShellNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="alert" className="mx-auto max-w-xl rounded-lg border p-6">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
