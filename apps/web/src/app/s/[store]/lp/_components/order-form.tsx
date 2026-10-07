"use client";

import { ensureInit, fire } from "@/components/pixels/runtime";
import { rupiah } from "@/lib/format";
import type { BrowserSignals } from "@bukalaris/db";
import { useRef } from "react";
import { useFormStatus } from "react-dom";

export type OrderVariant = { id: number; catalogId: string; title: string; price: number; stock: number };

/**
 * Platform order component of a landing page (UI-4 "locked element"): variant + quantity
 * only, no buyer fields. The Server Action adds the line to the store cart and hands off to
 * hosted checkout; before the page unloads, the AddToCart browser leg fires with the id the
 * server leg receives (`/api/signals`, keepalive), mirroring the storefront cart page (T-38).
 */
export function OrderForm({
  action,
  store,
  variants,
  signals,
  preview,
}: {
  action?: (f: FormData) => Promise<void>;
  store: string;
  variants: OrderVariant[];
  signals: BrowserSignals | null;
  /** Seller preview: real controls, no submission. */
  preview?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const sellable = variants.filter((v) => v.stock > 0);
  const first = sellable[0];
  if (!first) return <p role="status" className="lp-card lp-soft p-4 font-medium">Stok habis. Hubungi penjual untuk informasi stok berikutnya.</p>;

  const onSubmit = () => {
    if (!signals) return;
    const f = formRef.current;
    if (!f) return;
    const variantId = Number(new FormData(f).get("variantId"));
    const quantity = Math.min(Math.max(Number(new FormData(f).get("quantity")) || 1, 1), 99);
    const v = variants.find((x) => x.id === variantId);
    if (!v) return;
    const eventId = crypto.randomUUID();
    ensureInit(signals);
    fire("AddToCart", eventId, { items: [{ id: v.catalogId, quantity, price: v.price }], value: v.price * quantity });
    void fetch("/api/signals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ store, event: "AddToCart", eventId, items: [{ id: v.catalogId, quantity }], url: location.href }),
    }).catch(() => {});
  };

  return (
    <form ref={formRef} action={preview ? undefined : action} onSubmit={preview ? (e) => e.preventDefault() : onSubmit} className="grid gap-5">
      <fieldset className="grid gap-2">
        <legend className="lp-sm mb-2 font-semibold">Pilih varian</legend>
        {variants.map((v) => (
          <label key={v.id} className="lp-option">
            <input type="radio" name="variantId" value={v.id} defaultChecked={v.id === first.id} disabled={v.stock === 0} required />
            <span className="flex-1 font-medium">{v.title}</span>
            <span className="tabular-nums">{rupiah(v.price)}</span>
            <span className="lp-xs lp-muted">{v.stock > 0 ? `stok ${v.stock}` : "habis"}</span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid w-24 gap-1.5">
          <label htmlFor="lp-qty" className="lp-sm font-semibold">Jumlah</label>
          <input id="lp-qty" name="quantity" type="number" inputMode="numeric" min={1} max={99} defaultValue={1} required className="lp-field" />
        </div>
        <Submit preview={preview} />
      </div>
      <p className="lp-xs lp-muted">Alamat, kurir dan pembayaran diisi di halaman checkout Bukalaris. Harga dan stok dicek ulang oleh server.</p>
    </form>
  );
}

function Submit({ preview }: { preview?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="lp-btn flex-1" disabled={pending || preview} aria-busy={pending || undefined} aria-describedby={preview ? "lp-preview-note" : undefined}>
      {pending ? "Menyiapkan checkout…" : "Lanjut ke checkout"}
    </button>
  );
}
