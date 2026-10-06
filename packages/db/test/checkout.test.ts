import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateVariant } from "../src/catalog.ts";
import { getBuyerOrder, placeOrder } from "../src/checkout.ts";
import { fakeProviders, type Providers } from "../src/providers.ts";
import { order, variant } from "../src/schema.ts";
import { setCartLine } from "../src/storefront.ts";
import { buyer, db, makeStore } from "./helpers.ts";

const stockOf = async (id: number) => (await db.select().from(variant).where(eq(variant.id, id)))[0]!.stock;

describe("checkout (PR-4, DATA-2, NFR-2)", () => {
  it("rejects client-supplied prices or totals and derives money server-side", async () => {
    const s = await makeStore("toko-a", { price: 125_000 });
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 2 }, "add");
    for (const tamper of [{ total: 1 }, { unitPrice: 1 }, { shippingFee: 0 }, { lines: [{ variantId: s.variantId, price: 1 }] }]) {
      await expect(placeOrder(db, cartId, buyer(tamper))).rejects.toMatchObject({ name: "ZodError" });
    }
    await expect(placeOrder(db, cartId, buyer({ courier: "free-shipping" }))).rejects.toMatchObject({ code: "courier" });

    const { orderId } = await placeOrder(db, cartId, buyer());
    const o = await getBuyerOrder(db, orderId, cartId);
    // Fee comes from the server-side quote (fake: 15,000 for one cart line), not the client.
    expect(o).toMatchObject({ subtotal: 250_000, shippingFee: 15_000, total: 265_000 });
    expect(o!.lines[0]).toMatchObject({ unitPrice: 125_000, quantity: 2, lineTotal: 250_000 });
    expect(await stockOf(s.variantId)).toBe(8);

    // Later catalog edits do not rewrite the snapshot (DATA-2).
    await updateVariant(s.owner, s.variantId, { title: "M", price: 1, stock: 8 });
    expect((await getBuyerOrder(db, orderId, cartId))!.total).toBe(265_000);
  });

  it("an order id alone does not reveal the order", async () => {
    const s = await makeStore("toko-a");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer());
    expect(await getBuyerOrder(db, orderId, randomUUID())).toBeNull();
    expect(await getBuyerOrder(db, orderId, undefined)).toBeNull();
  });

  it("is idempotent for sequential and concurrent duplicate submits", async () => {
    const s = await makeStore("toko-a", { stock: 10 });
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 3 }, "add");
    const input = buyer();
    const results = await Promise.all(Array.from({ length: 5 }, () => placeOrder(db, cartId, input)));
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const again = await placeOrder(db, cartId, input);
    expect(again).toEqual({ orderId: results[0]!.orderId, replayed: true });
    expect(await db.select().from(order)).toHaveLength(1);
    expect(await stockOf(s.variantId)).toBe(7);
  });

  it("rejects the same idempotency key with a different payload", async () => {
    const s = await makeStore("toko-a");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const input = buyer();
    await placeOrder(db, cartId, input);
    await expect(placeOrder(db, cartId, { ...input, buyerName: "Orang Lain" })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("never oversells or goes negative under concurrent checkout", async () => {
    // 12 placeOrder calls in parallel; each runs its own transaction on its own pooled
    // connection (postgres.js pool, max 10), so they genuinely contend on the row.
    const initial = 3;
    const s = await makeStore("toko-a", { stock: initial });
    const carts = await Promise.all(
      Array.from({ length: 12 }, () => setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add")),
    );
    const settled = await Promise.allSettled(carts.map((c) => placeOrder(db, c, buyer())));
    const ok = settled.filter((r) => r.status === "fulfilled");
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok.length).toBeLessThanOrEqual(initial);
    expect(ok).toHaveLength(initial); // and no false rejections
    expect(failed.every((r) => r.reason.code === "out_of_stock")).toBe(true);
    expect(await stockOf(s.variantId)).toBeGreaterThanOrEqual(0);
    expect(await stockOf(s.variantId)).toBe(0);
    expect(await db.select().from(order)).toHaveLength(3);
  });

  it("rolls back the whole order when one line is out of stock", async () => {
    const s = await makeStore("toko-a", { stock: 5 });
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 6 }, "add");
    await expect(placeOrder(db, cartId, buyer())).rejects.toMatchObject({ code: "out_of_stock" });
    expect(await stockOf(s.variantId)).toBe(5);
    expect(await db.select().from(order)).toHaveLength(0);
  });

  it("transfer orders get a payment instruction after commit; a provider failure leaves an explicit pending state", async () => {
    const s = await makeStore("toko-a");
    const c1 = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, c1, buyer({ paymentMethod: "manual_transfer" }));
    expect(await getBuyerOrder(db, orderId, c1)).toMatchObject({ status: "awaiting_payment", paymentReference: `FAKE-AL-${orderId}` });

    const down: Providers = { ...fakeProviders, payment: { createInstruction: () => Promise.reject(new Error("timeout")) } };
    const c2 = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const r2 = await placeOrder(db, c2, buyer({ paymentMethod: "manual_transfer" }), down);
    expect(await getBuyerOrder(db, r2.orderId, c2)).toMatchObject({ status: "awaiting_payment", paymentReference: null });
  });

  it("a checked-out cart is not reused for new items", async () => {
    const s = await makeStore("toko-a");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await placeOrder(db, cartId, buyer());
    const next = await setCartLine(s.sf, cartId, { variantId: s.variantId, quantity: 1 }, "add");
    expect(next).not.toBe(cartId);
    await expect(placeOrder(db, cartId, buyer())).rejects.toMatchObject({ code: "empty" });
  });
});
