import { buttonVariants } from "@/components/ui/button";
import { operator } from "@/lib/context";
import Link from "next/link";
import { signOut } from "../login/actions";

export const metadata = { title: "Super Admin — Bukalaris" };

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const { user, op } = await operator();
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b bg-foreground text-background">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <span className="font-semibold">Bukalaris · Bos</span>
          {op && (
            <nav aria-label="Super Admin" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <Link href="/admin" className="hover:underline">Toko</Link>
              <Link href="/admin/shipping" className="hover:underline">Ongkir</Link>
              {/* PR-11: visible Log System button (page owned by the ops track). */}
              <Link href="/admin/logs" className="rounded-md border border-background/40 px-2 py-0.5 hover:bg-background/10">Log System</Link>
            </nav>
          )}
          <span className="ml-auto text-sm opacity-80 max-sm:hidden">{user.email}</span>
          <form action={signOut}>
            <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>Keluar</button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        {op ? children : (
          <p role="alert" className="rounded-lg border p-6">Akses ditolak. Halaman ini khusus operator platform.</p>
        )}
      </main>
    </div>
  );
}
