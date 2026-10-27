export const metadata = { title: "Checkout — Bukalaris" };

// Platform-owned layout: no storefront theme, header or scripts (ARCH-7, UX-12).
export default function CheckoutLayout({ children }: LayoutProps<"/checkout">) {
  return (
    <div className="flex flex-1 flex-col bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-4 py-3 text-sm">
          <span className="font-semibold tracking-tight">Bukalaris Checkout</span>
          <span className="text-muted-foreground">Harga dan stok dicek ulang oleh server</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
