import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.ts";
import {
  adjustStock,
  allowedActions,
  getOrder,
  listInventory,
  listOrders,
  listStockAdjustments,
  TRANSITIONS,
  transitionOrder,
  type OrderAction,
} from "../src/orders.ts";
import { membership, order, ORDER_STATUSES, orderStatusHistory, stockAdjustment, variant, type OrderStatus } from "../src/schema.ts";
import { setCartLine } from "../src/storefront.ts";
import { buyer, db, makeStore, makeUser, seller } from "./helpers.ts";

const stockOf = async (id: number) => (await db.select().from(variant).where(eq(variant.id, id)))[0]!.stock;
const statusOf = async (id: number) => (await db.select().from(order).where(eq(order.id, id)))[0]!.status;

type Store = Awaited<ReturnType<typeof makeStore>>;
async function placed(s: Store, qty = 1, over: Record<string, unknown> = {}) {
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: qty }, "add");
  return (await placeOrder(db, cartId, buyer(over))).orderId;
}
/** Force an order into a given status directly (the matrix test needs every start state). */
/** The strict input each action accepts (extra keys are rejected by the schema). */
const inputFor = (action: OrderAction) =>
  action === "ship" ? { trackingNumber: "RESI-1" } : action === "cancel" ? { reason: "uji transisi pesanan" } : {};
const force = (id: number, status: OrderStatus) =>
  db.update(order).set({ status, trackingNumber: status === "shipped" || status === "completed" ? "X" : null }).where(eq(order.id, id));

