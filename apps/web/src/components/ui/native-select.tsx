import * as React from "react"
import { cn } from "cn"
import { ChevronDownIcon } from "lucide-react"

/** A native `<select>` (works without JS, submits with the form) styled like `<Input>`. */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <span className={cn("relative inline-flex w-full min-w-0", className)}>
      <select
        data-slot="native-select"
        className="h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm dark:bg-input/30 [&>option]:bg-background [&>option]:text-foreground"
        {...props}
      />
      <ChevronDownIcon aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
    </span>
  )
}

export { NativeSelect }
