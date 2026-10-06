import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/lib/status";
import type { ComponentProps } from "react";

/** One badge for every enum: `label` and `tone` come from `@/lib/status`, never from a raw value. */
export function StatusBadge({ label, tone, ...props }: { label: string; tone: Tone } & Omit<ComponentProps<typeof Badge>, "variant" | "children">) {
  return (
    <Badge variant={tone} {...props}>
      {label}
    </Badge>
  );
}
