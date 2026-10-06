"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";

// Posts to Better Auth's HTTP endpoint (not auth.api in a Server Action) so its
// origin check and sign-in rate limiting apply.
export function LoginForm({ next }: { next: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const res = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: f.get("email"), password: f.get("password") }),
    }).catch(() => null);
    if (res?.ok) return window.location.assign(next);
    setPending(false);
    // Same message for unknown email and wrong password (no account enumeration).
    setError(
      res?.status === 429
        ? "Terlalu banyak percobaan. Coba lagi sebentar lagi."
        : res
          ? "Email atau kata sandi salah."
          : "Tidak dapat terhubung. Coba lagi.",
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">Kata sandi</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <Button type="submit" disabled={pending}>{pending ? "Memproses…" : "Masuk"}</Button>
    </form>
  );
}
