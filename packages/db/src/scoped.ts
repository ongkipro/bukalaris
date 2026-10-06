import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "./client.ts";
import { membership, platformOperator, store } from "./schema.ts";
export { slugFromHost } from "./host.ts";

/**
 * Store-scoped data access (TEN-1/TEN-2). Every store-owned query in this
 * package takes one of these scopes and filters by `scope.storeId`. A scope is
 * only produced here: from verified membership (seller), from host/slug
 * resolution of an active store (storefront), or from a verified platform
 * operator. Callers never pass a raw store id from the browser into a query.
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
  const rows = await exec
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
  const [row] = await exec
    .select({ id: store.id, name: store.name, slug: store.slug })
    .from(store)
    .where(and(eq(store.slug, slug), eq(store.status, "active")));
  if (!row) return null;
  return { kind: "storefront", exec, storeId: row.id, storeName: row.name, storeSlug: row.slug } as StorefrontScope;
}

export async function operatorScope(exec: Executor, userId: string): Promise<OperatorScope | null> {
  const [row] = await exec.select().from(platformOperator).where(eq(platformOperator.userId, userId));
  return row ? ({ kind: "operator", exec, userId } as OperatorScope) : null;
}
