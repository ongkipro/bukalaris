import { describe, expect, it } from "vitest";
import { calculateOrderFinance, withAffiliateCommission } from "../src/ledger/finance.ts";
import { calculateAffiliateCommission } from "../src/affiliate/commission.ts";
import { addReferralClick, classifyClickRequest, normalizeAffiliateCode, parseReferralCookie } from "../src/affiliate/code.ts";
import { effectiveOfferRate, type OfferRateFacts } from "../src/affiliate/catalog.ts";
import { affiliateFraudFlags, type AffiliateRiskRow } from "../src/affiliate/risk.ts";
import { CLICK_COOKIE_MAX_IDS } from "../src/affiliate/settings.ts";
import { samePhoneIdentity } from "../src/buyer/normalize.ts";
import { dispatchHostPath } from "../src/platform/host.ts";

// T-52 focused policy tests (pure, no database): the single-floor commission arithmetic, the typed-code and cookie rules, the Sec-Fetch classification of SEC-20,
// the effective-rate rule and the fraud flags. The database proves the same rules again in t52-schema / t52-checkout (parity with the SQL port).

describe("T-52 commission: one final floor over the whole sum, integer IDR and basis points (BILL-8, ADR-0009 section 5)", () => {
  const c = (...lines: [number, number][]) => calculateAffiliateCommission(lines.map(([commissionBase, rateBps]) => ({ commissionBase, rateBps })));

  it("floors ONCE: two half-rupiah lines earn 105, not the 104 that flooring each line would give (Tokophi 'floor once' fixture)", () => {
    expect(c([105, 5_000], [105, 5_000])).toBe(105);
    expect(Math.floor(105 * 0.5) + Math.floor(105 * 0.5)).toBe(104); // what per-line flooring would have paid: the named failure
  });

  it("mixed rates, discounts and bases: every product keeps its own rate, nothing is averaged", () => {
    expect(c([90_000, 1_000], [45_000, 2_000], [10_001, 333])).toBe(Math.floor((90_000 * 1_000 + 45_000 * 2_000 + 10_001 * 333) / 10_000));
    expect(c([100_000, 1_000], [100_000, 1_500])).toBe(25_000);
  });

  it("a zero base, a zero rate and a line outside the programme (rate 0) earn exactly zero", () => {
    expect(c([0, 2_000])).toBe(0);
    expect(c([100_000, 0])).toBe(0);
    expect(c([100_000, 0], [50_000, 1_000])).toBe(5_000);
    expect(c()).toBe(0);
  });

  it("rejects what cannot be a rate or an amount, with no silent clamp", () => {
    expect(() => c([100, 10_001])).toThrow();
    expect(() => c([100, -1])).toThrow();
    expect(() => c([-1, 100])).toThrow();
    expect(() => c([1.5, 100])).toThrow();
    expect(() => calculateAffiliateCommission([{ commissionBase: 100, rateBps: 12.5 }])).toThrow();
    expect(() => c([Number.MAX_SAFE_INTEGER, 10_000], [Number.MAX_SAFE_INTEGER, 10_000])).toThrow(); // more than a safe integer of rupiah
  });

  it("is exact where floating point is not: a base near 2^53 at 1 bp", () => {
    expect(c([9_007_199_254_740_991, 1])).toBe(900_719_925_474);
  });

  it("never exceeds the base at the largest allowed rate and never goes below zero (corpus)", () => {
    let seed = 52;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let i = 0; i < 400; i++) {
      const lines: [number, number][] = Array.from({ length: 1 + (next() % 5) }, () => [next() % 5_000_000, next() % 10_001]);
      const got = c(...lines);
      const exact = lines.reduce((s, [b, r]) => s + BigInt(b) * BigInt(r), BigInt(0));
      expect(BigInt(got)).toBe(exact / BigInt(10_000));
      expect(got).toBeGreaterThanOrEqual(0);
      expect(got).toBeLessThanOrEqual(lines.reduce((s, [b]) => s + b, 0));
    }
  });
});

