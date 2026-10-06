"use client";

import { Button } from "@/components/ui/button";
import { useState } from "react";

/** Copies a safe identifier; the result is announced to assistive technology (UX-9). */
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
      <span role="status" className="text-xs text-muted-foreground">
        {state === "done" ? "Tersalin." : state === "failed" ? "Gagal menyalin." : ""}
      </span>
    </span>
  );
}
