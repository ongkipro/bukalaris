import { describe, expect, it } from "vitest";
import { clientIpHeader, resolveClientIp } from "../src/platform/client-ip.ts";

const h = (headers: Record<string, string>) => (name: string) => headers[name];

describe("trusted client-IP header (D-23): exactly one header is believed, chosen by topology", () => {
  it("default: the last x-forwarded-for hop, else x-real-ip; a forged cf-connecting-ip is ignored", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9", "cf-connecting-ip": "1.2.3.4" }), {})).toBe("203.0.113.9");
    expect(resolveClientIp(h({ "x-real-ip": "198.51.100.4" }), {})).toBe("198.51.100.4");
    expect(resolveClientIp(h({ "cf-connecting-ip": "1.2.3.4" }), {})).toBeUndefined();
  });

  it("cf-connecting-ip mode: only that header counts; a client-supplied x-forwarded-for cannot choose the IP; absent or malformed gives no IP dimension", () => {
    const env = { CLIENT_IP_HEADER: "cf-connecting-ip" };
    expect(resolveClientIp(h({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6" }), env)).toBe("203.0.113.9");
    expect(resolveClientIp(h({ "x-forwarded-for": "6.6.6.6" }), env)).toBeUndefined();
    expect(resolveClientIp(h({ "cf-connecting-ip": "not an ip; drop table" }), env)).toBeUndefined();
    expect(resolveClientIp(h({ "cf-connecting-ip": "2001:db8::1" }), env)).toBe("2001:db8::1");
  });

  it("a typo in the setting fails loudly instead of silently trusting a different header", () => {
    expect(() => clientIpHeader({ CLIENT_IP_HEADER: "x-forwarded-fro" })).toThrow(/CLIENT_IP_HEADER/);
    expect(clientIpHeader({ CLIENT_IP_HEADER: " CF-Connecting-IP " })).toBe("cf-connecting-ip");
  });
});
