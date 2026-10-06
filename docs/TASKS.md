# Bukalaris Planning Task Queue

All tasks remain planning tasks until the product/architecture owners explicitly
approve implementation. Each task has one primary requirement; constraints do
not create a second primary.

### T-1 — Verify Bukalaris repository and baseline
- Status: Done (M1, 2026-10-06) — repository, pinned stack, schema, tests and docs recorded; see "M1 implementation evidence".
- Primary requirement: PR-1
- Constraints: CTX-5, TD-1
- Dependencies: None
- Done when: repository location, instructions, stack, current schema/routes,
  tests, provider code, and existing documents are recorded; this pack is
  reconciled without overwriting repository truth.

### T-2 — Approve tenancy and host model
- Status: Partial (M1) — store-scoped data access, host/slug resolution and negative tests exist for browser paths; worker/cache/media paths do not exist yet; RLS deferred (DECISIONS D-4).
- Primary requirement: PR-3
- Constraints: TEN-1, TEN-2, TEN-3, DOM-1, SEC-1
- Dependencies: T-1, ADR-0001
- Done when: accepted schema/authorization/host-resolution contract has
  negative test targets for browser, worker, cache, media, and root tenant data.

### T-3 — Specify seller and Super Admin workflows
- Status: Partial (M1) — implemented: product/variant CRUD, members, store suspend/reactivate with audited reason. Not accepted as a UX contract; other Phase 1 screens pending.
- Primary requirement: PR-2
- Constraints: IAM-1, IAM-2, UX-1, UX-2
- Dependencies: T-1
- Done when: every Phase 1 screen/action/state/permission is accepted in the
  UX contract, including suspension, publish, validation, conflict, and audit.

### T-4 — Produce versioned OpenAPI and state-machine contract
- Primary requirement: PR-5
- Constraints: API-1, API-2, TD-3, SEC-4
- Dependencies: T-1, T-2
- Done when: accepted operations and schemas cover catalog, cart, checkout,
  orders, provider callbacks, pagination/errors/idempotency; OpenAPI validates
  with the repository-approved validator.

### T-5 — Decide payment and shipping account ownership
- Primary requirement: PR-4
- Constraints: BILL-1, BILL-2, PRIV-3, Q-1, Q-2
- Dependencies: Current provider account documentation and finance owner review
- Done when: finance owner records merchant/account ownership, fee disclosure,
  COD eligibility, order/payment/shipment lifecycle, reconciliation proof, and
  unknown-result policy; no live transaction is created by this task.

### T-6 — Create provider sandbox verification plan
- Primary requirement: PR-5
- Constraints: API-2, BILL-2, OBS-2, SEC-5, SEC-6
- Dependencies: T-5
- Done when: approved non-production, server-side test plan specifies a
  sanitized Mengantar estimate and AutoLaris creation/reconciliation evidence
  without credentials, orders, or production writes.

### T-7 — Define marketplace listing policy
- Primary requirement: PR-6
- Constraints: DATA-3, IAM-3, BILL-3, UX-5
- Dependencies: T-3
- Done when: owner accepts listing eligibility, review states/reasons,
  takedown/appeal behavior, catalog sync ownership, and explicit prohibition of
  marketplace checkout before finance decision Q-3.

### T-8 — Define buyer account and affiliate data boundaries
- Primary requirement: PR-7
- Constraints: DATA-4, IAM-4, PRIV-1, PRIV-2, UX-6
- Dependencies: T-1
- Done when: owner accepts guest-to-account linking, account recovery, data
  access/retention, affiliate attribution window, and no-PII affiliate view.

### T-9 — Design observability and security proof
- Primary requirement: PR-5
- Constraints: OBS-1, OBS-2, OBS-3, SEC-1 through SEC-7, NFR-4
- Dependencies: T-1, T-4
- Done when: accepted signal/audit/redaction/rate-limit contract has named
  owners, safe synthetic checks, and a tenant-isolation negative test plan.

