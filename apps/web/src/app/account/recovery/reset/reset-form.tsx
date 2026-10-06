"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authPost } from "@/lib/auth-client";
import Link from "next/link";
import { useState } from "react";

export function ResetForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "pending" | "done" | "expired">("idle");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const newPassword = String(f.get("password") ?? "");
    if (newPassword !== f.get("confirm")) return setError("Konfirmasi kata sandi tidak sama.");
    setError(null);
    setState("pending");
    const res = await authPost("/reset-password", { newPassword, token });
    if (res.ok) return setState("done");
    if (res.code === "INVALID_TOKEN") return setState("expired");
    setState("idle");
    setError(
      res.status === 429
        ? "Terlalu banyak percobaan. Coba lagi sebentar lagi."
        : res.code === "PASSWORD_TOO_SHORT"
          ? "Kata sandi minimal 8 karakter."
          : res.code === "PASSWORD_TOO_LONG"
            ? "Kata sandi terlalu panjang."
            : "Kata sandi gagal diubah. Coba lagi.",
    );
  }

  if (state === "done")
    return (
      <>
        <p role="status" className="rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300">
          Kata sandi berhasil diubah. Semua sesi lama telah dikeluarkan.
        </p>
        <Link href="/login" className="text-sm underline-offset-4 hover:underline">Masuk dengan kata sandi baru</Link>
      </>
    );
  if (state === "expired")
    return (
      <>
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          Tautan sudah kedaluwarsa atau sudah dipakai.
        </p>
        <Link href="/account/recovery" className="text-sm underline-offset-4 hover:underline">Minta tautan baru</Link>
      </>
    );

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      {error && (
        <p id="reset-error" role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
      )}
      <div className="grid gap-2">
        <Label htmlFor="password">Kata sandi baru</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required aria-describedby="password-hint" />
        <p id="password-hint" className="text-xs text-muted-foreground">Minimal 8 karakter.</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="confirm">Ulangi kata sandi baru</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required aria-describedby={error ? "reset-error" : undefined} aria-invalid={!!error} />
      </div>
      <Button type="submit" disabled={state === "pending"}>{state === "pending" ? "Menyimpan…" : "Simpan kata sandi"}</Button>
    </form>
  );
}
