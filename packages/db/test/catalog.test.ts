import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addVariant, canonicalSlug, createProduct, getProduct, listCatalogHistory, updateProduct, updateVariant } from "../src/catalog.ts";
import { getBuyerOrder, placeOrder } from "../src/checkout.ts";
import { catalogAudit, product, productSlugAlias, variant } from "../src/schema.ts";
import { getPublishedProduct, listPublishedProducts, setCartLine } from "../src/storefront.ts";
import { buyer, db, makeStore, platform } from "./helpers.ts";

const CATALOG_ID = /^[1-9][0-9]{4,}$/;
const resolve = async (sf: Parameters<typeof getPublishedProduct>[0], segment: string) => {
  const p = await getPublishedProduct(sf, segment);
  return p && canonicalSlug(p);
};

describe("catalog ids (T-14, PR-12, DATA-5, D-8)", () => {
  it("concurrent creates get distinct, immutable, platform-wide ids ≥ 10000 as strings", async () => {
    const s = await makeStore("toko-a");
    const ids = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createProduct(s.owner, { title: `P${i}`, variant: { title: "D", price: 1000 * (i + 1), stock: 1 } })),
    );
    await addVariant(s.owner, ids[0]!, { title: "L", price: 5000, stock: 1 });
    const products = await platform.select({ catalogId: product.catalogId }).from(product);
    const variants = await platform.select({ catalogId: variant.catalogId }).from(variant);
    const all = [...products, ...variants].map((r) => r.catalogId);
    expect(all).toHaveLength(9 + 10); // makeStore's product + 8, their 9 variants + 1
    for (const id of all) {
      expect(typeof id).toBe("string");
      expect(id).toMatch(CATALOG_ID);
      expect(Number(id)).toBeGreaterThanOrEqual(10000);
    }
    expect(new Set(all).size).toBe(all.length); // one sequence: a variant id never equals a product id

    // Immutable after insert, even for a direct SQL update (trigger, migration 0003).
    await expect(platform.update(product).set({ catalogId: "99999999" }).where(eq(product.id, ids[0]!))).rejects.toMatchObject({
      cause: { constraint_name: "catalog_id_immutable" },
    });
    await expect(platform.update(variant).set({ catalogId: "99999998" }).where(eq(variant.id, s.variantId))).rejects.toMatchObject({
      cause: { constraint_name: "catalog_id_immutable" },
    });
    // Other columns still update; the id survives title and slug changes.
    const before = (await getProduct(s.owner, s.productId))!.catalogId;
    await updateProduct(s.owner, s.productId, { title: "Renamed", slug: "renamed", status: "active" });
    expect((await getProduct(s.owner, s.productId))!.catalogId).toBe(before);
  });

  it("serialises the catalog id as a string at storefront, API shape and order-snapshot boundaries", async () => {
    const s = await makeStore("toko-a", { price: 125_000 });
    const p = (await getPublishedProduct(s.sf, String(s.productId)))!;
    expect(p.catalogId).toMatch(CATALOG_ID);
    expect(JSON.parse(JSON.stringify(p))).toMatchObject({ catalogId: p.catalogId, variants: [{ catalogId: expect.stringMatching(CATALOG_ID) }] });
    expect((await listPublishedProducts(s.sf))[0]!.catalogId).toBe(p.catalogId);
    // The storefront's canonical segment is the catalog id when there is no readable slug — never the database id.
    expect(canonicalSlug(p)).toBe(p.catalogId);
    expect(canonicalSlug(p)).not.toBe(String(s.productId));

    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer());
    const line = (await getBuyerOrder(db, orderId, cartId))!.lines[0]!;
    expect(line.variantCatalogId).toBe(p.variants[0]!.catalogId);
    expect(typeof line.variantCatalogId).toBe("string");
  });

  it("resolves the catalog id, legacy database id, slug and aliases to one canonical URL without chains", async () => {
    const s = await makeStore("toko-a");
    const id = await createProduct(s.owner, { title: "Kaos", slug: "kaos-lama", status: "active", variant: { title: "M", price: 1000, stock: 1 } });
    const { catalogId } = (await getProduct(s.owner, id))!;
    expect(await resolve(s.sf, "kaos-lama")).toBe("kaos-lama");
    expect(await resolve(s.sf, catalogId)).toBe("kaos-lama"); // numeric ≥ 10000 → catalog id, page 308s to the slug
    expect(await resolve(s.sf, String(id))).toBe("kaos-lama"); // legacy database id keeps resolving (308)

    await updateProduct(s.owner, id, { title: "Kaos", slug: "kaos-baru", status: "active" });
    await updateProduct(s.owner, id, { title: "Kaos", slug: "kaos-final", status: "active" });
    // Both historical slugs point directly at the current canonical (one redirect, no chain).
    expect(await resolve(s.sf, "kaos-lama")).toBe("kaos-final");
    expect(await resolve(s.sf, "kaos-baru")).toBe("kaos-final");
    expect(await resolve(s.sf, "kaos-final")).toBe("kaos-final");
    expect((await platform.select().from(productSlugAlias)).map((a) => a.slug).sort()).toEqual(["kaos-baru", "kaos-lama"]);

    // Aliases are never handed to another product of the store — on create or on update.
    await expect(createProduct(s.owner, { title: "X", slug: "kaos-lama", variant: { title: "D", price: 1, stock: 1 } })).rejects.toMatchObject({ code: "slug_taken" });
    await expect(updateProduct(s.owner, s.productId, { title: "Kaos toko-a", slug: "kaos-baru", status: "active" })).rejects.toMatchObject({ code: "slug_taken" });
    // The owning product can take an old slug back; it becomes current again (no self-redirect).
    await updateProduct(s.owner, id, { title: "Kaos", slug: "kaos-lama", status: "active" });
    expect(await resolve(s.sf, "kaos-lama")).toBe("kaos-lama");
    expect((await platform.select().from(productSlugAlias)).map((a) => a.slug).sort()).toEqual(["kaos-baru", "kaos-final"]);

    // Clearing the slug falls back to the catalog id; the readable slug becomes an alias.
    await updateProduct(s.owner, id, { title: "Kaos", slug: "", status: "active" });
    expect(await resolve(s.sf, "kaos-lama")).toBe(catalogId);

    // Aliases resolve only published products of this store.
    await updateProduct(s.owner, id, { title: "Kaos", slug: null, status: "draft" });
    expect(await getPublishedProduct(s.sf, "kaos-final")).toBeNull();
    const b = await makeStore("toko-b");
    expect(await getPublishedProduct(b.sf, "kaos-final")).toBeNull();
    expect(await getPublishedProduct(b.sf, catalogId)).toBeNull();
  });
});

