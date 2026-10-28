// Named LOCAL settings of the seller ledger, payouts, refunds and reconciliation (T-37, D-22 item 3). None of these figures is an owner
// decision except where the comment says so; each is a single constant so reversing one is a one-line change. Money amounts are
// integer IDR, durations are named with their unit. Live gates (Q-17, OPEN-F7, OPEN-F8, OPEN-F9) are NOT settings: they stay off.

/** Smallest payout a store may request. PLACEHOLDER: no owner figure exists (D-22 item 3), so the value is deliberately conservative. */
export const MIN_PAYOUT_IDR = 100_000;
/** D-19 (owner decided): a new or changed payout destination is held this long before a payout may use it. Owner-configurable later. */
export const PAYOUT_DESTINATION_HOLD_HOURS = 72;
/** ADR-0006 decision 5 / BILL-5 (99ribu precedent): an operator executing a `processing` payout or refund holds an exclusive lease. */
export const PAYOUT_CLAIM_LEASE_MINUTES = 30;
/** ADR-0006 decision 5: a transfer receipt artifact is at most 10 MB. */
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
/** A transfer reference is compared after removing everything but letters and digits; fewer characters than this is not a reference. */
export const EVIDENCE_REF_MIN_LENGTH = 6;
/** Seller-side step-up proof life and the freshness of the second-factor code it needs (the same figure T-60 uses for operators). */
export const SELLER_STEP_UP_WINDOW_SECONDS = 300;
/**
 * OPEN-F8 (UNVERIFIED): the provider reconciliation signal does not release money while this is false. The only release path for a
 * COD sale is an applied Owner console reconciliation batch. Turning it on needs the owner's written acceptance of the observed signal.
 */
export const PROVIDER_RECONCILIATION_ENABLED = false;
/** Stores one page of a `ledger.release` run examines (a store count, not an entry count). The run pages through EVERY store with something releasable, so no store starves. */
export const LEDGER_RELEASE_BATCH = 200;
/** Rows a statement page shows. */
export const STATEMENT_PAGE = 25;
/** Longest list a console queue renders. */
export const CONSOLE_QUEUE_LIMIT = 100;
/** Reconciliation batch size ceiling (items). A safety bound, not a business figure. */
export const RECONCILIATION_BATCH_MAX_ITEMS = 500;
