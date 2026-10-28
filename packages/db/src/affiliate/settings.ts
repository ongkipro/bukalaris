// Named settings of the affiliate programme (T-52, D-22 item 3). None of the NOT-DECIDED figures is an owner decision: each is one constant
// that the migration seeds into `affiliate_policy` and a test pins to that row, so changing a default is a deliberate two-place edit and
// the Owner console (T-54) later changes the stored value without a deploy. Decided figures say so; the rest say "placeholder".

/**
 * Attribution window in days: a captured click earns only inside it. PLACEHOLDER: ADR-0009 leaves the length OPEN (PRIV-7: "30-day reference
 * windows are not an accepted default"), so the value is deliberately short and conservative. It is snapshotted on every click and
 * attribution, so changing it never rewrites either.
 */
export const AFFILIATE_ATTRIBUTION_WINDOW_DAYS_DEFAULT = 7;
/** DECIDED (owner, D-14/D-16, ADR-0009 section 6): days between delivery plus seller-sale release and the commission credit. Snapshotted per attribution; consumed by T-53. */
export const AFFILIATE_HOLD_DAYS_DEFAULT = 3;
/** PLACEHOLDER platform bounds of any commission rate a seller may set, in basis points (ADR-0009: "the Owner console sets valid minimum/maximum rates; there is no invented initial rate"). */
export const AFFILIATE_MIN_RATE_BPS_DEFAULT = 100;
export const AFFILIATE_MAX_RATE_BPS_DEFAULT = 2000;

/** Click ids a continuity cookie may carry (newest first). Resolution still validates every id against the database. */
export const CLICK_COOKIE_MAX_IDS = 5;

/** RL-CLICK (16-OBSERVABILITY): per client IP and per link, fixed windows. Over the limit the buyer is still redirected, without a click. */
export const RL_CLICK = {
  ip: { limit: 120, windowSec: 600 },
  link: { limit: 600, windowSec: 600 },
} as const;
/** RL-CODE: invalid typed codes per cart. Over the limit the typed code is ignored (checkout continues, a click may still win). */
export const RL_CODE = { invalid: { limit: 10, windowSec: 600 } } as const;

/** Rows of the discovery list one page returns. */
export const AFFILIATE_CATALOG_PAGE = 30;
/** Offers one store-wide projection job handles per run (a store with more is projected by repeated jobs of its next revision). */
export const AFFILIATE_PROJECT_BATCH = 200;

/** Phase-1 risk flag thresholds (SA-18). OPEN in SEC-20: PLACEHOLDERS so the counters can be read as flags; the console may override them per call. */
export const AFFILIATE_RISK_THRESHOLDS = {
  selfReferralSuppressed: 3,
  clickRefusedRate: 20,
  clicksPerOrder: 200,
  voidedShare: 0.5,
  minOrdersForShares: 5,
} as const;
