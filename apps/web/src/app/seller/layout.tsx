import { AdminShell, ShellNotice, type NavItem } from "@/components/admin-shell";
import { buttonVariants } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { seller } from "@/lib/context";
import { roleLabel } from "@/lib/status";
import { signOut } from "../login/actions";
import { switchStore } from "./actions";

export const metadata = { title: "Seller Admin — Bukalaris" };

// Owned by M2 tracks: each page is created by its track (AGENTS.md "Parallel tracks").
const sellerNav: NavItem[] = [
  { href: "/seller/products", label: "Produk" },
  { href: "/seller/inventory", label: "Inventaris" },
  { href: "/seller/orders", label: "Pesanan" },
  { href: "/seller/collections", label: "Koleksi" },
  { href: "/seller/pages", label: "Halaman" },
  { href: "/seller/members", label: "Anggota" },
  { href: "/seller/shipping", label: "Pengiriman" },
  { href: "/seller/channels", label: "Channel" },
  { href: "/seller/settings", label: "Pengaturan" },
];

export default async function SellerLayout({ children }: LayoutProps<"/seller">) {
  const { user, ctx } = await seller();
  return (
    <AdminShell
      tone="seller"
      brand="Seller"
      home="/seller/products"
      email={user.email}
      signOut={signOut}
      nav={ctx.ok ? [...sellerNav, { href: `/s/${ctx.scope.storeSlug}`, label: "Lihat toko", external: true }] : []}
      context={
        ctx.ok && (
          <>
            {/* Persistent store scope (UI-7): name + role; the switcher only when the account has several stores. */}
            <span className="truncate text-muted-foreground">
              {ctx.scope.storeName} · {roleLabel[ctx.scope.role]}
            </span>
            {ctx.stores.length > 1 && (
              <form action={switchStore} className="flex items-center gap-1.5">
                <label htmlFor="store" className="sr-only">Toko aktif</label>
                <NativeSelect id="store" name="storeId" defaultValue={ctx.scope.storeId} className="w-40">
                  {ctx.stores.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </NativeSelect>
                <button type="submit" className={buttonVariants({ variant: "outline", size: "sm" })}>Ganti</button>
              </form>
            )}
          </>
        )
      }
    >
      {ctx.ok ? (
        children
      ) : ctx.reason === "suspended" ? (
        <ShellNotice title={`Toko ${ctx.storeName} sedang ditangguhkan`}>Pengelolaan toko dan checkout pembeli dinonaktifkan. Hubungi tim Bukalaris.</ShellNotice>
      ) : (
        <ShellNotice title="Akun ini belum terhubung ke toko">Minta pemilik toko atau tim Bukalaris menambahkan akun Anda.</ShellNotice>
      )}
    </AdminShell>
  );
}
