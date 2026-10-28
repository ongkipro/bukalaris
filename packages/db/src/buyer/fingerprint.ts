import { createHmac, timingSafeEqual } from "node:crypto";

// Keyed fingerprints of buyer contacts (T-57, SEC-22, 16-OBSERVABILITY "Shared limiter"): a rate-limit key, a log line or an audit
// reference may name a phone number or an e-mail address only through an HMAC under a key that lives outside the database, never
// as the value itself. One key ring for one purpose: `KEYRING_BUYER_FINGERPRINT` = `<key_id>:<base64 of 32 bytes>[,<key_id>:<base64>...]`,
// the first entry is current (it fingerprints new values), every entry is listed for lookups across a rotation. A key that equals one of
// the tax-identity keys or the integration token key is refused, so one leaked secret never opens a second purpose. An absent or
// malformed ring fails closed (`buyer_key_unavailable`); there is no fallback to another secret and no unkeyed hash.

export const BUYER_FINGERPRINT_RING_ENV = "KEYRING_BUYER_FINGERPRINT";
const KEY_BYTES = 32;

export interface BuyerFingerprintKey {
  keyId: string;
  key: Buffer;
}

/** Purposes are part of the HMAC input, so a fingerprint made for one purpose can never be replayed as another (T-58 adds the OTP ones). */
export type FingerprintPurpose = "rate.order_phone" | "rate.voucher_phone" | "promotion.buyer_usage";

function parseKey(entry: string, code: string): BuyerFingerprintKey {
  const split = entry.indexOf(":");
  const keyId = entry.slice(0, split);
  const key = Buffer.from(entry.slice(split + 1), "base64");
  if (split <= 0 || !/^[a-zA-Z0-9_-]+$/.test(keyId) || key.length !== KEY_BYTES) throw new Error(code);
  return { keyId, key };
}

/** Keys of the other purposes that may be configured; unparseable values are somebody else's problem and are skipped here. */
function otherPurposeKeys(): Buffer[] {
  const keys: Buffer[] = [];
  for (const entry of [...(process.env.KEYRING_TAX_IDENTITY?.split(",") ?? []), process.env.IDENTITY_FINGERPRINT_KEY ?? ""]) {
    try {
      keys.push(parseKey(entry, "skip").key);
    } catch {}
  }
  const token = process.env.INTEGRATION_TOKEN_KEY;
  if (token) keys.push(/^[0-9a-f]{64}$/i.test(token) ? Buffer.from(token, "hex") : Buffer.from(token, "base64"));
  return keys;
}

/** The configured ring, newest first. Throws `buyer_key_unavailable` (missing, malformed, duplicate id) or `buyer_key_purpose_reused`. */
export function buyerFingerprintKeyring(): BuyerFingerprintKey[] {
  const raw = process.env[BUYER_FINGERPRINT_RING_ENV];
  if (!raw) throw new Error("buyer_key_unavailable");
  const ring = raw.split(",").map((entry) => parseKey(entry, "buyer_key_unavailable"));
  if (new Set(ring.map((k) => k.keyId)).size !== ring.length) throw new Error("buyer_key_unavailable");
  const others = otherPurposeKeys();
  if (ring.some((k) => others.some((o) => o.length === k.key.length && timingSafeEqual(o, k.key)))) throw new Error("buyer_key_purpose_reused");
  return ring;
}

const hmac = (key: BuyerFingerprintKey, purpose: FingerprintPurpose, kind: "phone" | "email", canonical: string) =>
  `${key.keyId}.${createHmac("sha256", key.key).update(`buyer.${purpose}\0${kind}\0${canonical}`).digest("hex")}`;

/** `<key_id>.<hex>` of a canonical contact under the current key. */
export const buyerFingerprint = (purpose: FingerprintPurpose, kind: "phone" | "email", canonical: string): string => hmac(buyerFingerprintKeyring()[0]!, purpose, kind, canonical);

/** The fingerprint under every key of the ring, newest first: what a lookup must try while a rotation is in progress. */
export const buyerFingerprintsAllKeys = (purpose: FingerprintPurpose, kind: "phone" | "email", canonical: string): string[] =>
  buyerFingerprintKeyring().map((key) => hmac(key, purpose, kind, canonical));
