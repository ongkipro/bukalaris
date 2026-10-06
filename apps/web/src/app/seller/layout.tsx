import { buttonVariants } from "@/components/ui/button";
import { seller } from "@/lib/context";
import Link from "next/link";
import { signOut } from "../login/actions";
import { switchStore } from "./actions";

export const metadata = { title: "Seller Admin — Bukalaris" };

const sellerNav = [
  ["/seller/products", "Produk"],
  ["/seller/inventory", "Inventaris"],
  ["/seller/orders", "Pesanan"],
  ["/seller/collections", "Koleksi"],
  ["/seller/pages", "Halaman"],
  ["/seller/members", "Anggota"],
  ["/seller/shipping", "Pengiriman"],
  ["/seller/channels", "Channel"],
  ["/seller/settings", "Pengaturan"],
] as const;

export default async function SellerLayout({ children }: LayoutProps<"/seller">) {
  const { user, ctx } = await seller();
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <span className="font-semibold">Bukalaris · Seller</span>
          {ctx.ok && (
            <nav aria-label="Seller" className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
              {/* Owned by M2 tracks: each page is created by its track (AGENTS.md "Parallel tracks"). */}
              {sellerNav.map(([href, label]) => (
                <Link key={href} href={href} className="hover:underline">{label}</Link>
              ))}
              <a href={`/s/${ctx.scope.storeSlug}`} className="hover:underline">Lihat toko</a>
            </nav>
          )}
          <div className="ml-auto flex items-center gap-3 text-sm">
            {ctx.ok && ctx.stores.length > 1 && (
              <form action={switchStore} className="flex items-center gap-2">
                <label htmlFor="store" className="sr-only">Toko aktif</label>
                <select id="store" name="storeId" defaultValue={ctx.scope.storeId} className="h-8 rounded-md border bg-background px-2">
                  {ctx.stores.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <button type="submit" className={buttonVariants({ variant: "outline", size: "sm" })}>Ganti</button>
              </form>
            )}
            {ctx.ok && <span className="text-muted-foreground">{ctx.scope.storeName} · {ctx.scope.role === "owner" ? "Pemilik" : "Staf"}</span>}
            <span className="text-muted-foreground max-sm:hidden">{user.email}</span>
            <form action={signOut}>
              <button type="submit" className={buttonVariants({ variant: "ghost", size: "sm" })}>Keluar</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        {ctx.ok ? (
          children
        ) : (
          <div role="alert" className="rounded-lg border p-6">
            <h1 className="text-lg font-semibold">
              {ctx.reason === "suspended" ? `Toko ${ctx.storeName} sedang ditangguhkan` : "Akun ini belum terhubung ke toko"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {ctx.reason === "suspended"
                ? "Pengelolaan toko dan checkout pembeli dinonaktifkan. Hubungi tim Bukalaris."
                : "Minta pemilik toko atau tim Bukalaris menambahkan akun Anda."}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
