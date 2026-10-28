import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { providerStatusLabel, shipmentTimeline } from "../src/shipping/fulfillment.ts";
import { whiteLabel } from "../src/shipping/copy.ts";

// Repo-wide copy guard ("Bukalaris Kirim", D-15/ADR-0007; the T-48 report listed it as DEFERRED). Sellers and buyers never read the shipping provider's
// brand or an internal tracking id (OPEN-F9, Q-17, D-15, ADR-0007 ...). The scan parses every source file with the TypeScript compiler and looks only at the
// strings a person can be shown: string and template literals, JSX text. Import specifiers, comments and identifiers (`fakeMengantar`) are not copy.
//
//   Scope A, web (apps/web/src): every surface a seller, buyer or visitor reads. NOT scanned (allow-list, each reason is real):
//     (operator)  the Owner console is staff-only and states the vendor and the gates by name on purpose (SA-07, SA-53);
//     api/ and every route.ts  machine endpoints: their strings are log operations and protocol text, never rendered.
//   Scope B, db package: the MESSAGE of every `new DomainError(code, message)` / `new MengantarError(code, message)` (rendered by the pages, mails and
//     `lastError`), plus ALL strings of the mail templates. Provider adapters, clients, fixtures, schema and the demo seed carry the vendor name as code
//     (URLs, header names, log operations): they are scanned for internal ids in messages only, never for the brand, see `BRAND_EXEMPT_MESSAGE_FILES`.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BRAND = /mengantar|autolaris/i;
const INTERNAL_IDS = [/\bOPEN-[A-Z]?\d+\b/, /\bQ-\d+\b/, /\bD-\d{2}\b/, /\bADR-\d+\b/, /\b(?:BILL|PR|UX|SF|SC|SA|IAM|DATA|ARCH|SEC|DOM|JOB|HTTP|PRIV|OBS)-\d+\b/, /\bT-\d{2,3}[a-z]?\b/, /master[- ]key/i, /\bfail[- ]closed\b/i];

const WEB_SKIP = [/\/\(operator\)\//, /\/api\//, /\/route\.ts$/, /\.test\.tsx?$/, /\/node_modules\//, /\/\.next\//];
/** Message-scan exemptions from the BRAND rule only: transport/adapter code whose messages are scrubbed by `whiteLabel` at display (internal ids are still refused). */
const BRAND_EXEMPT_MESSAGE_FILES = [/^packages\/db\/src\/shipping\/mengantar\//, /^packages\/db\/src\/payments\//];

function files(dir: string, accept: (p: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next") continue;
    if (statSync(p).isDirectory()) files(p, accept, out);
    else if (accept(p)) out.push(p);
  }
  return out;
}

type Found = { file: string; line: number; text: string };
const literals = (file: string, onlyDomainMessages: boolean) => scan(file, readFileSync(file, "utf8"), onlyDomainMessages);
function scan(file: string, text: string, onlyDomainMessages: boolean): Found[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Found[] = [];
  const add = (node: ts.Node, text: string) => text.trim() && out.push({ file: relative(ROOT, file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text });
  const visit = (node: ts.Node, inScope: boolean) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node) || ts.isLiteralTypeNode(node)) return;
    if (onlyDomainMessages && !inScope) {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["DomainError", "MengantarError"].includes(node.expression.text) && node.arguments?.[1]) visit(node.arguments[1], true);
      else ts.forEachChild(node, (c) => visit(c, false));
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text);
    else if (ts.isJsxText(node)) add(node, node.text);
    ts.forEachChild(node, (c) => visit(c, inScope));
  };
  visit(source, !onlyDomainMessages);
  return out;
}
const violations = (found: Found[], brand: (file: string) => boolean) =>
  found.filter((f) => (brand(f.file) && BRAND.test(f.text)) || INTERNAL_IDS.some((r) => r.test(f.text))).map((f) => `${f.file}:${f.line}: ${JSON.stringify(f.text.trim().slice(0, 120))}`);

