// D-22 conservative LOCAL settings, not vendor status mappings. The production allowlist is intentionally empty.
export const ADVICE_SETTLED: readonly string[] = Object.freeze([]);
/**
 * Where the inquiry carries the status and the provider amount, and the one status word that means settled (the spec's `PAID`).
 * The response schema is not published (observed: `{ rc, ket, data: { awb } }`), so the field names are settings with the
 * most literal default: if the vendor uses other fields nothing settles (safe), nothing is guessed.
 */
export const ADVICE_STATUS_FIELD = "status";
export const ADVICE_AMOUNT_FIELD = "amount";
export const ADVICE_MAX_POLLS = 24;
export const ADVICE_INTERVAL_MS = 300_000;
export const PAYMENT_INSTRUCTION_LIFETIME_MS = 86_400_000;
export const ADVICE_BATCH_SIZE = 24;
export const REDACT_BATCH_SIZE = 1000;
export const CALLBACK_BODY_MAX_BYTES = 16_384;
/** Distinct callback bodies stored (and verified by one provider inquiry each) per attempt; the signed URL does not expire (wave 2 review). */
export const CALLBACK_MAX_PER_ATTEMPT = 50;
export const AUTOLARIS_CALLBACK_RETENTION_DAYS: number | null = null; // OPEN: never silently adopt the older 30-day proposal
export const AUTOLARIS_CALLBACK_LIMIT = { name: "RL-AUTOLARIS-CB", limit: 120, windowSec: 60 } as const;

// ── T-106 (ADR-0013 sections 4 to 6, D-21, D-33) ─────────────────────────────────────────────────────────────────────
/**
 * Decision 22: the ONE allow-list of status words that, together with the paid code and an equal provider amount, settle an attempt checked on
 * the store's own key. UNVERIFIED: AutoLaris has not published the Advice settlement mapping (skill `autolaris-h2h`, references/docs/reference/
 * h2h-api.md "Advice" and "Batas kontrak", Postman snapshot of 2026-09-03; only `02/PENDING` was observed). "PAID" is the spec's own word (D-21 K),
 * not a confirmed provider value. A word outside this list is recorded on the observation and reviewed; it never settles.
 */
export const AUTOLARIS_PAID = Object.freeze({
  code: "00",
  statusField: ADVICE_STATUS_FIELD,
  amountField: ADVICE_AMOUNT_FIELD,
  words: Object.freeze(["PAID"]) as readonly string[],
  verified: false,
  source: "UNVERIFIED: D-21 K spec word; AutoLaris Advice mapping unpublished (autolaris-h2h skill, Postman snapshot 2026-09-03)",
});
/** Decision 23: the scheduled status check covers pending attempts and those expired in the last 24 hours, newest first, in bounded batches. */
export const STATUS_CHECK_LOOKBACK_MS = 24 * 3_600_000;
export const STATUS_CHECK_BATCH_SIZE = 50;
/** RL-AUTOLARIS-CB per signed reference (doc 16, D-33): 10 per 10 minutes; the per-IP value stays `AUTOLARIS_CALLBACK_LIMIT`. */
export const AUTOLARIS_CALLBACK_REF_LIMIT = { name: "RL-AUTOLARIS-CB", limit: 10, windowSec: 600 } as const;
/** RL-PAY-RECHECK (doc 16, D-33): a buyer or seller "check now" (and a buyer retry): 6 per minute per order, 30 per 10 minutes per IP. */
export const PAY_RECHECK_LIMITS = { order: { limit: 6, windowSec: 60 }, ip: { limit: 30, windowSec: 600 } } as const;
/**
 * Provider facts T-106 depends on, each with its state. UNVERIFIED rows are confirmed with AutoLaris (or at the first sandbox call) before the
 * production switch of decision 34 may be turned on.
 */
export const AUTOLARIS_FACTS = Object.freeze({
  paidStatusWords: "UNVERIFIED (see AUTOLARIS_PAID)",
  feeRates: "UNVERIFIED: payment_fee_rate version 1 is the reference system's starting data (decision 19)",
  expiryTimeZone: "UNVERIFIED: `expired` is sent as WIB (UTC+7, expiryStampWib); the provider has not published its time zone",
  sandboxOrigin: "UNVERIFIED: the official documentation names one base URL (https://api-h2h.autolaris.com) and no sandbox origin; AUTOLARIS_SANDBOX_ORIGIN stays unset",
  ipAllowList: "Owner statement (D-33, 2026-11-15): none for payment-gateway use; the documentation snapshot says 'whitelist maksimal 5 IP' for production. Proven at the first sandbox call",
  requestShape: "UNVERIFIED (C-P8): the 24-key /submit payment-only profile with courir_id 1 is a per-account agreement",
  feeGrossUp: "UNVERIFIED: with fee bearer `buyer` the fee is priced on the goods omset or the payable (fee schedule base) and added to the bill; whether AutoLaris charges its fee on the billed total (so a true gross-up would be needed for the seller to net the order total) is unconfirmed",
  sellerBorneFee: "UNVERIFIED: with fee bearer `seller` the bill equals the order total; whether AutoLaris adds `biaya_admin` to `grand_total` is unconfirmed (parseSubmit fails closed on a total mismatch)",
  statusWordPath: "UNVERIFIED: the status word is read from data.status, falling back to the envelope `ket` for review only (adviceStatusWord); only data.status can settle",
});
