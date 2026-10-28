import Link from "next/link";

export const metadata = { title: "Tautan tidak berlaku — Bukalaris", robots: { index: false, follow: false } };

export default function SupportRecoveryInvalidPage() {
  return (
    <>
      <h1 className="text-xl font-semibold">Tautan tidak berlaku</h1>
      <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">Tautan ini sudah dipakai, sudah kedaluwarsa, atau tidak berlaku untuk akun ini. Hubungi tim dukungan untuk tautan baru.</p>
      <Link href="/login" className="text-sm text-muted-foreground underline-offset-4 hover:underline">Kembali ke halaman masuk</Link>
    </>
  );
}
