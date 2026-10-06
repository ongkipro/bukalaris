"use client";

import { Button } from "@/components/ui/button";
import type { ComponentProps } from "react";

/** Submit button that asks for confirmation first (destructive actions). The server re-validates regardless. */
export function ConfirmSubmit({ message, ...props }: { message: string } & ComponentProps<typeof Button>) {
  return (
    <Button
      type="submit"
      {...props}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    />
  );
}
