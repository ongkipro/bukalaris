"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authPost } from "@/lib/auth-client";
import { useState } from "react";

const RESET_PATH = "/account/recovery/reset";

export function RecoveryForm() {
  const [state, setState] = useState<"idle" | "pending" | "sent" | "throttled" | "offline">("idle");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("pending");
    const email = new FormData(e.currentTarget).get("email");
    // Better Auth answers 200 whether or not the account exists; the UI never distinguishes either.
    const res = await authPost("/request-password-reset", { email, redirectTo: RESET_PATH });
    setState(res.status === 429 ? "throttled" : res.status === 0 ? "offline" : "sent");
  }

  if (state === "sent")
    return (
      <p role="status" className="rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300">
        Jika email tersebut terdaftar, tautan pengaturan ulang sudah dikirim. Periksa kotak masuk Anda; tautan berlaku 60 menit.
      </p>
    );

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      {state === "throttled" && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          Terlalu banyak permintaan. Coba lagi dalam satu menit.
        </p>
      )}
      {state === "offline" && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">Tidak dapat terhubung. Coba lagi.</p>
      )}
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <Button type="submit" disabled={state === "pending"}>{state === "pending" ? "Mengirim…" : "Kirim tautan"}</Button>
    </form>
  );
}
