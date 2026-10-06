import type { ComponentProps, ReactNode } from "react";

/**
 * Empty list or no-result state: says why it is empty and what to do next. Rendered as paragraphs, not a
 * heading, so the page keeps exactly one h1 and role queries stay unambiguous.
 */
export function EmptyState({ title, children, action, ...props }: { title: string; children?: ReactNode; action?: ReactNode } & ComponentProps<"div">) {
  return (
    <div {...props} className="grid justify-items-start gap-2 rounded-lg border border-dashed px-5 py-8 sm:justify-items-center sm:text-center">
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-prose text-sm text-muted-foreground">{children}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
