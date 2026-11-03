#!/usr/bin/env node
// Read-only ARCH-5 drift guard. No network, database, environment secrets or writes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const cellsOf = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
const tokens = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
const normalizeUrl = (url) => url.split("?")[0].replace(/\[[^\]]+\]|<[^>]+>/g, "*").replace(/\/+$/, "") || "/";
const urlOf = (entry) => normalizeUrl("/" + entry.split("/").slice(0, -1).filter((part) => !/^\(.+\)$/.test(part)).join("/"));

/** File-backed validation is also run against disposable fixtures by the node:test suite. */
export function checkSystemMap(workspace, doc = readFileSync(join(workspace, "docs/04-SYSTEM-ARCHITECTURE.md"), "utf8")) {
  const problems = [];
  const start = doc.indexOf("## ARCH-5 ");
  const currentEnd = doc.indexOf("## Planned surfaces", start);
  const end = doc.indexOf("## ARCH-6 ", currentEnd);
  if (start < 0 || currentEnd < start || end < currentEnd) {
    return { problems: ["cannot locate ARCH-5 / Planned surfaces / ARCH-6 boundaries"], routes: 0, rows: 0, implemented: 0 };
  }
  const appDir = join(workspace, "apps/web/src/app");
  const real = walk(appDir).map((path) => relative(appDir, path).replaceAll("\\", "/"))
    .filter((path) => /(^|\/)(page\.tsx|route\.ts)$/.test(path));
  const routeOwners = new Map(real.map((path) => [path, []]));
  const ids = new Set();
  const taskDoc = readFileSync(join(workspace, "docs/TASKS.md"), "utf8");
  const taskIds = new Set([...taskDoc.matchAll(/^### (T-\d+)\b/gm)].map((match) => match[1]));
  let rows = 0;
  let implemented = 0;
  // Current rows use nine columns; future pages eight and future handlers/jobs six.
  const futureHandlers = doc.indexOf("### Proposed handler and job register", currentEnd);
  for (const line of doc.slice(start, end).split("\n")) {
    if (!/^\| (?:AU|SA|SC|SF|HTTP|JOB|OPS|WEB|BA|AF|UL)-\d+/.test(line)) continue;
    const cells = cellsOf(line);
    const id = cells[0].match(/^[A-Z]+-\d+/)[0];
    if (ids.has(id)) problems.push(`${id}: duplicate map ID`);
    ids.add(id);
    const position = doc.indexOf(line, start);
    const isCurrent = position < currentEnd;
    const columns = isCurrent ? 9 : futureHandlers >= 0 && position > futureHandlers ? 6 : 8;
    if (cells.length !== columns) {
      problems.push(`${id}: expected ${columns} columns, got ${cells.length}`);
      continue;
    }
    if (!isCurrent) {
      if (/^Implemented/i.test(cells.at(-1))) problems.push(`${id}: implemented entry belongs in ARCH-5, not the future register`);
      continue;
    }
    rows++;
    if (!/^Implemented/i.test(cells[8])) continue;
    implemented++;
    const taskRefs = cells[7].match(/T-\d+\b/g) ?? [];
    if (!taskRefs.length) problems.push(`${id}: implemented row has no task ID`);
    for (const task of taskRefs) if (!taskIds.has(task)) problems.push(`${id}: unknown task ${task}`);
    // Full app-relative entry paths, never URL fallback or an ambiguous suffix match.
    const entries = tokens(cells[2]).filter((token) => /(?:page\.tsx|route\.ts)$/.test(token));
    for (const entry of entries) {
      if (!routeOwners.has(entry)) problems.push(`${id}: entry file is not an exact app route: ${entry}`);
      else {
        routeOwners.get(entry).push(id);
        const urls = tokens(cells[1]).flatMap((token) => token.split(/\s+/)).filter((token) => token.startsWith("/"));
        if (!urls.some((url) => normalizeUrl(url) === urlOf(entry))) problems.push(`${id}: route URL does not match entry: ${entry}`);
      }
    }
    if (/^(?:AU|SA|SC|SF|HTTP|OPS|WEB)-/.test(id) && !entries.length) {
      problems.push(`${id}: implemented route has no explicit page.tsx/route.ts entry`);
    }
    if (id.startsWith("JOB-")) {
      const files = tokens(cells[2]).filter((token) => /\.(?:ts|mjs)$/.test(token));
      if (!files.length) problems.push(`${id}: implemented background row has no source file`);
      for (const file of files) {
        const path = file.startsWith("scripts/") ? file : `packages/db/src/${file}`;
        if (!existsSync(join(workspace, path))) problems.push(`${id}: background file missing: ${path}`);
      }
    }
    const tests = tokens(cells[6]).filter((token) => /\.(?:test|spec)\.(?:ts|mjs)$/.test(token)
      || /^scripts\/[\w/-]+\.sh$/.test(token) || /^(?:e2e|test)\/global-setup\.ts$/.test(token));
    if (!tests.length) problems.push(`${id}: implemented row has no concrete test locator`);
    for (const test of tests) {
      const path = test.startsWith("test/") ? `packages/db/${test}`
        : test.startsWith("e2e/") ? `apps/web/${test}` : test;
      if (!existsSync(join(workspace, path))) problems.push(`${id}: test file missing: ${path}`);
    }
  }
  for (const [path, owners] of routeOwners) {
    if (!owners.length) problems.push(`code has no implemented map owner: ${path}`);
    if (owners.length > 1) problems.push(`route has multiple map owners: ${path} (${owners.join(", ")})`);
  }
  return { problems, routes: real.length, rows, implemented };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkSystemMap(root);
  console.log(`system-map: ${result.routes} route files, ${result.rows} current rows (${result.implemented} Implemented)`);
  if (result.problems.length) {
    console.error(result.problems.join("\n"));
    console.error(`system-map: ${result.problems.length} drift problem(s). Update ARCH-5 in the same change.`);
    process.exitCode = 1;
  } else console.log("system-map: ok (structural coverage only; not runtime or symbol proof)");
}
