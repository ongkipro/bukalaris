import { CsrfField } from "@/lib/auth-csrf-form";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { sellerScope } from "@/lib/context";
import { publishStatusLabel, publishStatusTone } from "@/lib/status";
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
      <PageHeader
        back={{ href: "/seller/collections", label: "Semua koleksi" }}
        title={c.title}
        badge={<StatusBadge label={publishStatusLabel[c.status]} tone={publishStatusTone[c.status]} />}
        description={
          <>
            ID koleksi <span className="font-mono" data-testid="collection-id">{c.id}</span> ·{" "}
            {c.status === "published" ? <a href={url} className="underline underline-offset-4">{url}</a> : <span>{url} (draf, belum tampil)</span>}
          </>
        }
      />
      <Notice error={error} saved={saved} />
      <form action={updateCollectionAction.bind(null, c.id)} className="grid gap-6">
        <CsrfField />
        <CollectionFields d={c} products={products} />
        <div>
          <SubmitButton>Simpan koleksi</SubmitButton>
        </div>
      </form>
    </section>
  );
}
