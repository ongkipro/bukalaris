import { fieldClass, Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { SignalEvent } from "@/components/pixels/runtime";
import { rupiah } from "@/lib/format";
import { signalsFor } from "@/lib/signals";
import { cartCookie } from "@/lib/storefront";
import { canonicalSlug, coverImages, getCart, variantCatalogIds } from "@bukalaris/db";
import { cookies } from "next/headers";
import Link from "next/link";
import { EmptyState } from "../_components/product-grid";
import { StoreImage } from "../_components/store-image";
import { storeShell } from "../_lib";
import { updateCart } from "../actions";

export const metadata = { title: "Keranjang" };

export default async function CartPage({ params, searchParams }: PageProps<"/s/[store]/cart">) {
  const { store } = await params;
  const { error, added } = await searchParams;
  const { scope, base } = await storeShell(store);
  const cart = await getCart(scope, (await cookies()).get(cartCookie(scope.storeId))?.value);
  const covers = await coverImages(scope, cart.lines.map((l) => l.productId));
  const addedEvent = await addToCartSignal(scope, cart.lines, typeof added === "string" ? added : "");
  return (
    <section className="mx-auto grid w-full max-w-3xl gap-5">
      <h1 className="text-2xl font-semibold tracking-tight">Keranjang</h1>
      <Notice error={error} />
      {addedEvent}
      {cart.lines.length === 0 ? (
        <EmptyState
          title="Keranjang masih kosong."
          hint="Pilih produk dulu, lalu kembali ke sini untuk checkout."
          action={<Link href={base || "/"} className={buttonVariants({ variant: "outline" })}>Lihat produk</Link>}
        />
      ) : (
        <>
          <ul className="divide-y rounded-xl border">
            {cart.lines.map((l) => {
              const href = `${base}/products/${canonicalSlug({ catalogId: l.productCatalogId, slug: l.productSlug })}`;
              return (
                <li key={l.variantId} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3 p-4 @xl:grid-cols-[5rem_minmax(0,1fr)_auto] @xl:items-center">
                  <Link href={href} tabIndex={-1} className="row-span-2 @xl:row-span-1">
                    <StoreImage base={base} image={covers.get(l.productId)} className="aspect-square w-full rounded-lg" />
                  </Link>
                  <div className="min-w-0">
                    <Link href={href} className="font-medium underline-offset-4 hover:underline">{l.productTitle}</Link>
                    <p className="text-sm tabular-nums text-muted-foreground">{l.variantTitle} · {rupiah(l.price)}</p>
                    {l.quantity > l.stock && <p className="mt-1 text-sm text-destructive" role="alert">Stok tersisa {l.stock}; jumlah akan ditolak saat checkout.</p>}
                  </div>
                  <form action={updateCart.bind(null, store)} className="col-start-2 flex items-center gap-2 @xl:col-start-3">
                    <input type="hidden" name="variantId" value={l.variantId} />
                    <label htmlFor={`qty-${l.variantId}`} className="sr-only">Jumlah {l.productTitle}</label>
                    <input id={`qty-${l.variantId}`} name="quantity" type="number" inputMode="numeric" min={0} max={99} defaultValue={l.quantity} className={`${fieldClass} w-20 tabular-nums`} />
                    <SubmitButton pendingText="…" variant="outline" size="sm">Ubah</SubmitButton>
                  </form>
                </li>
              );
            })}
          </ul>
          <div className="grid gap-3 rounded-xl border bg-muted/30 p-4 @xl:flex @xl:items-center @xl:justify-between">
            <p className="flex items-baseline justify-between gap-4 @xl:block">
              <span className="text-sm text-muted-foreground">Subtotal</span>{" "}
              <strong className="text-lg tabular-nums">{rupiah(cart.subtotal)}</strong>
            </p>
            <Link href={`/checkout?store=${scope.storeSlug}`} className={buttonVariants({ size: "lg", className: "h-11 px-6 text-base" })}>Checkout</Link>
          </div>
          <p className="text-xs text-muted-foreground">Ongkir dihitung saat checkout. Ubah jumlah ke 0 untuk menghapus barang.</p>
        </>
      )}
    </section>
  );
}

/** AddToCart signal (T-38) for the line the buyer just added; `added` is display input, validated against the cart. */
async function addToCartSignal(scope: Awaited<ReturnType<typeof storeShell>>["scope"], lines: { variantId: number; price: number }[], added: string) {
  const m = /^([0-9]{1,15}):([0-9]{1,2})$/.exec(added);
  const line = m ? lines.find((l) => l.variantId === Number(m[1])) : undefined;
  if (!line) return null;
  const signals = await signalsFor(scope.storeId);
  if (!signals) return null;
  const quantity = Math.min(Math.max(Number(m![2]), 1), 99);
  const [catalogId] = await variantCatalogIds(scope, [line.variantId]);
  if (!catalogId) return null;
  return <SignalEvent config={signals} store={scope.storeSlug} name="AddToCart" items={[{ id: catalogId, quantity, price: line.price }]} value={line.price * quantity} />;
}
