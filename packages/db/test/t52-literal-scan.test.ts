import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// T-52 / D-22 item 3 (explicit repository-scan test, same method as t50-literal-scan): the attribution window, the hold, the rate bounds and every other figure are NAMED settings
// (affiliate/settings.ts, seeded into `affiliate_policy`), never literals in business code. No database: runs in milliseconds.
describe("T-52 the named settings are never literals in logic (D-22 item 3)", () => {
  const dir = fileURLToPath(new URL("../src/affiliate/", import.meta.url));
  // Numeric literals other than 0, 1 and 2 are listed with their reason. A new one fails until a reviewer decides what it is; a window, hold, rate bound or fee must be a named setting.
  const ALLOWED: Record<string, Record<string, string>> = {
    "accounts.ts": { "80": "display name length cap", "128": "user id length cap", "40": "phone text length cap", "12": "random bytes of a link token (96 bits, 16 base64url characters)" },
    "catalog.ts": { "100": "page size ceiling" },
    "click.ts": { "32": "hex characters of the hashed link key (128 bits)" },
    "code.ts": { "64": "typed code raw length cap", "24": "normalised code length (database check)", "32": "click id hex width (database check)", "16": "link token minimum length", "512": "cookie value length cap" },
    "commission.ts": { "10_000": "basis points per whole (a unit)" },
    "jobs.ts": {},
    "referral.ts": {},
    "risk.ts": { "30": "default report window in days", "366": "report window ceiling" },
    "schema-affiliate.ts": { "10000": "bps scale bound of a rate column", "80": "name length", "500": "reason length", "300": "reason length", "365": "attribution window bound (days)", "90": "hold bound (days)", "16": "token minimum length", "64": "token maximum length", "4": "code minimum length", "24": "code maximum length" },
    "seller.ts": { "10_000": "bps scale bound of a rate", "300": "reason length cap" },
    "settings.ts": { "7": "NAMED attribution window placeholder", "3": "NAMED hold (owner decided) and a risk placeholder", "100": "NAMED minimum rate placeholder", "2000": "NAMED maximum rate placeholder", "5": "NAMED cookie id cap", "120": "RL-CLICK per IP", "600": "RL-CLICK per link and window seconds", "10": "RL-CODE and window seconds", "30": "catalog page size", "200": "projection batch and a risk placeholder", "20": "risk placeholder", "0.5": "risk placeholder" },
  };
  // Comments, string and template literals and regular-expression literals are not logic: their digits are protocol (error codes, character classes), not settings.
  const strip = (t: string) =>
    t
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
      .replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, '""')
      .replace(/`(?:\\.|[^`\\])*`/g, "``")
      .replace(/(?<=[=(,:?!&|]\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[a-z]*/g, "/re/");
  const literals = (t: string) => [...strip(t).matchAll(/(?<![\w$])(\d[\d_]*(?:\.\d+)?)(?![\w])/g)].map((m) => m[1]!).filter((l) => !["0", "1", "2"].includes(l));
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  it("every file of the affiliate context is on the list", () => expect(files.sort()).toEqual(Object.keys(ALLOWED).sort()));
  for (const f of files) {
    it(`${f} carries only its listed unit, bound and protocol literals`, () => {
      const unexpected = [...new Set(literals(readFileSync(join(dir, f), "utf8")))].filter((l) => !(l in ALLOWED[f]!));
      expect(unexpected, `numeric literals not on the list in ${f}: a window, hold, rate bound or fee must come from settings.ts or the policy row`).toEqual([]);
    });
  }
  it("the scan catches a hard-coded window, hold and fee (not vacuous)", () => {
    expect(literals("const windowDays = 30; const holdDays = 14; const fee = commission * 15 / 100;")).toEqual(["30", "14", "15", "100"]);
  });
  it("only settings.ts declares the window, hold and rate-bound defaults", () => {
    for (const f of files.filter((x) => x !== "settings.ts" && x !== "schema-affiliate.ts")) expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/windowDays\s*[:=]\s*\d|holdDays\s*[:=]\s*\d|minRateBps\s*[:=]\s*\d|maxRateBps\s*[:=]\s*\d/);
  });
});

