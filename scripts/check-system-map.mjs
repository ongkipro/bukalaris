#!/usr/bin/env node
// Drift guard for the canonical system map (docs/04-SYSTEM-ARCHITECTURE.md ARCH-5).
// Mechanises ARCH-5 "How to keep this map current" rules 1-2. Read-only (no network, DB or writes).
//   A. every page.tsx / route.ts under apps/web/src/app is covered by an ARCH-5 row, either because its
//      full relative path is named, or because a row's Route cell names its URL (dynamic segments are
//      compared as `*`, route groups like `(shop)` are ignored);
//   B. every entry-file token ending in page.tsx / route.ts that an Implemented Pages/HTTP row names
//      resolves to a real file (abbreviated forms such as `new/page.tsx` or `…/items/route.ts` are
//      accepted when some real file ends with them);
//   C. every Implemented AU/SA/SC/SF/HTTP row names a task id.
// Exit 1 on drift. Run: `pnpm map:check`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps/web/src/app");
const mapFile = join(root, "docs/04-SYSTEM-ARCHITECTURE.md");

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const real = walk(appDir)
  .map((p) => relative(appDir, p).split("\\").join("/"))
  .filter((p) => /(^|\/)(page\.tsx|route\.ts)$/.test(p))
  .sort();

const norm = (route) =>
  route
    .replace(/\?.*$/, "")
    .replace(/\[\.\.\.[^\]]+\]/g, "*")
    .replace(/\[[^\]]+\]|<[^>]+>|\{[^}]+\}/g, "*")
    .replace(/\/+$/, "") || "/";

const urlOf = (file) =>
  norm(
    "/" +
      file
        .replace(/(^|\/)(page\.tsx|route\.ts)$/, "")
        .split("/")
        .filter((seg) => !/^\(.+\)$/.test(seg))
        .join("/"),
  );

const doc = readFileSync(mapFile, "utf8");
const start = doc.indexOf("## ARCH-5 ");
const end = doc.indexOf("## Planned surfaces");
if (start < 0 || end < 0 || end < start) {
  console.error("system-map: cannot locate the ARCH-5 section boundaries in docs/04-SYSTEM-ARCHITECTURE.md");
  process.exit(1);
}
const arch5 = doc.slice(start, end);
const tables = arch5.slice(Math.max(arch5.indexOf("### Pages"), 0));
const rows = tables.split("\n").filter((l) => /^\| (AU|SA|SC|SF|HTTP|JOB|OPS|WEB|BA|AF)-\d+/.test(l));

// Route URLs named in any row's Route cell (2nd column): backticked tokens that look like paths.
const mappedUrls = new Set();
for (const row of rows) {
  const routeCell = row.split("|")[2] ?? "";
  for (const m of routeCell.matchAll(/`([^`]+)`/g)) {
    for (const part of m[1].split(/\s+/)) if (part.startsWith("/")) mappedUrls.add(norm(part));
  }
}

const problems = [];

for (const f of real) {
  if (!tables.includes(f) && !mappedUrls.has(urlOf(f))) problems.push(`A  code has no map row: apps/web/src/app/${f}`);
}

let implemented = 0;
for (const row of rows) {
  const cells = row.split("|").map((c) => c.trim());
  const id = cells[1].split(" ")[0];
  const prefix = id.split("-")[0];
  const status = cells[cells.length - 2] ?? "";
  if (!/^Implemented/i.test(status)) continue;
  implemented++;
  if (["AU", "SA", "SC", "SF", "HTTP"].includes(prefix) && !/T-\d+/.test(cells[cells.length - 3] ?? "")) {
    problems.push(`C  ${id}: Implemented row has no task id`);
  }
  if (!["AU", "SA", "SC", "SF", "HTTP", "WEB"].includes(prefix)) continue;
  for (const m of row.matchAll(/`([^`]+(?:page\.tsx|route\.ts))`/g)) {
    const token = m[1].replace(/^…\//, "").replace(/^\.\//, "");
    if (token.startsWith("packages/") || token.startsWith("apps/")) continue;
    if (!real.some((f) => f === token || f.endsWith("/" + token))) {
      problems.push(`B  ${id}: entry file does not resolve to a real route file: ${m[1]}`);
    }
  }
}

console.log(`system-map: ${real.length} route files in code, ${rows.length} map rows (${implemented} Implemented)`);
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`system-map: ${problems.length} drift problem(s). Update ARCH-5 in the same change (docs/04 "How to keep this map current").`);
  process.exit(1);
}
console.log("system-map: ok");
