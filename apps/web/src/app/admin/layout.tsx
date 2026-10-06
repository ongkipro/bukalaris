import { buttonVariants } from "@/components/ui/button";
import { operator } from "@/lib/context";
import { signOut } from "../login/actions";

export const metadata = { title: "Super Admin — Bukalaris" };

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const { user, op } = await operator();
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b bg-foreground text-background">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-4 px-4 py-3">
          <span className="font-semibold">Bukalaris · Bos</span>
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
