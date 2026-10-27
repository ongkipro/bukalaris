import { cn } from "cn";
import type { ReactNode } from "react";

const pct = new Intl.NumberFormat("id-ID", { style: "percent", maximumFractionDigits: 0 });
/** "—" when the denominator is zero: a rate over nothing is not 0 %. */
export const rate = (part: number, whole: number) => (whole > 0 ? pct.format(part / whole) : "—");
export const angka = (n: number) => new Intl.NumberFormat("id-ID").format(n);

/**
 * One KPI as a description-list pair: label, value (largest), one line of context that says what
 * the number is made of. Tiles are tinted only when they carry a decision (`tone="warning"` for
 * the work queue), never for decoration.
 */
export function Kpi({ label, value, hint, tone, testId }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "warning"; testId?: string }) {
  return (
    <div data-testid={testId} className={cn("grid content-start gap-1 rounded-lg border p-4", tone === "warning" && "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40")}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]">{value}</dd>
      {hint && <dd className="text-xs text-muted-foreground text-pretty">{hint}</dd>}
    </div>
  );
}
