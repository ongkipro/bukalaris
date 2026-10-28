import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// TASKS T-65 slice 2 (explicitly requested repository-scan test): no tax rate, base fraction, bracket or deadline in source, seeds or
// defaults. Any numeric literal in the tax module other than 0, 1, 2 must be listed here with its reason. A new literal fails this test until
// a reviewer decides it is a unit, a bound or a protocol size and not a tax parameter.
const src = fileURLToPath(new URL("../src/", import.meta.url));
const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
const ALLOWED: Record<string, Record<string, string>> = {
  "tax/compute.ts": { "10_000": "bps scale: unit conversion", "63": "bigint column bound, 2^63-1", "4": "year digits of an ISO date", "10": "ISO date length", "256": "sha256 name" },
  "tax/seal.ts": { "12": "GCM iv bytes", "32": "AES-256 key bytes", "256": "algorithm name", "3": "envelope part count (iv.ciphertext.tag)", "9_": "key id character class" },
  "tax/identity.ts": { "15": "syntactic digit count of an identifier (UNVERIFIED rule, BILL-9 W1)", "16": "same", "4": "last-four mask" },
  "tax/payout.ts": { "4": "year digits of an ISO date" },
  "tax/settings.ts": { "500": "audit_log reason length cap" },
  "tax/reseal.ts": {},
  "tax/schema-tax.ts": { "10000": "bps scale bound in CHECKs", "31": "day-of-month bound in CHECKs", "256": "sha256 column name" },
};
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
// Decimal, leading-dot, exponent and hex forms all count (`.11`, `11e-2`, `1e3`, `0x0B`).
const literals = (text: string) => [...stripComments(text).matchAll(/(?<![\w$])(0[xX][0-9a-fA-F_]+n?|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?n?|\.\d+(?:[eE][+-]?\d+)?)(?![\w])/g)].map((m) => m[1]!).filter((l) => !["0", "1", "2", "0n", "1n", "2n"].includes(l));

describe("T-65 no numeric tax parameter literal in non-test tax source (BILL-9, ADR-0012 section 1)", () => {
  const files = walk(join(src, "tax")).filter((f) => f.endsWith(".ts"));
  it("scans every file of the tax module", () => {
    expect(files.map((f) => relative(src, f)).sort()).toEqual(Object.keys(ALLOWED).sort());
  });
  for (const file of files) {
    const rel = relative(src, file);
    it(`${rel} holds only the listed unit/bound/protocol literals`, () => {
      const found = new Set(literals(readFileSync(file, "utf8")));
      const unexpected = [...found].filter((l) => !(l in (ALLOWED[rel] ?? {})));
      expect(unexpected, `numeric literals not on the allow-list in ${rel}: a tax rate, fraction, bracket or day must come from a policy row`).toEqual([]);
    });
  }
  it("the scan itself catches a rate, a fraction, a bracket and a deadline (not vacuous)", () => {
    expect(literals("const rate = 0.11; const f = 5000; const b = 60_000_000n; const due = 10;")).toEqual(["0.11", "5000", "60_000_000n", "10"]);
    expect(literals("const a = .11; const b = 11e-2; const c = 0x0B; const d = 1e3;")).toEqual([".11", "11e-2", "0x0B", "1e3"]);
    expect(literals("// 0.5% in a comment\nconst ok = 1 + 2;")).toEqual([]);
    expect(literals("const id = `sha256-${x}` + v1")).toEqual([]);
  });
  it("the tax tables carry no column default for a rate, fraction, bracket, rounding, method, due day or date, and the seed names no policy row", () => {
    const sql = readFileSync(join(migrations, readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort().filter((f) => readFileSync(join(migrations, f), "utf8").includes('CREATE TABLE "tax_policy_version"')).at(-1)!), "utf8"); // the file that creates the table (later migrations only reference it)
    const policyTable = sql.slice(sql.indexOf('CREATE TABLE "tax_policy_version"'), sql.indexOf(");", sql.indexOf('CREATE TABLE "tax_policy_version"')));
    const defaults = [...policyTable.matchAll(/^\s*"(\w+)"[^\n]*DEFAULT ([^\n,]+)/gm)].map((m) => m[1]);
    expect(defaults.sort()).toEqual(["clawback_treatment", "status"]); // review treatment label and lifecycle state only
    expect(sql).not.toMatch(/INSERT INTO\s+(public\.)?"?tax_policy_version/i);
  });
});

// TASKS T-65 added assertion: the scan also covers checkout and order_financials code, so a VAT rate (for example the COD-fee VAT)
// cannot appear outside a policy lookup. Rule: a line that names tax/VAT/PPN must not carry a numeric literal other than 0, 1, 2.
describe("T-65 no VAT or sales-tax rate literal in checkout, order and payment code", () => {
  const roots = ["seller/commerce", "payments", "shipping"].map((d) => join(src, d));
  const files = roots.flatMap((r) => walk(r)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const taxLine = /vat|ppn|pajak|tax/i;
  const offending = (text: string) => stripComments(text).split("\n").filter((l) => taxLine.test(l) && literals(l).length > 0);
  it("finds no tax-named line with a numeric literal in checkout/order/payment/shipping source", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.flatMap((f) => offending(readFileSync(f, "utf8")).map((l) => `${relative(src, f)}: ${l.trim()}`))).toEqual([]);
  });
  it("the rule catches a hard-coded rate on a tax line (not vacuous)", () => {
    expect(offending("const codFeeVat = Math.floor(fee * 11 / 100);")).toHaveLength(1);
    expect(offending("const vatBps = policy.rateBps;")).toHaveLength(0);
  });
});
