import Link from "next/link";
import { ResetForm } from "./reset-form";

export const metadata = { title: "Atur ulang kata sandi — Bukalaris" };

export default async function ResetPage({ searchParams }: PageProps<"/account/recovery/reset">) {
  const { token, error } = await searchParams;
  // Better Auth's callback redirects here with ?token= when the link is valid, or ?error=INVALID_TOKEN.
  const valid = typeof token === "string" && token.length > 0 && !error;
  return (
    <>
      <h1 className="text-xl font-semibold">Atur ulang kata sandi</h1>
      {valid ? (
        <ResetForm token={token} />
      ) : (
        <>
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            Tautan ini tidak valid atau sudah kedaluwarsa. Tautan hanya berlaku 60 menit dan sekali pakai.
          </p>
          <Link href="/account/recovery" className="inline-flex min-h-6 w-fit items-center rounded-sm py-1 text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">Minta tautan baru</Link>
        </>
      )}
    </>
  );
}
