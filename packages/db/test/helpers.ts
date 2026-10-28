import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, vi } from "vitest";
import { createDb, platformDb } from "../src/client.ts";
import { addVariant, createProduct } from "../src/seller/commerce/catalog.ts";
import { localRoleUrl } from "../src/local-roles.ts";
import { createStore } from "../src/platform/platform.ts";
import { platformOperator, user } from "../src/schema.ts";
import { operatorScope, sellerContext, storefrontScope, type SellerScope } from "../src/platform/scoped.ts";
import { setPickupArea } from "../src/shipping/shipping.ts";
import { grantAsSystem } from "../src/ops/capabilities-grants.ts";
import { AFFILIATE_ATTRIBUTION_WINDOW_DAYS_DEFAULT, AFFILIATE_HOLD_DAYS_DEFAULT, AFFILIATE_MAX_RATE_BPS_DEFAULT, AFFILIATE_MIN_RATE_BPS_DEFAULT } from "../src/affiliate/settings.ts";
import type { PlatformCapability } from "../src/ops/schema-ops.ts";

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
    `truncate "user", store, membership, platform_operator, product, variant, cart, cart_line, "order", order_line, audit_log, session, account, verification, rate_limit, buyer, reconciliation_batch, transfer_evidence_artifact, transfer_evidence_registry, payout, payout_destination, store_step_up_proof restart identity cascade`,
  );
  // `payout_control` is a singleton that must keep its row: reset it instead of truncating (a test that froze payouts or changed the hold never leaks).
  await admin.execute(`update payout_control set frozen = false, reason = 'initial', changed_by = 'system:migration', destination_hold_hours = 72`);
  // T-48: policy is a four-eyes singleton (its guard refuses a direct write), the partner budget and dispatch leases are process-wide counters.
  await admin.execute(`alter table shipping_control disable trigger shipping_policy_guard; update shipping_control set prefer_partner = false, discount_idr = 0, discount_bps = 0, revision = 0, approval_request_id = null, updated_by = null; alter table shipping_control enable trigger shipping_policy_guard; truncate shipping_margin_rule, cashback_rule, shipping_partner_budget, shipping_dispatch_lease restart identity`);
  // T-52: the programme limits are a singleton row that tests change; every test starts from the named defaults (the truncate above clears every affiliate row through the foreign keys).
  await admin.execute(`update affiliate_policy set min_rate_bps = ${AFFILIATE_MIN_RATE_BPS_DEFAULT}, max_rate_bps = ${AFFILIATE_MAX_RATE_BPS_DEFAULT}, attribution_window_days = ${AFFILIATE_ATTRIBUTION_WINDOW_DAYS_DEFAULT}, hold_days = ${AFFILIATE_HOLD_DAYS_DEFAULT}`);
  // The fake courier fixture (the COD-capable JNE) is data that T-48 tests edit: every test starts from the seeded values.
  await admin.execute(`update courier_service_policy set cod_allowed = true, return_free = true, return_free_evidence_ref = 'fixture:fake-adapter', status = 'active', updated_by = 'fixture:local-seed' where courier_code = 'JNE'; delete from courier_service_policy where courier_code not in ('JNE', 'SPX')`);
});
afterAll(async () => {
  await Promise.all([db.$client.end(), platform.$client.end(), admin.$client.end()]);
});

export async function makeUser(name: string) {
  const id = randomUUID();
  await platform.insert(user).values({ id, name, email: `${name}-${id.slice(0, 6)}@test.local` });
  return id;
}

/** Capabilities the plain test operator holds: the powers every operator had before T-60 (`logs.read` was always a separate grant). */
export const DEFAULT_OPERATOR_CAPABILITIES: readonly PlatformCapability[] = ["tenants.read", "tenants.manage", "shipping.manage", "audit.read"];

export async function makeOperator(capabilities: readonly PlatformCapability[] = DEFAULT_OPERATOR_CAPABILITIES) {
  const id = await makeUser("operator");
  await platform.insert(platformOperator).values({ userId: id });
  await grantAsSystem(platform, { userId: id, capabilities, source: "system_bootstrap", reason: "test fixture" });
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
    variant: { title: "M", price: opts.price ?? 100_000, stock: opts.stock ?? 10, weightGrams: 1000 },
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
  paymentChannel: "VABCA", // T-49: prepaid orders name a channel of the provider's list; COD ignores it
  ...over,
});

export { addVariant };

/** The Mengantar entry gate is closed in every test by default (vitest.config.ts sets nothing); a test that drives a STUBBED provider client opens it for itself. Undone after each test (`unstubEnvs`). */
export function openMengantarGate() {
  vi.stubEnv("MENGANTAR_PARTNER_SECRET_ROTATED_AT", "2026-01-01T00:00:00Z");
  vi.stubEnv("MENGANTAR_PARTNER_OLD_SECRET_REVOKED", "1");
}
