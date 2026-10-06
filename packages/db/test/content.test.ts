import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { updateProduct } from "../src/catalog.ts";
import {
  addProductMedia,
  coverImages,
  createCollection,
  createPage,
  createStoreForOwnerEmail,
  getCollection,
  getPage,
  getPublicMedia,
  getPublishedCollection,
  getPublishedPage,
  getStoreDetail,
  getStorefrontStore,
  listCollections,
  listPages,
  listProductMedia,
  publishedProductImages,
  removeProductMedia,
  searchPublishedProducts,
  sniffImage,
  updateCollection,
  updateMediaAlt,
  updatePage,
  updateStoreSettings,
  validateImage,
} from "../src/content.ts";
import { collectionProduct, media, membership, user } from "../src/schema.ts";
import { makeStore, makeUser, platform, seller } from "./helpers.ts";

// Header-only fixtures: sniffing reads dimensions from the first bytes, never the extension.
const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpeg = (w: number, h: number) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const webp = (w: number, h: number) => {
  const b = new Uint8Array(30);
  b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  b.set([..."WEBPVP8 "].map((c) => c.charCodeAt(0)), 8);
  b[26] = w & 255; b[27] = w >> 8; b[28] = h & 255; b[29] = h >> 8;
  return b;
};

describe("content: upload validation (SEC-8)", () => {
  it("sniffs jpg/png/webp and reads dimensions from the header", () => {
    expect(sniffImage(png(640, 480))).toEqual({ mime: "image/png", width: 640, height: 480 });
    expect(sniffImage(jpeg(300, 200))).toEqual({ mime: "image/jpeg", width: 300, height: 200 });
    expect(sniffImage(webp(1024, 768))).toEqual({ mime: "image/webp", width: 1024, height: 768 });
  });

  it("rejects non-images, empty, oversized and absurd dimensions regardless of file name", () => {
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(() => validateImage(new Uint8Array(0))).toThrow(expect.objectContaining({ code: "empty_file" }));
    expect(() => validateImage(new TextEncoder().encode("%PDF-1.4 fake.jpg"))).toThrow(expect.objectContaining({ code: "bad_type" }));
    expect(() => validateImage(new Uint8Array(5 * 1024 * 1024 + 1))).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(() => validateImage(png(20_000, 10))).toThrow(expect.objectContaining({ code: "bad_dims" }));
    expect(() => validateImage(png(0, 10))).toThrow(expect.objectContaining({ code: "bad_dims" }));
  });
});

describe("content: store settings and theme (SC-10/11, PR-8)", () => {
  it("owner updates settings; staff is denied; storefront sees the theme", async () => {
    const a = await makeStore("toko-a");
    const staffId = await makeUser("staff");
    await platform.insert(membership).values({ storeId: a.storeId, userId: staffId, role: "staff" });
    const staff = await seller(staffId);
    await expect(updateStoreSettings(staff, { name: "X", theme: "mobile" })).rejects.toMatchObject({ code: "forbidden" });

    await updateStoreSettings(a.owner, { name: "Toko Ayu", description: "Kaos lokal.", whatsapp: "0812-3456-7890", theme: "mobile" });
    expect(await getStorefrontStore(a.sf)).toEqual({ description: "Kaos lokal.", whatsapp: "6281234567890", theme: "mobile" });
    await expect(updateStoreSettings(a.owner, { name: "Toko Ayu", whatsapp: "+1 555 0100", theme: "mobile" })).rejects.toThrow(/WhatsApp/);
    await expect(updateStoreSettings(a.owner, { name: "Toko Ayu", theme: "neon" })).rejects.toThrow();
  });

  it("settings of another store are untouched", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    await updateStoreSettings(a.owner, { name: "Renamed A", theme: "mobile" });
    expect(await getStorefrontStore(b.sf)).toMatchObject({ theme: "responsive" });
  });
});

describe("content: collections (SC-05/06, SF-02)", () => {
  it("membership cannot reference a foreign product (service and database)", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    await expect(
      createCollection(a.owner, { title: "Best", slug: "best", status: "published", productIds: [a.productId, b.productId] }),
    ).rejects.toMatchObject({ code: "foreign_product" });
    const id = await createCollection(a.owner, { title: "Best", slug: "best", status: "published", productIds: [a.productId] });
    await expect(
      platform.insert(collectionProduct).values({ collectionId: id, storeId: a.storeId, productId: b.productId, position: 9 }),
    ).rejects.toMatchObject({ cause: { constraint_name: "collection_product_product_fk" } });
    await expect(
      platform.insert(collectionProduct).values({ collectionId: id, storeId: b.storeId, productId: b.productId, position: 9 }),
    ).rejects.toMatchObject({ cause: { constraint_name: "collection_product_collection_fk" } });
  });

  it("cross-store read/write is denied and storefront shows only published, active members in order", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const id = await createCollection(a.owner, { title: "Pilihan", slug: "pilihan", productIds: [a.productId] });
    expect(await getCollection(b.owner, id)).toBeNull();
    expect((await listCollections(b.owner)).length).toBe(0);
    await expect(updateCollection(b.owner, id, { title: "hijack", slug: "pilihan" })).rejects.toMatchObject({ code: "not_found" });
    await expect(createCollection(a.owner, { title: "Dup", slug: "pilihan" })).rejects.toMatchObject({ code: "slug_taken" });

    expect(await getPublishedCollection(a.sf, "pilihan")).toBeNull(); // draft
    await updateCollection(a.owner, id, { title: "Pilihan", slug: "pilihan", status: "published", productIds: [a.productId] });
    expect(await getPublishedCollection(b.sf, "pilihan")).toBeNull(); // other store
    const shown = await getPublishedCollection(a.sf, "pilihan");
    expect(shown?.products.map((p) => p.id)).toEqual([a.productId]);
    expect(shown?.products[0]?.minPrice).toBe(100_000);
    await updateProduct(a.owner, a.productId, { title: "Kaos toko-a", status: "draft" });
    expect((await getPublishedCollection(a.sf, "pilihan"))?.products).toEqual([]);
  });
});

