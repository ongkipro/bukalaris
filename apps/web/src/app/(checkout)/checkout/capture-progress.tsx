"use client";

import { useEffect, useRef } from "react";
import { captureProgress } from "./actions";

const FIELDS = ["buyerName", "buyerPhone", "buyerEmail", "shippingAddress"] as const;
/** Quiet time after the last keystroke before the form state is reported. */
const DEBOUNCE_MS = 1500;

/**
 * T-45 (PR-25): reports the four contact fields of the checkout form once the buyer has typed and paused. Renders nothing. It listens only to `input`
 * events (so nothing is sent on page load, and nothing for a field the buyer never touched) and sends the four fields plus the store slug; the cart comes
 * from the HttpOnly cookie on the server. The notice that explains this sits next to the fields (`CaptureNotice`).
 */
export function CaptureProgress({ store }: { store: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    const send = () => {
      const data = new FormData();
      data.set("store", store);
      for (const k of FIELDS) data.set(k, String((form.elements.namedItem(k) as HTMLInputElement | null)?.value ?? ""));
      const body = FIELDS.map((k) => data.get(k)).join("\u0000");
      if (body === last) return;
      last = body;
      void captureProgress(data);
    };
    const onInput = (e: Event) => {
      const name = (e.target as HTMLInputElement | null)?.name;
      if (!(FIELDS as readonly string[]).includes(name ?? "")) return;
      clearTimeout(timer);
      timer = setTimeout(send, DEBOUNCE_MS);
    };
    form.addEventListener("input", onInput);
    return () => {
      form.removeEventListener("input", onInput);
      clearTimeout(timer);
    };
  }, [store]);
  return <span ref={anchor} hidden />;
}
