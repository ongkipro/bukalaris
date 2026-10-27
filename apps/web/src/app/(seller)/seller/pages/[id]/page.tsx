import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { sellerScope } from "@/lib/context";
import { publishStatusLabel, publishStatusTone } from "@/lib/status";
import { getPage } from "@bukalaris/db";
import { notFound } from "next/navigation";
import { MarkdownLite } from "@/app/(storefront)/s/[store]/(shop)/_components/markdown-lite";
import { updatePageAction } from "../actions";
import { PageFields } from "../page-fields";

export default async function PageEditor({ params, searchParams }: PageProps<"/seller/pages/[id]">) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const pageId = /^[0-9]{1,15}$/.test(id) ? Number(id) : NaN;
  const p = Number.isSafeInteger(pageId) ? await getPage(scope, pageId) : null;
  if (!p) notFound();
  const url = `/s/${scope.storeSlug}/pages/${p.slug}`;
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader
        back={{ href: "/seller/pages", label: "Semua halaman" }}
        title={p.title}
        badge={<StatusBadge label={publishStatusLabel[p.status]} tone={publishStatusTone[p.status]} />}
        description={
          <>
            ID halaman <span className="font-mono" data-testid="page-id">{p.id}</span> ·{" "}
            {p.status === "published" ? <a href={url} className="underline underline-offset-4">{url}</a> : <span>{url} (draf, belum tampil)</span>}
          </>
        }
      />
      <Notice error={error} saved={saved} />
      <form action={updatePageAction.bind(null, p.id)} className="grid gap-6">
        <PageFields d={p} />
        <div>
          <SubmitButton>Simpan halaman</SubmitButton>
        </div>
      </form>
      {p.body && (
        <section aria-labelledby="preview" className="grid gap-3 rounded-lg border bg-muted/30 p-4">
          <h2 id="preview" className="text-sm font-medium text-muted-foreground">Pratinjau tersimpan</h2>
          <MarkdownLite body={p.body} className="min-w-0 rounded-md bg-background p-4 [overflow-wrap:anywhere]" />
        </section>
      )}
    </section>
  );
}