describe("content: CMS pages (SC-07/08, SF-05)", () => {
  it("rejects reserved and invalid slugs", async () => {
    const a = await makeStore("toko-a");
    for (const s of ["products", "cart", "checkout", "search", "collections", "admin", "Produk Baru"]) {
      await expect(createPage(a.owner, { title: "x", slug: s })).rejects.toThrow();
    }
  });

  it("unpublished pages are hidden and other stores cannot read or edit", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const id = await createPage(a.owner, { title: "Tentang", slug: "tentang", body: "# Halo\n\nKami **lokal**." });
    expect(await getPublishedPage(a.sf, "tentang")).toBeNull();
    expect(await getPage(b.owner, id)).toBeNull();
    expect(await listPages(b.owner)).toEqual([]);
    await expect(updatePage(b.owner, id, { title: "hijack", slug: "tentang" })).rejects.toMatchObject({ code: "not_found" });
    await updatePage(a.owner, id, { title: "Tentang", slug: "tentang", body: "Isi", status: "published" });
    expect(await getPublishedPage(a.sf, "tentang")).toMatchObject({ title: "Tentang", body: "Isi" });
    expect(await getPublishedPage(b.sf, "tentang")).toBeNull();
    await expect(createPage(a.owner, { title: "Dup", slug: "tentang" })).rejects.toMatchObject({ code: "slug_taken" });
  });
});

describe("content: product media", () => {
  it("validates bytes, orders images, scopes reads and denies foreign access", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    await expect(addProductMedia(a.owner, a.productId, new TextEncoder().encode("nope"), "")).rejects.toMatchObject({ code: "bad_type" });
    await expect(addProductMedia(a.owner, b.productId, png(10, 10), "")).rejects.toMatchObject({ code: "not_found" });
    await expect(
      platform.insert(media).values({ storeId: a.storeId, productId: b.productId, position: 0, mime: "image/png", width: 1, height: 1, bytes: 1 }),
    ).rejects.toMatchObject({ cause: { constraint_name: "media_product_fk" } });

    const first = await addProductMedia(a.owner, a.productId, png(800, 600), "Tampak depan");
    const second = await addProductMedia(a.owner, a.productId, jpeg(640, 640), "");
    expect(first.key).toBe(`${a.storeId}/${first.id}.png`);
    expect((await listProductMedia(a.owner, a.productId)).map((m) => m.id)).toEqual([first.id, second.id]);
    expect((await coverImages(a.sf, [a.productId])).get(a.productId)?.alt).toBe("Tampak depan");
    expect((await publishedProductImages(a.sf, a.productId)).length).toBe(2);

    expect(await listProductMedia(b.owner, a.productId)).toEqual([]);
    await expect(updateMediaAlt(b.owner, first.id, "hijack")).rejects.toMatchObject({ code: "not_found" });
    await expect(removeProductMedia(b.owner, first.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await getPublicMedia(b.sf, first.id)).toBeNull();
    expect(await getPublicMedia(a.sf, first.id)).toMatchObject({ mime: "image/png", key: first.key });

    await updateMediaAlt(a.owner, first.id, "Depan");
    expect(await removeProductMedia(a.owner, second.id)).toBe(`${a.storeId}/${second.id}.jpg`);
    expect(await listProductMedia(a.owner, a.productId)).toMatchObject([{ id: first.id, alt: "Depan" }]);
  });
});

describe("content: storefront search (SF-03)", () => {
  it("finds only this store's active products, escaping wildcards", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    expect((await searchPublishedProducts(a.sf, "kaos")).products.map((p) => p.id)).toEqual([a.productId]);
    expect((await searchPublishedProducts(b.sf, "toko-a")).products).toEqual([]);
    expect((await searchPublishedProducts(a.sf, "%")).products).toEqual([]);
    expect((await searchPublishedProducts(a.sf, "")).products).toEqual([]);
    await updateProduct(a.owner, a.productId, { title: "Kaos toko-a", status: "archived" });
    expect((await searchPublishedProducts(a.sf, "kaos")).products).toEqual([]);
  });
});

describe("content: Super Admin store detail and creation (SA-03)", () => {
  it("creates a store for an existing owner email and reports counts", async () => {
    const a = await makeStore("toko-a");
    const ownerId = await makeUser("new-owner");
    const [{ email }] = await platform.select({ email: user.email }).from(user).where(eq(user.id, ownerId));
    await expect(createStoreForOwnerEmail(a.op, { slug: "toko-c", name: "Toko C", ownerEmail: "nobody@test.local" })).rejects.toMatchObject({ code: "owner_not_found" });
    await expect(createStoreForOwnerEmail(a.op, { slug: "toko-a", name: "Dup", ownerEmail: email })).rejects.toMatchObject({ code: "slug_taken" });
    const id = await createStoreForOwnerEmail(a.op, { slug: "toko-c", name: "Toko C", ownerEmail: email.toUpperCase() });
    const detail = await getStoreDetail(a.op, id);
    expect(detail).toMatchObject({ slug: "toko-c", status: "active", theme: "responsive", counts: { products: 0, members: 1, orders: 0 } });
    expect(detail?.members).toMatchObject([{ email, role: "owner" }]);
    expect(detail?.audit[0]).toMatchObject({ action: "store.create" });
    expect((await getStoreDetail(a.op, a.storeId))?.counts.products).toBe(1);
    expect(await getStoreDetail(a.op, 999_999)).toBeNull();
  });
});
