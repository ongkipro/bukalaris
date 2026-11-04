"use client";

import { CsrfField } from "@/lib/auth-csrf-form";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActionState } from "react";
import { createChannelAction, type CreateChannelState } from "./actions";

export function CreateChannelForm() {
  const [state, action, pending] = useActionState<CreateChannelState, FormData>(createChannelAction, null);
  if (state?.token) {
    return (
      <section role="status" aria-labelledby="token-once" className="grid gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4">
        <h2 id="token-once" className="font-medium">Token channel &ldquo;{state.name}&rdquo; dibuat</h2>
        <p className="text-sm">
          Salin sekarang dan simpan di secret store backend storefront Anda. Token ini <strong>hanya ditampilkan sekali</strong>; jika hilang,
          buat channel pengganti lalu cabut yang lama.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code data-testid="channel-token" className="min-w-0 flex-1 overflow-x-auto rounded-md bg-background p-3 text-sm break-all select-all">{state.token}</code>
          <CopyButton value={state.token} label="token channel" />
        </div>
        <p className="text-xs text-muted-foreground">Prefix {state.prefix} muncul di daftar sebagai pengenal.</p>
      </section>
    );
  }
  return (
    <form action={action} className="grid gap-4 rounded-lg border bg-background p-4">
        <CsrfField />
      <h2 className="font-medium">Channel baru</h2>
      {state?.error && (
        <p id="ch-error" role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">{state.error}</p>
      )}
      <div className="grid gap-2">
        <Label htmlFor="ch-name">Nama</Label>
        <Input id="ch-name" name="name" required maxLength={100} placeholder="Storefront Cloudflare" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="ch-origin">Origin storefront</Label>
        <Input id="ch-origin" name="origin" type="url" required placeholder="https://toko.example" aria-describedby="ch-origin-help" />
        <p id="ch-origin-help" className="text-xs text-muted-foreground">Hanya skema dan host (https). Pembeli dikembalikan ke origin ini setelah checkout.</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="ch-return">Path kembali</Label>
        <Input id="ch-return" name="returnPath" defaultValue="/" pattern="/.*" maxLength={500} aria-describedby="ch-return-help" />
        <p id="ch-return-help" className="text-xs text-muted-foreground">Diawali “/”, mis. /thanks. Ditambahkan ke origin setelah checkout selesai.</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="ch-expires">Kedaluwarsa (opsional)</Label>
        <Input id="ch-expires" name="expiresAt" type="datetime-local" aria-describedby="ch-expires-help" />
        <p id="ch-expires-help" className="text-xs text-muted-foreground">Kosongkan agar token berlaku sampai dicabut.</p>
      </div>
      <Button type="submit" className="justify-self-start" disabled={pending} aria-busy={pending || undefined} aria-describedby={state?.error ? "ch-error" : undefined}>
        {pending ? "Membuat…" : "Buat channel"}
      </Button>
    </form>
  );
}
