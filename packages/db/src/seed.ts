// Local development seed: two stores, a platform operator, owners and a staff member.
// The shared password is a documented local-only value, never used outside dev.
import { hashPassword } from "better-auth/crypto";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { addVariant, createProduct } from "./seller/commerce/catalog.ts";
import { platformDb } from "./client.ts";
import { createStore } from "./platform/platform.ts";
import { account, membership, operatorGrant, platformOperator, store, user } from "./schema.ts";
import { operatorScope, sellerContext } from "./platform/scoped.ts";
import { setPickupAddress, setPickupArea } from "./shipping/shipping.ts";

if (process.env.NODE_ENV === "production") throw new Error("seed is for local development only");
export const DEV_PASSWORD = "bukalaris-dev-123";

// Seeding creates stores and operators: platform role (BYPASSRLS). Store-scoped writes below still run in context via the scopes.
const db = platformDb();
if ((await db.select().from(store).where(eq(store.slug, "toko-a"))).length) {
  console.log("seed: already applied, nothing to do");
  await db.$client.end();
  process.exit(0);
}

const hash = await hashPassword(DEV_PASSWORD);
async function makeUser(email: string, name: string) {
  const id = randomUUID();
  await db.insert(user).values({ id, email, name, emailVerified: true });
  await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash });
  return id;
}

const adminId = await makeUser("admin@bukalaris.local", "Operator Bukalaris");
await db.insert(platformOperator).values({ userId: adminId });
// ops track: Log System access is an explicit platform grant (PR-11).
await db.insert(operatorGrant).values({ userId: adminId, capability: "logs.read" });
const op = (await operatorScope(db, adminId))!;

const ownerA = await makeUser("owner-a@bukalaris.local", "Ayu (Toko A)");
const staffA = await makeUser("staff-a@bukalaris.local", "Sari (Staf Toko A)");
// Dedicated to the password-recovery e2e, which changes its password; never reuse it in other specs.
const recoveryA = await makeUser("recovery-a@bukalaris.local", "Rani (Staf Toko A, uji pemulihan)");
const ownerB = await makeUser("owner-b@bukalaris.local", "Bima (Toko B)");
const storeA = await createStore(op, { slug: "toko-a", name: "Toko Ayu", ownerUserId: ownerA });
await db.insert(membership).values({ storeId: storeA, userId: staffA, role: "staff" });
await db.insert(membership).values({ storeId: storeA, userId: recoveryA, role: "staff" });
await createStore(op, { slug: "toko-b", name: "Toko Bima", ownerUserId: ownerB });

const scopeOf = async (userId: string) => {
  const ctx = await sellerContext(db, userId);
  if (!ctx.ok) throw new Error("seed: no scope");
  return ctx.scope;
};
const a = await scopeOf(ownerA);
const kaos = await createProduct(a, {
  title: "Kaos Katun Basic",
  slug: "kaos-katun-basic",
  description: "Kaos katun combed 30s.",
  status: "active",
  variant: { title: "M", price: 89_000, stock: 20, weightGrams: 1000 },
});
await addVariant(a, kaos, { title: "L", price: 95_000, stock: 5, weightGrams: 1000 });
// Toko A can quote shipping (fake area "Braga"); Toko B deliberately has no pickup area yet.
await setPickupArea(a, { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Sumur Bandung, Bandung, Jawa Barat 40111" });
await setPickupAddress(a, { addressText: "Jl. Braga No. 1, Bandung" });
await createProduct(a, { title: "Totebag Kanvas", status: "active", variant: { title: "Natural", price: 55_000, stock: 1, weightGrams: 1000 } });
await createProduct(a, { title: "Topi (draf)", status: "draft", variant: { title: "All size", price: 45_000, stock: 10, weightGrams: 1000 } });
await createProduct(await scopeOf(ownerB), {
  title: "Kopi Arabika 250g",
  status: "active",
  variant: { title: "Biji", price: 120_000, stock: 30, weightGrams: 1000 },
});

console.log(`seed: done. Users (password "${DEV_PASSWORD}"): admin@, owner-a@, staff-a@, owner-b@ bukalaris.local`);
await db.$client.end();
