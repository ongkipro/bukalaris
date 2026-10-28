"use client";

import { useEffect, useState } from "react";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Live countdown to the server-stated end of a flash sale (UX-16). The server text ("Berakhir …") stays in the markup for no-JS
 * readers; this only adds the remaining time. It is a timer role without a live region: a screen reader is never interrupted every second.
 * The end instant is advisory display only: checkout re-reads the database clock, so a skewed device clock never changes a price.
 */
export function Countdown({ endsAtIso }: { endsAtIso: string }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const end = new Date(endsAtIso).getTime();
    const tick = () => setLeft(Math.max(0, end - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endsAtIso]);
  if (left === null) return null;
  if (left === 0) return <span data-testid="countdown">Flash sale berakhir. Muat ulang halaman untuk harga terbaru.</span>;
  const s = Math.floor(left / 1000);
  const days = Math.floor(s / 86_400);
  return (
    <span role="timer" data-testid="countdown" className="tabular-nums">
      Sisa waktu {days > 0 ? `${days} hari ` : ""}{pad(Math.floor((s % 86_400) / 3600))}:{pad(Math.floor((s % 3600) / 60))}:{pad(s % 60)}
    </span>
  );
}