describe("T-48 fix 4: seller and buyer copy never names the provider or an internal id", () => {
  it("web: no user-facing string of a seller, storefront, checkout, buyer or shared component names the provider brand or an internal id", () => {
    const web = files(join(ROOT, "apps/web/src"), (p) => /\.tsx?$/.test(p) && !WEB_SKIP.some((r) => r.test(p)));
    expect(web.length).toBeGreaterThan(100); // the walk really reached the surfaces
    expect(web.some((f) => f.includes("(seller)")) && web.some((f) => f.includes("(public-services)")) && web.some((f) => f.includes("(checkout)"))).toBe(true);
    expect(violations(web.flatMap((f) => literals(f, false)), () => true)).toEqual([]);
  });

  it("db: no DomainError or MengantarError message, and no mail template string, names the provider (outside the scrubbed adapters) or an internal id", () => {
    const src = files(join(ROOT, "packages/db/src"), (p) => p.endsWith(".ts"));
    const messages = src.flatMap((f) => literals(f, true));
    expect(messages.length).toBeGreaterThan(100);
    const mail = files(join(ROOT, "packages/db/src/ops/jobs"), (p) => p.endsWith("notify.ts")).flatMap((f) => literals(f, false));
    expect(mail.length).toBeGreaterThan(20);
    expect(violations([...messages, ...mail], (file) => !BRAND_EXEMPT_MESSAGE_FILES.some((r) => r.test(file)))).toEqual([]);
  });

  it("the guard itself works: it flags the vendor name and every internal id family, and ignores comments, identifiers, import specifiers and non-message strings", () => {
    const sample = [
      "// Mengantar OPEN-F9 only in a comment",
      'import x from "../mengantar/client.ts";',
      "const fakeMengantar = 1;",
      'const a = "Dikirim lewat Mengantar";',
      "const b = `Terkunci OPEN-F9`;",
      'const c = "Q-17 belum diputuskan";',
      'const d = "tanpa master-key";',
      'throw new DomainError("x", "Akun belum siap, lihat ADR-0007");',
      'throw new Error("OPEN-F9 internal");',
      'const e = new DomainError(`T-48 ${1}`, "Pesan biasa");',
    ].join("\n");
    expect(scan("sample.ts", sample, false).map((f) => f.text)).toEqual(["Dikirim lewat Mengantar", "Terkunci OPEN-F9", "Q-17 belum diputuskan", "tanpa master-key", "x", "Akun belum siap, lihat ADR-0007", "OPEN-F9 internal", "T-48 ", "Pesan biasa"]);
    expect(violations(scan("sample.ts", sample, false), () => true)).toHaveLength(7);
    expect(scan("sample.ts", sample, true).map((f) => f.text)).toEqual(["Akun belum siap, lihat ADR-0007", "Pesan biasa"]); // only DomainError messages, never the code argument or a plain Error
    expect(violations(scan("sample.ts", sample, true), () => true)).toHaveLength(1);
    expect(violations(scan("tpl.tsx", "export const A = () => <p>Dikirim lewat Mengantar</p>;", false), () => true)).toHaveLength(1); // JSX text
  });

  it("a raw provider status or timeline line never reaches a seller or a buyer: unknown status text is neutral, vendor names are scrubbed, known statuses are translated", () => {
    expect(providerStatusLabel("WEIRD NEW STATE")).toBe("Pembaruan terbaru dari kurir");
    expect(providerStatusLabel("Mengantar: kurir X gagal OPEN-F9")).toBe("Pembaruan terbaru dari kurir");
    expect(providerStatusLabel("PICKED UP")).toBe("Sudah diambil kurir");
    expect(providerStatusLabel(null)).toBeNull();
    const base = { createdAt: new Date(0), bookedAt: null, deliveredAt: null, status: "in_transit" as const };
    const lines = shipmentTimeline({ ...base, trackingHistory: [{ at: "28-10-2026 10:00", desc: "Diteruskan oleh Mengantar ke hub" }, { at: "28-10-2026 11:00", desc: "ON DELIVERY" }, { at: "28-10-2026 12:00", desc: "x".repeat(500) }] }).map((t) => t.text);
    expect(lines.join("|")).not.toMatch(/mengantar/i);
    expect(lines).toContain("Diteruskan oleh Bukalaris Kirim ke hub");
    expect(lines).toContain("Dalam pengantaran"); // a raw provider status line is translated
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(200);
    expect(whiteLabel("MengantarError: Mengantar: gagal")).toBe("gagal");
  });
});
