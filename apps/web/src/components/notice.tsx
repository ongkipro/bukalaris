/** Result banner for redirect-based form actions (`?error=` / `?saved=1`). */
export function Notice({ error, saved }: { error?: string | string[]; saved?: string | string[] }) {
  if (typeof error === "string")
    return (
      <p role="alert" className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
        {error}
      </p>
    );
  if (saved)
    return (
      <p role="status" className="mb-4 rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300">
        Tersimpan.
      </p>
    );
  return null;
}

export const fieldClass = "h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm";
