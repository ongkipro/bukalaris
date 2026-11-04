import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authRateLimitStorage } from "../src/platform/rate-limit.ts";
import { admin, db } from "./helpers.ts";

// T-83 RL-LOGIN: Better Auth's rate-limit storage on the shared Postgres counter. Two storage objects stand for two
// application instances (or one instance before and after a restart): they share nothing in memory, only the table.
const SIGN_IN = { window: 10, max: 3 }; // Better Auth's own sign-in rule, unchanged
const RESET = { window: 60, max: 3 }; // Better Auth's own request-password-reset rule, unchanged

/** Start right after a fixed-window boundary so a check cannot straddle two windows (review d6365bea P2). */
const freshWindow = async (windowSec: number) => {
  const ms = windowSec * 1000;
  const left = ms - (Date.now() % ms);
  if (left < 3000) await new Promise((resolve) => setTimeout(resolve, left + 100));
};

const rows = async () => (await admin.execute(sql`select key, count from rate_limit where key like 'auth:%' order by key`)) as unknown as { key: string; count: number }[];

describe("auth rate limits on the shared counter (T-83)", () => {
  it("two independent instances share one sign-in budget per surface and client key", async () => {
    const a = authRateLimitStorage(() => db, "seller");
    const b = authRateLimitStorage(() => db, "seller");
    const key = "203.0.113.7|/sign-in/email";
    await freshWindow(SIGN_IN.window);
    expect((await a.consume(key, SIGN_IN)).allowed).toBe(true);
    expect((await b.consume(key, SIGN_IN)).allowed).toBe(true);
    expect((await a.consume(key, SIGN_IN)).allowed).toBe(true);
    const refused = await b.consume(key, SIGN_IN);
    expect(refused.allowed, "the fourth request across both instances is refused").toBe(false);
    expect(refused.retryAfter! >= 1 && refused.retryAfter! <= SIGN_IN.window).toBe(true);
    // A third, freshly created instance (a restart) still sees the spent budget.
    expect((await authRateLimitStorage(() => db, "seller").consume(key, SIGN_IN)).allowed).toBe(false);
  });

  it("budgets are separate per surface, per client and per path; the reset rule keeps its own bound", async () => {
    const seller = authRateLimitStorage(() => db, "seller");
    const owner = authRateLimitStorage(() => db, "owner");
    await freshWindow(SIGN_IN.window);
    for (let i = 0; i < 3; i++) await seller.consume("198.51.100.1|/sign-in/email", SIGN_IN);
    expect((await seller.consume("198.51.100.1|/sign-in/email", SIGN_IN)).allowed).toBe(false);
    expect((await owner.consume("198.51.100.1|/sign-in/email", SIGN_IN)).allowed, "another surface").toBe(true);
    expect((await seller.consume("198.51.100.2|/sign-in/email", SIGN_IN)).allowed, "another client").toBe(true);
    for (let i = 0; i < 3; i++) expect((await seller.consume("198.51.100.1|/request-password-reset", RESET)).allowed).toBe(true);
    expect((await seller.consume("198.51.100.1|/request-password-reset", RESET)).allowed, "reset bound 3").toBe(false);
  });

  it("stores no raw client address: keys are surface-scoped digests", async () => {
    await authRateLimitStorage(() => db, "buyer").consume("192.0.2.55|/sign-in/email", SIGN_IN);
    const stored = await rows();
    expect(stored.length).toBe(1);
    expect(/^auth:buyer:[0-9a-f]{64}$/.test(stored[0]!.key)).toBe(true);
    expect(stored.some((r) => r.key.includes("192.0.2.55"))).toBe(false);
  });

  it("a failing counter store refuses with a bounded retry, never allows", async () => {
    const errors: unknown[] = [];
    const broken = authRateLimitStorage(() => { throw new Error("counter store down"); }, "seller", (e) => errors.push(e));
    const result = await broken.consume("203.0.113.8|/sign-in/email", SIGN_IN);
    expect(result).toEqual({ allowed: false, retryAfter: SIGN_IN.window });
    expect(errors.length).toBe(1);
  });

  it("concurrent requests from many instances cannot exceed the bound", async () => {
    const key = "203.0.113.9|/sign-in/email";
    await freshWindow(SIGN_IN.window);
    const results = await Promise.all(Array.from({ length: 12 }, () => authRateLimitStorage(() => db, "seller").consume(key, SIGN_IN)));
    expect(results.filter((r) => r.allowed).length).toBe(SIGN_IN.max);
  });
});
