import { createHmac, timingSafeEqual } from "node:crypto";

/** Pure Node primitive. Callers must resolve live authority; a MAC is not authentication. */
export type CsrfBinding = { surface: string; origin: string } & (
  | { kind: "session" | "pending-mfa"; id: string }
  | { kind: "cart"; storeId: number; id: string | null }
);

export function createCsrfToken(binding: CsrfBinding, secret: string): string {
  if (secret.length < 32) throw new Error("CSRF signing key is not configured");
  if (binding.id !== null && (!binding.id || binding.id.length > 4096)) throw new Error("Invalid CSRF binding");
  const payload = JSON.stringify(["bukalaris:csrf", 1, binding.kind, binding.surface, binding.origin, binding.kind === "cart" ? binding.storeId : null, binding.id]);
  return `v1.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function validCsrfToken(token: unknown, binding: CsrfBinding, secret: string): boolean {
  if (typeof token !== "string" || !/^v1\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(createCsrfToken(binding, secret)));
}

/** No Referer fallback, forwarded-host inference, or same-site sibling allowance. */
export function validCsrfOrigin(headers: Headers, origin: string): boolean {
  const site = headers.get("sec-fetch-site");
  return headers.get("origin") === origin && (site === null || ["same-origin", "same-site", "none"].includes(site));
}

/** Duplicate fields and non-FormData RPC arguments fail closed before invoking anything. */
export function csrfFormToken(data: unknown): string | undefined {
  if (!(data instanceof FormData)) return undefined;
  const values = data.getAll("_csrf");
  return values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
}
