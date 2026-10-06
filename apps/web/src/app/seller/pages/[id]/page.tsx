import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { sellerScope } from "@/lib/context";
import { getPage } from "@bukalaris/db";
import { notFound } from "next/navigation";
import { MarkdownLite } from "@/app/s/[store]/_components/markdown-lite";
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{p.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          ID halaman <span className="font-mono" data-testid="page-id">{p.id}</span> ·{" "}
          {p.status === "published" ? <a href={url} className="underline">{url}</a> : <span>{url} (draf, belum tampil)</span>}
        </p>
      </div>
      <Notice error={error} saved={saved} />
      <form action={updatePageAction.bind(null, p.id)} className="grid gap-6">
        <PageFields d={p} />
        <div>
          <Button type="submit">Simpan halaman</Button>
        </div>
      </form>
      {p.body && (
        <section aria-labelledby="preview" className="grid gap-3 rounded-lg border bg-muted/30 p-4">
          <h2 id="preview" className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Pratinjau tersimpan</h2>
          <MarkdownLite body={p.body} className="rounded-md bg-background p-4" />
        </section>
      )}
    </section>
  );
}
