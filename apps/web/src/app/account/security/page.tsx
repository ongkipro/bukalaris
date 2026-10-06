import { Badge } from "@/components/ui/badge";
import { currentUser } from "@/lib/context";
import { db, operatorScope } from "@bukalaris/db";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SecurityEnrol } from "./security-enrol";

export const metadata = { title: "Keamanan akun — Bukalaris" };

export default async function SecurityPage({ searchParams }: PageProps<"/account/security">) {
  const user = await currentUser();
  if (!user) redirect("/login?next=/account/security");
  const { next } = await searchParams;
  const target = next === "/admin" ? "/admin" : "/seller";
  const isOperator = !!(await operatorScope(db(), user.id));
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
        {isOperator && !user.twoFactorEnabled && " · Operator platform wajib mengaktifkan verifikasi dua langkah sebelum membuka Super Admin."}
      </p>
      {user.twoFactorEnabled ? (
        <>
          <p className="text-sm">
            Setiap kali masuk, Anda diminta kode dari aplikasi autentikator. Kode cadangan yang Anda simpan dapat dipakai jika
            aplikasi tidak tersedia.
          </p>
          <Link href={target} className="text-sm underline-offset-4 hover:underline">
            Lanjut ke {target === "/admin" ? "Super Admin" : "Seller Admin"}
          </Link>
        </>
      ) : (
        <SecurityEnrol email={user.email} next={target} />
      )}
    </>
  );
}
