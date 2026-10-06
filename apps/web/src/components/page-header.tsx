import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Page header pattern for Seller and Super Admin: optional back link, one h1 (with optional inline badge),
 * a one-line description and the primary action. On narrow screens the action drops under the title.
 */
export function PageHeader({
  title,
  badge,
  description,
  action,
  back,
}: {
  title: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="grid gap-3 sm:flex sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 grid gap-1">
        {back && (
          <Link href={back.href} className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            <ArrowLeftIcon className="size-3.5" aria-hidden />
            {back.label}
          </Link>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="min-w-0 text-xl font-semibold tracking-tight text-balance sm:text-2xl">{title}</h1>
          {badge}
        </div>
        {/* Descriptions carry URLs and ids: let any token break rather than widen the page at 320 px. */}
        {description && <p className="max-w-prose text-sm text-muted-foreground text-pretty [overflow-wrap:anywhere]">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </header>
  );
}
