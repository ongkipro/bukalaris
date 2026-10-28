import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { storeStepUpProof } from "../schema.ts";
import { DomainError, type SellerScope } from "../platform/scoped.ts";
import { inStore } from "../platform/tenant.ts";
import { enforceLimits } from "../seller/commerce/checkout.ts";
import { SELLER_STEP_UP_WINDOW_SECONDS } from "./settings.ts";

// Seller step-up (IAM-9, D-19, D-21 item 6): a payout request or a destination change needs a FRESH second-factor verification of THIS session. The
// proof is bound to session, user, store, action and subject, is issued only by the definer function `issue_store_step_up` (which re-derives
// session, owner membership and the session's own recent MFA record instead of trusting its arguments), and is consumed with `UPDATE ... RETURNING`
// inside the transaction of the write it authorises, so a failed write leaves it unconsumed until it expires and it can never be used twice.
// The database guards additionally refuse a destination or payout row whose proof was not consumed in the same transaction.

export type SellerProofAction = "payout.destination" | "payout.request";
const REAUTH = "Masukkan kode verifikasi dua langkah lagi untuk melanjutkan. Aktifkan verifikasi dua langkah di Keamanan akun bila belum.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const messageChain = (err: unknown): string => (err instanceof Error ? `${err.message} ${messageChain(err.cause)}` : "");

/** The session is NOT part of the binding the caller supplies: it comes from the scope (the server-side session of the request), so a form value can never choose it. */
export type SellerProofBinding = { action: SellerProofAction; subjectId: string };
const sessionOf = (scope: SellerScope): string => {
  if (!scope.sessionId) throw new DomainError("reauth_required", REAUTH);
  return scope.sessionId;
};

/**
 * Attempts to enter a step-up code per user (wave 3 review P2): Better Auth rate-limits and locks only in its HTTP router and at sign-in, and the code
 * is verified here from a Server Action, so a holder of a stolen owner cookie could otherwise guess a 6-digit code without limit. The slot is taken
 * atomically BEFORE the code is looked at (so parallel guesses cannot all pass a read-then-count check and a correct code during the lockout is refused too)
 * and given back when the code was right: only FAILED attempts accumulate, 5 per 15 minutes per user and 20 per 15 minutes per store.
 */
export const STEP_UP_ATTEMPT_LIMITS = { user: { limit: 5, windowSec: 900 }, store: { limit: 20, windowSec: 900 } } as const;
export function limitStepUpAttempts(scope: SellerScope): Promise<void> {
  return enforceLimits(scope.exec, [
    { key: `stepup:user:${scope.userId}`, rule: STEP_UP_ATTEMPT_LIMITS.user },
    { key: `stepup:store:${scope.storeId}`, rule: STEP_UP_ATTEMPT_LIMITS.store },
  ]);
}

/** Give the slot back after a CORRECT code: a legitimate owner's successful verifications never lock them out. */
export async function refundStepUpAttempt(scope: SellerScope): Promise<void> {
  const keys = [`stepup:user:${scope.userId}`, `stepup:store:${scope.storeId}`];
  const { windowSec } = STEP_UP_ATTEMPT_LIMITS.user;
  await scope.exec.execute(sql`update rate_limit set count = greatest(count - 1, 0) where key in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)}) and window_start = to_timestamp(floor(extract(epoch from now()) / ${windowSec}) * ${windowSec})`);
}

/** Issue a proof when this session verified a second-factor code within the window; the store owner only. */
export async function issueSellerStepUp(scope: SellerScope, b: SellerProofBinding): Promise<string> {
  if (scope.role !== "owner") throw new DomainError("forbidden", "Hanya pemilik toko yang bisa melakukan ini.");
  try {
    const rows = (await inStore(scope, ({ exec }) =>
      exec.execute(sql`select public.issue_store_step_up(${scope.storeId}::bigint, ${scope.userId}, ${sessionOf(scope)}, ${b.action}, 'store', ${b.subjectId}, ${SELLER_STEP_UP_WINDOW_SECONDS}::integer) as id`),
    )) as unknown as { id: string }[];
    return rows[0]!.id;
  } catch (err) {
    if (/reauth_required/.test(messageChain(err))) throw new DomainError("reauth_required", REAUTH);
    throw err;
  }
}

/** Consume inside the write's transaction. A wrong session, user, store, action or subject, a used or an expired proof all fail the same way. */
export async function consumeSellerStepUp(tx: Tx, scope: SellerScope, proofId: string, b: SellerProofBinding): Promise<void> {
  if (!UUID.test(proofId)) throw new DomainError("reauth_required", REAUTH);
  const rows = await tx
    .update(storeStepUpProof)
    .set({ consumedAt: sql`now()` as unknown as Date })
    .where(
      and(
        eq(storeStepUpProof.id, proofId),
        eq(storeStepUpProof.storeId, scope.storeId),
        eq(storeStepUpProof.userId, scope.userId),
        eq(storeStepUpProof.sessionId, sessionOf(scope)),
        eq(storeStepUpProof.actionKey, b.action),
        eq(storeStepUpProof.subjectKind, "store"),
        eq(storeStepUpProof.subjectId, b.subjectId),
        isNull(storeStepUpProof.consumedAt),
        gt(storeStepUpProof.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: storeStepUpProof.id });
  if (rows.length === 0) throw new DomainError("reauth_required", REAUTH);
}
