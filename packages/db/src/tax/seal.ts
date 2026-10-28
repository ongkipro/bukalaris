import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export interface TaxKey { keyId: string; key: Buffer }
export function taxKeyring(): TaxKey[] {
  const parts = process.env.KEYRING_TAX_IDENTITY?.split(",") ?? [];
  const ring = parts.map(parseTaxKey);
  if (!ring.length || new Set(ring.map((k) => k.keyId)).size !== ring.length) throw new Error("tax_key_unavailable");
  const fingerprint = fingerprintKey();
  if (ring.some((k) => k.key.equals(fingerprint.key))) throw new Error("tax_key_purpose_reused");
  return ring;
}
function parseTaxKey(entry: string): TaxKey {
  const split = entry.indexOf(":");
  const keyId = entry.slice(0, split); const key = Buffer.from(entry.slice(split + 1), "base64");
  if (split <= 0 || !/^[a-zA-Z0-9_-]+$/.test(keyId) || key.length !== 32) throw new Error("tax_key_unavailable");
  return { keyId, key };
}
export function fingerprintKey(): TaxKey { return parseTaxKey(process.env.IDENTITY_FINGERPRINT_KEY ?? ""); }
export interface TaxIdentityBinding { subjectKind: "affiliate" | "store"; subjectId: number; version: number; idKind: string; field: "identifier" | "registered_name" }
const aad = (binding: TaxIdentityBinding) => Buffer.from(JSON.stringify(["tax_identity", binding.subjectKind, binding.subjectId, binding.version, binding.idKind, binding.field]));
export function sealTaxValue(value: string, binding: TaxIdentityBinding, key = taxKeyring()[0]!) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key.key, iv); cipher.setAAD(aad(binding));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { keyId: key.keyId, envelope: [iv, encrypted, cipher.getAuthTag()].map((v) => v.toString("base64")).join(".") };
}
/** Internal cryptographic primitive: no API/DTO returns its plaintext. */
export function unsealTaxValue(envelope: string, keyId: string, binding: TaxIdentityBinding): string {
  const key = taxKeyring().find((k) => k.keyId === keyId);
  if (!key) throw new Error("tax_key_unavailable");
  const parts = envelope.split(".");
  if (parts.length !== 3) throw new Error("tax_envelope_invalid");
  const [iv, encrypted, tag] = parts.map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key.key, iv!); decipher.setAAD(aad(binding)); decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString("utf8");
}
export function taxIdentityFingerprint(idKind: string, identifier: string) {
  // Validate purpose separation even if called independently of sealTaxValue.
  taxKeyring(); const key = fingerprintKey();
  return { keyId: key.keyId, fingerprint: createHmac("sha256", key.key).update(`${idKind}:${identifier}`).digest("hex") };
}
