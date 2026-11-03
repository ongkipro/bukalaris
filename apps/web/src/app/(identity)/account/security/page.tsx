import { Badge } from "@/components/ui/badge";
import { currentUser, isOperator as checkOperator } from "@/lib/context";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SecurityEnrol } from "./security-enrol";

export const metadata = { title: "Keamanan akun — Bukalaris" };

export default async function SecurityPage({ searchParams }: PageProps<"/account/security">) {
  const user = await currentUser();
  if (!user) redirect("/login?next=/account/security");
  const { next } = await searchParams;
  const target = next === "/admin" ? "/admin" : "/seller";
  const isOperator = await checkOperator(user.id);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Keamanan akun</h1>
        <Badge variant={user.twoFactorEnabled ? "default" : "outline"}>
          {user.twoFactorEnabled ? "Verifikasi dua langkah aktif" : "Belum aktif"}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {user.email}
        {isOperator && !user.twoFactorEnabled && " · Staf Owner console wajib mengaktifkan verifikasi dua langkah sebelum membuka Owner console."}
      </p>
      {user.twoFactorEnabled ? (
        <>
          <p className="text-sm">
            Setiap kali masuk, Anda diminta kode dari aplikasi autentikator. Kode cadangan yang Anda simpan dapat dipakai jika
            aplikasi tidak tersedia.
          </p>
          <Link href={target} className="inline-flex min-h-6 w-fit items-center rounded-sm py-1 text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
            Lanjut ke {target === "/admin" ? "Owner console" : "Seller Admin"}
          </Link>
        </>
      ) : (
        <SecurityEnrol email={user.email} next={target} />
      )}
    </>
  );
}
