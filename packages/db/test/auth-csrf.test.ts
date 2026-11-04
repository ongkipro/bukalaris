import { describe, expect, it } from "vitest";
import { createCsrfToken, csrfFormToken, validCsrfOrigin, validCsrfToken, type CsrfBinding } from "../../../apps/web/src/lib/auth-csrf-token.mts";

// Public test-only material, never a deployment credential.
const secret = "test-only-csrf-key-0123456789abcdef0123456789";
const session: CsrfBinding = { kind: "session", surface: "seller", origin: "https://app.example.test", id: "session-one" };

describe("session/capability-bound CSRF MAC (T-82)", () => {
  it("accepts the current binding without exposing its identifier", () => {
    const token = createCsrfToken(session, secret);
    expect(validCsrfToken(token, session, secret)).toBe(true);
    expect(token).not.toContain(session.id);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
  });

  it.each([undefined, null, "", "forged", "v1." + "A".repeat(43), "v1." + "A".repeat(44), "v1." + "A".repeat(1_000_000), {}, new Blob(["not a string"])])("rejects missing, forged and malformed input %#", (input) => {
    expect(validCsrfToken(input, session, secret)).toBe(false);
  });

  it("rejects a previous session of the same user (binding must not be user-only)", () => {
    const token = createCsrfToken(session, secret);
    expect(validCsrfToken(token, { ...session, id: "session-two-for-the-same-user" }, secret)).toBe(false);
  });

  it.each([
    { ...session, surface: "owner" },
    { ...session, origin: "https://owner.example.test" },
    { ...session, origin: "http://app.example.test" },
    { ...session, origin: "https://app.example.test:8443" },
    { ...session, kind: "pending-mfa" as const },
    { ...session, kind: "cart" as const, storeId: 1 },
  ])("separates surface, complete origin and authority class %#", (binding) => {
    expect(validCsrfToken(createCsrfToken(session, secret), binding, secret)).toBe(false);
  });

  it("separates cart replacement, store context and initial-cart authority", () => {
    const cart: CsrfBinding = { kind: "cart", surface: "store", origin: "https://toko.example.test", storeId: 1, id: "cart-one" };
    const token = createCsrfToken(cart, secret);
    expect(validCsrfToken(token, cart, secret)).toBe(true);
    for (const binding of [{ ...cart, id: "cart-two" }, { ...cart, storeId: 2 }, { ...cart, id: null }]) expect(validCsrfToken(token, binding, secret)).toBe(false);
    expect(validCsrfToken(createCsrfToken({ ...cart, id: null }, secret), cart, secret)).toBe(false);
  });

  it("rejects a changed key and fails closed on absent/short configuration", () => {
    expect(validCsrfToken(createCsrfToken(session, secret), session, secret + "changed")).toBe(false);
    expect(() => createCsrfToken(session, "")).toThrow("CSRF signing key is not configured");
    expect(() => createCsrfToken({ ...session, id: "" }, secret)).toThrow("Invalid CSRF binding");
    expect(() => createCsrfToken({ ...session, id: "x".repeat(4097) }, secret)).toThrow("Invalid CSRF binding");
  });
});

describe("CSRF request transport (T-82)", () => {
  it("requires exactly one string FormData field and never calls an RPC-shaped object's method", () => {
    const data = new FormData();
    expect(csrfFormToken(data)).toBeUndefined();
    data.set("_csrf", "a-token");
    expect(csrfFormToken(data)).toBe("a-token");
    data.append("_csrf", "another-token");
    expect(csrfFormToken(data)).toBeUndefined();
    data.set("_csrf", new Blob(["a-token"]));
    expect(csrfFormToken(data)).toBeUndefined();
    expect(csrfFormToken({ getAll() { throw new Error("must not invoke untrusted functions"); } })).toBeUndefined();
  });

  it("requires the exact Origin even with a valid same-site or absent Fetch-Metadata header", () => {
    expect(validCsrfOrigin(new Headers({ origin: session.origin }), session.origin)).toBe(true);
    expect(validCsrfOrigin(new Headers({ origin: session.origin, "sec-fetch-site": "same-origin" }), session.origin)).toBe(true);
    expect(validCsrfOrigin(new Headers({ origin: session.origin, "sec-fetch-site": "same-site" }), session.origin)).toBe(true);
    expect(validCsrfOrigin(new Headers({ referer: session.origin }), session.origin)).toBe(false);
    for (const origin of ["null", "http://app.example.test", "https://shop.example.test", session.origin + "/", session.origin + ":8443"]) expect(validCsrfOrigin(new Headers({ origin }), session.origin)).toBe(false);
    for (const site of ["cross-site", "CROSS-SITE", "", "unknown", "same-origin, cross-site"]) expect(validCsrfOrigin(new Headers({ origin: session.origin, "sec-fetch-site": site }), session.origin)).toBe(false);
  });

  it("rejects combined/duplicate header values rather than choosing one token", () => {
    const token = createCsrfToken(session, secret);
    const headers = new Headers();
    headers.append("x-bl-csrf", token);
    headers.append("x-bl-csrf", token);
    expect(validCsrfToken(headers.get("x-bl-csrf"), session, secret)).toBe(false);
  });
});
