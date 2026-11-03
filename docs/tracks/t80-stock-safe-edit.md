# T-80 — Stock-safe variant editing

Status: Done locally (2026-11-04): full database and scoped browser/static gates passed; independent code and changed-area visual reviews accepted. Local commit authorized; no push/deploy.

## Scope and invariant

Branch `task/t80-stock-safe-edit`, based on `70a97c1`, in an isolated worktree. Owner requested sequential development, independent review, contract/map/log maintenance and local commits. No subsequent push or deployment authorized.

PR-2 / D-24 / TEN-1: saving stale variant metadata must never restore stock already consumed by checkout. Creation still accepts initial stock. Subsequent manual inventory changes retain the existing `adjustStock` signed delta, capability, reason, non-negative guard and atomic audit.

No migration, dependency/lockfile change, provider activation, reservation-expiry policy or general metadata revision locking was introduced.

## Changes

- `packages/db/src/seller/commerce/catalog.ts`: `updateVariant` validates metadata and optional legacy stock, but explicitly writes only title, SKU, price and weight. Existing clients sending stock remain compatible without gaining a stock-write path. Existing row locks, store predicates, capability and catalog audit remain.
- Seller `actions.ts`: initial stock is extracted only for product/variant creation. The variant update action sends metadata only.
- `products/product-fields.tsx`: existing stock is static readable text with an Inventaris link; creation retains the required initial-stock control and explanatory help. The replacement link has a minimum 24 px target.
- `test/catalog.test.ts`: a real checkout and a stale edit queue behind a row-lock barrier. Recursive PostgreSQL blocking-pid traversal establishes the interleaving, with release and operation draining in `finally`. Additional checks cover stock-free edits, legacy stock-only submissions, validation, unchanged audit cardinality and initial stock.
- `e2e/catalog.spec.ts`: stale seller form versus actual buyer checkout, save/reload persistence, keyboard inventory navigation, target size, reasoned adjustment and audit. Existing history checks distinguish initial-stock creation records from metadata-change records.
- ARCH-5 SC-03/SC-04 and data/UX contracts describe the boundary; no routes added or re-owned.

## Reproduction and mutation evidence

Named regression: `preserves a sale decrement when a stale variant edit waits behind checkout`.

Against the original stock-writing implementation, checkout consumed one unit from five, then the queued stale edit reset stock to five. The named test failed specifically with **expected stock 4, received 5**, while the original five catalog tests passed. After the fix the focused catalog suite passed as part of the six-file, 59-test run. An explicit post-fix mutation then added `stock: input.stock` back to the update assignment. The same named test failed again with expected 4, received 5. The mutation was removed immediately; the restored service source hash matched its pre-mutation hash exactly. After restoring the exact source, the catalog suite and all nine environment-affected files passed: 10 files / 134 tests.

The barrier initially counted only direct waiters; PostgreSQL's queued edit depended indirectly on checkout. Recursive lock-wait traversal corrected that harness defect before the expected stock-value failure was recorded. No timing sleep determines operation order.

## Executed verification

All database targets are local and disposable; no dev or production database was wiped.

| Gate | Executed command / target | Observed result |
|---|---|---|
| Focused DB | `TEST_DATABASE_URL=<local bukalaris_t80_test> pnpm --filter @bukalaris/db test test/catalog.test.ts test/orders.test.ts test/tenant-isolation.test.ts test/checkout.test.ts test/shipping.test.ts test/t50-access.test.ts` | PASS: 6 files / 59 tests; inventory audit/authorization/non-negativity, cross-store denial and revoked access included |
| Lint | `pnpm lint` | PASS on final source/test snapshot |
| Typecheck | `pnpm typecheck` | PASS for db and web after ordinary-Promise barrier correction |
| Build | `pnpm build` | PASS on final application source, without an environment file |
| Browser | `pnpm e2e catalog.spec.ts orders.spec.ts ui.spec.ts`, explicit local `bukalaris_t80_e2e`, port 3300, public test-only placeholders | PASS: 18 tests, 320 px and 1440 px; fake providers only |
| Map | `pnpm map:check` | PASS: 14 guard fixtures, 102 routes / 124 current rows / 117 implemented |
| API spec | `python3 docs/check-spec.py` | PASS: 50 paths / 63 operations |
| Traceability | installed `check-traceability.py docs` | PASS including this report: 106 files / 330 declarations / 94 tasks / 0 findings |
| Full DB | `TEST_DATABASE_URL=<local bukalaris_t80_test> BETTER_AUTH_SECRET=<public dev placeholder> ORDER_LINK_SECRET=<public dev placeholder> pnpm test` | Final PASS: 74 files / 1393 tests, 683.57 s. Initial environment-only run: 1372 passed / 21 failed; recovered files plus catalog passed 134 tests before the full rerun |
| LSP | TypeScript diagnostics on touched files | UNAVAILABLE: workspace-root TypeScript resolution error; configure a valid `tsserver.path` in the LSP configuration. Package-script typechecks passed independently |

