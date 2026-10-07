import { LandingRenderer } from "@/app/s/[store]/lp/_components/landing-renderer";
import { buttonVariants } from "@/components/ui/button";
import { sellerScope } from "@/lib/context";
import { getDraftLandingPage } from "@bukalaris/db";
import Link from "next/link";
import { notFound } from "next/navigation";

export const metadata = { title: "Pratinjau landing page — Bukalaris" };

/**
 * SC-16: private preview of the current draft through the same renderer as the public route.
 * Images come from the session-scoped seller media route (drafts included); the order form is
 * shown but disabled, so a preview never touches a cart.
 */
export default async function LandingPreview({ params }: PageProps<"/seller/landing-pages/[id]/preview">) {
  const { id } = await params;
  const scope = await sellerScope();
  const pageId = /^[0-9]{1,15}$/.test(id) ? Number(id) : NaN;
  const lp = Number.isSafeInteger(pageId) ? await getDraftLandingPage(scope, pageId) : null;
  if (!lp) notFound();
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm" role="note">
        <p>
          <strong>Pratinjau draf</strong> — {lp.title}. Hanya Anda yang bisa melihat halaman ini; pembeli melihat revisi yang dipublikasikan.
        </p>
        <Link href={`/seller/landing-pages/${lp.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Kembali ke editor</Link>
      </div>
      <div className="flex overflow-hidden rounded-xl border" data-testid="lp-preview">
        <LandingRenderer
          lp={lp}
          storeName={scope.storeName}
          storeHome={`/s/${scope.storeSlug}`}
          imageSrc={(m) => `/seller/products/${m.productId}/media/${m.id}`}
          order={{ store: scope.storeSlug, signals: null, preview: true }}
        />
      </div>
    </section>
  );
}
