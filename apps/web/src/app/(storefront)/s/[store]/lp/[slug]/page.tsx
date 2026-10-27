import { Pixels } from "@/components/pixels/pixels";
import { SignalEvent } from "@/components/pixels/runtime";
import { mediaUrl } from "@/lib/media";
import { signalsFor } from "@/lib/signals";
import { storeOr404 } from "@/lib/storefront";
import { getPublishedLandingPage } from "@bukalaris/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LandingRenderer } from "../_components/landing-renderer";
import { orderFromLanding } from "../actions";

/**
 * Public landing page (SF `/lp/<slug>`, also `/s/<store>/lp/<slug>`): lives beside the
 * `(shop)` route group, so the storefront shell and theme never wrap it (UI-6). Only the
 * published revision of an active store's page renders; drafts and other stores are a 404.
 */
export async function generateMetadata({ params }: PageProps<"/s/[store]/lp/[slug]">): Promise<Metadata> {
  const { store, slug } = await params;
  const { scope } = await storeOr404(store);
  const lp = await getPublishedLandingPage(scope, slug);
  return { title: lp ? `${lp.title} — ${scope.storeName}` : scope.storeName };
}

export default async function LandingPage({ params, searchParams }: PageProps<"/s/[store]/lp/[slug]">) {
  const { store, slug } = await params;
  const { error } = await searchParams;
  const { scope, base } = await storeOr404(store);
  const lp = await getPublishedLandingPage(scope, slug);
  if (!lp) notFound();
  const signals = await signalsFor(scope.storeId);
  const viewed = lp.product?.status === "active" ? (lp.product.variants.find((v) => v.stock > 0) ?? lp.product.variants[0]) : undefined;
  return (
    <>
      <Pixels storeId={scope.storeId} />
      {signals && viewed && <SignalEvent config={signals} store={scope.storeSlug} name="ViewContent" items={[{ id: viewed.catalogId, quantity: 1, price: viewed.price }]} value={viewed.price} />}
      <LandingRenderer
        lp={lp}
        storeName={scope.storeName}
        storeHome={base || "/"}
        imageSrc={(m) => mediaUrl(base, m.id)}
        order={{ store: scope.storeSlug, signals, action: orderFromLanding.bind(null, store, slug) }}
        error={error}
      />
    </>
  );
}
