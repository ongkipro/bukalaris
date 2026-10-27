import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { BLOCK_TYPES, type BlockType, type LandingBlock, type StoreMedia } from "@bukalaris/db";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { addBlockAction, moveBlockAction, removeBlockAction, saveBlockAction } from "./actions";
import { blockHint, blockLabel } from "./labels";

/**
 * One card per block: move up/down/remove in the header (separate forms, button alternatives
 * to the drag-and-drop that T-11 adds later) and an edit form for the block's fields. Every
 * form carries the expected revision id so a stale tab is refused server-side.
 */
type Ctx = { pageId: number; expectedRevisionId: number; media: StoreMedia[]; products: { id: number; title: string; status: string }[] };

export function BlockCard({ block: b, index, count, ctx }: { block: LandingBlock; index: number; count: number; ctx: Ctx }) {
  const hidden = (
    <>
      <input type="hidden" name="expectedRevisionId" value={ctx.expectedRevisionId} />
      <input type="hidden" name="blockId" value={b.id} />
    </>
  );
  const f = (name: string) => `${b.id}-${name}`;
  return (
    <article id={`blok-${b.id}`} aria-labelledby={`blok-h-${b.id}`} className="grid gap-4 rounded-xl border bg-background p-4 sm:p-5" data-testid={`block-${b.type}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`blok-h-${b.id}`} className="font-medium">
            <span className="text-muted-foreground tabular-nums">{index + 1}.</span> {blockLabel[b.type]}
          </h3>
          <p className="text-xs text-muted-foreground">{blockHint[b.type]}</p>
        </div>
        <div className="flex gap-1">
          <form action={moveBlockAction.bind(null, ctx.pageId)}>
            {hidden}
            <input type="hidden" name="dir" value="up" />
            <Button type="submit" variant="outline" size="icon-sm" disabled={index === 0} aria-label={`Naikkan blok ${index + 1}`}><ArrowUpIcon aria-hidden /></Button>
          </form>
          <form action={moveBlockAction.bind(null, ctx.pageId)}>
            {hidden}
            <input type="hidden" name="dir" value="down" />
            <Button type="submit" variant="outline" size="icon-sm" disabled={index === count - 1} aria-label={`Turunkan blok ${index + 1}`}><ArrowDownIcon aria-hidden /></Button>
          </form>
          <form action={removeBlockAction.bind(null, ctx.pageId)}>
            {hidden}
            <ConfirmSubmit variant="destructive" size="icon-sm" message={`Hapus blok ${index + 1} (${blockLabel[b.type]})?`} aria-label={`Hapus blok ${index + 1}`}><Trash2Icon aria-hidden /></ConfirmSubmit>
          </form>
        </div>
      </header>
      <form action={saveBlockAction.bind(null, ctx.pageId)} className="grid gap-4">
        {hidden}
        <Fields block={b} f={f} ctx={ctx} />
        <div>
          <SubmitButton variant="outline" size="sm">Simpan blok {index + 1}</SubmitButton>
        </div>
      </form>
    </article>
  );
}

function Field({ id, label, children, help }: { id: string; label: string; children: ReactNode; help?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function MediaSelect({ id, name, value, media }: { id: string; name: string; value: number | null; media: StoreMedia[] }) {
  return (
    <NativeSelect id={id} name={name} defaultValue={value ?? ""}>
      <option value="">Tanpa gambar</option>
      {media.map((m) => (
        <option key={m.id} value={m.id}>{m.productTitle} — {m.alt || `gambar #${m.id}`}</option>
      ))}
    </NativeSelect>
  );
}

/** Existing rows plus one blank row (up to `max`); a row is kept when its first field is filled. */
function Rows<T extends Record<string, string>>({ items, max, f, render }: { items: T[]; max: number; f: (n: string) => string; render: (i: number, item: T | undefined, name: (k: string) => string, id: (k: string) => string) => ReactNode }) {
  const n = Math.min(items.length + 1, max);
  return (
    <ol className="grid gap-3">
      {Array.from({ length: n }, (_, i) => (
        <li key={i} className="grid gap-2 rounded-lg border border-dashed p-3">
          <p className="text-xs font-medium text-muted-foreground">Item {i + 1}{i >= items.length ? " (baru — isi untuk menambah)" : ""}</p>
          {render(i, items[i], (k) => `items.${i}.${k}`, (k) => f(`items-${i}-${k}`))}
        </li>
      ))}
    </ol>
  );
}

