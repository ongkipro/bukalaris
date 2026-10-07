"use server";

import { sellerScope } from "@/lib/context";
import {
  appendBlock,
  BLOCK_TYPES,
  createLandingPage,
  DomainError,
  getLandingPage,
  listOrderableProducts,
  moveBlock,
  newBlock,
  publishLandingPage,
  removeBlock,
  replaceBlock,
  saveDraft,
  unpublishLandingPage,
  updateLandingPageMeta,
  type BlockType,
  type LandingBlock,
  type LandingDocument,
  type SellerScope,
} from "@bukalaris/db";
import { notFound } from "next/navigation";
import { run, text } from "../_run";

// Landing Page Builder actions (SC-14/15, T-42). Every edit is "load the current draft, apply
// one change, save it as a new revision"; `saveDraft` rejects the save when the form's
// expectedRevisionId is no longer the draft pointer, so a stale tab cannot overwrite newer work.

const editor = (id: number) => `/seller/landing-pages/${id}`;

async function draftOf(scope: SellerScope, pageId: number): Promise<LandingDocument> {
  const p = await getLandingPage(scope, pageId);
  if (!p) notFound();
  return p.draft.document;
}

async function edit(pageId: number, f: FormData, change: (doc: LandingDocument, scope: SellerScope) => LandingDocument | Promise<LandingDocument>, done = "1") {
  const scope = await sellerScope();
  await run(editor(pageId), () => `${editor(pageId)}?saved=${done}`, async () => saveDraft(scope, pageId, text(f, "expectedRevisionId"), await change(await draftOf(scope, pageId), scope)));
}

export async function createLandingPageAction(f: FormData) {
  const scope = await sellerScope();
  await run("/seller/landing-pages/new", (id) => `${editor(id as number)}?saved=1`, () => createLandingPage(scope, { title: text(f, "title"), slug: text(f, "slug") }));
}

/** Title/slug live on the page row; accent and font scale are part of the versioned document. */
export async function updateSettingsAction(pageId: number, f: FormData) {
  const scope = await sellerScope();
  await run(editor(pageId), () => `${editor(pageId)}?saved=1`, async () => {
    await updateLandingPageMeta(scope, pageId, { title: text(f, "title"), slug: text(f, "slug") });
    const doc = await draftOf(scope, pageId);
    const design = { accent: text(f, "accent"), fontScale: text(f, "fontScale") } as LandingDocument["design"];
    if (design.accent !== doc.design.accent || design.fontScale !== doc.design.fontScale) {
      await saveDraft(scope, pageId, text(f, "expectedRevisionId"), { ...doc, design });
    }
  });
}

export async function addBlockAction(pageId: number, f: FormData) {
  const type = text(f, "type") as BlockType;
  await edit(pageId, f, async (doc, scope) => {
    if (!BLOCK_TYPES.includes(type)) throw new DomainError("bad_block", "Jenis blok tidak dikenal.");
    const block = newBlock(type);
    if (block.type === "order") {
      const products = await listOrderableProducts(scope);
      const pick = products.find((p) => p.status === "active") ?? products[0];
      if (!pick) throw new DomainError("no_product", "Tambahkan produk dulu di menu Produk sebelum memasang bagian pemesanan.");
      block.productId = pick.id;
    }
    return appendBlock(doc, block);
  });
}

export async function moveBlockAction(pageId: number, f: FormData) {
  const dir = text(f, "dir") === "up" ? "up" : "down";
  await edit(pageId, f, (doc) => moveBlock(doc, text(f, "blockId"), dir));
}

export async function removeBlockAction(pageId: number, f: FormData) {
  await edit(pageId, f, (doc) => removeBlock(doc, text(f, "blockId")));
}

const nullableId = (v: string) => (v.trim() === "" ? null : v);

/** Raw block from the form fields; the document schema validates it inside `saveDraft`. */
function blockFromForm(type: BlockType, id: string, f: FormData): unknown {
  const t = (k: string) => text(f, k);
  const rows = (max: number, keys: string[], first: string) =>
    Array.from({ length: max }, (_, i) => Object.fromEntries(keys.map((k) => [k, t(`items.${i}.${k}`)]))).filter((r) => r[first]!.trim() !== "");
  switch (type) {
    case "hero": return { id, type, headline: t("headline"), subheadline: t("subheadline"), mediaId: nullableId(t("mediaId")), ctaLabel: t("ctaLabel") };
    case "text": return { id, type, body: t("body") };
    case "image": return { id, type, mediaId: nullableId(t("mediaId")), caption: t("caption") };
    case "benefits": return { id, type, title: t("title"), items: rows(8, ["title", "body"], "title") };
    case "testimonials": return { id, type, title: t("title"), items: rows(8, ["quote", "name", "note"], "quote") };
    case "faq": return { id, type, title: t("title"), items: rows(12, ["q", "a"], "q") };
    case "cta": return { id, type, label: t("label"), note: t("note") };
    case "order": return { id, type, productId: t("productId"), title: t("title"), note: t("note") };
  }
}

export async function saveBlockAction(pageId: number, f: FormData) {
  await edit(pageId, f, (doc) => {
    const id = text(f, "blockId");
    const current = doc.blocks.find((b) => b.id === id);
    if (!current) throw new DomainError("not_found", "Blok ini sudah dihapus.");
    return replaceBlock(doc, blockFromForm(current.type, id, f) as LandingBlock);
  });
}

export async function publishAction(pageId: number, f: FormData) {
  const scope = await sellerScope();
  await run(editor(pageId), () => `${editor(pageId)}?saved=published`, () => publishLandingPage(scope, pageId, text(f, "expectedRevisionId")));
}

export async function unpublishAction(pageId: number) {
  const scope = await sellerScope();
  await run(editor(pageId), () => `${editor(pageId)}?saved=unpublished`, () => unpublishLandingPage(scope, pageId));
}
