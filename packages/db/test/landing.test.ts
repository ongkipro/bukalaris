import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateProduct } from "../src/catalog.ts";
import { addProductMedia } from "../src/content.ts";
import {
  appendBlock,
  createLandingPage,
  defaultDocument,
  getDraftLandingPage,
  getLandingPage,
  getPublishedLandingPage,
  landingDocument,
  listLandingPages,
  listStoreMedia,
  moveBlock,
  newBlock,
  publishLandingPage,
  removeBlock,
  replaceBlock,
  saveDraft,
  unpublishLandingPage,
  type LandingDocument,
} from "../src/landing.ts";
import { makeStore, platform } from "./helpers.ts";

// landing track (T-42, PR-9): store-owned pages with immutable revisions, draft/published
// pointers, expected-revision checks and document validation; all under RLS (`db` = app role).

/** Header-only PNG so a media row can exist (content.ts sniffs bytes, never a file name). */
const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

const withOrder = (doc: LandingDocument, productId: number): LandingDocument => appendBlock(doc, { ...newBlock("order"), productId } as never);

describe("landing: pages and revisions", () => {
  it("creates a page with revision 1 as its draft, lists it, validates and dedupes slugs", async () => {
    const a = await makeStore("toko-a");
    const id = await createLandingPage(a.owner, { title: "Promo Kaos", slug: "promo-kaos" });
    const page = (await getLandingPage(a.owner, id))!;
    expect(page).toMatchObject({ slug: "promo-kaos", title: "Promo Kaos", status: "draft", publishedRevisionId: null, published: null });
    expect(page.draft.revisionNumber).toBe(1);
    expect(page.draft.id).toBe(page.draftRevisionId);
    expect(page.draft.document.blocks[0]).toMatchObject({ type: "hero", headline: "Promo Kaos" });
    expect((await listLandingPages(a.owner)).map((p) => p.slug)).toEqual(["promo-kaos"]);

    await expect(createLandingPage(a.owner, { title: "X", slug: "cart" })).rejects.toThrow(/dicadangkan/);
    await expect(createLandingPage(a.owner, { title: "X", slug: "lp" })).rejects.toThrow(/dicadangkan/);
    await expect(createLandingPage(a.owner, { title: "X", slug: "Promo Kaos!" })).rejects.toThrow(/huruf kecil/);
    await expect(createLandingPage(a.owner, { title: "X", slug: "promo-kaos" })).rejects.toMatchObject({ code: "slug_taken" });
  });

  it("saveDraft appends an immutable revision and moves the pointer; a stale expected revision is rejected", async () => {
    const a = await makeStore("toko-a");
    const id = await createLandingPage(a.owner, { title: "Promo", slug: "promo" });
    const r1 = (await getLandingPage(a.owner, id))!.draftRevisionId!;
    const doc2 = appendBlock(defaultDocument("Promo"), { ...newBlock("faq"), items: [{ q: "Kirim ke mana?", a: "Seluruh Indonesia." }] } as never);
    const r2 = await saveDraft(a.owner, id, r1, doc2);
    expect(r2).not.toBe(r1);
    const after = (await getLandingPage(a.owner, id))!;
    expect(after.draftRevisionId).toBe(r2);
    expect(after.draft.revisionNumber).toBe(2);
    expect(after.draft.document.blocks.map((b) => b.type)).toEqual(["hero", "faq"]);

    // The tab that still holds r1 cannot overwrite r2.
    await expect(saveDraft(a.owner, id, r1, defaultDocument("Lama"))).rejects.toMatchObject({ code: "stale_revision" });
    expect((await getLandingPage(a.owner, id))!.draftRevisionId).toBe(r2);
    // Revision 1 is untouched (immutable snapshot).
    const [{ n }] = (await platform.execute(sql`select count(*)::int as n from landing_page_revision where page_id = ${id}`)) as unknown as { n: number }[];
    expect(n).toBe(2);
    // Two concurrent saves from the same base: exactly one wins.
    const results = await Promise.allSettled([saveDraft(a.owner, id, r2, doc2), saveDraft(a.owner, id, r2, doc2)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("validates the document: block shape, one order section, bounded blocks, store-owned media and product", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const id = await createLandingPage(a.owner, { title: "Promo", slug: "promo" });
    const rev = (await getLandingPage(a.owner, id))!.draftRevisionId!;
    const base = defaultDocument("Promo");
    expect(() => landingDocument.parse({ ...base, blocks: [{ id: "abcd1234", type: "video", url: "x" }] })).toThrow();
    expect(() => landingDocument.parse({ ...base, version: 2 })).toThrow();
    expect(() => landingDocument.parse({ ...base, design: { accent: "neon", fontScale: "regular" } })).toThrow();
    expect(() => landingDocument.parse(withOrder(withOrder(base, a.productId), a.productId))).toThrow(/satu bagian pemesanan/);
    expect(() => landingDocument.parse({ ...base, blocks: Array.from({ length: 31 }, (_, i) => ({ ...newBlock("text"), id: `blok${i.toString().padStart(4, "0")}` })) })).toThrow(/Maksimal/);
    expect(() => landingDocument.parse({ ...base, blocks: [{ ...newBlock("hero"), extra: 1 }] })).toThrow();

    await expect(saveDraft(a.owner, id, rev, withOrder(base, b.productId))).rejects.toMatchObject({ code: "foreign_product" });
    const bMedia = await addProductMedia(b.owner, b.productId, png(10, 10), "b");
    await expect(saveDraft(a.owner, id, rev, appendBlock(base, { ...newBlock("image"), mediaId: bMedia.id } as never))).rejects.toMatchObject({ code: "foreign_media" });
    const aMedia = await addProductMedia(a.owner, a.productId, png(10, 10), "Kaos A");
    expect((await listStoreMedia(a.owner)).map((m) => m.id)).toEqual([aMedia.id]);
    const ok = await saveDraft(a.owner, id, rev, appendBlock(withOrder(base, a.productId), { ...newBlock("image"), mediaId: aMedia.id } as never));
    expect(ok).toBeGreaterThan(rev);
  });
});

describe("landing: publish pointer, visibility and isolation", () => {
  it("publish points the public route at the draft (active product required); unpublish hides it; drafts are never public", async () => {
    const a = await makeStore("toko-a");
    const id = await createLandingPage(a.owner, { title: "Promo", slug: "promo" });
    const r1 = (await getLandingPage(a.owner, id))!.draftRevisionId!;
    const r2 = await saveDraft(a.owner, id, r1, withOrder(defaultDocument("Promo"), a.productId));
    expect(await getPublishedLandingPage(a.sf, "promo")).toBeNull();

    await updateProduct(a.owner, a.productId, { title: `Kaos toko-a`, status: "draft" });
    await expect(publishLandingPage(a.owner, id, r2)).rejects.toMatchObject({ code: "product_inactive" });
    await updateProduct(a.owner, a.productId, { title: `Kaos toko-a`, status: "active" });
    await expect(publishLandingPage(a.owner, id, r1)).rejects.toMatchObject({ code: "stale_revision" });
    await publishLandingPage(a.owner, id, r2);

    const live = (await getPublishedLandingPage(a.sf, "promo"))!;
    expect(live.revisionId).toBe(r2);
    expect(live.product).toMatchObject({ id: a.productId, status: "active" });
    expect(live.product!.variants).toEqual([expect.objectContaining({ id: a.variantId, price: 100_000, stock: 10 })]);
    expect((await getLandingPage(a.owner, id))!).toMatchObject({ status: "published", publishedRevisionId: r2 });

    // A new draft does not change what is live until it is published.
    const r3 = await saveDraft(a.owner, id, r2, defaultDocument("Promo v3"));
    expect((await getPublishedLandingPage(a.sf, "promo"))!.revisionId).toBe(r2);
    expect((await getDraftLandingPage(a.owner, id))!.revisionId).toBe(r3);

    await unpublishLandingPage(a.owner, id);
    expect(await getPublishedLandingPage(a.sf, "promo")).toBeNull();
    expect((await getLandingPage(a.owner, id))!).toMatchObject({ status: "draft", publishedRevisionId: null, draftRevisionId: r3 });
    const audits = (await platform.execute(sql`select action from audit_log where store_id = ${a.storeId} and action like 'landing.%' order by id`)) as unknown as { action: string }[];
    expect(audits.map((x) => x.action)).toEqual([`landing.publish:${id}:${r2}`, `landing.unpublish:${id}`]);
  });

  it("pointer integrity is enforced by the database: a pointer cannot name another page's revision, and published needs a pointer", async () => {
    const a = await makeStore("toko-a");
    const p1 = await createLandingPage(a.owner, { title: "Satu", slug: "satu" });
    const p2 = await createLandingPage(a.owner, { title: "Dua", slug: "dua" });
    const r2 = (await getLandingPage(a.owner, p2))!.draftRevisionId!;
    await expect(platform.execute(sql`update landing_page set published_revision_id = ${r2}, status = 'published' where id = ${p1}`)).rejects.toMatchObject({
      cause: { constraint_name: "landing_page_published_revision_fk" },
    });
    await expect(platform.execute(sql`update landing_page set draft_revision_id = ${r2} where id = ${p1}`)).rejects.toMatchObject({ cause: { constraint_name: "landing_page_draft_revision_fk" } });
    await expect(platform.execute(sql`update landing_page set status = 'published' where id = ${p1}`)).rejects.toMatchObject({ cause: { constraint_name: "landing_page_published_chk" } });
    await expect(platform.execute(sql`update landing_page_revision set revision_number = 1 where page_id = ${p2}`)).resolves.toBeDefined(); // same value: no-op
    await expect(platform.execute(sql`insert into landing_page_revision (store_id, page_id, revision_number, schema_version, document, created_by) values (${a.storeId}, ${p2}, 1, 1, '{}', 'x')`)).rejects.toMatchObject({
      cause: { constraint_name: "landing_page_revision_number_uq" },
    });
  });

  it("another store never sees, edits, publishes or resolves the page; the same slug is free per store", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const id = await createLandingPage(a.owner, { title: "Promo", slug: "promo" });
    const r1 = (await getLandingPage(a.owner, id))!.draftRevisionId!;
    await saveDraft(a.owner, id, r1, withOrder(defaultDocument("Promo"), a.productId));
    const r2 = (await getLandingPage(a.owner, id))!.draftRevisionId!;
    await publishLandingPage(a.owner, id, r2);

    expect(await getLandingPage(b.owner, id)).toBeNull();
    expect(await getDraftLandingPage(b.owner, id)).toBeNull();
    expect(await listLandingPages(b.owner)).toEqual([]);
    await expect(saveDraft(b.owner, id, r2, defaultDocument("Dibajak"))).rejects.toMatchObject({ code: "not_found" });
    await expect(publishLandingPage(b.owner, id, r2)).rejects.toMatchObject({ code: "not_found" });
    await expect(unpublishLandingPage(b.owner, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getPublishedLandingPage(b.sf, "promo")).resolves.toBeNull();
    expect((await getPublishedLandingPage(a.sf, "promo"))!.revisionId).toBe(r2);

    // Same slug in store B is a different page; its order block cannot borrow A's product.
    const bId = await createLandingPage(b.owner, { title: "Promo B", slug: "promo" });
    const bRev = (await getLandingPage(b.owner, bId))!.draftRevisionId!;
    await expect(saveDraft(b.owner, bId, bRev, withOrder(defaultDocument("Promo B"), a.productId))).rejects.toMatchObject({ code: "foreign_product" });
    expect((await getLandingPage(b.owner, bId))!.title).toBe("Promo B");
    expect((await getLandingPage(a.owner, id))!.title).toBe("Promo");
  });
});

describe("landing: block helpers", () => {
  it("move up/down, remove and replace keep ids unique and order stable", () => {
    const doc = ["hero", "text", "faq"].reduce((d, t, i) => appendBlock(d, { ...newBlock(t as never), id: `blok000${i}` }), { ...defaultDocument("x"), blocks: [] } as LandingDocument);
    const ids = (d: LandingDocument) => d.blocks.map((b) => b.id);
    expect(ids(moveBlock(doc, "blok0002", "up"))).toEqual(["blok0000", "blok0002", "blok0001"]);
    expect(ids(moveBlock(doc, "blok0000", "up"))).toEqual(ids(doc));
    expect(ids(moveBlock(doc, "blok0002", "down"))).toEqual(ids(doc));
    expect(ids(removeBlock(doc, "blok0001"))).toEqual(["blok0000", "blok0002"]);
    const replaced = replaceBlock(doc, { ...newBlock("text"), id: "blok0001", body: "Baru" } as never);
    expect(replaced.blocks[1]).toMatchObject({ id: "blok0001", body: "Baru" });
    expect(() => landingDocument.parse(replaced)).not.toThrow();
  });
});

describe("landing: storefront route group keeps Log System modules", () => {
  it("ignores the (shop) group in Next route paths", async () => {
    const { moduleForRoute } = await import("../src/ops.ts");
    expect(moduleForRoute("/app/s/[store]/(shop)/cart/page")).toBe("storefront.cart");
    expect(moduleForRoute("/app/s/[store]/(shop)/cart/page")).toBe(moduleForRoute("/app/s/[store]/cart/page"));
    expect(moduleForRoute("/app/s/[store]/(shop)/page")).toBe("storefront.catalog");
  });
});
