import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONSOLE_ROUTES, consoleNavigation, resolveConsolePath } from "../src/ops/console-routes.ts";

// T-62 slice 1: "A Vitest route test derives the page list from the `admin` directory and fails when a page lacks a registry
// entry (unlisted routes fail closed)". This is the one repo-scan test the task demands: it reads the directory, not behaviour.
// Behaviour (denial, audit row, revocation) is proven against the database in t62-console.test.ts.
const ADMIN = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/src/app/(operator)/admin");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const files = walk(ADMIN);
const template = (file: string) => "/admin" + relative(ADMIN, dirname(file)).split("/").filter(Boolean).map((s) => `/${s}`).join("");
const pages = files.filter((f) => /\/(page|route)\.tsx?$/.test(f));

describe("route registry derived from the admin directory (fails closed)", () => {
  it("finds the pages (the scan itself works)", () => {
    expect(pages.length).toBeGreaterThanOrEqual(12);
    expect(pages.map(template)).toContain("/admin");
    expect(pages.map(template)).toContain("/admin/stores/[id]");
  });

  it("every page and handler under /admin has a registry entry with an ARCH-5 id and a capability, and every route-less entry is dormant", () => {
    const registered = new Map(CONSOLE_ROUTES.map((r) => [r.path, r]));
    const missing = pages.map(template).filter((t) => !registered.has(t));
    expect(missing, "pages without a registry entry (add them to packages/db/src/ops/console-routes.ts)").toEqual([]);
    for (const r of CONSOLE_ROUTES) {
      expect(r.pageId, r.path).toMatch(/^(SA|HTTP)-\d+$/);
      expect(r.capabilities.length, r.path).toBeGreaterThan(0);
    }
    // The other direction: an active (P1) entry without a page is a dead menu link; P2 and P1.5 entries must not have a page yet.
    const built = new Set(pages.map(template));
    for (const r of CONSOLE_ROUTES) expect(built.has(r.path), `${r.path} (${r.phase})`).toBe(r.phase === "P1");
  });

  it("every page runs the console gate for its own template before it reads anything", () => {
    for (const file of pages) {
      const src = readFileSync(file, "utf8");
      const t = template(file);
      const body = src.slice(src.indexOf(file.endsWith("/route.ts") ? "export async function" : "export default"));
      const firstAwait = body.indexOf("await ");
      expect(body.slice(firstAwait).startsWith(`await consoleGate("${t}"`), `${t}: the first await of the page must be consoleGate("${t}")`).toBe(true);
    }
  });

  it("every exported server action runs the console gate as its first awaited statement", () => {
    const actionFiles = files.filter((f) => readFileSync(f, "utf8").startsWith('"use server"'));
    expect(actionFiles.length).toBeGreaterThanOrEqual(4);
    for (const file of actionFiles) {
      const src = readFileSync(file, "utf8");
      const parts = src.split(/\nexport async function /).slice(1);
      expect(parts.length, file).toBeGreaterThan(0);
      for (const part of parts) {
        const name = part.slice(0, part.indexOf("("));
        const firstAwait = part.indexOf("await ");
        expect(part.slice(firstAwait).startsWith("await consoleActionOp(") || part.slice(firstAwait).startsWith("await consoleGate("), `${relative(ADMIN, file)}: ${name} must start with the gate`).toBe(true);
      }
    }
  });

  it("an action's gate names a registered template", () => {
    for (const file of files.filter((f) => readFileSync(f, "utf8").startsWith('"use server"'))) {
      for (const m of readFileSync(file, "utf8").matchAll(/consoleActionOp\("([^"]+)"/g)) {
        expect(resolveConsolePath(m[1]!)?.path, `${relative(ADMIN, file)} gate ${m[1]}`).toBe(m[1]);
      }
    }
  });
});

describe("route resolution and navigation", () => {
  it("static templates win over detail templates; unknown and dormant paths resolve to nothing active", () => {
    expect(resolveConsolePath("/admin/stores/new")?.pageId).toBe("SA-03");
    expect(resolveConsolePath("/admin/stores/new")?.path).toBe("/admin/stores/new");
    expect(resolveConsolePath("/admin/stores/42?x=1")?.path).toBe("/admin/stores/[id]");
    expect(resolveConsolePath("/admin/unlisted")).toBeUndefined();
    expect(resolveConsolePath("/admin/stores/42/extra")).toBeUndefined();
    expect(resolveConsolePath("/admin/domains")?.phase).toBe("P2");
  });

  it("a group appears only with a permitted child, and dormant (P2, P1.5) items never appear", () => {
    expect(consoleNavigation([])).toEqual([]);
    expect(consoleNavigation(["logs.read"])).toEqual([{ label: "Operasional", items: [{ href: "/admin/logs", label: "Log System" }] }]);
    expect(consoleNavigation(["updates.write", "updates.publish"])).toEqual([]); // P1.5
    const groups = consoleNavigation(["tenants.manage"]); // Tambah toko only; no list, no P2 "Domain" (also tenants.manage)
    expect(groups).toEqual([{ label: "Toko", items: [{ href: "/admin/stores/new", label: "Tambah toko" }] }]);
    const all = consoleNavigation(["dashboard.read", "tenants.read", "shipping.manage", "logs.read", "ops.read", "audit.read", "ops.issues.manage", "settings.manage", "providers.read", "staff.manage"]);
    for (const g of all) expect(g.items.length, g.label).toBeGreaterThan(0);
    expect(all.flatMap((g) => g.items.map((i) => i.href))).not.toContain("/admin/domains");
    expect(all.map((g) => g.label)).toContain("Ringkasan"); // approvals: a four-eyes capability opens it
  });
});
