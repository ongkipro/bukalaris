import { Badge } from "@/components/ui/badge";
import type { LogLevel } from "@bukalaris/db";

export const LEVEL_LABEL: Record<LogLevel, string> = { debug: "Debug", info: "Info", warn: "Peringatan", error: "Error", fatal: "Fatal" };
const LEVEL_VARIANT: Record<LogLevel, "secondary" | "outline" | "destructive"> = {
  debug: "outline",
  info: "secondary",
  warn: "outline",
  error: "destructive",
  fatal: "destructive",
};
export const LevelBadge = ({ level }: { level: LogLevel }) => (
  <Badge variant={LEVEL_VARIANT[level]} className={level === "warn" ? "border-amber-500/60 text-amber-700 dark:text-amber-300" : undefined}>
    {LEVEL_LABEL[level]}
  </Badge>
);

// Viewer timezone is unknown server-side; show one explicit zone (WIB) so operators never guess (UX-9).
const wib = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Jakarta" });
export const fmtTime = (d: Date) => `${wib.format(d)} WIB`;

/** `back` only ever re-enters the list with its own query string (no open redirect). */
export const safeBack = (back: unknown) => (typeof back === "string" && /^\?[A-Za-z0-9_=&%.:+-]{0,400}$/.test(back) ? `/admin/logs${back}` : "/admin/logs");
