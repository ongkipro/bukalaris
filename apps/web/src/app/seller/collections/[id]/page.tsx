import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { sellerScope } from "@/lib/context";
import { getCollection, listProducts } from "@bukalaris/db";
import { notFound } from "next/navigation";
import { updateCollectionAction } from "../actions";
import { CollectionFields } from "../collection-fields";

export default async function CollectionPage({ params, searchParams }: PageProps<"/seller/collections/[id]">) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const collectionId = /^[0-9]{1,15}$/.test(id) ? Number(id) : NaN;
  const c = Number.isSafeInteger(collectionId) ? await getCollection(scope, collectionId) : null;
  if (!c) notFound();
  const products = await listProducts(scope);
  const url = `/s/${scope.storeSlug}/collections/${c.slug}`;
  return (
    <section className="grid max-w-3xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{c.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          ID koleksi <span className="font-mono" data-testid="collection-id">{c.id}</span> ·{" "}
          {c.status === "published" ? <a href={url} className="underline">{url}</a> : <span>{url} (draf, belum tampil)</span>}
        </p>
      </div>
      <Notice error={error} saved={saved} />
      <form action={updateCollectionAction.bind(null, c.id)} className="grid gap-6">
        <CollectionFields d={c} products={products} />
        <div>
          <Button type="submit">Simpan koleksi</Button>
        </div>
      </form>
    </section>
  );
}
