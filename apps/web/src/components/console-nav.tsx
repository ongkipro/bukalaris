"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type ConsoleNavItem = { href: string; label: string };
export type ConsoleNavGroup = { label: string; items: ConsoleNavItem[] };

/**
 * UX-22 grouped navigation. The server passes only groups that have at least one item the operator may open, so an empty
 * group can never render. The active group (the one whose item is the longest match of the pathname) shows its items in a
 * second row. Both rows wrap instead of scrolling, so nothing is clipped at 320 CSS px; the page never overflows (NFR-3).
 */
export function ConsoleNav({ groups, label }: { groups: ConsoleNavGroup[]; label: string }) {
  const pathname = usePathname();
  const matches = groups.flatMap((g) => g.items.map((item) => ({ group: g, item })).filter(({ item }) => pathname === item.href || (item.href !== "/admin" && pathname.startsWith(`${item.href}/`))));
  const best = matches.sort((a, b) => b.item.href.length - a.item.href.length)[0];
  const activeGroup = best?.group ?? null;
  const link = "inline-flex min-h-10 items-center border-b-2 border-transparent px-1 text-sm whitespace-nowrap transition-colors outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50";
  return (
    <nav aria-label={label} className="grid gap-x-4">
      <ul className="flex flex-wrap gap-x-4">
        {groups.map((g) => {
          const active = g === activeGroup;
          return (
            <li key={g.label}>
              <Link href={g.items[0]!.href} aria-current={active && best?.item.href === g.items[0]!.href ? "page" : undefined} data-group-active={active ? "true" : undefined} className={cn(link, active ? "border-current font-medium" : "opacity-70 hover:opacity-100")}>
                {g.label}
              </Link>
            </li>
          );
        })}
      </ul>
      {activeGroup && (
        <ul aria-label={`Menu ${activeGroup.label}`} className="flex flex-wrap gap-x-4 border-t border-white/15 pt-0.5">
          {activeGroup.items.map((item) => {
            const current = best?.item.href === item.href;
            return (
              <li key={item.href}>
                <Link href={item.href} aria-current={current ? "page" : undefined} className={cn(link, "text-[0.8125rem]", current ? "border-current font-medium" : "opacity-70 hover:opacity-100")}>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
