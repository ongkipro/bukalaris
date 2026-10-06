import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach } from "vitest";
import { createDb, platformDb } from "../src/client.ts";
import { addVariant, createProduct } from "../src/catalog.ts";
import { localRoleUrl } from "../src/local-roles.ts";
import { createStore } from "../src/platform.ts";
import { platformOperator, user } from "../src/schema.ts";
import { operatorScope, sellerContext, storefrontScope, type SellerScope } from "../src/scoped.ts";
import { setPickupArea } from "../src/shipping.ts";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {}
const adminUrl = process.env.TEST_DATABASE_URL ?? "";
if (!/_test\b/.test(adminUrl)) throw new Error("TEST_DATABASE_URL must point at a *_test database");

// Three connections to the one test database, as in production (ADR-0005):
//   db        role bukalaris_app — what every service and scope runs as; RLS applies. The
//             whole suite passing on it is the main proof of T-27.
//   platform  role bukalaris_platform (BYPASSRLS) — operators, the worker, cleanup, and the
//             tests' own fixtures and raw inspection of rows across stores.
//   admin     the compose superuser — truncation between tests only.
process.env.PLATFORM_DATABASE_URL = localRoleUrl(adminUrl, "bukalaris_platform");
export const db = createDb(localRoleUrl(adminUrl, "bukalaris_app"));
export const platform = platformDb();
export const admin = createDb(adminUrl);

beforeEach(async () => {
  await admin.execute(
    `truncate "user", store, membership, platform_operator, product, variant, cart, cart_line, "order", order_line, audit_log, session, account, verification, rate_limit restart identity cascade`,
  );
});
afterAll(async () => {
  await Promise.all([db.$client.end(), platform.$client.end(), admin.$client.end()]);
});

export async function makeUser(name: string) {
  const id = randomUUID();
  await platform.insert(user).values({ id, name, email: `${name}-${id.slice(0, 6)}@test.local` });
  return id;
}

export async function makeOperator() {
  const id = await makeUser("operator");
  await platform.insert(platformOperator).values({ userId: id });
  return (await operatorScope(platform, id))!;
}

export async function seller(userId: string, storeId?: number): Promise<SellerScope> {
  const ctx = await sellerContext(db, userId, storeId);
  if (!ctx.ok) throw new Error(`no seller scope: ${ctx.reason}`);
  return ctx.scope;
}

/** Pickup origin every test store ships from (fake area "Braga"), unless `pickupArea: false`. */
export const PICKUP_AREA = { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Sumur Bandung, Bandung, Jawa Barat 40111" };
/** Default destination of the test buyer (fake area "Menteng"). */
export const DESTINATION = { destinationAreaId: "b1b1b1b1b1b1b1b1b1b1b1b1", destinationAreaLabel: "Menteng, Menteng, Jakarta Pusat, DKI Jakarta 10310" };

/** A store with an owner, one active product (one variant) and a pickup area so checkout can quote shipping. */
export async function makeStore(slug: string, opts: { price?: number; stock?: number; pickupArea?: boolean } = {}) {
  const op = await makeOperator();
  const ownerId = await makeUser(`${slug}-owner`);
  const storeId = await createStore(op, { slug, name: `Toko ${slug}`, ownerUserId: ownerId });
  const owner = await seller(ownerId);
  const productId = await createProduct(owner, {
    title: `Kaos ${slug}`,
    status: "active",
    variant: { title: "M", price: opts.price ?? 100_000, stock: opts.stock ?? 10 },
  });
  const variantId = (await platform.query.variant.findFirst({ where: (v, { eq }) => eq(v.productId, productId) }))!.id;
  if (opts.pickupArea !== false) await setPickupArea(owner, PICKUP_AREA);
  return { op, storeId, ownerId, owner, productId, variantId, sf: (await storefrontScope(db, slug))! };
}

/** Checkout input of the test buyer: fake JNE (supports COD) to the default destination. */
export const buyer = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(),
  buyerName: "Budi Santoso",
  buyerPhone: "081234567890",
  shippingAddress: "Jl. Merdeka No. 1, Bandung 40111",
  ...DESTINATION,
  courier: "JNE",
  paymentMethod: "cod",
  ...over,
});

export { addVariant };