function Fields({ block: b, f, ctx }: { block: LandingBlock; f: (n: string) => string; ctx: Ctx }) {
  switch (b.type) {
    case "hero":
      return (
        <>
          <Field id={f("headline")} label="Judul utama"><Input id={f("headline")} name="headline" required maxLength={160} defaultValue={b.headline} /></Field>
          <Field id={f("subheadline")} label="Kalimat pendukung"><Textarea id={f("subheadline")} name="subheadline" rows={2} maxLength={400} defaultValue={b.subheadline} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={f("mediaId")} label="Gambar utama" help="Dari foto produk toko."><MediaSelect id={f("mediaId")} name="mediaId" value={b.mediaId} media={ctx.media} /></Field>
            <Field id={f("ctaLabel")} label="Label tombol pesan" help="Kosongkan untuk menyembunyikan tombol."><Input id={f("ctaLabel")} name="ctaLabel" maxLength={60} defaultValue={b.ctaLabel} /></Field>
          </div>
        </>
      );
    case "text":
      return (
        <Field id={f("body")} label="Isi" help="Format ringan: # Judul, - daftar, **tebal**, [tautan](https://…). HTML tidak dijalankan.">
          <Textarea id={f("body")} name="body" rows={8} maxLength={20000} defaultValue={b.body} className="font-mono text-sm" />
        </Field>
      );
    case "image":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={f("mediaId")} label="Gambar"><MediaSelect id={f("mediaId")} name="mediaId" value={b.mediaId} media={ctx.media} /></Field>
          <Field id={f("caption")} label="Keterangan"><Input id={f("caption")} name="caption" maxLength={300} defaultValue={b.caption} /></Field>
        </div>
      );
    case "benefits":
      return (
        <>
          <Field id={f("title")} label="Judul bagian"><Input id={f("title")} name="title" maxLength={120} defaultValue={b.title} /></Field>
          <Rows items={b.items} max={8} f={f} render={(i, it, name, id) => (
            <div className="grid gap-2 sm:grid-cols-2">
              <Field id={id("title")} label="Judul manfaat"><Input id={id("title")} name={name("title")} maxLength={120} defaultValue={it?.title} /></Field>
              <Field id={id("body")} label="Penjelasan"><Input id={id("body")} name={name("body")} maxLength={400} defaultValue={it?.body} /></Field>
            </div>
          )} />
        </>
      );
    case "testimonials":
      return (
        <>
          <Field id={f("title")} label="Judul bagian"><Input id={f("title")} name="title" maxLength={120} defaultValue={b.title} /></Field>
          <Rows items={b.items} max={8} f={f} render={(i, it, name, id) => (
            <>
              <Field id={id("quote")} label="Kutipan"><Textarea id={id("quote")} name={name("quote")} rows={2} maxLength={600} defaultValue={it?.quote} /></Field>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field id={id("name")} label="Nama"><Input id={id("name")} name={name("name")} maxLength={80} defaultValue={it?.name} /></Field>
                <Field id={id("note")} label="Keterangan (kota, profesi)"><Input id={id("note")} name={name("note")} maxLength={80} defaultValue={it?.note} /></Field>
              </div>
            </>
          )} />
        </>
      );
    case "faq":
      return (
        <>
          <Field id={f("title")} label="Judul bagian"><Input id={f("title")} name="title" maxLength={120} defaultValue={b.title} /></Field>
          <Rows items={b.items} max={12} f={f} render={(i, it, name, id) => (
            <>
              <Field id={id("q")} label="Pertanyaan"><Input id={id("q")} name={name("q")} maxLength={200} defaultValue={it?.q} /></Field>
              <Field id={id("a")} label="Jawaban"><Textarea id={id("a")} name={name("a")} rows={2} maxLength={2000} defaultValue={it?.a} /></Field>
            </>
          )} />
        </>
      );
    case "cta":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={f("label")} label="Label tombol"><Input id={f("label")} name="label" required maxLength={60} defaultValue={b.label} /></Field>
          <Field id={f("note")} label="Kalimat pengantar"><Input id={f("note")} name="note" maxLength={200} defaultValue={b.note} /></Field>
        </div>
      );
    case "order":
      return (
        <>
          <Field id={f("productId")} label="Produk" help="Varian, harga dan stok selalu dibaca dari katalog saat halaman dibuka. Produk harus aktif saat publikasi.">
            <NativeSelect id={f("productId")} name="productId" required defaultValue={b.productId}>
              {ctx.products.map((p) => (
                <option key={p.id} value={p.id}>{p.title}{p.status !== "active" ? " (draf)" : ""}</option>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={f("title")} label="Judul bagian"><Input id={f("title")} name="title" maxLength={120} defaultValue={b.title} /></Field>
            <Field id={f("note")} label="Catatan singkat"><Input id={f("note")} name="note" maxLength={300} defaultValue={b.note} /></Field>
          </div>
        </>
      );
  }
}

export function AddBlockForm({ pageId, expectedRevisionId, hasOrder }: { pageId: number; expectedRevisionId: number; hasOrder: boolean }) {
  return (
    <form action={addBlockAction.bind(null, pageId)} className="grid gap-3 rounded-xl border border-dashed p-4 sm:flex sm:items-end">
      <input type="hidden" name="expectedRevisionId" value={expectedRevisionId} />
      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="add-type">Tambah blok</Label>
        <NativeSelect id="add-type" name="type" defaultValue={hasOrder ? "text" : "order"}>
          {BLOCK_TYPES.filter((t) => !(hasOrder && t === "order")).map((t: BlockType) => (
            <option key={t} value={t}>{blockLabel[t]}</option>
          ))}
        </NativeSelect>
      </div>
      <SubmitButton pendingText="Menambahkan…">Tambah blok</SubmitButton>
    </form>
  );
}
