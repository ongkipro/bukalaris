import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import { changeMember, listMembers } from "../src/platform/membership.ts";
import { setStoreStatus, storeAudit } from "../src/platform/platform.ts";
import { membership } from "../src/schema.ts";
import { operatorScope, sellerContext, storefrontScope } from "../src/platform/scoped.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { buyer, db, makeStore, makeUser, platform, seller } from "./helpers.ts";

describe("store suspension (PR-1)", () => {
  it("blocks storefront, checkout and seller admin, and is audited", async () => {
    const s = await makeStore("toko-a");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await expect(setStoreStatus(s.op, s.storeId, { status: "suspended", reason: "" })).rejects.toMatchObject({ name: "ZodError" });
    await setStoreStatus(s.op, s.storeId, { status: "suspended", reason: "Laporan penipuan #12" });

    expect(await storefrontScope(db, "toko-a")).toBeNull();
    await expect(placeOrder(db, cartId, buyer())).rejects.toMatchObject({ code: "store_unavailable" });
    expect(await sellerContext(db, s.ownerId)).toMatchObject({ ok: false, reason: "suspended" });
    expect((await storeAudit(s.op, s.storeId))[0]).toMatchObject({ action: "store.suspended", reason: "Laporan penipuan #12", actorUserId: s.op.userId });

    await setStoreStatus(s.op, s.storeId, { status: "active", reason: "Investigasi selesai" });
    expect(await storefrontScope(db, "toko-a")).not.toBeNull();
    await expect(placeOrder(db, cartId, buyer())).resolves.toMatchObject({ replayed: false });
  });

  it("a seller in several stores falls back to an active one when the preferred store is suspended", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    await platform.insert(membership).values({ storeId: b.storeId, userId: a.ownerId, role: "staff" });
    await setStoreStatus(a.op, a.storeId, { status: "suspended", reason: "Uji fallback toko" });

    const ctx = await sellerContext(db, a.ownerId, a.storeId);
    expect(ctx.ok && { storeId: ctx.scope.storeId, role: ctx.scope.role, stores: ctx.stores.map((s) => s.id) }).toEqual({
      storeId: b.storeId,
      role: "staff",
      stores: [b.storeId],
    });

    await setStoreStatus(b.op, b.storeId, { status: "suspended", reason: "Uji semua toko" });
    expect(await sellerContext(db, a.ownerId, a.storeId)).toMatchObject({ ok: false, reason: "suspended", storeName: "Toko toko-a" });
  });

  it("only platform operators get an operator scope", async () => {
    const s = await makeStore("toko-a");
    expect(await operatorScope(platform, s.ownerId)).toBeNull();
  });
});

describe("membership (PR-15)", () => {
  it("prevents removing or demoting the last owner", async () => {
    const s = await makeStore("toko-a");
    await expect(changeMember(s.owner, s.ownerId, null)).rejects.toMatchObject({ code: "last_owner" });
    await expect(changeMember(s.owner, s.ownerId, "staff")).rejects.toMatchObject({ code: "last_owner" });
    expect(await listMembers(s.owner)).toHaveLength(1);
  });

  it("allows handoff once another owner exists", async () => {
    const s = await makeStore("toko-a");
    const other = await makeUser("other");
    await platform.insert(membership).values({ storeId: s.storeId, userId: other, role: "staff" });
    await changeMember(s.owner, other, "owner");
    await changeMember(s.owner, s.ownerId, null);
    expect((await listMembers(await seller(other))).map((m) => m.role)).toEqual(["owner"]);
  });

  it("concurrent mutual removal by two owners leaves one owner", async () => {
    const s = await makeStore("toko-a");
    const other = await makeUser("other");
    await platform.insert(membership).values({ storeId: s.storeId, userId: other, role: "owner" });
    const otherScope = await seller(other);
    const settled = await Promise.allSettled([changeMember(s.owner, other, null), changeMember(otherScope, s.ownerId, null)]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const owners = await platform.select().from(membership).where(eq(membership.storeId, s.storeId));
    expect(owners.filter((m) => m.role === "owner")).toHaveLength(1);
  });

  it("staff cannot manage members", async () => {
    const s = await makeStore("toko-a");
    const staff = await makeUser("staff");
    await platform.insert(membership).values({ storeId: s.storeId, userId: staff, role: "staff" });
    await expect(changeMember(await seller(staff), s.ownerId, null)).rejects.toMatchObject({ code: "forbidden" });
  });
});
