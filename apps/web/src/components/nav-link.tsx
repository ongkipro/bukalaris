"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * Admin navigation item: `aria-current="page"` on the active section (exact match or a sub-route), and
 * the active item centres itself when the strip overflows on narrow screens. Done through the strip's
 * `scrollLeft`, not `scrollIntoView()`: the latter moves Chrome's sequential-focus starting point to the
 * item, so the first Tab would skip the skip link.
 */
export function NavLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const pathname = usePathname();
  const ref = useRef<HTMLAnchorElement>(null);
  // "/seller/products" is active for "/seller/products/12", but "/admin" only for "/admin" itself.
  const root = href.split("/").length <= 2;
  const current = pathname === href || (!root && pathname.startsWith(`${href}/`));
  useEffect(() => {
    const el = ref.current;
    const strip = el?.parentElement;
    if (!current || !el || !strip || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2;
  }, [current]);
  return (
    <Link
      ref={ref}
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "inline-flex h-10 shrink-0 scroll-mx-4 items-center border-b-2 border-transparent px-1 text-sm whitespace-nowrap transition-colors outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50",
        current ? "border-current font-medium" : "opacity-70 hover:opacity-100",
        className,
      )}
    >
      {children}
    </Link>
  );
}