describe("seller orders (SC-12/SC-13)", () => {
  it("lists newest first with a status filter and a stable cursor", async () => {
    const s = await makeStore("toko-a", { stock: 50 });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await placed(s, 1, i % 2 ? { paymentMethod: "manual_transfer" } : {}));

    const p1 = await listOrders(s.owner, { limit: 2 });
    expect(p1.orders.map((o) => o.id)).toEqual([ids[4], ids[3]]);
    expect(p1.nextCursor).toBe(ids[3]);
    const p2 = await listOrders(s.owner, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.orders.map((o) => o.id)).toEqual([ids[2], ids[1]]);
    const p3 = await listOrders(s.owner, { limit: 2, cursor: p2.nextCursor! });
    expect(p3.orders.map((o) => o.id)).toEqual([ids[0]]);
    expect(p3.nextCursor).toBeNull();

    const awaiting = await listOrders(s.owner, { status: "awaiting_payment" });
    expect(awaiting.orders.map((o) => o.id)).toEqual([ids[3], ids[1]]);
    await expect(listOrders(s.owner, { status: "hacked" })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("detail shows the line snapshot, buyer contact, totals, payment and history; secrets are not exposed", async () => {
    const s = await makeStore("toko-a", { price: 125_000 });
    const id = await placed(s, 2, { paymentMethod: "manual_transfer" });
    const o = (await getOrder(s.owner, id))!;
    expect(o).toMatchObject({
      status: "awaiting_payment",
      buyerName: "Budi Santoso",
      buyerPhone: "081234567890",
      paymentMethod: "manual_transfer",
      paymentReference: `FAKE-AL-${id}`,
      subtotal: 250_000,
      total: 265_000,
      actions: ["pay", "cancel"],
    });
    expect(o.lines).toEqual([expect.objectContaining({ productTitle: "Kaos toko-a", variantTitle: "M", unitPrice: 125_000, quantity: 2 })]);
    expect(o.history).toEqual([]);
    expect(o).not.toHaveProperty("requestHash");
    expect(o).not.toHaveProperty("idempotencyKey");
  });

  it("cross-store: another store's seller cannot read or transition the order", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const id = await placed(a);
    expect(await getOrder(b.owner, id)).toBeNull();
    expect((await listOrders(b.owner)).orders).toEqual([]);
    for (const action of Object.keys(TRANSITIONS) as OrderAction[]) {
      await expect(transitionOrder(b.owner, id, action, inputFor(action))).rejects.toMatchObject({ code: "not_found" });
    }
    expect(await statusOf(id)).toBe("placed");
    expect(await stockOf(a.variantId)).toBe(9);
    expect(await db.select().from(orderStatusHistory)).toHaveLength(0);
  });

  it("happy path: paid → processing → shipped → completed, each step audited with the actor", async () => {
    const s = await makeStore("toko-a");
    const id = await placed(s, 1, { paymentMethod: "manual_transfer" });
    expect(await transitionOrder(s.owner, id, "pay")).toBe("placed");
    expect(await transitionOrder(s.owner, id, "process")).toBe("processing");
    await expect(transitionOrder(s.owner, id, "ship", { trackingNumber: "x" })).rejects.toMatchObject({ name: "ZodError" });
    expect(await transitionOrder(s.owner, id, "ship", { trackingNumber: "JNE-0001" })).toBe("shipped");
    expect(await transitionOrder(s.owner, id, "complete")).toBe("completed");
    const o = (await getOrder(s.owner, id))!;
    expect(o.paidAt).toBeInstanceOf(Date);
    expect(o.trackingNumber).toBe("JNE-0001");
    expect(o.actions).toEqual([]);
    expect(o.history.map((h) => [h.fromStatus, h.toStatus, h.actorName])).toEqual([
      ["awaiting_payment", "placed", "toko-a-owner"],
      ["placed", "processing", "toko-a-owner"],
      ["processing", "shipped", "toko-a-owner"],
      ["shipped", "completed", "toko-a-owner"],
    ]);
    expect(o.history[2]!.note).toBe("JNE-0001");
    expect(await stockOf(s.variantId)).toBe(9); // completing never touches stock
  });

  it("transition matrix: every (status, action) pair is allowed or rejected exactly as declared", async () => {
    const s = await makeStore("toko-a", { stock: 100 });
    for (const from of ORDER_STATUSES) {
      for (const action of Object.keys(TRANSITIONS) as OrderAction[]) {
        const id = await placed(s);
        await force(id, from);
        const allowed = (TRANSITIONS[action].from as readonly OrderStatus[]).includes(from);
        expect(allowedActions(from).includes(action)).toBe(allowed);
        const run = transitionOrder(s.owner, id, action, inputFor(action));
        if (allowed) {
          expect(await run).toBe(TRANSITIONS[action].to);
          expect(await statusOf(id)).toBe(TRANSITIONS[action].to);
        } else {
          await expect(run).rejects.toMatchObject({ code: "invalid_transition" });
          expect(await statusOf(id)).toBe(from);
        }
      }
    }
    const transitions = await db.select().from(orderStatusHistory);
    const allowedCount = Object.values(TRANSITIONS).reduce((n, t) => n + t.from.length, 0);
    expect(transitions).toHaveLength(allowedCount);
  });

  it("cancel restocks every line exactly once; a second cancel and a cancel after shipping are rejected", async () => {
    const s = await makeStore("toko-a", { stock: 10 });
    const id = await placed(s, 3);
    expect(await stockOf(s.variantId)).toBe(7);
    await expect(transitionOrder(s.owner, id, "cancel", { reason: "" })).rejects.toMatchObject({ name: "ZodError" });
    expect(await transitionOrder(s.owner, id, "cancel", { reason: "Pembeli berubah pikiran" })).toBe("cancelled");
    expect(await stockOf(s.variantId)).toBe(10);
    await expect(transitionOrder(s.owner, id, "cancel", { reason: "Pembeli berubah pikiran" })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await stockOf(s.variantId)).toBe(10);
    const moves = await db.select().from(stockAdjustment);
    expect(moves).toEqual([expect.objectContaining({ variantId: s.variantId, delta: 3, orderId: id, actorUserId: s.ownerId })]);

    const shipped = await placed(s, 2);
    await transitionOrder(s.owner, shipped, "process");
    await transitionOrder(s.owner, shipped, "ship", { trackingNumber: "SICEPAT-9" });
    await expect(transitionOrder(s.owner, shipped, "cancel", { reason: "terlambat membatalkan" })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await stockOf(s.variantId)).toBe(8);
  });

  it("two concurrent cancels (and a racing process) restock once", async () => {
    for (let round = 0; round < 3; round++) {
      const s = await makeStore(`toko-${round}`, { stock: 10 });
      const id = await placed(s, 4);
      const staff = await makeUser("staff");
      await db.insert(membership).values({ storeId: s.storeId, userId: staff, role: "staff" });
      const staffScope = await seller(staff);
      const settled = await Promise.allSettled([
        transitionOrder(s.owner, id, "cancel", { reason: "cancel oleh pemilik" }),
        transitionOrder(staffScope, id, "cancel", { reason: "cancel oleh staf" }),
        transitionOrder(s.owner, id, "process"),
      ]);
      const ok = settled.filter((r) => r.status === "fulfilled");
      expect(ok).toHaveLength(1);
      expect(settled.filter((r) => r.status === "rejected").every((r) => r.reason.code === "invalid_transition")).toBe(true);
      const final = await statusOf(id);
      expect(await stockOf(s.variantId)).toBe(final === "cancelled" ? 10 : 6);
      expect(await db.select().from(stockAdjustment).where(eq(stockAdjustment.orderId, id))).toHaveLength(final === "cancelled" ? 1 : 0);
      expect(await db.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, id))).toHaveLength(1);
    }
  });

  it("staff can read and fulfil orders; a non-member gets nothing", async () => {
    const s = await makeStore("toko-a");
    const id = await placed(s);
    const staff = await makeUser("staff");
    await db.insert(membership).values({ storeId: s.storeId, userId: staff, role: "staff" });
    const staffScope = await seller(staff);
    expect((await listOrders(staffScope)).orders.map((o) => o.id)).toEqual([id]);
    expect(await transitionOrder(staffScope, id, "process")).toBe("processing");
    expect((await getOrder(s.owner, id))!.history[0]).toMatchObject({ actorName: "staff" });
  });
});

