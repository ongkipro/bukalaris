import { storeOr404 } from "@/lib/storefront";
import Link from "next/link";

export default async function StoreLayout({ children, params }: LayoutProps<"/s/[store]">) {
  const { scope, base } = await storeOr404((await params).store);
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <Link href={base || "/"} className="text-lg font-semibold">{scope.storeName}</Link>
          <Link href={`${base}/cart`} className="text-sm font-medium underline-offset-4 hover:underline">Keranjang</Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
      <footer className="border-t py-4 text-center text-xs text-muted-foreground">Ditenagai Bukalaris</footer>
    </div>
  );
}
