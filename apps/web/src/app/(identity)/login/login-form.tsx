"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authPost } from "@/lib/auth-client";
import Link from "next/link";
import { useState } from "react";

// Posts to Better Auth's HTTP endpoints (not auth.api in a Server Action) so its
// origin check and sign-in / two-factor rate limiting apply.
export function LoginForm({ next }: { next: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [step, setStep] = useState<"password" | "totp" | "backup">("password");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const res =
      step === "password"
        ? await authPost("/sign-in/email", { email: f.get("email"), password: f.get("password") })
        : step === "totp"
          ? await authPost("/two-factor/verify-totp", { code: String(f.get("code") ?? "").replace(/\s/g, "") })
          : await authPost("/two-factor/verify-backup-code", { code: String(f.get("code") ?? "").trim() });
    if (res.ok && step === "password" && (res.data as { twoFactorRedirect?: boolean })?.twoFactorRedirect) {
      setPending(false);
      setStep("totp");
      return;
    }
    if (res.ok) return window.location.assign(next);
    setPending(false);
    // Same message for unknown email and wrong password (no account enumeration).
    setError(
      res.status === 429
        ? "Terlalu banyak percobaan. Coba lagi sebentar lagi."
        : res.status === 0
          ? "Tidak dapat terhubung. Coba lagi."
          : step === "password"
            ? "Email atau kata sandi salah."
            : res.status === 401 && res.code === "INVALID_TWO_FACTOR_COOKIE"
              ? "Sesi verifikasi habis. Masuk ulang dari awal."
              : "Kode tidak valid.",
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {step === "password" ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Kata sandi</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <Button type="submit" disabled={pending}>{pending ? "Memproses…" : "Masuk"}</Button>
          <Link href="/account/recovery" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Lupa kata sandi?
          </Link>
        </>
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {step === "totp"
              ? "Akun ini memakai verifikasi dua langkah. Masukkan kode 6 digit dari aplikasi autentikator."
              : "Masukkan salah satu kode cadangan yang Anda simpan saat mengaktifkan verifikasi dua langkah."}
          </p>
          <div className="grid gap-2">
            <Label htmlFor="code">{step === "totp" ? "Kode autentikator" : "Kode cadangan"}</Label>
            <Input
              id="code"
              name="code"
              inputMode={step === "totp" ? "numeric" : "text"}
              autoComplete="one-time-code"
              pattern={step === "totp" ? "[0-9 ]{6,7}" : undefined}
              required
              autoFocus
            />
          </div>
          <Button type="submit" disabled={pending}>{pending ? "Memeriksa…" : "Verifikasi"}</Button>
          <button
            type="button"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => {
              setError(null);
              setStep(step === "totp" ? "backup" : "totp");
            }}
          >
            {step === "totp" ? "Gunakan kode cadangan" : "Gunakan aplikasi autentikator"}
          </button>
        </>
      )}
    </form>
  );
}
