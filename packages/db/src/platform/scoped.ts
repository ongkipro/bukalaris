import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { platformOperator } from "../schema.ts";
import { billingAccess, type BillingAccess } from "../billing/access.ts";
import { resolveMemberStores, resolveStoreBySlug, resolveUserSuspended } from "./resolvers.ts";
export { slugFromHost } from "./host.ts";
export { inStore, withAffiliate, withAuditWriter, withBuyer, withStore } from "./tenant.ts";

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
  /** Subscription access policy at the time the scope was resolved (T-50): billing debt makes Seller Admin writes read-only. */
  billing: BillingAccess;
  /** The server-side session this scope was resolved for (T-37 finish): money step-up proofs bind to it, never to a value the caller types. Null until `bindSession`. */
  sessionId: string | null;
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
  "shipping.read": ["owner", "staff"],
  "shipping.manage": ["owner"],
  // M2 signals track (T-38): ad destinations carry server tokens → owner only.
  "marketing.manage": ["owner"],
  // M2 privacy track (T-43): buyer data export and irreversible redaction → owner only.
  "privacy.manage": ["owner"],
  // T-37 (UX-14): the ledger statement and balances, the payout destination and the payout request are the store OWNER's (staff never see money or request payouts).
  "finance.read": ["owner"],
  "finance.payout": ["owner"],
  // Store profile and presentation settings (name, description, WhatsApp, theme) → owner only.
  "settings.manage": ["owner"],
  // T-50 subscription billing: every member sees the subscription and its invoices; only the owner pays.
  "billing.read": ["owner", "staff"],
  "billing.pay": ["owner"],
  "promotions.read": ["owner", "staff"],
  "promotions.manage": ["owner"],
  // T-52 (IAM-3, IAM-13): the seller's own affiliate settings, product opt-in and blocks. Owner only to write; both roles read. The console never edits them.
  "affiliate.read": ["owner", "staff"],
  "affiliate.offers.manage": ["owner"],
  "affiliate.blocks.manage": ["owner"],
  // T-45 (SC-26): the abandoned-checkout queue shows buyer contact the checkout form collected. Owner and staff both already read buyer phones on the orders
  // they fulfil (`orders.read`), so both see and contact them; viewing is a read, opening the WhatsApp recovery stamps the session (a write).
  "carts.read": ["owner", "staff"],
  "carts.recover": ["owner", "staff"],
} as const satisfies Record<string, readonly Role[]>;
export type Capability = keyof typeof capabilities;
export const SELLER_CAPABILITIES = Object.keys(capabilities) as readonly Capability[];

export function can(scope: SellerScope, cap: Capability): boolean {
  return (capabilities[cap] as readonly Role[]).includes(scope.role);
}
/**
 * What stays usable when the subscription is `past_due` or billing-`suspended` (BILL-7): reading the catalog, the orders and the
 * ledger statement, the subscription itself (viewing invoices and paying), and the buyer-data export and erasure (a data-protection
 * duty, never gated by a debt). Every other capability, including any added later, is a Seller Admin write and is refused: the list
 * fails closed. `finance.payout` is therefore refused while unpaid (BILL-7 "read-only except billing"); whether a payout may still
 * be requested or netted against the debt is an owner decision recorded in TASKS (T-50 deferred).
 */
export const BILLING_READ_ONLY_ALLOWED: readonly Capability[] = ["catalog.read", "orders.read", "shipping.read", "privacy.manage", "finance.read", "billing.read", "billing.pay", "promotions.read", "carts.read", "affiliate.read"];

export function requireCap(scope: SellerScope, cap: Capability): void {
  if (!can(scope, cap)) throw new DomainError("forbidden", "Akses ditolak.");
  if (!scope.billing.writable && !BILLING_READ_ONLY_ALLOWED.includes(cap)) {
    throw new DomainError("billing_read_only", "Langganan belum aktif, sehingga Seller Admin hanya bisa dibaca. Selesaikan pembayaran di menu Langganan; data dan toko Anda tetap aman.");
  }
}

export type SellerContext =
  | { ok: true; scope: SellerScope; stores: { id: number; name: string }[] }
  | { ok: false; reason: "no_membership" | "suspended" | "identity_suspended"; storeName?: string };

/**
 * Resolve the seller's active store. `requestedStoreId` (e.g. from a cookie) is
 * only a preference: it is honoured only when the user is a member of it.
 */
export async function sellerContext(
  exec: Executor,
  userId: string,
  requestedStoreId?: number,
  now: Date = new Date(),
): Promise<SellerContext> {
  // T-63: an identity the Owner console suspended has no seller scope, whatever session it still holds (sessions are also deleted at suspension).
  if (await resolveUserSuspended(exec, userId)) return { ok: false, reason: "identity_suspended" };
  const rows = await resolveMemberStores(exec, userId);
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
    billing: await billingAccess({ exec, storeId: row.storeId }, now),
    sessionId: null,
  } as SellerScope;
  return { ok: true, scope, stores: active.map((r) => ({ id: r.storeId, name: r.name })) };
}

/** The same scope bound to the session of the request (the web layer reads it from the server-side session, never from a form). */
export function bindSession(scope: SellerScope, sessionId: string): SellerScope {
  return { ...scope, sessionId };
}

/** Resolve an active store by slug. Unknown and suspended stores both yield null. */
export async function storefrontScope(exec: Executor, slug: string): Promise<StorefrontScope | null> {
  const row = await resolveStoreBySlug(exec, slug);
  if (!row) return null;
  return { kind: "storefront", exec, storeId: row.id, storeName: row.name, storeSlug: row.slug } as StorefrontScope;
}

/** `exec` must be the platform pool: Super Admin reads across stores and the app role has no access to `platform_operator`. */
export async function operatorScope(exec: Executor, userId: string): Promise<OperatorScope | null> {
  // A deactivated operator (T-63, SA-38) has no scope at all: every console entry point refuses it.
  const [row] = await exec.select().from(platformOperator).where(and(eq(platformOperator.userId, userId), isNull(platformOperator.deactivatedAt)));
  return row ? ({ kind: "operator", exec, userId } as OperatorScope) : null;
}
