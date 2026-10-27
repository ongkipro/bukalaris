export const metadata = { title: "Status pesanan — Bukalaris" };

// Platform-owned, read-only buyer page reached from e-mail links (T-36): no storefront
// theme, no navigation, nothing beyond the one order the signed link grants.
export default function OrderStatusLayout({ children }: LayoutProps<"/o">) {
  return (
    <div className="flex flex-1 flex-col bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-4 py-3 text-sm">
          <span className="font-semibold tracking-tight">Bukalaris</span>
          <span className="text-muted-foreground">Status pesanan</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
