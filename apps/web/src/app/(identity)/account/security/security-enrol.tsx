"use client";

import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authPost } from "@/lib/auth-client";
import Link from "next/link";
import { useState } from "react";

type Enrolment = { totpURI: string; backupCodes: string[] };

/**
 * TOTP enrolment through Better Auth's two-factor HTTP routes: password → secret +
 * backup codes → verify a code → done. The secret is shown as a manual key (no QR
 * encoder dependency); the otpauth URI is offered for apps that accept pasting.
 */
export function SecurityEnrol({ email, next }: { email: string; next: string }) {
  const [step, setStep] = useState<"password" | "verify" | "done">("password");
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await authPost("/two-factor/enable", { password: new FormData(e.currentTarget).get("password"), method: "totp" });
    setPending(false);
    if (!res.ok) return setError(res.status === 429 ? "Terlalu banyak percobaan. Coba lagi sebentar lagi." : "Kata sandi salah.");
    setEnrolment(res.data as Enrolment);
    setStep("verify");
  }

  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const code = String(new FormData(e.currentTarget).get("code") ?? "").replace(/\s/g, "");
    const res = await authPost("/two-factor/verify-totp", { code });
    if (!res.ok) {
      setPending(false);
      return setError(res.status === 429 ? "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi." : "Kode tidak cocok. Periksa jam perangkat dan coba kode berikutnya.");
    }
    // Sessions opened before enrolment never passed a second factor: drop them.
    await authPost("/revoke-other-sessions", {});
    setPending(false);
    setStep("done");
  }

  const secret = enrolment ? new URL(enrolment.totpURI).searchParams.get("secret") ?? "" : "";

  if (step === "done" && enrolment)
    return (
      <div className="grid gap-4">
        <p role="status" className="rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300">
          Verifikasi dua langkah aktif. Simpan kode cadangan di bawah ini di tempat aman; setiap kode hanya berlaku sekali dan tidak ditampilkan lagi.
        </p>
        <ul aria-label="Kode cadangan" className="grid grid-cols-2 gap-1 rounded-md border p-3 font-mono text-sm">
          {enrolment.backupCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CopyButton value={enrolment.backupCodes.join("\n")} label="semua kode cadangan" />
          <Link href={next} className="inline-flex min-h-6 w-fit items-center rounded-sm py-1 text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
            Lanjut ke {next === "/admin" ? "Owner console" : "Seller Admin"}
          </Link>
        </div>
      </div>
    );

  if (step === "verify" && enrolment)
    return (
      <form onSubmit={verify} className="grid gap-4">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Buka aplikasi autentikator (mis. Aegis, Google Authenticator, 1Password).</li>
          <li>
            Tambahkan akun secara manual untuk <span className="font-medium">{email}</span> dengan kunci berikut (berbasis waktu, 6 digit):
          </li>
        </ol>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-3">
          <p className="break-all font-mono text-sm" data-testid="totp-secret" aria-label="Kunci rahasia">
            {secret}
          </p>
          <CopyButton value={secret} label="kunci rahasia" />
        </div>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer py-1">Tautan otpauth untuk aplikasi yang mendukung tempel</summary>
          <p className="mt-1 break-all font-mono" data-testid="totp-uri">{enrolment.totpURI}</p>
        </details>
        {error && (
          <p id="code-error" role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
        )}
        <div className="grid gap-2">
          <Label htmlFor="code">Kode 6 digit dari aplikasi</Label>
          <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required aria-invalid={!!error} aria-describedby={error ? "code-error" : undefined} />
        </div>
        <Button type="submit" disabled={pending}>{pending ? "Memeriksa…" : "Verifikasi dan aktifkan"}</Button>
      </form>
    );

  return (
    <form onSubmit={start} className="grid gap-4">
      <p className="text-sm">Aktifkan verifikasi dua langkah (TOTP). Konfirmasi kata sandi Anda untuk mulai.</p>
      {error && (
        <p id="pw-error" role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
      )}
      <div className="grid gap-2">
        <Label htmlFor="password">Kata sandi</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required aria-invalid={!!error} aria-describedby={error ? "pw-error" : undefined} />
      </div>
      <Button type="submit" disabled={pending}>{pending ? "Menyiapkan…" : "Mulai aktivasi"}</Button>
    </form>
  );
}
