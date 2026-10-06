import { and, asc, eq } from "drizzle-orm";
import { platformDb, type Executor } from "./client.ts";
import { membership, platformOperator, store } from "./schema.ts";
export { slugFromHost } from "./host.ts";
export { inStore, withStore } from "./tenant.ts";

/**
 * Store-scoped data access (TEN-1/TEN-2). Every store-owned query in this
 * package takes one of these scopes and filters by `scope.storeId`. A scope is
 * only produced here: from verified membership (seller), from host/slug
 * resolution of an active store (storefront), or from a verified platform
 * operator. Callers never pass a raw store id from the browser into a query.
 *
 * T-27 (ADR-0005): the database enforces the same boundary with row-level security.
 * Services run store-owned statements through `inStore(scope, …)`, which opens a
 * transaction on `scope.exec` with the store context set. Resolving a scope is itself a
 * cross-store lookup (which stores is this user a member of? which store has this slug?),
 * so the two store resolvers below read through the privileged platform pool and return
 * only the resolved store; everything after that runs on the caller's executor.
 */
declare const scopeBrand: unique symbol;
type Branded = { readonly [scopeBrand]: true };

export type Role = "owner" | "staff";
export type SellerScope = Branded & {
  kind: "seller";
  exec: Executor;
  storeId: number;
  storeName: string;
  storeSlug: string;
  userId: string;
  role: Role;
};
export type StorefrontScope = Branded & {
  kind: "storefront";
  exec: Executor;
  storeId: number;
  storeName: string;
  storeSlug: string;
};
export type OperatorScope = Branded & { kind: "operator"; exec: Executor; userId: string };

export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const capabilities = {
  "catalog.read": ["owner", "staff"],
  "catalog.write": ["owner", "staff"],
  "members.manage": ["owner"],
  // M2 orders track: owner and staff both fulfil orders and adjust stock.
  "orders.read": ["owner", "staff"],
  "orders.fulfill": ["owner", "staff"],
  "inventory.write": ["owner", "staff"],
  "integrations.manage": ["owner"],
  // M2 shipping track: pickup origin is a store-level commercial setting → owner only.
  "shipping.manage": ["owner"],
  // M2 signals track (T-38): ad destinations carry server tokens → owner only.
  "marketing.manage": ["owner"],
} as const satisfies Record<string, readonly Role[]>;
export type Capability = keyof typeof capabilities;

export function can(scope: SellerScope, cap: Capability): boolean {
  return (capabilities[cap] as readonly Role[]).includes(scope.role);
}
export function requireCap(scope: SellerScope, cap: Capability): void {
  if (!can(scope, cap)) throw new DomainError("forbidden", "Akses ditolak.");
}

export type SellerContext =
  | { ok: true; scope: SellerScope; stores: { id: number; name: string }[] }
  | { ok: false; reason: "no_membership" | "suspended"; storeName?: string };

/**
 * Resolve the seller's active store. `requestedStoreId` (e.g. from a cookie) is
 * only a preference: it is honoured only when the user is a member of it.
 */
export async function sellerContext(
  exec: Executor,
  userId: string,
  requestedStoreId?: number,
): Promise<SellerContext> {
  const rows = await platformDb()
    .select({ storeId: store.id, name: store.name, slug: store.slug, status: store.status, role: membership.role })
    .from(membership)
    .innerJoin(store, eq(store.id, membership.storeId))
    .where(eq(membership.userId, userId))
    .orderBy(asc(store.id));
  if (rows.length === 0) return { ok: false, reason: "no_membership" };
  const active = rows.filter((r) => r.status === "active");
  // Preferred store if it is a member store and active; otherwise the first active one.
  const row = active.find((r) => r.storeId === requestedStoreId) ?? active[0];
  if (!row) {
    const shown = rows.find((r) => r.storeId === requestedStoreId) ?? rows[0]!;
    return { ok: false, reason: "suspended", storeName: shown.name };
  }
  const scope = {
    kind: "seller",
    exec,
    storeId: row.storeId,
    storeName: row.name,
    storeSlug: row.slug,
    userId,
    role: row.role,
  } as SellerScope;
  return { ok: true, scope, stores: active.map((r) => ({ id: r.storeId, name: r.name })) };
}

/** Resolve an active store by slug. Unknown and suspended stores both yield null. */
export async function storefrontScope(exec: Executor, slug: string): Promise<StorefrontScope | null> {
  const [row] = await platformDb()
    .select({ id: store.id, name: store.name, slug: store.slug })
    .from(store)
    .where(and(eq(store.slug, slug), eq(store.status, "active")));
  if (!row) return null;
  return { kind: "storefront", exec, storeId: row.id, storeName: row.name, storeSlug: row.slug } as StorefrontScope;
}

/** `exec` must be the platform pool (`platformDb()`): Super Admin reads across stores and the app role has no access to `platform_operator`. */
export async function operatorScope(exec: Executor, userId: string): Promise<OperatorScope | null> {
  const [row] = await exec.select().from(platformOperator).where(eq(platformOperator.userId, userId));
  return row ? ({ kind: "operator", exec, userId } as OperatorScope) : null;
}
