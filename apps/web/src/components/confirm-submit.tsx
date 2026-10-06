"use client";

import { Button } from "@/components/ui/button";
import type { ComponentProps } from "react";

/**
 * Submit button for destructive actions: a native confirm names the object before the form posts.
 * `onlyWhen={{ field, equals }}` makes one form confirm only for its destructive branch (e.g. the role
 * select set to "remove"); declarative because server components cannot pass functions to client ones.
 * The server re-validates regardless; this is a guard against slips, not authorization.
 */
export function ConfirmSubmit({ message, onlyWhen, ...props }: { message: string; onlyWhen?: { field: string; equals: string } } & ComponentProps<typeof Button>) {
  return (
    <Button
      type="submit"
      {...props}
      onClick={(e) => {
        if (onlyWhen) {
          const control = e.currentTarget.form?.elements.namedItem(onlyWhen.field);
          const value = control && "value" in control ? String((control as { value: unknown }).value) : undefined;
          if (value !== onlyWhen.equals) return;
        }
        if (!window.confirm(message)) e.preventDefault();
      }}
    />
  );
}
