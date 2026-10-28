import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type ShippingKey = { keyId: string; key: Buffer };
/** The same reading as `tokenKey` (INTEGRATION_TOKEN_KEY is 32 bytes in hex OR base64): a key reused under the other encoding must still be recognised. */
const keyBytes = (raw: string): Buffer => (/^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64"));
export function shippingKeyring(env: NodeJS.ProcessEnv = process.env): ShippingKey[] {
  const fail = () => { throw new Error("shipping_key_unavailable"); };
  const ring = (env.KEYRING_SHIPPING_CREDENTIALS ?? "").split(",").map((entry) => {
    const colon = entry.indexOf(":");
    const keyId = entry.slice(0, colon), encoded = entry.slice(colon + 1);
    const key = Buffer.from(encoded, "base64");
    if (colon < 1 || !/^[A-Za-z0-9_-]+$/.test(keyId) || key.length !== 32 || key.toString("base64") !== encoded) fail();
    return { keyId, key };
  });
  if (!ring.length || new Set(ring.map((k) => k.keyId)).size !== ring.length) fail();
  const others = [env.INTEGRATION_TOKEN_KEY, ...(env.KEYRING_INTEGRATION_TOKENS ?? "").split(",").map((x) => x.slice(x.indexOf(":") + 1)), ...(env.KEYRING_TAX_IDENTITY ?? "").split(",").map((x) => x.slice(x.indexOf(":") + 1)), ...(env.KEYRING_BUYER_FINGERPRINT ?? "").split(",").map((x) => x.slice(x.indexOf(":") + 1)), env.IDENTITY_FINGERPRINT_KEY?.split(":").at(-1)];
  if (ring.some((k) => others.some((s) => s && k.key.equals(keyBytes(s))))) throw new Error("shipping_key_purpose_reused");
  return ring;
}
const aad = (storeId: number, accountId: number) => Buffer.from(JSON.stringify(["shipping_credentials", storeId, accountId, "partner_managed"]));
export function sealShippingKey(value: string, storeId: number, accountId: number) {
  const current = shippingKeyring()[0]!;
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", current.key, iv);
  cipher.setAAD(aad(storeId, accountId));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { keyId: current.keyId, sealedKey: [iv, encrypted, cipher.getAuthTag()].map((x) => x.toString("base64")).join("."), sealedAt: new Date() };
}
/** Worker-only primitive. Never re-exported by the browser-facing package entry point. */
export function unsealShippingKey(envelope: string, keyId: string, storeId: number, accountId: number) {
  const key = shippingKeyring().find((k) => k.keyId === keyId);
  if (!key) throw new Error("shipping_key_unavailable");
  try {
    const parts = envelope.split(".").map((x) => Buffer.from(x, "base64"));
    if (parts.length !== 3 || parts[0]!.length !== 12 || parts[2]!.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key.key, parts[0]!);
    decipher.setAAD(aad(storeId, accountId)); decipher.setAuthTag(parts[2]!);
    return Buffer.concat([decipher.update(parts[1]!), decipher.final()]).toString("utf8");
  } catch { throw new Error("shipping_envelope_invalid"); }
}