describe("inventory (SC-04)", () => {
  it("lists only the store's variants and records signed adjustments with reason and actor", async () => {
    const a = await makeStore("toko-a", { stock: 5 });
    const b = await makeStore("toko-b", { stock: 99 });
    expect((await listInventory(a.owner)).map((v) => v.variantId)).toEqual([a.variantId]);
    expect((await listInventory(b.owner)).map((v) => v.stock)).toEqual([99]);

    await expect(adjustStock(a.owner, a.variantId, { delta: 0, reason: "nol" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(adjustStock(a.owner, a.variantId, { delta: 1, reason: "" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(adjustStock(a.owner, a.variantId, { delta: "abc", reason: "huruf" })).rejects.toMatchObject({ name: "ZodError" });
    expect(await adjustStock(a.owner, a.variantId, { delta: "7", reason: "Restock dari supplier" })).toBe(12);
    expect(await adjustStock(a.owner, a.variantId, { delta: -2, reason: "Barang rusak" })).toBe(10);
    await expect(adjustStock(a.owner, a.variantId, { delta: -11, reason: "terlalu banyak" })).rejects.toMatchObject({ code: "insufficient_stock" });
    expect(await stockOf(a.variantId)).toBe(10);

    const log = await listStockAdjustments(a.owner);
    expect(log.map((l) => [l.delta, l.reason, l.actorName])).toEqual([
      [-2, "Barang rusak", "toko-a-owner"],
      [7, "Restock dari supplier", "toko-a-owner"],
    ]);
    expect(await listStockAdjustments(b.owner)).toEqual([]);
  });

  it("cross-store adjustment is denied and leaves the stock untouched", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b", { stock: 3 });
    await expect(adjustStock(a.owner, b.variantId, { delta: 100, reason: "bajak stok" })).rejects.toMatchObject({ code: "not_found" });
    await expect(adjustStock(a.owner, b.variantId, { delta: -1, reason: "bajak stok" })).rejects.toMatchObject({ code: "not_found" });
    expect(await stockOf(b.variantId)).toBe(3);
    expect(await db.select().from(stockAdjustment)).toHaveLength(0);
  });

  it("concurrent decrements never go negative and every success is recorded", async () => {
    const s = await makeStore("toko-a", { stock: 5 });
    const settled = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => adjustStock(s.owner, s.variantId, { delta: -1, reason: `opname ${i}` })),
    );
    const ok = settled.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(5);
    expect(settled.filter((r): r is PromiseRejectedResult => r.status === "rejected").every((r) => r.reason.code === "insufficient_stock")).toBe(true);
    expect(await stockOf(s.variantId)).toBe(0);
    expect(await db.select().from(stockAdjustment)).toHaveLength(5);
  });

  it("staff can adjust stock", async () => {
    const s = await makeStore("toko-a", { stock: 1 });
    const staff = await makeUser("staff");
    await db.insert(membership).values({ storeId: s.storeId, userId: staff, role: "staff" });
    expect(await adjustStock(await seller(staff), s.variantId, { delta: 4, reason: "Hitung ulang gudang" })).toBe(5);
    expect((await listStockAdjustments(s.owner))[0]).toMatchObject({ actorName: "staff", delta: 4 });
  });
});
