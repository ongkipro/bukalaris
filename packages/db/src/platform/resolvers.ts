import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client.ts";

/**
 * Cross-store resolvers (ADR-0005 amendment 4). Each one calls a SECURITY DEFINER function owned by
 * `bukalaris_resolver` (migration `0011_chain_a_foundation.sql`, T-59 section, registered in `DEFINER_FUNCTIONS`) on the caller's own
 * executor, normally the app pool: no BYPASSRLS login is involved. They return the resolved store (id, and for
 * storefront and seller lookups name, slug, status, role), never other row data; the caller then continues
 * inside that store's context (`withStore`). Arguments are bound parameters of one fixed statement.
 * `bigint` columns arrive from the driver as strings, hence `Number`.
 */
type Row = Record<string, unknown>;
const rows = async (exec: Executor, query: SQL) => (await exec.execute(query)) as unknown as Row[];
const storeId = async (exec: Executor, query: SQL): Promise<number | null> => {
  const [row] = await rows(exec, query);
  const id = row && Object.values(row)[0];
  return id === null || id === undefined ? null : Number(id);
};

/** Active store by slug (unknown and suspended stores both yield null). */
export async function resolveStoreBySlug(exec: Executor, slug: string): Promise<{ id: number; name: string; slug: string } | null> {
  const [row] = await rows(exec, sql`select id, name, slug from resolve_store_by_slug(${slug})`);
  return row ? { id: Number(row.id), name: String(row.name), slug: String(row.slug) } : null;
}

/** Every store the user is a member of, any status, ordered by store id. */
export async function resolveMemberStores(exec: Executor, userId: string) {
  const found = await rows(exec, sql`select store_id, name, slug, status, role from resolve_member_stores(${userId})`);
  return found.map((r) => ({ storeId: Number(r.store_id), name: String(r.name), slug: String(r.slug), status: String(r.status), role: r.role as "owner" | "staff" }));
}

/** The store a cart belongs to, checked out or not (`cartId` must be a uuid). */
export const resolveCartStore = (exec: Executor, cartId: string) => storeId(exec, sql`select resolve_cart_store(${cartId}::uuid)`);

/** Store of the channel whose token prefix and token hash both match. */
export const resolveChannelStore = (exec: Executor, prefix: string, tokenHash: string) => storeId(exec, sql`select resolve_channel_store(${prefix}, ${tokenHash})`);

/** Store of the active feed token whose prefix and hash both match. */
export const resolveFeedStore = (exec: Executor, prefix: string, tokenHash: string) => storeId(exec, sql`select resolve_feed_store(${prefix}, ${tokenHash})`);

/** Store of a checkout handoff by the hash of its code. */
export const resolveHandoffStore = (exec: Executor, codeHash: string) => storeId(exec, sql`select resolve_handoff_store(${codeHash})`);

/** Store of an invitation by the hash of its token. */
export const resolveInvitationStore = (exec: Executor, tokenHash: string) => storeId(exec, sql`select resolve_invitation_store(${tokenHash})`);

/** Store of an order by id (the id comes from a verified signed order link). */
export const resolveOrderStore = (exec: Executor, orderId: number) => storeId(exec, sql`select resolve_order_store(${orderId}::bigint)`);

/** Store of the payment attempt with this local `reff_id` (the signed AutoLaris callback reference; T-49, HTTP-17). */
export const resolvePaymentAttemptStore = (exec: Executor, reffId: string) => storeId(exec, sql`select resolve_payment_attempt_store(${reffId})`);

/** Store of the subscription payment attempt with this local `reff_id` (the signed AutoLaris callback reference of a platform invoice; T-50, HTTP-17). */
export const resolveSubscriptionAttemptStore = (exec: Executor, reffId: string) => storeId(exec, sql`select resolve_subscription_attempt_store(${reffId})`);

/** Platform-wide identity suspension (T-63): true when the Owner console suspended this user. Callable on the app pool; returns nothing else about the user. */
export async function resolveUserSuspended(exec: Executor, userId: string): Promise<boolean> {
  const [row] = await rows(exec, sql`select resolve_user_suspended(${userId}) as suspended`);
  return row?.suspended === true;
}
