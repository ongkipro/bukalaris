import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  authenticateChannel,
  channelReturnTarget,
  createChannel,
  createEmptyCart,
  createHandoff,
  exchangeHandoff,
  listChannels,
  ownsOpenCart,
  revokeChannel,
} from "../src/storefront/channels.ts";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import { checkoutHandoff, membership, storefrontChannel } from "../src/schema.ts";
import { getCart, listPublishedProducts, setCartLine } from "../src/storefront/storefront.ts";
import { buyer, db, makeStore, makeUser, platform, seller } from "./helpers.ts";

const channelFor = (s: Awaited<ReturnType<typeof makeStore>>, over: Record<string, unknown> = {}) =>
  createChannel(s.owner, { name: `Channel ${s.storeId}`, origin: "https://shop.example", returnPath: "/thanks", ...over });
const bearer = (token: string) => `Bearer ${token}`;
const live = async (token: string) => {
  const auth = await authenticateChannel(db, bearer(token));
  if (!auth.ok) throw new Error(`denied: ${auth.reason}`);
  return auth;
};

describe("headless channels (SC-21, IAM-11)", () => {
  it("stores only a hash and verifies the token shown once", async () => {
    const s = await makeStore("toko-a");
    const { id, token, prefix } = await channelFor(s);
    expect(token).toMatch(/^blsk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
    const [row] = await platform.select().from(storefrontChannel).where(eq(storefrontChannel.id, id));
    expect(row).toMatchObject({ tokenPrefix: prefix, tokenHash: createHash("sha256").update(token).digest("hex"), status: "active" });
    expect(JSON.stringify(row)).not.toContain(token.slice(-20));
    expect((await listChannels(s.owner)).map((c) => ({ id: c.id, state: c.state, tokenPrefix: c.tokenPrefix }))).toEqual([
      { id, state: "active", tokenPrefix: prefix },
    ]);

    const auth = await live(token);
    expect(auth.scope.storeId).toBe(s.storeId);
    expect(auth.channel).toMatchObject({ id, origin: "https://shop.example", returnPath: "/thanks" });

    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    for (const bad of [undefined, "", "Bearer", bearer("nope"), bearer(tampered), token, bearer(token.replace("blsk_", "blpk_"))]) {
      expect(await authenticateChannel(db, bad)).toEqual({ ok: false, reason: "unauthorized" });
    }
  });

  it("denies revoked and expired tokens and a suspended store", async () => {
    const s = await makeStore("toko-a");
    const a = await channelFor(s);
    await revokeChannel(s.owner, a.id);
    expect(await authenticateChannel(db, bearer(a.token))).toEqual({ ok: false, reason: "unauthorized" });
    expect((await listChannels(s.owner))[0]!.state).toBe("revoked");
    await expect(revokeChannel(s.owner, a.id)).rejects.toMatchObject({ code: "not_found" });

    const b = await channelFor(s, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect((await authenticateChannel(db, bearer(b.token))).ok).toBe(true);
    await platform.update(storefrontChannel).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(storefrontChannel.id, b.id));
    expect(await authenticateChannel(db, bearer(b.token))).toEqual({ ok: false, reason: "unauthorized" });
    expect((await listChannels(s.owner)).find((c) => c.id === b.id)!.state).toBe("expired");

    const c = await channelFor(s);
    await platform.execute(sql`update store set status = 'suspended' where id = ${s.storeId}`);
    expect(await authenticateChannel(db, bearer(c.token))).toEqual({ ok: false, reason: "store_unavailable" });
  });

  it("only owners manage channels; origin and return path are validated", async () => {
    const s = await makeStore("toko-a");
    const staffId = await makeUser("staff");
    await platform.insert(membership).values({ storeId: s.storeId, userId: staffId, role: "staff" });
    const staff = await seller(staffId);
    await expect(channelFor({ ...s, owner: staff })).rejects.toMatchObject({ code: "forbidden" });
    await expect(listChannels(staff)).rejects.toMatchObject({ code: "forbidden" });

    for (const origin of ["http://shop.example", "https://shop.example/path", "https://u:p@shop.example", "shop.example", "javascript:alert(1)"]) {
      await expect(channelFor(s, { origin })).rejects.toMatchObject({ name: "ZodError" });
    }
    for (const returnPath of ["//evil.example", "thanks", "https://evil.example", "/a b"]) {
      await expect(channelFor(s, { returnPath })).rejects.toMatchObject({ name: "ZodError" });
    }
    await expect(channelFor(s, { expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toMatchObject({ name: "ZodError" });
    const dev = await channelFor(s, { origin: "http://localhost:3000/", returnPath: "" });
    expect((await listChannels(s.owner)).find((c) => c.id === dev.id)).toMatchObject({ origin: "http://localhost:3000", returnPath: "/" });
  });

  it("channel A cannot read store B's products or carts", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const { scope: scopeA, channel } = await live((await channelFor(a)).token);
    expect((await listPublishedProducts(scopeA)).map((p) => p.id)).toEqual([a.productId]);

    const cartB = await setCartLine(b.sf, undefined, { variantId: b.variantId, quantity: 1 }, "add");
    expect(await ownsOpenCart(scopeA, cartB)).toBe(false);
    expect((await getCart(scopeA, cartB)).id).toBeNull();
    await expect(createHandoff(scopeA, channel.id, cartB)).rejects.toMatchObject({ code: "not_found" });
    await expect(setCartLine(scopeA, cartB, { variantId: b.variantId, quantity: 1 }, "add")).rejects.toMatchObject({ code: "not_found" });
    expect(await platform.select().from(checkoutHandoff)).toHaveLength(0);

    const cartA = await createEmptyCart(scopeA);
    expect(await ownsOpenCart(scopeA, cartA)).toBe(true);
    await expect(createHandoff(scopeA, channel.id, cartA)).rejects.toMatchObject({ code: "empty" });
  });

  it("a handoff is consumed exactly once under concurrent exchanges and sets the return target", async () => {
    const s = await makeStore("toko-a");
    const { scope, channel } = await live((await channelFor(s)).token);
    const cartId = await setCartLine(scope, undefined, { variantId: s.variantId, quantity: 2 }, "add");
    const h = await createHandoff(scope, channel.id, cartId);
    expect(h.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const [row] = await platform.select().from(checkoutHandoff);
    expect(row!.codeHash).toBe(createHash("sha256").update(h.code).digest("hex"));

    const results = await Promise.all([exchangeHandoff(db, h.code), exchangeHandoff(db, h.code)]);
    const won = results.filter(Boolean);
    expect(won).toHaveLength(1);
    expect(won[0]).toEqual({ storeId: s.storeId, storeSlug: "toko-a", cartId });
    expect(await exchangeHandoff(db, h.code)).toBeNull(); // replay
    expect(await channelReturnTarget(db, cartId)).toBe("https://shop.example/thanks");

    // The buyer completes checkout from the exchanged cart; revoking the channel afterwards hides the return link.
    await placeOrder(db, cartId, buyer());
    await revokeChannel(s.owner, channel.id);
    expect(await channelReturnTarget(db, cartId)).toBeNull();
    expect(await channelReturnTarget(db, randomUUID())).toBeNull();
  });

  it("denies expired handoffs, revoked channels, checked-out carts and garbage codes", async () => {
    const s = await makeStore("toko-a");
    const { scope, channel } = await live((await channelFor(s)).token);
    const cartId = await setCartLine(scope, undefined, { variantId: s.variantId, quantity: 1 }, "add");

    const expired = await createHandoff(scope, channel.id, cartId);
    await platform.update(checkoutHandoff).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(checkoutHandoff.id, expired.id));
    expect(await exchangeHandoff(db, expired.code)).toBeNull();

    const checkedOut = await createHandoff(scope, channel.id, cartId);
    await placeOrder(db, cartId, buyer());
    expect(await exchangeHandoff(db, checkedOut.code)).toBeNull();
    expect(await ownsOpenCart(scope, cartId)).toBe(false);

    const cart2 = await setCartLine(scope, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const unused = await createHandoff(scope, channel.id, cart2);
    await revokeChannel(s.owner, channel.id);
    expect(await exchangeHandoff(db, unused.code)).toBeNull();

    for (const code of ["", "short", "x".repeat(43), unused.code.slice(1) + "A"]) expect(await exchangeHandoff(db, code)).toBeNull();
  });
});
