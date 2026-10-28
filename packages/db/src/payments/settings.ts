// D-22 conservative LOCAL settings, not vendor status mappings. The production allowlist is intentionally empty.
export const ADVICE_SETTLED: readonly string[] = Object.freeze([]);
/**
 * Where the inquiry carries the status and the provider amount, and the one status word that means settled (the spec's `PAID`).
 * The response schema is not published (observed: `{ rc, ket, data: { awb } }`), so the field names are settings with the
 * most literal default: if the vendor uses other fields nothing settles (safe), nothing is guessed.
 */
export const ADVICE_STATUS_FIELD = "status";
export const ADVICE_AMOUNT_FIELD = "amount";
export const ADVICE_PAID_STATUS = "PAID";
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