### T-10 — Specify the two built-in storefront themes
- Primary requirement: PR-8
- Constraints: UI-1, UI-3, UI-4, UI-5, UX-3, NFR-3
- Dependencies: T-1, T-3
- Done when: the existing design and UX contracts record inspected reference
  direction, theme selection and preview/publish states, content preservation,
  and exact responsive behavior; the responsive theme is explicitly the initial
  store/demo default and the mobile alternative is capped at 480 CSS px.
  The browser acceptance plan covers both themes at 320px, 480px, and a wide
  desktop viewport, including keyboard navigation and the buyer purchase path.

### T-11 — Specify MCP-enabled storefront landing-page builder
- Primary requirement: PR-9
- Constraints: ARCH-4, TD-4, API-3, UI-4, UI-6, UX-7, IAM-2, IAM-7, TEN-1
- Dependencies: T-1, T-3, T-10
- Done when: the existing technical, API, data, and UX contracts define MCP
  integration direction, official protocol/version references, authentication,
  operation schemas, composable content, store-owned page revisions, storefront
  routes/reserved slugs, private previews, publication permissions, conflict and
  retry handling, and actor audit records. Acceptance checks cover both themes,
  unchanged cart/checkout behavior, failed publish preserving live content,
  cross-tenant denial, and access revocation. Implementation phase is explicit;
  this future capability does not silently expand the Phase 1 release gate.
  Resolve the builder recommendation from the research in Technical Design
  against the actual stack. Define a dedicated Landing Page Builder feature,
  independent LP document/style ownership, and a mobile-first editor contract.
  Plan a focused Puck integration spike if React fits: touch/keyboard authoring,
  visual/MCP round-trip, saved revisions, public-render payload, and unchanged
  LP appearance/URL/cart after switching either storefront theme. Library choice
  remains proposed until these checks are executed. Include free LP composition
  around the planned locked form. Specify form types, protected fields/logic,
  allowed appearance changes, and identical protection for visual and MCP edits;
  do not treat a fixed section library as the accepted layout ceiling.

### T-12 — Maintain the system and page implementation map
- Status: Partial (M1) — 11 implemented pages have real locators in 04-SYSTEM-ARCHITECTURE "M1 implementation locators"; no commit revision exists yet.
- Primary requirement: PR-10
- Constraints: ARCH-5, UX-8
- Dependencies: T-1, T-3
- Done when: every defined page has a stable ID and planned/implemented status;
  each developed page links to existing route/layout/component, service,
  schema/query, permission, test, and task owners at a checked code revision.
  Validate file links and route coverage against the actual repository; every
  page-changing task includes map maintenance. No placeholder claims code exists.

### T-13 — Specify Super Admin Log System and proof
- Status: Planned — button, function attribution and query contract expanded on 2026-09-25; runtime proof pending.
- Primary requirement: PR-11
- Constraints: OBS-5, UX-9, ARCH-5, IAM-1, IAM-5, NFR-4
- Dependencies: T-1, T-9, T-12
- Done when: existing UX/API/IAM/observability contracts define the visible
  button, restricted list/detail queries, safe projection, filters, correlation,
  page/module mapping, retention and query limits. Define synthetic sink-to-UI
  proof, denied access, redaction, and unavailable-source scenarios before
  implementation; do not treat a UI mockup as emitted-log evidence.

### T-14 — Specify concise product and advertising identity
- Status: In progress — M1 implements database identity, optional slug, canonical 308. Next (M2 wave 2): external catalog ID per product and variant — digit-only, at least five digits, unique platform-wide, string at every API/feed/event/order-snapshot boundary, never derived from slug/SKU or reused; slug aliases and creation idempotency. Meta item/group contract still awaits provider verification.
- Primary requirement: PR-12
- Constraints: DATA-5, API-4, UX-10, ARCH-5, TEN-1
- Dependencies: T-1, T-3
- Done when: schema and API contracts define automatic numeric identity,
  string transport, slug defaults and redirects, concurrency/retry behavior,
  and duplicate/archive behavior. Freeze product/variant catalog granularity
  against current official Meta documentation; specify shared feed/Pixel/CAPI
  fixtures including LP paths and domain changes. Update SC-03 and SC-17 code
  locators when implemented; no tracking match is claimed without provider proof.

