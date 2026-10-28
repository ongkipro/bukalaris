import { AdminShell, ShellNotice, type NavItem } from "@/components/admin-shell";
import { buttonVariants } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { seller } from "@/lib/context";
import { roleLabel } from "@/lib/status";
import { can } from "@bukalaris/db";
import { billingStateLabel } from "@/lib/billing";
import { tanggal } from "@/lib/format";
import Link from "next/link";
import { signOut } from "@/app/(identity)/login/actions";
import { switchStore } from "./actions";

export const metadata = { title: "Seller Admin — Bukalaris" };

// Owned by M2 tracks: each page is created by its track (AGENTS.md "Parallel tracks").
const sellerNav: NavItem[] = [
  { href: "/seller", label: "Ringkasan" }, // T-41 dashboard (track dashboard: exact-match active state)
  { href: "/seller/products", label: "Produk" },
  { href: "/seller/inventory", label: "Inventaris" },
  { href: "/seller/orders", label: "Pesanan" },
  { href: "/seller/customers/carts", label: "Keranjang tertinggal" }, // T-45 (SC-26)
  { href: "/seller/collections", label: "Koleksi" },
  { href: "/seller/pages", label: "Halaman" },
  { href: "/seller/promotions", label: "Promosi" }, // T-46 (SC-27)
  { href: "/seller/landing-pages", label: "Landing page" }, // T-42 (track landing)
  { href: "/seller/members", label: "Anggota" },
  { href: "/seller/privacy", label: "Data pembeli" }, // T-43 (track privacy)
  { href: "/seller/shipping", label: "Pengiriman" },
  { href: "/seller/channels", label: "Channel" },
  { href: "/seller/marketing", label: "Pemasaran" },
  { href: "/seller/finance", label: "Keuangan" }, // T-37 (SC-25); shown to the owner only (finance.read), see the nav filter below
  { href: "/seller/billing", label: "Langganan" }, // T-50 (UX-18)
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
      nav={ctx.ok ? [...sellerNav.filter((n) => n.href !== "/seller/finance" || can(ctx.scope, "finance.read")), { href: `/s/${ctx.scope.storeSlug}`, label: "Lihat toko", external: true }] : []}
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
        <>
          {/* T-50 (UX-18): the same restriction the server enforces on every write. No role="status": each page keeps its one live region. */}
          {!ctx.scope.billing.writable && (
            <aside aria-label="Status langganan" data-testid="billing-banner" className="mb-4 rounded-lg border border-amber-600/40 bg-amber-500/5 px-3 py-2.5 text-sm">
              <strong>{billingStateLabel[ctx.scope.billing.state]}.</strong> Seller Admin hanya bisa dibaca sampai langganan dibayar; toko dan checkout pembeli tetap berjalan dan data Anda aman.{" "}
              {ctx.scope.billing.graceEndsAt && ctx.scope.billing.state === "past_due" && <>Masa tenggang sampai {tanggal(ctx.scope.billing.graceEndsAt)}. </>}
              <Link href="/seller/billing" className="underline underline-offset-4">Lihat tagihan dan bayar</Link>
            </aside>
          )}
          {children}
        </>
      ) : ctx.reason === "suspended" ? (
        <ShellNotice title={`Toko ${ctx.storeName} sedang ditangguhkan`}>Pengelolaan toko dan checkout pembeli dinonaktifkan. Hubungi tim Bukalaris.</ShellNotice>
      ) : ctx.reason === "identity_suspended" ? (
        <ShellNotice title="Akun ini sedang ditangguhkan">Akses ke Seller Admin dinonaktifkan. Hubungi tim Bukalaris.</ShellNotice>
      ) : (
        <ShellNotice title="Akun ini belum terhubung ke toko">Minta pemilik toko atau tim Bukalaris menambahkan akun Anda.</ShellNotice>
      )}
    </AdminShell>
  );
}
