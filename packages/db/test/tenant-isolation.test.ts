import { describe, expect, it } from "vitest";
import { addVariant, getProduct, listProducts, updateProduct, updateVariant } from "../src/seller/commerce/catalog.ts";
import { variant } from "../src/schema.ts";
import { sellerContext, slugFromHost } from "../src/platform/scoped.ts";
import { getCart, getPublishedProduct, listPublishedProducts, setCartLine } from "../src/storefront/storefront.ts";
import { db, makeStore, platform } from "./helpers.ts";

describe("tenant isolation (TEN-1, TEN-2, TEN-5)", () => {
  it("seller cannot read another store's products", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    expect(await getProduct(a.owner, b.productId)).toBeNull();
    expect((await listProducts(a.owner)).map((p) => p.id)).toEqual([a.productId]);
  });

  it("seller cannot write another store's product or variant", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b", { price: 50_000, stock: 3 });
    await expect(updateProduct(a.owner, b.productId, { title: "hijacked", status: "draft" })).rejects.toMatchObject({ code: "not_found" });
    await expect(addVariant(a.owner, b.productId, { title: "X", price: 1, stock: 1, weightGrams: 1000 })).rejects.toMatchObject({ code: "not_found" });
    await expect(updateVariant(a.owner, b.variantId, { title: "X", price: 1, stock: 999, weightGrams: 1000 })).rejects.toMatchObject({ code: "not_found" });
    const intact = await getProduct(b.owner, b.productId);
    expect(intact).toMatchObject({ title: "Kaos toko-b", status: "active" });
    expect(intact!.variants[0]).toMatchObject({ price: 50_000, stock: 3 });
  });

  it("database rejects a variant whose product belongs to another store", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    await expect(
      platform.insert(variant).values({ storeId: a.storeId, productId: b.productId, title: "X", price: 1, stock: 1, weightGrams: 1000 }),
    ).rejects.toMatchObject({ cause: { constraint_name: "variant_product_fk" } });
  });

  it("a requested store id is honoured only with membership", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const ctx = await sellerContext(db, a.ownerId, b.storeId);
    expect(ctx.ok && ctx.scope.storeId).toBe(a.storeId);
  });

  it("storefront shows only its own store's published catalog", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    expect((await listPublishedProducts(a.sf)).map((p) => p.id)).toEqual([a.productId]);
    expect(await getPublishedProduct(a.sf, String(b.productId))).toBeNull();
    await updateProduct(a.owner, a.productId, { title: "Draft", status: "draft" });
    expect(await getPublishedProduct(a.sf, String(a.productId))).toBeNull();
  });

  it("cart cannot take a foreign variant, and a foreign cart id is not reused", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    await expect(setCartLine(a.sf, undefined, { variantId: b.variantId, quantity: 1 }, "add")).rejects.toMatchObject({ code: "not_found" });
    const cartA = await setCartLine(a.sf, undefined, { variantId: a.variantId, quantity: 2 }, "add");
    expect((await getCart(b.sf, cartA)).lines).toEqual([]);
    const cartB = await setCartLine(b.sf, cartA, { variantId: b.variantId, quantity: 1 }, "add");
    expect(cartB).not.toBe(cartA);
    expect((await getCart(a.sf, cartA)).lines).toHaveLength(1);
  });
});

describe("host resolution", () => {
  it("maps only single-label subdomains of the root domain", () => {
    expect(slugFromHost("toko-a.localhost:3000", "localhost")).toBe("toko-a");
    expect(slugFromHost("TOKO-A.bukalaris.com", "bukalaris.com")).toBe("toko-a");
    expect(slugFromHost("bukalaris.com", "bukalaris.com")).toBeNull();
    expect(slugFromHost("a.b.bukalaris.com", "bukalaris.com")).toBeNull();
    expect(slugFromHost("toko-a.evil.com", "bukalaris.com")).toBeNull();
    expect(slugFromHost("evilbukalaris.com", "bukalaris.com")).toBeNull();
    expect(slugFromHost(null, "bukalaris.com")).toBeNull();
  });
});