describe("T-52 the commission reads the ONE canonical allocation of BILL-4 and never re-allocates (T-46 reuse)", () => {
  const lines = [
    { lineNo: 1, unitPrice: 33_333, quantity: 3 },
    { lineNo: 2, unitPrice: 12_501, quantity: 1 },
    { lineNo: 3, unitPrice: 70_000, quantity: 2 },
  ];
  it("withAffiliateCommission equals the engine's own `affiliateCommission` input, for discounts, shipping discount and added or included tax", () => {
    for (const input of [
      { lines, checkoutShipping: 24_000 },
      { lines, goodsDiscount: 17_777, checkoutShipping: 24_000, shippingDiscount: 9_000 },
      { lines, goodsDiscounts: [{ amount: 5_000, lineNos: [1, 3] }, { amount: 999, lineNos: [2] }], priceMode: "tax_included" as const, salesTaxRateBps: 1_100, checkoutShipping: 0 },
      { lines, goodsDiscount: 3, priceMode: "tax_added" as const, salesTaxRateBps: 500, checkoutShipping: 10_000, codFee: 4_000 },
    ]) {
      const base = calculateOrderFinance(input);
      const rates = base.lines.map((_, i) => [0, 1_000, 1_750][i]!);
      const commission = calculateAffiliateCommission(base.lines.map((l, i) => ({ commissionBase: l.commissionBase, rateBps: rates[i]! })));
      expect(withAffiliateCommission(base, commission)).toEqual(calculateOrderFinance({ ...input, affiliateCommission: commission }));
      expect(withAffiliateCommission(base, commission).payable).toBe(base.payable); // the buyer's total never moves
      expect(withAffiliateCommission(base, commission).saleAmount).toBe(base.saleAmount - commission);
    }
  });

  it("the base excludes shipping, COD fee and added tax: they are not in `commissionBase`", () => {
    const f = calculateOrderFinance({ lines: [{ lineNo: 1, unitPrice: 100_000, quantity: 1 }], checkoutShipping: 50_000, codFee: 7_000, priceMode: "tax_added", salesTaxRateBps: 1_100 });
    expect(f.lines[0]!.commissionBase).toBe(100_000);
    expect(calculateAffiliateCommission([{ commissionBase: f.lines[0]!.commissionBase, rateBps: 1_000 }])).toBe(10_000);
  });

  it("refuses a commission above the seller's goods side", () => {
    const f = calculateOrderFinance({ lines: [{ lineNo: 1, unitPrice: 1_000, quantity: 1 }], checkoutShipping: 0 });
    expect(() => withAffiliateCommission(f, 1_001)).toThrow();
    expect(withAffiliateCommission(f, 1_000).saleAmount).toBe(0);
  });
});

describe("T-52 typed code normalisation: ASCII only, separators dropped, 4 to 24 letters or digits", () => {
  it.each([
    ["hemat10", "HEMAT10"],
    [" Hemat-10 ", "HEMAT10"],
    ["he mat_10", "HEMAT10"],
    ["ABCD", "ABCD"],
    ["A".repeat(24), "A".repeat(24)],
  ])("%j -> %j", (raw, want) => expect(normalizeAffiliateCode(raw)).toBe(want));
  it.each([
    "", "   ", "abc", "A".repeat(25), "kode!", "kode.satu", "kode/1", "kode\n1", "kodé123", "ＫＯＤＥ１２３", "\u212Aode123", "ıstanbul1", "ﬁle1234", "<script>", "'; drop table", null, undefined, 12345, {},
  ])("%j is not a code (no fold into someone else's code)", (raw) => expect(normalizeAffiliateCode(raw)).toBeNull());
});