### T-15 — Specify per-seller custom-domain lifecycle
- Status: In progress — lifecycle and operation contracts drafted; Cloudflare
  candidate researched, hosting compatibility/provider choice remain open.
- Primary requirement: PR-13
- Constraints: DOM-1, DOM-2, DOM-3, UX-11, ARCH-5, TEN-2, SEC-3
- Dependencies: T-1, T-2
- Done when: choose the domain/TLS provider and verify its official contract;
  define DNS instructions, ownership/certificate states, primary switching,
  removal/reassignment, tenant/cache isolation, canonical/feed URL updates,
  and failure recovery. Cover both store themes and independent LPs; map SC-18
  to actual code and tests when implemented. No live DNS mutation is authorized
  by completing this planning task.

## Planning handoff — 2026-09-18

Observed: The current deliverable remains a staged specification pack. No
Bukalaris application repository, installed stack, migrations, running pages,
or executable product checks have been established. The traceability checker
validates document structure only. T-14/T-15 are not complete, and no other task
is newly marked done by this planning pass.

Next dependency: T-1 establishes repository/stack truth before implementation.
Product decisions still required for the affected features (see PRD Q-6 through Q-11): catalog export
at product versus variant granularity; domain provider/hosting and apex support;
LP form type/protected fields. Existing architecture recommendations remain
proposals until reconciled with those decisions and implementation evidence.

### T-16 — Complete headless HTTP contract and consumer checks
- Status: In progress — proposed openapi.yaml authored. M2 track `channels` implements the first conforming Storefront API subset (catalog, cart, checkout handoff) with private channel tokens.
- Primary requirement: PR-14
- Constraints: API-7, ARCH-6, TEN-1, SEC-9
- Dependencies: T-1, T-4
- Status: In progress — proposed openapi.yaml authored; implementation conformance pending.
- Done when: OpenAPI validates; every initial workflow has a schema or explicit
  owned gap; real route/auth adapters conform; negative access and replay checks
  pass in the repository. Headless flow uses T-19's platform checkout contract.

### T-17 — Resolve operator identity and membership
- Status: Partial (M1) — Better Auth chosen (ADR-0004), sign-up disabled, owner/staff membership, last-owner protection (incl. concurrent) tested. Recovery, invitations, MFA, revocation proof pending.
- Primary requirement: PR-14
- Constraints: PR-15, IAM-8, IAM-9, TEN-1, SEC-9
- Dependencies: T-1, T-3
- Done when: auth provider and PR-15 policy are accepted; login/recovery/store
  context/member workflows map AU-01 through AU-03 and SC-19/SC-20 to actual code
  and checks proving last-owner protection, revocation, expiry and denied access.

### T-18 — Establish release, data migration and recovery proof
- Status: In progress — M1 has Docker web + slim migrate images. M2 track `release`: one `pnpm verify` gate, CI workflow file, media volume, Postgres backup + restore rehearsal script (local). No deployment by this task.
- Primary requirement: PR-14
- Constraints: DEL-1, DEL-2, DEL-3, DR-1, DR-2, SEC-12, NFR-1 through NFR-5
- Dependencies: T-1, T-9, T-12, T-16, T-17, T-19
- Done when: actual repository scripts cover the verification plan in Delivery;
  staging critical-path, telemetry, DB migration and isolated restore evidence
  is recorded at a known revision; provider/finance/privacy gaps have owners
  and are resolved before the affected paths go live. No release occurs by implication.