describe("catalog audit (T-31, SEC-17)", () => {
  it("writes actor/store/object/before-after rows for create, price, stock and status changes, scoped to the store", async () => {
    const a = await makeStore("toko-a", { price: 89_000, stock: 20 });
    const b = await makeStore("toko-b");
    const created = await listCatalogHistory(a.owner, a.productId);
    expect(created.map((r) => r.action)).toEqual(["variant.create", "product.create"]);
    expect(created[1]).toMatchObject({ actorName: expect.any(String), before: null, after: { title: "Kaos toko-a", status: "active", slug: null } });
    expect(created[0]).toMatchObject({ variantId: a.variantId, after: { price: 89_000, stock: 20, title: "M", sku: null } });

    await updateVariant(a.owner, a.variantId, { title: "M", price: 95_000, stock: 18 });
    await updateProduct(a.owner, a.productId, { title: "Kaos toko-a", status: "archived" });
    await updateProduct(a.owner, a.productId, { title: "Kaos toko-a", status: "archived" }); // no change → no row
    const vId = await addVariant(a.owner, a.productId, { title: "L", price: 99_000, stock: 3 });
    const rows = await listCatalogHistory(a.owner, a.productId);
    expect(rows.map((r) => r.action)).toEqual(["variant.create", "product.update", "variant.update", "variant.create", "product.create"]);
    expect(rows[2]).toMatchObject({ variantId: a.variantId, variantTitle: "M", before: { price: 89_000, stock: 20 }, after: { price: 95_000, stock: 18 } });
    expect(rows[1]).toMatchObject({ variantId: null, before: { status: "active" }, after: { status: "archived" } });
    expect(rows[0]).toMatchObject({ variantId: vId, after: { price: 99_000, stock: 3 } });
    for (const r of await platform.select().from(catalogAudit).where(eq(catalogAudit.productId, a.productId))) {
      expect(r).toMatchObject({ storeId: a.storeId, actorUserId: a.ownerId });
    }

    // Cross-store: another store's owner sees no history and a denied write leaves no row.
    expect(await listCatalogHistory(b.owner, a.productId)).toEqual([]);
    await expect(updateVariant(b.owner, a.variantId, { title: "M", price: 1, stock: 1 })).rejects.toMatchObject({ code: "not_found" });
    expect(await listCatalogHistory(a.owner, a.productId)).toHaveLength(5);
    // The database rejects an audit row whose product belongs to another store.
    await expect(
      platform.insert(catalogAudit).values({ storeId: b.storeId, actorUserId: b.ownerId, productId: a.productId, action: "product.update" }),
    ).rejects.toMatchObject({ cause: { constraint_name: "catalog_audit_product_fk" } });
  });
});
