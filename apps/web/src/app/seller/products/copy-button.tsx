"use client";

import { Button } from "@/components/ui/button";
import { useState } from "react";

/** Copies a catalog id or URL; the outcome is announced politely without claiming the page's status role (UX-9). */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        size="xs"
        variant="outline"
        aria-label={`Salin ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState("done");
          } catch {
            setState("failed");
          }
          setTimeout(() => setState("idle"), 2000);
        }}
      >
        Salin
      </Button>
      <span aria-live="polite" className="text-xs text-muted-foreground">
        {state === "done" ? "Tersalin." : state === "failed" ? "Gagal menyalin." : ""}
      </span>
    </span>
  );
}
