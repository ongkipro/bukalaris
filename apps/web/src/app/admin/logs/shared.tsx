import { StatusBadge } from "@/components/status-badge";
import { logLevelLabel, logLevelTone } from "@/lib/status";
import type { LogLevel } from "@bukalaris/db";

export const LEVEL_LABEL = logLevelLabel;
export const LevelBadge = ({ level }: { level: LogLevel }) => <StatusBadge label={logLevelLabel[level]} tone={logLevelTone[level]} />;

// Viewer timezone is unknown server-side; show one explicit zone (WIB) so operators never guess (UX-9).
export { waktuLog as fmtTime } from "@/lib/format";

/** `back` only ever re-enters the list with its own query string (no open redirect). */
export const safeBack = (back: unknown) => (typeof back === "string" && /^\?[A-Za-z0-9_=&%.:+-]{0,400}$/.test(back) ? `/admin/logs${back}` : "/admin/logs");
