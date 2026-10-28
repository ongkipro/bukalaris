"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rupiah } from "@/lib/format";
import { useRef, useState, useTransition } from "react";
import { previewVoucher, type VoucherPreview } from "./actions";

/** Voucher code lives inside the checkout form (it is submitted and validated again by the server). The preview is optional and read-only. */
export function VoucherField() {
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<VoucherPreview | null>(null);
  const [pending, start] = useTransition();
  const apply = () => {
    const form = input.current?.form;
    if (!form) return;
    const data = new FormData(form);
    start(async () => setResult(await previewVoucher(data)));
  };
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 font-medium">5. Voucher</legend>
      <Label htmlFor="voucherCode">Kode voucher (opsional)</Label>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <Input ref={input} id="voucherCode" name="voucherCode" autoComplete="off" autoCapitalize="characters" maxLength={64} aria-describedby="voucher-help voucher-result" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } }} />
        <Button type="button" variant="outline" onClick={apply} disabled={pending}>{pending ? "Memeriksa…" : "Terapkan voucher"}</Button>
      </div>
      <p id="voucher-help" className="text-xs text-muted-foreground">Isi nomor HP dan pilih kurir lebih dulu. Pemeriksaan tidak mengubah keranjang; server memeriksa ulang saat pesanan dibuat.</p>
      <div id="voucher-result" aria-live="polite" data-testid="voucher-result">
        {result && ("error" in result ? <p role="alert" className="text-sm text-destructive">{result.error}</p> : (
          <dl className="grid gap-1 rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between gap-4"><dt>Subtotal barang</dt><dd className="tabular-nums">{rupiah(result.subtotal)}</dd></div>
            <div className="flex justify-between gap-4"><dt>Diskon barang</dt><dd data-testid="goods-discount" className="tabular-nums">−{rupiah(result.goodsDiscount)}</dd></div>
            <div className="flex justify-between gap-4"><dt>Diskon ongkir</dt><dd data-testid="shipping-discount" className="tabular-nums">−{rupiah(result.shippingDiscount)}</dd></div>
            <div className="flex justify-between gap-4"><dt>Ongkir dibayar</dt><dd className="tabular-nums">{rupiah(result.shipping)}</dd></div>
            <div className="flex justify-between gap-4 border-t pt-1 font-medium"><dt>Total</dt><dd data-testid="promo-total" className="tabular-nums">{rupiah(result.total)}</dd></div>
          </dl>
        ))}
      </div>
    </fieldset>
  );
}
