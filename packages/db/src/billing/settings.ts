// D-22 item 3: where no owner-decided figure exists the value is a named setting with a conservative default, never a literal in
// business code. The owner-decided figures (Rp175.000 DPP per store per month, trial and grace of 3 days, PPN off) are NOT here:
// they are the first row of `subscription_plan` (migration 0013, section T-50) and are changed through the Owner console.

/** The one plan of the startup phase (D-17, BILL-7). A second plan code is not an assumption anyone has made. */
export const PLAN_CODE = "all_feature";

/** How long before a period starts its invoice may be created (named default: the length of the 3-day trial/grace; not an owner decision). */
export const INVOICE_LEAD_MS = 3 * 86_400_000;
/** Lifetime of a subscription payment instruction (same as the buyer order instruction, 24 hours). */
export const SUBSCRIPTION_INSTRUCTION_LIFETIME_MS = 86_400_000;
/** A live attempt past its expiry is replaced by a new controlled attempt only after this safety margin (a payment made at the last minute must reach us first). */
export const ATTEMPT_REPLACE_AFTER_EXPIRY_MS = 300_000;
/** Gateway channels a subscription invoice may use: the real channel codes, never a bare bank name (BILL-7, DATA-10). */
export const SUBSCRIPTION_CHANNELS: readonly string[] = ["VABCA", "VABNI", "VABRI", "VAMANDIRI", "VAPERMATA", "QRIS"];
/** Distinct callback bodies recorded (and each verified by one provider inquiry) per subscription attempt. */
export const SUBSCRIPTION_CALLBACK_MAX_PER_ATTEMPT = 50;

/** Stores handled by one `billing.cycle` run. The next run (one hour later) continues with the rest. */
export const CYCLE_BATCH_SIZE = 500;
/** Dunning timings (named defaults, owner-adjustable later; the Owner may also switch dunning off). */
export const DUNNING_TRIAL_ENDING_LEAD_MS = 86_400_000;
export const DUNNING_GRACE_ENDING_LEAD_MS = 86_400_000;

/** Bounds of the DATA-10 plan values (positive/valid ranges are a database invariant too: CHECKs of `subscription_plan`). */
export const TRIAL_DAYS_MAX = 60;
export const GRACE_DAYS_MAX = 60;
