import { sql } from "drizzle-orm";
import type { Executor } from "../client.ts";

// Worker side of the checkout association (T-57, ADR-0010 section 4, JOB-10). The only caller of the SECURITY DEFINER function
// `buyer_resolve_order` (migration 0013, registered in isolation-registry.ts): the platform login holds no table privilege on the
// buyer tables, so every identity effect goes through that one target-bound statement. It never returns a buyer id, a profile or the
// state of an existing buyer; the outcome says only what happened to this order.

/**
 * OPEN under ADR-0010 section 4 step 6 (recommended, not decided): an e-mail match accepts a first phone only when the matched e-mail
 * identifier is `bound`; for an `observed` e-mail a new buyer is created instead. `true` is the recommended, safer default; `false`
 * reproduces the literal decided algorithm (reversing this is one constant).
 */
export const EMAIL_MATCH_REQUIRES_BOUND = true;

/** `linked`: association written now. `already_linked`: replay, nothing changed. `no_identifier`: the order carries no usable contact (redacted, landline or foreign number, no e-mail): no buyer is created. */
export type BuyerResolveOutcome = "linked" | "already_linked" | "no_identifier";

/**
 * Resolve the buyer of one committed order. `requestId` is the correlation id written to the identity events (the job id). Idempotent: the
 * same order again returns `already_linked` and changes nothing. A missing order, a lost race on a unique identifier and a revoked identifier
 * raise, and the job retries (or dies visibly); a raised call leaves no partial buyer, identifier, link or event.
 */
export async function resolveBuyerForOrder(exec: Executor, storeId: number, orderId: number, requestId: string): Promise<BuyerResolveOutcome> {
  const rows = (await exec.execute(
    sql`select public.buyer_resolve_order(${storeId}::bigint, ${orderId}::bigint, ${requestId}::text, ${EMAIL_MATCH_REQUIRES_BOUND}::boolean) as outcome`,
  )) as unknown as { outcome: BuyerResolveOutcome }[];
  return rows[0]!.outcome;
}
