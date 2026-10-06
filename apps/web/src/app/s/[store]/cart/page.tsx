import { fieldClass, Notice } from "@/components/notice";
import { Button, buttonVariants } from "@/components/ui/button";
import { rupiah } from "@/lib/format";
import { cartCookie, storeOr404 } from "@/lib/storefront";
import { canonicalSlug, getCart } from "@bukalaris/db";
import { cookies } from "next/headers";
import Link from "next/link";
import { updateCart } from "../actions";

export default async function CartPage({ params, searchParams }: PageProps<"/s/[store]/cart">) {
  const { store } = await params;
  const { error } = await searchParams;
  const { scope, base } = await storeOr404(store);
  const cart = await getCart(scope, (await cookies()).get(cartCookie(scope.storeId))?.value);
  return (
    <section className="max-w-3xl">
      <h1 className="mb-4 text-2xl font-semibold">Keranjang</h1>
      <Notice error={error} />
      {cart.lines.length === 0 ? (
        <p className="text-muted-foreground">
          Keranjang kosong. <Link href={base || "/"} className="underline">Lihat produk</Link>
        </p>
      ) : (
        <>
          <ul className="divide-y rounded-lg border">
            {cart.lines.map((l) => (
              <li key={l.variantId} className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
                <div>
                  <Link href={`${base}/products/${canonicalSlug({ id: l.productId, slug: l.productSlug })}`} className="font-medium hover:underline">
                    {l.productTitle}
                  </Link>
                  <p className="text-sm text-muted-foreground">{l.variantTitle} · {rupiah(l.price)}</p>
                  {l.quantity > l.stock && <p className="text-sm text-destructive">Stok tersisa {l.stock}.</p>}
                </div>
                <form action={updateCart.bind(null, store)} className="flex items-center gap-2">
                  <input type="hidden" name="variantId" value={l.variantId} />
                  <label htmlFor={`qty-${l.variantId}`} className="sr-only">Jumlah {l.productTitle}</label>
                  <input id={`qty-${l.variantId}`} name="quantity" type="number" min={0} max={99} defaultValue={l.quantity} className={`${fieldClass} w-20`} />
                  <Button type="submit" variant="outline" size="sm">Ubah</Button>
                </form>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            <p className="text-lg">
              Subtotal <strong>{rupiah(cart.subtotal)}</strong>
            </p>
            <Link href={`/checkout?store=${scope.storeSlug}`} className={buttonVariants({ size: "lg" })}>Checkout</Link>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Ubah jumlah ke 0 untuk menghapus barang.</p>
        </>
      )}
    </section>
  );
}
