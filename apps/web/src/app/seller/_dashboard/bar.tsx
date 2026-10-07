// Horizontal bar whose length is a share of the group's maximum. The nonce CSP (T-29) forbids
// inline `style=`, so the width is one of 21 literal Tailwind classes (5 % steps); Tailwind only
// emits classes it can see in source, hence the spelled-out list. Bars start at zero and are
// decoration: the number next to each bar is the data.
const WIDTHS = [
  "w-0",
  "w-[5%]",
  "w-[10%]",
  "w-[15%]",
  "w-[20%]",
  "w-[25%]",
  "w-[30%]",
  "w-[35%]",
  "w-[40%]",
  "w-[45%]",
  "w-[50%]",
  "w-[55%]",
  "w-[60%]",
  "w-[65%]",
  "w-[70%]",
  "w-[75%]",
  "w-[80%]",
  "w-[85%]",
  "w-[90%]",
  "w-[95%]",
  "w-full",
] as const;

export function Bar({ value, max }: { value: number; max: number }) {
  // A non-zero value always shows at least one step so a 1 % share is not invisible.
  const step = max <= 0 || value <= 0 ? 0 : Math.max(1, Math.round((value / max) * 20));
  return (
    <span aria-hidden className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <span className={`block h-full rounded-full bg-foreground/80 ${WIDTHS[step]}`} />
    </span>
  );
}