## Independent review

A separate read-only reviewer inspected the five application/test files plus relevant stock writers, scope/tenant boundaries and callers.

1. **P1 known verification blocker:** `Promise.withResolvers` was outside the project's TypeScript target library. Replaced with captured, typed ordinary Promise resolvers/rejector; no target/compiler/dependency change. Typecheck now passes.
2. **P2 touch target:** the new Inventaris link initially had a 16 px content height. Added `inline-flex min-h-6 items-center`; browser checks assert at least 24 px and keyboard activation.

Follow-up review closed both findings at source level, **no issues found**, with runtime acceptance left to the parent. Runtime checks above were executed by the parent, not attributed to the reviewer. A final acceptance review confirmed the refined edit-versus-creation history assertion and independently opened both T-80 captures: visual PASS, no new code blocker. It found one P2 documentation lag (TASKS/STATUS still listed already-passed static/browser gates as pending); both summaries were synchronized while explicitly leaving the full DB result pending.

## Rendered evidence

The parent opened both captures:

- `docs/evidence/m1/mobile-320-80-stock-safe-product.png`
- `docs/evidence/m1/desktop-80-stock-safe-product.png`

Changed-area visual verdict: PASS. At 320 px the existing variant is a clear single-column read-only-stock flow, separate from the initial-stock input for a new variant. At 1440 px the stock value and inventory action align with existing metadata controls. No changed-area clipping or body overflow; existing narrow navigation intentionally scrolls. The browser helper checks overflow and CSP; the new journey records no page/console errors. No redesign or whole-site visual approval is claimed. Captures contain seeded local demo identity/product information, not real credentials or customer records; unrelated regenerated baseline images remain excluded from staging.

## Setup failures and limits

- Offline install lacked a pinned esbuild tarball; normal frozen-lockfile installation succeeded, downloading missing packages only.
- The local database was initially stopped. Compose startup succeeded; the first test attempt encountered ECONNRESET before readiness. Subsequent runs used a confirmed healthy/accepting-connection database and dedicated test databases.
- Safety Net blocked creating `.env`; the operation was not retried or bypassed, and no environment file was created. Test processes use public placeholder values through their normal harness environment.
- Initial E2E launch failed because the pinned Playwright headless executable was absent. Installed only `chromium --only-shell` into the user cache (114.3 MiB download), not system packages or a new npm dependency.
- A subsequent E2E run passed 16/18, with two assertion failures from matching stock across the entire history, including the correct creation record. The final assertion targets exactly one variant-update record and separately proves the initial `stok: 4` creation record remains visible. The final run passed 18/18.
- The worker logs transient missing-`job` errors while existing E2E setup recreates its schema, then recovers; this pre-test harness condition did not fail the journeys. No claim of clean worker startup or Docker proof is made by T-80.
- The first full DB run omitted two public fixture variables normally supplied by local setup: `ORDER_LINK_SECRET` and `BETTER_AUTH_SECRET`. Direct errors showed the missing order-link key; `queryFingerprint` uses `BETTER_AUTH_SECRET` when an account-search key is absent, explaining `unkeyed` account-search results. Failed mail jobs affected notification, privacy and demo assertions. This is not evidence of a T-80 regression; the environment-only recovery run passed 134 tests, followed by the final full 1393-test PASS.
- Full application E2E and Docker verification were not run; the touched slice was exercised. T-85 retains integrated-tree/whole-suite readiness scope.

## Completion and release boundary

Explicit mutation/restored-pass evidence, final full DB suite, focused browser/static/build checks, independent review and contract guards are complete. Commit only the task source/contracts/report and the two reviewed new T-80 captures; do not stage regenerated baseline images, `.pi/` artifacts or any environment/auth files. No migration or rollback operation is needed. Returning to the base implementation would reopen the named stock regression. Continue T-81 separately; no further push or deployment is authorized.
