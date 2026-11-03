import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkSystemMap } from "./check-system-map.mjs";

const page = "| SC-01 | `/seller` | `(seller)/seller/page.tsx` | `list` | `store` | member | `test/catalog.test.ts` | T-1 | Implemented |";
const job = "| JOB-01 | worker | `worker.ts` | drain | `job` | platform | `test/jobs.test.ts` | T-1 | Implemented |";
const doc = (rows = page, future = "") => `## ARCH-5 — Map\n### Pages\n${rows}\n## Planned surfaces\n${future}\n## ARCH-6 — Future\n`;
function check(t, markdown, extra = []) {
  const root = mkdtempSync(join(tmpdir(), "bukalaris-map-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["apps/web/src/app/(seller)/seller/page.tsx", "packages/db/test/catalog.test.ts", "packages/db/test/jobs.test.ts", "packages/db/src/worker.ts", ...extra]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "// synthetic fixture\n");
  }
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs/TASKS.md"), "### T-1 — Existing task\n");
  return checkSystemMap(root, markdown);
}

test("exact route ownership, background file and escaped table pipes pass", (t) => {
  const result = check(t, doc(page.replace("member", "read\\|write") + "\n" + job));
  assert.deepEqual(result.problems, []);
  assert.equal(result.routes, 1);
  assert.equal(result.implemented, 2);
});
test("new code cannot be covered by a URL alone", (t) => {
  const result = check(t, doc(page.replace("(seller)/seller/page.tsx", "page.tsx")));
  assert.ok(result.problems.some((p) => p.includes("not an exact app route")));
  assert.ok(result.problems.some((p) => p.includes("no implemented map owner")));
});
test("planned row cannot conceal a missing implemented owner", (t) => {
  const result = check(t, doc(page.replace("Implemented", "Planned")));
  assert.ok(result.problems.some((p) => p.includes("no implemented map owner")));
});
test("phantom explicit app path fails even when its URL exists", (t) => {
  const result = check(t, doc(page.replace("(seller)/seller/page.tsx", "apps/web/src/app/ghost/page.tsx")));
  assert.ok(result.problems.some((p) => p.includes("not an exact app route")));
});
test("two rows cannot own one route", (t) => {
  const result = check(t, doc(page + "\n" + page.replace("SC-01", "SC-02")));
  assert.ok(result.problems.some((p) => p.includes("multiple map owners")));
});
test("ID cannot occur in current and future registers", (t) => {
  const result = check(t, doc(page, "| SC-01 | proposed | target | data | auth | proof | T-1 | Planned |"));
  assert.ok(result.problems.some((p) => p.includes("duplicate map ID")));
});
test("missing test and unknown task fail", (t) => {
  const result = check(t, doc(page.replace("catalog.test.ts", "missing.test.ts").replace("T-1", "T-999")));
  assert.ok(result.problems.some((p) => p.includes("test file missing")));
  assert.ok(result.problems.some((p) => p.includes("unknown task")));
});
test("missing background entry fails", (t) => {
  const result = check(t, doc(page + "\n" + job.replace("worker.ts", "missing.ts")));
  assert.ok(result.problems.some((p) => p.includes("background file missing")));
});
test("unescaped extra table column fails", (t) => {
  const result = check(t, doc(page.replace("member", "read|write")));
  assert.ok(result.problems.some((p) => p.includes("expected 9 columns")));
});
test("additional unmapped route fails", (t) => {
  const result = check(t, doc(), ["apps/web/src/app/new/page.tsx"]);
  assert.ok(result.problems.some((p) => p.includes("no implemented map owner: new/page.tsx")));
});
test("implemented handler cannot stay in the future register", (t) => {
  const future = "### Proposed handler and job register\n| HTTP-01 | route | target | auth | T-1 | Implemented |";
  const result = check(t, doc(page, future));
  assert.ok(result.problems.some((p) => p.includes("implemented entry belongs in ARCH-5")));
});
test("entry path cannot silently describe a different URL", (t) => {
  const result = check(t, doc(page.replace("`/seller`", "`/wrong`")));
  assert.ok(result.problems.some((p) => p.includes("route URL does not match entry")));
});
test("future handler table shape is checked independently of its column count", (t) => {
  const future = "### Proposed handler and job register\n| HTTP-01 | route | target | auth | T-1 | extra | extra | Planned |";
  assert.ok(check(t, doc(page, future)).problems.some((p) => p.includes("expected 6 columns")));
});
test("section boundary drift fails closed", (t) => {
  assert.ok(check(t, "# no map").problems.some((p) => p.includes("boundaries")));
});
