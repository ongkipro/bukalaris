import { buttonVariants } from "@/components/ui/button";
import { PERIODS, type Period } from "@bukalaris/db";
import Link from "next/link";

export const PERIOD_LABEL: Record<Period, string> = { today: "Hari ini", "7d": "7 hari", "30d": "30 hari" };

/** URL-addressable period (`?period=`): plain links, so the keyboard path is Tab + Enter and the choice is shareable. */
export function PeriodSwitcher({ period }: { period: Period }) {
  return (
    <nav aria-label="Periode" className="flex flex-wrap gap-2 text-sm">
      {PERIODS.map((p) => (
        <Link key={p} href={p === "today" ? "/seller" : `/seller?period=${p}`} aria-current={p === period ? "page" : undefined} className={buttonVariants({ variant: p === period ? "default" : "outline", size: "sm" })}>
          {PERIOD_LABEL[p]}
        </Link>
      ))}
    </nav>
  );
}
