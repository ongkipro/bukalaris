import { AdminShell, ShellNotice, type NavItem } from "@/components/admin-shell";
import { operator } from "@/lib/context";
import { signOut } from "../login/actions";

export const metadata = { title: "Super Admin — Bukalaris" };

// PR-11: the Log System entry is a visible, text-labelled navigation item (page owned by the ops track).
const adminNav: NavItem[] = [
  { href: "/admin", label: "Toko" },
  { href: "/admin/shipping", label: "Ongkir" },
  { href: "/admin/logs", label: "Log System" },
];

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const { user, op } = await operator();
  return (
    <AdminShell tone="platform" brand="Bos" home="/admin" email={user.email} signOut={signOut} nav={op ? adminNav : []} context={op && <span>Operator platform</span>}>
      {op ? children : <ShellNotice title="Akses ditolak.">Halaman ini khusus operator platform.</ShellNotice>}
    </AdminShell>
  );
}
