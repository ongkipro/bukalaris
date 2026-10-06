"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authPost } from "@/lib/auth-client";
import { useState } from "react";
import { acceptAsNewAccount } from "../actions";

/** Creates the account while consuming the invitation, then signs in via the HTTP route (rate limited). */
export function NewAccountForm({ token, email }: { token: string; email: string }) {
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "pending" | "created">("idle");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setState("pending");
    const f = new FormData(e.currentTarget);
    const result = await acceptAsNewAccount(token, f);
    if (!result.ok) {
      setState("idle");
      return setError(result.error);
    }
    setState("created");
    const signIn = await authPost("/sign-in/email", { email: result.email, password: f.get("password") });
    // The account exists either way; if sign-in is throttled, the login page finishes the job.
    window.location.assign(signIn.ok ? "/seller/products?saved=1" : "/login?next=/seller");
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <p className="text-sm text-muted-foreground">Belum ada akun untuk alamat ini. Buat kata sandi untuk menyelesaikan pendaftaran.</p>
      {error && (
        <p id="acc-error" role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
      )}
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={email} readOnly aria-readonly />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="name">Nama</Label>
        <Input id="name" name="name" autoComplete="name" minLength={2} maxLength={100} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">Kata sandi</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required aria-describedby="pw-hint" />
        <p id="pw-hint" className="text-xs text-muted-foreground">Minimal 8 karakter.</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="confirm">Ulangi kata sandi</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required aria-invalid={!!error} aria-describedby={error ? "acc-error" : undefined} />
      </div>
      <Button type="submit" disabled={state !== "idle"}>
        {state === "pending" ? "Membuat akun…" : state === "created" ? "Masuk…" : "Buat akun dan gabung"}
      </Button>
    </form>
  );
}
