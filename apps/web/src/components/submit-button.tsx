"use client";

import { Button } from "@/components/ui/button";
import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";

/**
 * Submit button with a pending state: label swaps to `pendingText`, the control is disabled and `aria-busy`
 * while the Server Action runs, so a slow save never looks like a dead click (UI-8 "button pending state").
 */
export function SubmitButton({ children, pendingText = "Menyimpan…", disabled, ...props }: ComponentProps<typeof Button> & { pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" {...props} disabled={disabled || pending} aria-busy={pending || undefined}>
      {pending ? pendingText : children}
    </Button>
  );
}
