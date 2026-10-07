import "@/app/s/[store]/lp/lp.css";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { sellerScope } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { publishStatusLabel, publishStatusTone } from "@/lib/status";
import { getLandingPage, listOrderableProducts, listStoreMedia, LP_ACCENTS, LP_FONT_SCALES } from "@bukalaris/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { publishAction, unpublishAction, updateSettingsAction } from "../actions";
import { AddBlockForm, BlockCard } from "../block-editor";
import { accentLabel, fontScaleLabel } from "../labels";

const savedText: Record<string, string> = { "1": "Tersimpan.", published: "Landing page dipublikasikan.", unpublished: "Landing page ditarik dari publik; draf tetap tersimpan." };

/** SC-15: Landing Page Builder editor — settings, ordered blocks, preview, publish/unpublish. */
export default async function LandingPageEditor({ params, searchParams }: PageProps<"/seller/landing-pages/[id]">) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const pageId = /^[0-9]{1,15}$/.test(id) ? Number(id) : NaN;
  const p = Number.isSafeInteger(pageId) ? await getLandingPage(scope, pageId) : null;
  if (!p) notFound();
  const [media, products] = await Promise.all([listStoreMedia(scope), listOrderableProducts(scope)]);
  const url = `/s/${scope.storeSlug}/lp/${p.slug}`;
  const live = p.status === "published";
  const upToDate = live && p.publishedRevisionId === p.draftRevisionId;
  const ctx = { pageId: p.id, expectedRevisionId: p.draft.id, media, products };
  const hasOrder = p.draft.document.blocks.some((b) => b.type === "order");
  const savedKey = typeof saved === "string" ? saved : undefined;

  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader
        back={{ href: "/seller/landing-pages", label: "Semua landing page" }}
        title={p.title}
        badge={<StatusBadge label={publishStatusLabel[p.status]} tone={publishStatusTone[p.status]} />}
        description={
          <>
            ID <span className="font-mono" data-testid="lp-id">{p.id}</span> · {live ? <a href={url} className="underline underline-offset-4">{url}</a> : <span>{url} (draf, belum tampil)</span>}
            <br />
            Draf revisi <span data-testid="draft-revision">{p.draft.revisionNumber}</span> ({tanggal(p.draft.createdAt)})
            {p.published && <> · publik revisi {p.published.revisionNumber}{upToDate ? " (sama dengan draf)" : " — draf belum dipublikasikan"}</>}
          </>
        }
        action={
          <>
            <Link href={`/seller/landing-pages/${p.id}/preview`} className={buttonVariants({ variant: "outline" })}>Pratinjau draf</Link>
            <form action={publishAction.bind(null, p.id)}>
              <input type="hidden" name="expectedRevisionId" value={p.draft.id} />
              <SubmitButton pendingText="Mempublikasikan…" disabled={upToDate} title={upToDate ? "Draf sudah dipublikasikan" : undefined}>{live ? "Publikasikan draf" : "Publikasikan"}</SubmitButton>
            </form>
            {live && (
              <form action={unpublishAction.bind(null, p.id)}>
                <ConfirmSubmit variant="destructive" message={`Tarik “${p.title}” dari publik? Alamat ${url} akan menjadi 404; draf tetap tersimpan.`}>Tarik dari publik</ConfirmSubmit>
              </form>
            )}
          </>
        }
      />
      <Notice error={error} saved={savedKey} savedText={savedText[savedKey ?? "1"] ?? "Tersimpan."} />

      <form action={updateSettingsAction.bind(null, p.id)} className="grid gap-4 rounded-xl border bg-muted/30 p-4 sm:p-5" aria-labelledby="pengaturan">
        <h2 id="pengaturan" className="font-medium">Pengaturan halaman</h2>
        <input type="hidden" name="expectedRevisionId" value={p.draft.id} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="title">Judul</Label>
            <Input id="title" name="title" required maxLength={200} defaultValue={p.title} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="slug">Slug URL</Label>
            <Input id="slug" name="slug" required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" defaultValue={p.slug} />
          </div>
        </div>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Warna aksen</legend>
          <div className="flex flex-wrap gap-2">
            {LP_ACCENTS.map((a) => (
              <label key={a} className="flex cursor-pointer items-center gap-2 rounded-full border bg-background py-1.5 pr-3 pl-2 text-sm has-checked:border-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
                <input type="radio" name="accent" value={a} defaultChecked={p.draft.document.design.accent === a} className="sr-only" />
                <span className="lp lp-swatch" data-accent={a} aria-hidden />
                {accentLabel[a]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="fontScale">Ukuran huruf</Label>
          <NativeSelect id="fontScale" name="fontScale" defaultValue={p.draft.document.design.fontScale}>
            {LP_FONT_SCALES.map((s) => (
              <option key={s} value={s}>{fontScaleLabel[s]}</option>
            ))}
          </NativeSelect>
        </div>
        <div>
          <SubmitButton variant="outline" size="sm">Simpan pengaturan</SubmitButton>
        </div>
      </form>

      <section aria-labelledby="blok" className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="blok" className="font-medium">Blok ({p.draft.document.blocks.length})</h2>
          <p className="text-xs text-muted-foreground">Urutan blok = urutan tampil. Setiap simpan membuat revisi draf baru.</p>
        </div>
        {p.draft.document.blocks.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Belum ada blok. Tambahkan hero dan bagian pemesanan untuk mulai.</p>}
        {p.draft.document.blocks.map((b, i) => (
          <BlockCard key={b.id} block={b} index={i} count={p.draft.document.blocks.length} ctx={ctx} />
        ))}
        <AddBlockForm pageId={p.id} expectedRevisionId={p.draft.id} hasOrder={hasOrder} />
        {!hasOrder && <p className="text-xs text-muted-foreground">Tanpa bagian pemesanan, tombol hero dan tombol ajakan tidak tampil karena tidak ada tujuan.</p>}
      </section>
    </section>
  );
}
