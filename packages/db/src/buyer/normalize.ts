import { z } from "zod";

// The one normalization of buyer contacts (T-57 slice 1, ADR-0010 section 2). Pure: no I/O, no environment.
// Every caller that compares, keys or hashes a phone number or an e-mail address goes through here: the
// risk and privacy lookups, the ad-signal hashes, the checkout rate-limit key, the buyer identity resolver
// and (T-52) the affiliate self-referral comparison. The SQL port that the database uses for the same
// decisions is `buyer_phone_key` / `buyer_canonical_phone` / `buyer_canonical_email` in the T-57 section of
// the migration; `t57-normalize.test.ts` runs one table through both and fails when they disagree.
//
// Stored order snapshots are never rewritten by this module: it only derives keys from what was typed.

/** Longest raw phone text looked at (separators included); a limit on work, not on number length. */
export const PHONE_RAW_MAX_CHARS = 32;
/** E.164 (ITU-T) allows at most 15 digits including the country code. */
const E164_MAX_DIGITS = 15;
/** Shortest key accepted: the checkout rule `^\+?[0-9]{8,15}$` (SF-07) already requires 8 digits. */
const KEY_MIN_DIGITS = 8;
/**
 * Canonical Indonesian mobile / WhatsApp number: `62` + `8` + 7..12 digits. The lower and upper bound are a
 * conservative structural bracket inside E.164, not a numbering-plan statement (UNVERIFIED against the current
 * Indonesian numbering plan); a landline or foreign number simply has no canonical identity key.
 */
export const CANONICAL_PHONE_RE = /^628[0-9]{7,12}$/;
/** What the database column check and the SQL port accept as a canonical e-mail (the checkout validator, lower case). */
export const EMAIL_MAX_CHARS = 254;

const PHONE_CHARS_RE = /^[+0-9 \t().-]+$/;
const SEPARATORS_RE = /[ \t().-]/g;
const ASCII_RE = /^[\x00-\x7f]*$/;
const EMAIL_SCHEMA = z.email();

/**
 * Comparison key of a phone number typed in any common spelling, or `null` when it is not usable.
 *
 * Accepted: ASCII digits with the separators ` `, tab, `-`, `.`, `(`, `)`; a leading `+`; the international
 * prefix `00`; the local trunk `0` (read as Indonesia, the only country this platform serves); and a stray `0`
 * after the country code (`+62 0812…`). The result is digits without `+`, 8 to 15 long, starting 1-9. A number that
 * starts with neither `+`, `00`, `0` nor `62` is kept as typed (nothing proves its country). Anything else
 * (letters, other symbols, a `+` inside, non-ASCII digits, over-long text) is `null`.
 *
 * Landlines and foreign numbers get a key too (they are still matched in risk and privacy lookups); only
 * `normalizePhone` decides whether the key is an identity.
 */
export function phoneLookupKey(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > PHONE_RAW_MAX_CHARS || !PHONE_CHARS_RE.test(raw)) return null;
  const text = raw.replace(/^[ \t]+|[ \t]+$/g, "");
  const plus = text.startsWith("+");
  const body = plus ? text.slice(1) : text;
  if (body.includes("+")) return null;
  const digits = body.replace(SEPARATORS_RE, "");
  if (!/^[0-9]+$/.test(digits)) return null;
  let key: string;
  if (plus) key = digits;
  else if (digits.startsWith("00")) key = digits.slice(2);
  else if (digits.startsWith("0")) key = `62${digits.slice(1)}`;
  else key = digits;
  if (key.startsWith("620")) key = `62${key.slice(3)}`;
  return key.length >= KEY_MIN_DIGITS && key.length <= E164_MAX_DIGITS && /^[1-9]/.test(key) ? key : null;
}

/**
 * Canonical identity phone (`628…`) of an Indonesian mobile / WhatsApp number: `08…`, `628…`, `+628…`, `00628…` and the
 * separator variants all give the same value. `null` for everything else, including numbers of other countries and
 * landlines: no country is guessed and no second person is invented from an ambiguous value.
 */
export function normalizePhone(raw: unknown): string | null {
  const key = phoneLookupKey(raw);
  return key !== null && CANONICAL_PHONE_RE.test(key) ? key : null;
}

/**
 * Canonical e-mail: trimmed, lower case, the checkout validator (`z.email()`), at most 254 characters. Dots and `+tags` are
 * never stripped and no provider alias is inferred. Non-ASCII input is rejected before lower-casing, so a character such as the
 * Kelvin sign cannot fold into an ASCII letter and land on someone else's address.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string" || !ASCII_RE.test(raw)) return null;
  const value = raw.trim().toLowerCase();
  return value.length <= EMAIL_MAX_CHARS && EMAIL_SCHEMA.safeParse(value).success ? value : null;
}

/** Two phone texts are the same identity (affiliate self-referral, T-52): both canonical and equal. Never true for unusable input. */
export const samePhoneIdentity = (a: unknown, b: unknown): boolean => {
  const left = normalizePhone(a);
  return left !== null && left === normalizePhone(b);
};