### T-19 — Deliver external storefront channel and hosted checkout contract
- Status: In progress — M1 hosted /checkout with server-derived totals. M2 track `channels`: channel registration (SC-21), hashed one-time-shown tokens, one-use checkout handoff into the existing per-store cart cookie and /checkout, revoked/expired/replayed handoff denial.
- Primary requirement: PR-16
- Constraints: ARCH-7, API-8, IAM-11, DOM-4, SEC-13, UX-12, UI-10
- Dependencies: T-1, T-2, T-4, T-5
- Done when: validate proposed token/handoff/session API; verify the proposed checkout origin,
  auth adapter and token/session lifetimes; demonstrate an independent test
  storefront using the API and server-only token through cart, one-use handoff,
  standalone /checkout, platform outcome and registered return. Prove revoked
  tokens, foreign carts, expired/replayed handoffs, duplicate submit and no theme
  leakage. Link SC-21/SF-07/SF-08 to actual files and executed checks.

### T-20 — Specify and verify MCP catalog/content operations
- Primary requirement: PR-17
- Constraints: TD-6, DATA-6, API-9, IAM-12, UX-13, TEN-1, SEC-9
- Dependencies: T-1, T-3, T-4, T-17; T-11 before enabling LP tools
- Status: Planned — future milestone; documentation boundary defined.
- Done when: pin verified protocol/SDK and tool schemas; implement core-backed
  read/draft/preview/publish operations with scoped grants and revision-bound
  human approval. Prove denied foreign access, revocation, conflict, replay,
  partial batch recovery and protected price/stock/customer fields with runnable
  tests. Show the review/revoke journey in Tenant Admin and link audit evidence.

## Stack planning update — 2026-09-25

Decision: Next.js, TypeScript, shadcn/ui and Tailwind CSS are selected. Bos and
Tenant Admin domains are fixed. Architecture recommends Astro public rendering,
Next.js checkout and PostgreSQL/Drizzle. T-1 must establish compatible pinned
versions and the actual repository; a specification is not an installed stack.
No implementation task is marked complete by this update.


## M1 implementation evidence — 2026-10-06 (final round, after REVIEW R-7..R-11)

Revision: no commit exists yet (owner approves the first commit). Evidence is
for the uncommitted working tree; code fingerprint
`f64e666598bef5ac` = first 16 hex of `sha256` over the sorted `sha256sum` of
untracked, non-ignored files under `apps/`, `packages/` and the root build
files. Full log of each phase: `BUILD-LOG.md`.

