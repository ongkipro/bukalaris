import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

// Sealed provider credentials (ADR-0007 decision 6, ADR-0013 decision 5): AES-256-GCM under a purpose-separated keyring with `key_id`
// versioning. `shipping_credentials` seals Mengantar keys (Partner-provisioned and, since T-104, the seller's own); `payment_credentials`
// seals the seller's own AutoLaris key. The additional data binds purpose, store, account row and account kind, so an envelope copied to
// another store's row (or to another kind) never opens.

export type CredentialPurpose = "shipping_credentials" | "payment_credentials";
export type ShippingKey = { keyId: string; key: Buffer };
const RING_ENV: Record<CredentialPurpose, string> = { shipping_credentials: "KEYRING_SHIPPING_CREDENTIALS", payment_credentials: "KEYRING_PAYMENT_CREDENTIALS" };
const LABEL: Record<CredentialPurpose, string> = { shipping_credentials: "shipping", payment_credentials: "payment" };
/** The same reading as `tokenKey` (INTEGRATION_TOKEN_KEY is 32 bytes in hex OR base64): a key reused under the other encoding must still be recognised. */
const keyBytes = (raw: string): Buffer => (/^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64"));
const ringValues = (raw: string | undefined) => (raw ?? "").split(",").map((x) => x.slice(x.indexOf(":") + 1));

export function credentialKeyring(purpose: CredentialPurpose, env: NodeJS.ProcessEnv = process.env): ShippingKey[] {
  const label = LABEL[purpose];
  const fail = () => { throw new Error(`${label}_key_unavailable`); };
  const ring = (env[RING_ENV[purpose]] ?? "").split(",").map((entry) => {
    const colon = entry.indexOf(":");
    const keyId = entry.slice(0, colon), encoded = entry.slice(colon + 1);
    const key = Buffer.from(encoded, "base64");
    if (colon < 1 || !/^[A-Za-z0-9_-]+$/.test(keyId) || key.length !== 32 || key.toString("base64") !== encoded) fail();
    return { keyId, key };
  });
  if (!ring.length || new Set(ring.map((k) => k.keyId)).size !== ring.length) fail();
  const otherRing = purpose === "shipping_credentials" ? env.KEYRING_PAYMENT_CREDENTIALS : env.KEYRING_SHIPPING_CREDENTIALS;
  const others = [env.INTEGRATION_TOKEN_KEY, ...ringValues(env.KEYRING_INTEGRATION_TOKENS), ...ringValues(env.KEYRING_TAX_IDENTITY), ...ringValues(env.KEYRING_BUYER_FINGERPRINT), ...ringValues(otherRing), env.IDENTITY_FINGERPRINT_KEY?.split(":").at(-1)];
  if (ring.some((k) => others.some((s) => s && k.key.equals(keyBytes(s))))) throw new Error(`${label}_key_purpose_reused`);
  return ring;
}
export const shippingKeyring = (env: NodeJS.ProcessEnv = process.env) => credentialKeyring("shipping_credentials", env);
export const paymentKeyring = (env: NodeJS.ProcessEnv = process.env) => credentialKeyring("payment_credentials", env);

const aad = (purpose: CredentialPurpose, storeId: number, accountId: number, kind: string) => Buffer.from(JSON.stringify([purpose, storeId, accountId, kind]));
export function sealCredential(purpose: CredentialPurpose, value: string, storeId: number, accountId: number, kind: string) {
  const current = credentialKeyring(purpose)[0]!;
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", current.key, iv);
  cipher.setAAD(aad(purpose, storeId, accountId, kind));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { keyId: current.keyId, sealedKey: [iv, encrypted, cipher.getAuthTag()].map((x) => x.toString("base64")).join("."), sealedAt: new Date() };
}
/** Server-side provider clients only. Never re-exported by the browser-facing package entry point. */
export function unsealCredential(purpose: CredentialPurpose, envelope: string, keyId: string, storeId: number, accountId: number, kind: string) {
  const label = LABEL[purpose];
  const key = credentialKeyring(purpose).find((k) => k.keyId === keyId);
  if (!key) throw new Error(`${label}_key_unavailable`);
  try {
    const parts = envelope.split(".").map((x) => Buffer.from(x, "base64"));
    if (parts.length !== 3 || parts[0]!.length !== 12 || parts[2]!.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key.key, parts[0]!);
    decipher.setAAD(aad(purpose, storeId, accountId, kind)); decipher.setAuthTag(parts[2]!);
    return Buffer.concat([decipher.update(parts[1]!), decipher.final()]).toString("utf8");
  } catch { throw new Error(`${label}_envelope_invalid`); }
}
export const sealShippingKey = (value: string, storeId: number, accountId: number, kind = "partner_managed") => sealCredential("shipping_credentials", value, storeId, accountId, kind);
/** Worker-only primitive. Never re-exported by the browser-facing package entry point. */
export const unsealShippingKey = (envelope: string, keyId: string, storeId: number, accountId: number, kind = "partner_managed") => unsealCredential("shipping_credentials", envelope, keyId, storeId, accountId, kind);

/**
 * Audit identifier of a key (ADR-0013 decision 6): an HMAC keyed per purpose, so a short key cannot be guessed offline from an audit row.
 * The HMAC key is derived (HKDF) from the purpose's CURRENT ring key: a ring rotation changes fingerprints, and the re-seal job writes the
 * new fingerprint with the new envelope (`resealShippingCredentials`). Equal keys under one ring key give equal fingerprints.
 */
export function keyFingerprint(purpose: CredentialPurpose, value: string): string {
  const ringKey = credentialKeyring(purpose)[0]!.key;
  const macKey = Buffer.from(hkdfSync("sha256", ringKey, Buffer.alloc(0), `bukalaris:${purpose}:key-fingerprint`, 32));
  return `hmac:${createHmac("sha256", macKey).update(value, "utf8").digest("hex").slice(0, 16)}`;
}
/** The only form of a key a screen shows (ADR-0013 decision 7): shorter than 24 characters fully masked, otherwise the first and last four. */
export const keyHint = (value: string) => (value.length < 24 ? "••••••••" : `${value.slice(0, 4)}••••${value.slice(-4)}`);
