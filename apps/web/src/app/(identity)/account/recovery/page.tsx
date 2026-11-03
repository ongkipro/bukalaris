import Link from "next/link";
import { RecoveryForm } from "./recovery-form";

export const metadata = { title: "Lupa kata sandi — Bukalaris" };

export default function RecoveryPage() {
  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Lupa kata sandi</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Masukkan email akun Anda. Jika terdaftar, kami kirimkan tautan untuk mengatur ulang kata sandi.
        </p>
      </div>
      <RecoveryForm />
      <Link href="/login" className="inline-flex min-h-6 w-fit items-center rounded-sm py-1 text-sm text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
        Kembali ke halaman masuk
      </Link>
    </>
  );
}