| Command (repo root) | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm db:migrate && pnpm db:seed` (fresh dev DB) | exit 0 |
| `pnpm lint` | exit 0 (ESLint, apps/web) |
| `pnpm typecheck` | exit 0 (db: tsc; web: next typegen + tsc) |
| `pnpm test` | exit 0 — 3 files, 22 tests, against compose Postgres `bukalaris_test` |
| `pnpm build` | exit 0 — Next.js 16.3.8 standalone, 16 routes + proxy |
| `pnpm e2e` | exit 0 — 10 Playwright tests (320px and 1440px) against the standalone server and `bukalaris_e2e`; screenshots in `docs/evidence/m1/` |
| `docker build -f apps/web/Dockerfile -t bukalaris-web:m1 .` | exit 0 — 301 MB, user `app`; on the compose network `/api/health` 200, Docker HEALTHCHECK `healthy` |
| `docker build -f apps/web/Dockerfile --target migrate -t bukalaris-migrate:m1 .` | exit 0 — 273 MB (was 1.84 GB); fresh DB "migrations applied", re-run exit 0 |
| `cd docs && python3 check-spec.py` | PASS |

Invariants proven by integration tests (`packages/db/test/`):
cross-tenant read and write denial (service and FK level), membership-checked
store selection, host parsing; checkout price/total tampering rejected and
server-derived totals; idempotent sequential and concurrent duplicate submit;
different payload with the same key rejected; no oversell under 12 parallel
checkouts on stock 3; whole-order rollback on one short line; payment
instruction after commit and explicit pending state on provider failure;
suspended store blocked for storefront, checkout and seller admin with audit;
last-owner protection including concurrent mutual removal; staff denied
member management; seller with a suspended preferred store falls back to an
active membership (suspended only when all are).

Browser evidence (`apps/web/e2e/`): seller product create (+ cross-store 404),
storefront → cart → checkout → confirmation (tampered hidden total ignored,
confirmation 404 without the buyer cookie), Super Admin suspend/reactivate,
seller denied Super Admin; carts of two stores coexist and checkout uses the
selected store's cart; no horizontal overflow at 320px.

Not verified / not implemented: real providers (fakes only, no network),
RLS, recovery/invitation/MFA, external storefront channel and handoff, custom
domains, LP/MCP, Log System, deployment.

## M2 task queue — 2026-10-06

Authorization: Paduka Ongki authorized M2 implementation on 2026-10-06 (tracks
orders, accounts, ops, content; parallel worktrees, local only, no deploy).
PR-1, PR-2, PR-4 and PR-15 are still `Proposed` in 02-PRD.md: implementation is
authorized, product acceptance stays an owner decision after evidence review.
Execution: branch `m2/<track>` per worktree (AGENTS.md "Parallel tracks");
the orchestrator merges, consolidates migrations and records evidence here.

### T-21 — Seller order operations and inventory
- Status: Done (merged to main 2026-10-06) — `packages/db/src/orders.ts`, `schema-orders.ts`; `apps/web/src/app/seller/{orders,inventory}/**`. Evidence: orchestrator re-run on the branch — lint/typecheck/build exit 0, Vitest 34 passed (12 new in `test/orders.test.ts`: cross-store denial, 6×5 transition matrix, concurrent cancels restock once, 12 concurrent decrements on stock 5 → 5 succeed), Playwright 14 passed (`e2e/orders.spec.ts`, 320px + desktop). Q-10 defaults: manual "mark paid" for transfer only; cancel only before shipping (no returns/refunds); shipping requires a tracking number. Report: `docs/tracks/orders.md`.
- Primary requirement: PR-2
- Constraints: PR-4, NFR-2, TEN-1, IAM-8, DATA-2, Q-10
- Dependencies: T-1, T-19
- Done when: `/seller/orders`, `/seller/orders/[id]` and `/seller/inventory`
  exist; status transitions are validated server-side and audited; cancel
  restocks exactly once under concurrent requests; stock adjustments are atomic
  and never negative; Vitest proves cross-store denial for every new read and
  write and Playwright covers the order lifecycle at 320px and desktop.

### T-22 — Account recovery, member invitations and operator MFA
- Status: In progress — track `accounts` (wave 1).
- Primary requirement: PR-15
- Constraints: IAM-5, IAM-8, IAM-9, NFR-4, SEC-1
- Dependencies: T-17
- Done when: recovery does not reveal account existence; invitations are
  hashed, expiring, single-use, store-bound and role-bounded; operators cannot
  open `/admin` without verified TOTP; removed members lose access on the next
  request; tests and e2e prove each denial case.

### T-23 — Correlation, structured logs, Log System and error pages
- Status: In progress — track `ops` (wave 1).
- Primary requirement: PR-11
- Constraints: OBS-5, UX-9, IAM-1, NFR-4, NFR-5
- Dependencies: T-13
- Done when: requests carry a validated correlation id; sanitized events reach
  the Log System list/detail behind `logs.read`; empty and unavailable sources
  are distinct; a DB outage renders a friendly error page with the request id;
  `/api/ready` reports DB readiness.

### T-24 — Store settings and the two storefront themes
- Status: In progress — track `content` (wave 1).
- Primary requirement: PR-8
- Constraints: UI-1, UI-3, UX-3, NFR-3, TEN-1
- Dependencies: T-10
- Done when: owners edit store profile and choose `responsive` (default) or
  `mobile` (≤480px); both themes render home, collection, product, cart,
  search and pages with no horizontal overflow at 320px; checkout is unchanged
  by the theme.

### T-25 — Collections, CMS pages, search and product media
- Status: In progress — track `content` (wave 1).
- Primary requirement: PR-2
- Constraints: DATA-6, TEN-5, SEC-2, NFR-3
- Dependencies: T-24
- Done when: collections, pages and media are store-scoped with same-store
  constraints; uploads are validated by content; unpublished content is hidden;
  storefront search returns only the store's published products.

### T-26 — Super Admin store detail and creation
- Status: In progress — track `content` (wave 1).
- Primary requirement: PR-1
- Constraints: IAM-5, UX-1
- Dependencies: T-3
- Done when: an operator creates a store with an existing owner account and
  sees status, counts and recent audit on `/admin/stores/[id]`; sellers are denied.

### T-27 — Database-enforced tenant isolation
- Status: Planned — wave 2, after wave-1 merge (touches every service).
- Primary requirement: PR-2
- Constraints: NFR-1, TEN-3, DATA-1, DECISIONS D-4
- Dependencies: T-21, T-22, T-23, T-25
- Done when: the app runs as a non-owner role with RLS on every store-owned
  table, store context set per transaction inside the scope helpers, migrations
  run as the owner role, and the whole integration suite passes under the
  runtime role, including a test that a missing store context returns no rows.

### T-28 — Seller and Super Admin UI consistency pass
- Status: Planned — wave 2, after merge.
- Primary requirement: PR-2
- Constraints: NFR-3, UX-2, UI-1
- Dependencies: T-21, T-22, T-23, T-25, T-26
- Done when: every seller/admin page passes an impeccable critique-and-polish
  pass and browser evidence at 320px and desktop with keyboard paths, focus
  states and empty/error states recorded in docs/evidence.

## M2 gap-analysis tasks — 2026-10-06

Source: business/security/system review recorded in 02-PRD.md "Business model
and growth loop" (PR-18..PR-22, Q-12..Q-16, all Proposed — no tasks until the
owner accepts them) and 12-SECURITY-ARCHITECTURE.md SEC-14..SEC-19 (observed
findings, tasks below).

### T-29 — Security headers and production dependency hygiene
- Status: Planned — wave 2 (touches `next.config.ts` and `apps/web/package.json`, shared by running tracks).
- Primary requirement: PR-16
- Constraints: SEC-9, SEC-13, SEC-14, SEC-15
- Dependencies: T-23, T-25
- Done when: responses carry CSP (with nonces or a documented allowance),
  `frame-ancestors 'none'` on admin and checkout, HSTS in production,
  nosniff, Referrer-Policy and Permissions-Policy, and no `X-Powered-By`; a
  test asserts the headers on admin, storefront and checkout; build-only
  tooling (shadcn CLI) is a devDependency and `pnpm audit --prod` reports no
  high or critical advisory, or each remaining one is recorded with reachability.

### T-30 — Checkout and cart abuse controls
- Status: Planned — wave 2.
- Primary requirement: PR-4
- Constraints: SEC-16, NFR-1, NFR-5, Q-10
- Dependencies: T-21
- Done when: order submission and cart mutation are rate limited per client
  network signal and per cart/phone with a retryable, user-readable response;
  a cart is capped (lines and quantity); carts idle beyond a configured age are
  deleted by a scheduled job without touching checked-out carts; tests prove
  limits, caps and cleanup boundaries.

### T-31 — Audit catalog and price changes
- Status: Planned — wave 2.
- Primary requirement: PR-2
- Constraints: SEC-17, IAM-5
- Dependencies: T-1
- Done when: product and variant create/update/price/stock-field changes write
  an audit row (actor, store, object, before/after of price and status) in the
  same transaction; a seller-visible history on the product page; tests prove
  rows exist and are store-scoped.

### T-32 — Durable outbox and worker for post-commit side effects
- Status: Planned — wave 2.
- Primary requirement: PR-5
- Constraints: SEC-18, TD-3, NFR-2, NFR-5, ARCH-6
- Dependencies: T-21, T-23
- Done when: business writes enqueue side effects in the same transaction;
  a separate worker process (same image, different command) claims jobs with
  `FOR UPDATE SKIP LOCKED`, retries with backoff and idempotency keys, and
  records terminal failures; the payment-instruction call moves onto it;
  crash-in-the-middle and duplicate-claim tests pass.

### T-33 — Buyer personal-data lifecycle
- Status: Planned — needs privacy-owner retention periods (Q-11) before enforcement.
- Primary requirement: PR-4
- Constraints: SEC-19, PRIV-1, PRIV-4, PRIV-2
- Dependencies: T-21
- Done when: a data inventory of buyer fields exists in 13-COMPLIANCE-PRIVACY;
  a seller can export and redact one buyer's contact data from an order while
  financial snapshot amounts stay intact; redaction is audited; retention job
  thresholds are configuration with owner-approved values.

## M2 business tasks — 2026-10-06 (owner decisions Q-12, Q-13, Q-15, Q-16)

Provider rule for all tasks below: Mengantar credentials only through
`secrets-env run -- …` (never files, logs or the browser). Read operations
(`searchAddress`, `estimate3pl`/`estimate`, `getReceiverScore`, `listOrigins`)
may call the real API in development. Write operations (`createOrder`,
`upsertOrigin`, `addPickupTime`, `payUnpaid`, `addDropshipper`, any delete)
are disabled in code unless `MENGANTAR_WRITE_ENABLED=1` and must not be run
without a separate explicit owner approval. Endpoint contracts are unverified
until an observed, sanitized call is recorded (skill `mengantar-api`).

### T-34 — Mengantar shipping quotes with platform margin
- Status: In progress — track `shipping` (wave 1c): adapter, area search, margin config, seller pickup area, observed read-only contract evidence. Checkout wiring follows after `content` and `jobs` merge.
- Primary requirement: PR-5
- Constraints: Q-12, Q-13, NFR-4, NFR-5, TEN-1, SEC-9, DATA-2
- Dependencies: T-21, T-32
- Done when: a server-only Mengantar client implements the read operations
  with timeouts, redacted logging and typed errors; one sanitized observed call
  per used operation is recorded in `docs/tracks/shipping.md`; sellers set a
  pickup area via area search; Super Admin sets the platform margin rule;
  checkout shows only couriers with `unsupported=false`, hides COD where
  `unsupported_cod=true`, and snapshots provider cost, margin and buyer fee on
  the order; tests use a recorded-fixture fake and prove the margin math,
  gating and that write methods refuse without the flag.

### T-35 — COD confirmation and risk signals
- Status: Planned — after T-34 adapter.
- Primary requirement: PR-19
- Constraints: Q-10, Q-14, PRIV-2, PRIV-3, NFR-2, TEN-1
- Dependencies: T-21, T-34
- Done when: COD orders start in `awaiting_confirmation`; sellers confirm,
  hold or reject with a reason; risk reasons show receiver score (read-only
  provider call, cached per order), repeat unconfirmed/cancelled orders for the
  same phone in the same store, and address completeness; nothing auto-books an
  unconfirmed order; tests cover each state and cross-store isolation.

### T-36 — Email order notifications
- Status: Planned — after `accounts` (mailer) and `jobs` (outbox) merge.
- Primary requirement: PR-21
- Constraints: NFR-4, NFR-5, PRIV-4, Q-16
- Dependencies: T-22, T-32, T-21
- Done when: order created/confirmed/shipped/cancelled events enqueue one email
  per event and recipient through the outbox (dev outbox until a provider is
  chosen); buyer email is optional at checkout; a signed, expiring order-status
  link shows only that order; tests prove at-most-once per event and link expiry.

### T-37 — COD remittance ledger (design gate)
- Status: Blocked — needs Q-17 (finance + legal).
- Primary requirement: PR-5
- Constraints: Q-17, BILL-1, BILL-3, NFR-2
- Dependencies: T-34, T-35
- Done when: the owner accepts a remittance policy; then a double-entry style
  ledger records COD collected, shipping cost, platform margin and seller
  payable per order, reconciled against provider reports.
