import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach } from "vitest";
import { createDb } from "../src/client.ts";
import { addVariant, createProduct } from "../src/catalog.ts";
import { createStore } from "../src/platform.ts";
import { platformOperator, user } from "../src/schema.ts";
import { operatorScope, sellerContext, storefrontScope, type SellerScope } from "../src/scoped.ts";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {}
if (!/_test\b/.test(process.env.TEST_DATABASE_URL ?? "")) throw new Error("TEST_DATABASE_URL must point at a *_test database");
export const db = createDb(process.env.TEST_DATABASE_URL);

beforeEach(async () => {
  await db.execute(
    `truncate "user", store, membership, platform_operator, product, variant, cart, cart_line, "order", order_line, audit_log, session, account, verification restart identity cascade`,
  );
});
afterAll(async () => {
  await db.$client.end();
});

export async function makeUser(name: string) {
  const id = randomUUID();
  await db.insert(user).values({ id, name, email: `${name}-${id.slice(0, 6)}@test.local` });
  return id;
}

export async function makeOperator() {
  const id = await makeUser("operator");
  await db.insert(platformOperator).values({ userId: id });
  return (await operatorScope(db, id))!;
}

export async function seller(userId: string, storeId?: number): Promise<SellerScope> {
  const ctx = await sellerContext(db, userId, storeId);
  if (!ctx.ok) throw new Error(`no seller scope: ${ctx.reason}`);
  return ctx.scope;
}

/** A store with an owner and one active product (one variant). */
export async function makeStore(slug: string, opts: { price?: number; stock?: number } = {}) {
  const op = await makeOperator();
  const ownerId = await makeUser(`${slug}-owner`);
  const storeId = await createStore(op, { slug, name: `Toko ${slug}`, ownerUserId: ownerId });
  const owner = await seller(ownerId);
  const productId = await createProduct(owner, {
    title: `Kaos ${slug}`,
    status: "active",
    variant: { title: "M", price: opts.price ?? 100_000, stock: opts.stock ?? 10 },
  });
  const variantId = (await db.query.variant.findFirst({ where: (v, { eq }) => eq(v.productId, productId) }))!.id;
  return { op, storeId, ownerId, owner, productId, variantId, sf: (await storefrontScope(db, slug))! };
}

export const buyer = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(),
  buyerName: "Budi Santoso",
  buyerPhone: "081234567890",
  shippingAddress: "Jl. Merdeka No. 1, Bandung 40111",
  courier: "fake-reg",
  paymentMethod: "cod",
  ...over,
});

export { addVariant };