describe("T-52 the continuity cookie carries opaque ids only", () => {
  const id = (n: number) => `c${n.toString(16).padStart(32, "0")}`;
  it("keeps well-formed ids, newest first, no duplicates, capped", () => {
    expect(parseReferralCookie(`${id(1)}.${id(2)}.${id(1)}`)).toEqual([id(1), id(2)]);
    const many = Array.from({ length: 12 }, (_, i) => id(i + 1)).join(".");
    expect(parseReferralCookie(many)).toHaveLength(CLICK_COOKIE_MAX_IDS);
    expect(addReferralClick(`${id(1)}.${id(2)}`, id(3))).toBe(`${id(3)}.${id(1)}.${id(2)}`);
    expect(addReferralClick(`${id(1)}.${id(2)}`, id(2))).toBe(`${id(2)}.${id(1)}`);
    expect(addReferralClick(many, id(99)).split(".")).toHaveLength(CLICK_COOKIE_MAX_IDS);
  });
  it("drops everything that is not an id: edited, truncated, upper-case, foreign, oversized values", () => {
    expect(parseReferralCookie(undefined)).toEqual([]);
    expect(parseReferralCookie("")).toEqual([]);
    expect(parseReferralCookie(`${id(1).slice(0, 20)}`)).toEqual([]);
    expect(parseReferralCookie(id(1).toUpperCase())).toEqual([]);
    expect(parseReferralCookie(`x${id(1)}`)).toEqual([]);
    expect(parseReferralCookie(`${id(1)};admin=1`)).toEqual([]);
    expect(parseReferralCookie(`${id(1)}.${"z".repeat(600)}`)).toEqual([]);
    expect(parseReferralCookie(`${id(1)}.not-an-id.${id(2)}`)).toEqual([id(1), id(2)]);
  });
});

describe("T-52 SEC-20: a click only for a top-level navigation (cookie stuffing)", () => {
  const req = (method: string, h: Record<string, string>) => classifyClickRequest({ method, headers: { get: (n: string) => h[n.toLowerCase()] ?? null } });
  const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  it("captures exactly a GET navigation to a document", () => {
    expect(req("GET", nav)).toBe("capture");
    expect(req("get", { ...nav, "sec-fetch-site": "cross-site" })).toBe("capture"); // a link from another site is the normal case
    expect(req("GET", { ...nav, "sec-fetch-site": "none" })).toBe("capture"); // typed or bookmarked
  });
  it.each([
    ["an <img>", { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }],
    ["a <script>", { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" }],
    ["a hidden <iframe>", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }],
    ["an <embed>", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "embed" }],
    ["fetch()", { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }],
    ["a prefetch", { ...nav, "sec-purpose": "prefetch" }],
    ["a prerender", { ...nav, "sec-purpose": "prefetch;prerender" }],
    ["a legacy Purpose: prefetch", { ...nav, purpose: "prefetch" }],
    ["no Fetch Metadata at all (curl, an old client)", {}],
    ["only the mode", { "sec-fetch-mode": "navigate" }],
    ["only the dest", { "sec-fetch-dest": "document" }],
    ["a same-origin navigate to a frame", { "sec-fetch-mode": "nested-navigate", "sec-fetch-dest": "frame" }],
  ])("%s captures nothing", (_label, headers) => expect(req("GET", headers as Record<string, string>)).toBe("non_navigation"));
  it("HEAD, POST and every other method capture nothing, even with perfect navigation headers", () => {
    for (const m of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) expect(req(m, nav)).toBe("non_navigation");
  });
});

describe("T-52 the effective offer rate: one rule, zero when anything makes the offer ineligible", () => {
  const ok: OfferRateFacts = { offerStatus: "active", participation: "open", productStatus: "active", storeStatus: "active", offerRateBps: null, defaultRateBps: 1_000, minRateBps: 100, maxRateBps: 2_000 };
  it("override beats the store default; the default applies without one", () => {
    expect(effectiveOfferRate(ok)).toBe(1_000);
    expect(effectiveOfferRate({ ...ok, offerRateBps: 1_500 })).toBe(1_500);
    expect(effectiveOfferRate({ ...ok, defaultRateBps: null, offerRateBps: 700 })).toBe(700);
  });
  it.each([
    ["a paused offer", { offerStatus: "paused" }],
    ["a withdrawn offer", { offerStatus: "withdrawn" }],
    ["a closed store", { participation: "closed" }],
    ["no store policy at all", { participation: null }],
    ["a draft product", { productStatus: "draft" }],
    ["an archived product", { productStatus: "archived" }],
    ["a suspended store", { storeStatus: "suspended" }],
    ["no rate anywhere", { defaultRateBps: null, offerRateBps: null }],
    ["a rate under the programme minimum", { offerRateBps: 99 }],
    ["a rate over the programme maximum", { offerRateBps: 2_001 }],
    ["a default over a lowered maximum", { maxRateBps: 900 }],
  ])("%s earns 0", (_label, patch) => expect(effectiveOfferRate({ ...ok, ...patch })).toBe(0));
});

