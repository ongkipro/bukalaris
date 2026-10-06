import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";

/**
 * Result banner for redirect-based form actions (`?error=` / `?saved=1`).
 * Exactly one `role="alert"` / `role="status"` per page: specs and screen readers both rely on that.
 */
export function Notice({ error, saved, savedText = "Tersimpan." }: { error?: string | string[]; saved?: string | string[]; savedText?: string }) {
  if (typeof error === "string")
    return (
      <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{error}</span>
      </p>
    );
  if (saved)
    return (
      <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-3 py-2.5 text-sm text-emerald-800 dark:text-emerald-300">
        <CircleCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{savedText}</span>
      </p>
    );
  return null;
}

/** Legacy class for storefront quantity inputs (content track); seller/admin use `<Input>`/`<NativeSelect>`. */
export const fieldClass = "h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm";
