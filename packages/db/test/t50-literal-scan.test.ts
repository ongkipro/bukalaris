import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// TASKS T-50 / D-17 (explicitly requested repository-scan test): no VAT/PPN rate, base or percentage in the billing context: the rate is always the
// effective-dated `vat_output` policy value of T-65. Every numeric literal other than 0, 1, 2 in `packages/db/src/billing` must be listed here
// with its reason (a unit, a bound or a protocol size, never a tax parameter), and a line that names tax, VAT or PPN carries none at all except the
// four digits of a year. A new literal fails this test until a reviewer decides what it is.
const dir = fileURLToPath(new URL("../src/billing/", import.meta.url));
const ALLOWED: Record<string, Record<string, string>> = {
  "access.ts": {},
  "attempts.ts": { "12": "random bytes of a reff_id (96 bits)", "29": "digits of the provider reff_id (limit 30)", "5": "attempt allocation tries", "0800000000": "the placeholder phone the T-49 profile already uses" },
  "callback.ts": {},
  "console.ts": { "5": "minimum reason length", "500": "reason length cap", "50": "overview page size", "200": "page size cap and evidence length cap", "1200": "period index bound (100 years)", "8": "minimum request key length", "64": "request key length cap", "9_.": "request key character class (regex)", "100_000_000": "price upper bound of the form" },
  "cycle.ts": { "200": "error text cap", "10": "ISO date length (slice of an instant)" },
  "dunning.ts": {},
  "invoices.ts": { "36": "base-36 clock in the reference", "9": "reference clock width", "3": "reference entropy width", "5": "reference tries", "100": "default list size", "200": "list size cap", "8": "uuid segment length in the id check", "4": "uuid segment length in the id check", "12": "uuid last segment length in the id check" },
  "jobs.ts": {},
  "period.ts": { "7": "Asia/Jakarta is UTC+7 (no DST)", "3_600_000": "ms per hour", "86_400_000": "ms per day", "10": "ISO date length", "00": "midnight in a date literal", "4": "year digits", "3": "ISO date part width", "12": "months per year" },
  "plan.ts": {},
  "schema-billing.ts": { "9007199254740991": "Number.MAX_SAFE_INTEGER bound of integer IDR", "60": "bound of trial and grace days (TRIAL_DAYS_MAX)", "9_": "reference character class (regex)", "31": "regex width", "9": "reference width", "3": "reference width", "10000": "bps scale bound of a rate snapshot column", "30": "provider reff_id digit limit", "64": "sha256 hex width", "40": "event kind length cap" },
  "settings.ts": { "3": "days of the named invoice lead", "86_400_000": "ms per day", "300_000": "named replace margin", "50": "named callback cap", "500": "named cycle batch size", "60": "bound of trial and grace days" },
  "state.ts": {},
  "vat.ts": { "4": "year digits of an ISO date" },
};
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const literals = (text: string) => [...stripComments(text).matchAll(/(?<![\w$])(0[xX][0-9a-fA-F_]+n?|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?n?|\.\d+(?:[eE][+-]?\d+)?)(?![\w])/g)].map((m) => m[1]!).filter((l) => !["0", "1", "2", "0n", "1n", "2n"].includes(l));
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
const taxLine = /vat|ppn|pajak|\btax/i;
const offending = (text: string) => stripComments(text).split("\n").filter((l) => taxLine.test(l) && literals(l.replace(/slice\(0, 4\)/g, "")).length > 0);

describe("T-50 no VAT or PPN rate literal in the billing context (D-17, BILL-7)", () => {
  it("scans every file of the billing module (a new file needs its allow-list entry)", () => {
    expect(files.sort()).toEqual(Object.keys(ALLOWED).sort());
  });
  for (const file of files) {
    it(`${file} holds only the listed unit/bound/protocol literals and no tax-named line carries a number`, () => {
      const text = readFileSync(join(dir, file), "utf8");
      const unexpected = [...new Set(literals(text))].filter((l) => !(l in (ALLOWED[file] ?? {})));
      expect(unexpected, `numeric literals not on the allow-list in ${file}: a VAT rate or base must come from a policy row`).toEqual([]);
      // The schema file declares column bounds and CHECKs on tax-named columns (its bounds are the allow-list above); the rule for code is no number on a tax line.
      if (file !== "schema-billing.ts") expect(offending(text).map((l) => l.trim())).toEqual([]);
    });
  }
  it("the scan catches a hard-coded rate, percent and base on a tax line (not vacuous)", () => {
    expect(literals("const ppn = Math.floor(dpp * 11 / 100);")).toEqual(["11", "100"]);
    expect(offending("const ppnIdr = Math.round(dppIdr * 0.11);")).toHaveLength(1);
    expect(offending("const vatBps = 1100;")).toHaveLength(1);
    expect(offending("const ppnIdr = policy.rateBps;")).toHaveLength(0);
  });
  it("the migration seeds a plan with PPN off and names no vat_output policy or rate, and the plan table has no rate column", () => {
    const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const file = readdirSync(migrations).filter((f) => f.endsWith(".sql") && readFileSync(join(migrations, f), "utf8").includes('CREATE TABLE "subscription_plan"')).at(-1)!;
    const sql = readFileSync(join(migrations, file), "utf8");
    const table = sql.slice(sql.indexOf('CREATE TABLE "subscription_plan"'), sql.indexOf(");", sql.indexOf('CREATE TABLE "subscription_plan"')));
    expect(table).not.toMatch(/^\t"\w*(?:rate|bps|percent)\w*"/im); // a column named for a rate
    expect(sql).toMatch(/INSERT INTO "subscription_plan"[\s\S]*?175000, 3, 3, false/); // the owner-decided plan: Rp175.000, 3 + 3 days, PPN off
    expect(sql).not.toMatch(/INSERT INTO\s+(public\.)?"?tax_policy_version/i);
  });
});