describe("T-52 canonical-phone self-referral (T-57 contract)", () => {
  it("every spelling of one number is the same identity; unusable input never matches", () => {
    for (const spelling of ["081234567890", "+6281234567890", "6281234567890", "0062 812-3456-7890", "(0812) 3456 7890", "+62 0812 3456 7890"]) expect(samePhoneIdentity("081234567890", spelling)).toBe(true);
    expect(samePhoneIdentity("081234567890", "081234567891")).toBe(false);
    expect(samePhoneIdentity("081234567890", "abc")).toBe(false);
    expect(samePhoneIdentity("abc", "abc")).toBe(false);
    expect(samePhoneIdentity("021 5551234", "021 5551234")).toBe(false); // a landline has no identity key
  });
});

describe("T-52 SA-18 phase-1 fraud flags from the counters (thresholds are OPEN placeholders; callers may pass their own)", () => {
  const row = (over: Partial<AffiliateRiskRow>): AffiliateRiskRow => ({ affiliateId: 1, displayName: "A", status: "active", clicksCaptured: 0, attributedOrders: 0, voidedOrders: 0, selfReferralSuppressed: 0, clickRefusedRate: 0, clickNonNavigation: 0, clicksPerOrder: null, voidedShare: null, ...over });
  const t = { selfReferralSuppressed: 3, clickRefusedRate: 20, clicksPerOrder: 200, voidedShare: 0.5, minOrdersForShares: 5 } as const;
  it("raises exactly the rules whose counter reaches its threshold", () => {
    expect(affiliateFraudFlags([row({})], t)).toEqual([]);
    expect(affiliateFraudFlags([row({ selfReferralSuppressed: 3 })], t).map((f) => f.rule)).toEqual(["self_referral"]);
    expect(affiliateFraudFlags([row({ selfReferralSuppressed: 2 })], t)).toEqual([]);
    expect(affiliateFraudFlags([row({ clickRefusedRate: 20 })], t).map((f) => f.rule)).toEqual(["click_flood"]);
    expect(affiliateFraudFlags([row({ clicksCaptured: 200 })], t).map((f) => f.rule)).toEqual(["clicks_without_orders"]);
    expect(affiliateFraudFlags([row({ clicksCaptured: 400, attributedOrders: 2, clicksPerOrder: 200 })], t).map((f) => f.rule)).toEqual(["clicks_without_orders"]);
    expect(affiliateFraudFlags([row({ clicksCaptured: 100, attributedOrders: 2, clicksPerOrder: 50 })], t)).toEqual([]);
  });
  it("a voided share needs enough orders to mean anything", () => {
    expect(affiliateFraudFlags([row({ attributedOrders: 4, voidedOrders: 4, voidedShare: 1 })], t)).toEqual([]);
    expect(affiliateFraudFlags([row({ attributedOrders: 6, voidedOrders: 3, voidedShare: 0.5 })], t).map((f) => f.rule)).toEqual(["voided_share"]);
  });
});

describe("T-52 HTTP-27 is dispatched on the apex host only, GET only (DOM-5)", () => {
  const at = (host: string, method: string, pathname = "/r/abcdefghijklmnop") => dispatchHostPath({ host, rootDomain: "bukalaris.com", pathname, method, proto: "https" });
  it("the apex passes a GET; every other method, and every other surface, never reaches the click route", () => {
    expect(at("bukalaris.com", "GET")).toMatchObject({ action: "pass", surface: "apex" });
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect(at("bukalaris.com", method), method).toMatchObject({ action: "not_found" });
    for (const host of ["owner.bukalaris.com", "app.bukalaris.com", "checkout.bukalaris.com", "affiliate.bukalaris.com", "buyer.bukalaris.com", "logs.bukalaris.com", "toko-a.bukalaris.com", "unknown.example.org"]) {
      expect(at(host, "GET"), host).toMatchObject({ action: "not_found" });
    }
  });
  it("local path mode (one host, no subdomains) serves it for development and Playwright", () => {
    expect(dispatchHostPath({ host: "localhost:3000", rootDomain: "localhost", pathname: "/r/abcdefghijklmnop", method: "GET", proto: "http" })).toMatchObject({ action: "pass", surface: "local_path" });
  });
});
