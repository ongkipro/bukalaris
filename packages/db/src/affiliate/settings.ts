// Named settings of the affiliate programme (T-52, D-22 item 3; T-108, D-31). Each figure is one constant that the migrations seed into `affiliate_policy`
// and a test pins to that row, so changing a default is a deliberate two-place edit and the Owner console later changes the stored value without a deploy.
// Decided figures say so; the rest say "placeholder".

/**
 * Attribution window in days: a captured click earns only inside it. DECIDED (owner, D-31 / ADR-0015 OPEN-A2): 7 days, Owner-configurable. It is
 * snapshotted on every click and attribution, so changing it never rewrites either.
 */
export const AFFILIATE_ATTRIBUTION_WINDOW_DAYS_DEFAULT = 7;
/** DECIDED (owner, D-16, ADR-0015 decision 4): days between delivery and the commission becoming `payable`. Snapshotted per attribution and obligation. */
export const AFFILIATE_HOLD_DAYS_DEFAULT = 3;
/** DECIDED (owner, D-31 / ADR-0015 OPEN-A1): platform bounds of any commission rate a seller may set, in basis points (1 % to 50 %), Owner-configurable. Seeded by migration 0028. */
export const AFFILIATE_MIN_RATE_BPS_DEFAULT = 100;
export const AFFILIATE_MAX_RATE_BPS_DEFAULT = 5000;

/** RL-AFF-STORE-APPLY (doc 16, D-33): applications per affiliate and day (fixed window). The "one open application per affiliate and store" half is the table's unique key. */
export const RL_AFF_STORE_APPLY = { limit: 20, windowSec: 86_400 } as const;
/** Obligations one run of `affiliate.commission.release` (JOB-38) moves to `payable`; a longer backlog is taken by the next minute's run. */
export const AFFILIATE_RELEASE_BATCH = 500;

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
