# Bukalaris Planning Task Queue

Each task's Status line owns its scoped delivery state; Done locally or delivered slices do not imply production readiness or completion of deferred scope. Planned tasks require their stated approval gates before implementation. Each task has one primary requirement; constraints do not create a second primary. Review disposition D-24 adds T-80 to T-94; it does not activate gated business/provider/legal choices.

Naming and ids: "Super Admin" and "Bos" in older task text mean the Owner console (`owner.bukalaris.com`, ADR-0011) and "Tenant Admin" means Seller Admin. Review ids from `docs/reviews/2026-10-27-code-vs-spec-gap-report.md` are written `CRMON-nn`, `CRSEC-nn`, `CRUXR-nn` and `CRDAT-nn` so they never collide with spec ids (`SEC-n`, `DATA-n`). Status and phase words follow the legend in the README. A `Dependencies:` line lists task ids only; explanations go in a `Notes:` line.

### T-1 — Verify Bukalaris repository and baseline
- Status: Done (M1, 2026-10-06; first commits on `main` 2026-10-06/07) — repository, pinned stack (DECISIONS D-1), schema, tests and docs recorded; see "M1 implementation evidence". Route/entry inventory is maintained in 04-SYSTEM-ARCHITECTURE ARCH-5 (T-12).
- Primary requirement: PR-1
- Constraints: CTX-5, TD-1
- Dependencies: None
- Done when: repository location, instructions, stack, current schema/routes,
  tests, provider code, and existing documents are recorded; this pack is
  reconciled without overwriting repository truth.

### T-2 — Approve tenancy and host model
- Status: Partial (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — store/buyer/affiliate/audit-writer RLS contexts (`packages/db/src/platform/tenant.ts:45-64`, `scoped.ts:122-170`), 79-table isolation registry with `bukalaris_owner`/`bukalaris_app`/`bukalaris_platform` plus no-login `bukalaris_restricted`/`bukalaris_resolver` roles and `SECURITY DEFINER` resolvers (`packages/db/src/platform/isolation-registry.ts:53-406`, `resolvers.ts:21-60`, T-27/T-59), and DOM-5 exact-host dispatch, 16 reserved host labels and per-surface `__Host-` session cookies (`packages/db/src/platform/host.ts:6-44,210-423`, `apps/web/src/proxy.ts:15-75`, T-70; ADR-0005/ADR-0008 accepted in D-20) are implemented locally; proven by `test/tenant-isolation.test.ts` ("tenant isolation", "host resolution"), `test/rls.test.ts` (48 cases: "isolation registry: completeness and shape per class", "fail closed (TEN-3)"), `test/rls-contract.test.ts` ("contract step: grants"), `test/host.test.ts` ("T-70 host × path × method golden table (DOM-5)"), `e2e/host-mode.spec.ts` ("a session cookie of one surface never opens a session on another"), worker (`test/jobs.test.ts`) and media (`test/content.test.ts` "product media"). Still open: custom domains (T-15, Q-8: only the fail-closed `customDomainStore` seam in `host.ts:173-181` exists; unbuilt work + owner decision), T-59 contract migration revoking legacy table-wide platform grants and T-59b separate operator identity tables (owner deploy approval / unbuilt work), public HTML cache isolation (not verified: no public HTML cache exists yet; T-69 Update Log is unbuilt), and owner acceptance of PR-3 / ADR-0001 (owner decision).
- Primary requirement: PR-3
- Constraints: TEN-1, TEN-2, TEN-3, DOM-1, SEC-1
- Dependencies: T-1, ADR-0001
- Done when: accepted schema/authorization/host-resolution contract has
  negative test targets for browser, worker, cache, media, and root tenant data.

### T-3 — Specify seller and Super Admin workflows
- Status: Partial (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — PR-1 and PR-2 accepted (D-21), ADR-0011 accepted (D-21); implemented locally across Seller Admin `SC-01`..`SC-08`, `SC-10`..`SC-17`, `SC-19`, `SC-21`..`SC-29` (added in 2026-10-28: `SC-25` `/seller/finance` in `apps/web/src/app/(seller)/seller/finance/page.tsx:1`, T-37; `SC-26` `/seller/customers/carts` in `(seller)/seller/customers/carts/page.tsx:1`, T-45; `SC-27` `/seller/promotions` in `(seller)/seller/promotions/page.tsx:1`, T-46; `SC-28`/`SC-29` `/seller/billing` with `BILLING_READ_ONLY_ALLOWED` in `packages/db/src/platform/scoped.ts:105`, T-50; `SC-22` Partner Mengantar view, T-48) and Owner console `SA-02`/`SA-03`/`SA-05`..`SA-10`/`SA-14`/`SA-16`..`SA-18`/`SA-20`/`SA-23`/`SA-24`/`SA-26`/`SA-28`/`SA-34`..`SA-39`/`SA-50`/`SA-53` plus `AU-06` behind `CONSOLE_ROUTES` and `authorizeConsole` (`packages/db/src/ops/console-routes.ts:6`, `console.ts:44`, `capabilities.ts:27`, `schema-ops.ts:122` `FOUR_EYES_MATRIX`, T-37/T-48/T-50/T-60/T-62/T-63/T-68; tested in `test/t62-routes.test.ts`, `test/t62-console.test.ts`, `test/t63-governance.test.ts`, `test/t68-issues.test.ts`, `e2e/t62.spec.ts`, `e2e/t63.spec.ts`, `e2e/t37.spec.ts`, `e2e/t50.spec.ts`). Still open: `SC-09` menus (derived nav ceiling in `(storefront)/s/[store]/(shop)/_lib.ts:20`), `SC-18` custom domains (T-15, Q-8), product duplicate/revision conflict UI on `SC-03` and CMS page revisions/preview on `SC-07`/`SC-08`, staff invitation/account creation on `SA-38` (awaits T-59b operator auth tables), `SA-27` reconciliation screen, `SC-30`/`SA-11`..`SA-13` affiliate screens (T-54), `SC-31`/`SA-40`..`SA-42` startup tax screens (T-66/T-71) (unbuilt work), and product-owner acceptance of the screen contracts in `17-UX-FLOWS-SCREEN-CONTRACTS.md` (owner decision).
- Primary requirement: PR-2
- Constraints: IAM-1, IAM-2, UX-1, UX-2
- Dependencies: T-1
- Done when: every Phase 1 screen/action/state/permission is accepted in the
  UX contract, including suspension, publish, validation, conflict, and audit.

### T-4 — Produce versioned OpenAPI and state-machine contract
- Status: Partial (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — `docs/openapi.yaml` (50 paths, 63 operations) passes `docs/check-spec.py` with 11 `x-implemented` operations (Storefront API v1 `HTTP-05`..`HTTP-11` in `apps/web/src/app/api/storefront/v1/**` now carrying `catalog_id` and `product_slug_alias` resolution in `packages/db/src/storefront/storefront.ts:36-62`, channel actions `SC-21`, and `requestShipment` `T-39`). In code, the order state machine (`TRANSITIONS` and courier/four-eyes `applyProviderTransition` with `returned` in `packages/db/src/seller/commerce/orders.ts:32-40,264-304`, DB trigger `order_status_guard` in migration 0014, tested in `test/orders.test.ts` and `test/t37b-review.test.ts`), the AutoLaris payment attempt/callback/verify-by-pull state machine and `HTTP-17` `POST /api/payments/autolaris/callback` (`packages/db/src/payments/contract.ts:1`, `callback.ts:28`, `apps/web/src/app/(public-services)/api/payments/autolaris/callback/route.ts:15`, `test/t49-payments.test.ts`, `e2e/t49.spec.ts`), `HTTP-23` issue export (T-68), `HTTP-27` referral click (T-52), and `HTTP-32` checkout resume (T-45) are implemented. Still open: transcribing the T-37/T-49 order, payment and shipment state machines (`returned`, `unknown`, `awaiting_account`) and `HTTP-17`/`HTTP-23`/`HTTP-26`/`HTTP-27`/`HTTP-32` into `docs/openapi.yaml`, HTTP pagination and `Idempotency-Key` on Storefront/Seller/Admin routes (unbuilt work), live provider callback/webhook schemas (external fact), and owner acceptance of API-1/API-2 (owner decision).
- Primary requirement: PR-5
- Constraints: API-1, API-2, TD-3, SEC-4
- Dependencies: T-1, T-2
- Done when: accepted operations and schemas cover catalog, cart, checkout,
  orders, provider callbacks, pagination/errors/idempotency; OpenAPI validates
  with the repository-approved validator.

### T-5 — Decide payment and shipping account ownership
- Status: Partial (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — PR-4, ADR-0006 and ADR-0007 are Accepted (D-20, D-21), and D-14/D-15/D-19/D-20/D-21/D-22 decide the unified Bukalaris-managed money and shipping boundary (`Bukalaris Kirim` / `Bukalaris Bayar`, Partner-managed Mengantar seller account per store with `platform_master` fallback and no `own_key`, COD/cashback release only when delivered AND reconciled, 72-hour payout destination hold, full-payable buyer refunds, and verify-by-pull AutoLaris callbacks). Implemented locally on fake adapters: immutable `order_financials`/`order_line_financials`/`shipment_cost`, append-only `ledger_entry`, four-eyes `reconciliation_batch`, `payout`, `refund`, `payout_control` and `pnpm verify:ledger` (`packages/db/src/ledger/ledger.ts:1`, `payouts.ts:1`, `reconciliation.ts:1`, `verify.ts:1`, T-37; `test/t37-ledger.test.ts`, `test/t37-payouts.test.ts`, `test/t37b-money.test.ts`, `test/t37b-review.test.ts`), Partner Mengantar provisioning/policy (`packages/db/src/shipping/accounts.ts:1`, `policy.ts:1`, T-48; `test/t48-accounts.test.ts`, `test/t48-orders.test.ts`), and AutoLaris payment attempts/callbacks (`packages/db/src/payments/attempts.ts:1`, `callback.ts:1`, T-49; `test/t49-payments.test.ts`). Still open before live money/dispatches: Q-1 AutoLaris commercial account & `courir_id: 1` profile approval, Q-17 legal review of holding seller COD funds, Mengantar Partner Secret rotation, `OPEN-F7` SPX free-return terms, `OPEN-F8` reconciliation fields, `OPEN-F9` Partner settlement/cashback sweep, and effective cashback/COD-fee rates (owner decision + external fact; no live transaction created).
- Primary requirement: PR-4
- Constraints: BILL-1, BILL-2, BILL-4, BILL-5, PRIV-3, Q-1, Q-2, ADR-0006
- Dependencies: Current provider account documentation and finance owner review
- Done when: finance owner records merchant/account ownership, fee disclosure,
  COD eligibility, order/payment/shipment lifecycle, reconciliation proof, and
  unknown-result policy; no live transaction is created by this task.

### T-6 — Create provider sandbox verification plan
- Status: Partial (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — Mengantar: server-only client (`packages/db/src/shipping/mengantar/client.ts:86`) with 5 sanitized read calls recorded in `docs/tracks/shipping.md` and fixture tests in `test/shipping.test.ts`; T-48 added the mandatory Partner Secret rotation entry gate (`mengantarRotationRecorded` in `packages/db/src/shipping/mengantar/gate.ts:1`, enforced in `client.ts:1` and `partner.ts:1` before any network read/write; tested in `test/t48-accounts.test.ts`) in addition to `MENGANTAR_WRITE_ENABLED=1` (`client.ts:57-62`). AutoLaris: T-49 implemented the full local contract, domain-tagged HMAC callback `?cb=<reff>.<hmac128>` and verify-by-pull inquiry on `FakeAutoLaris` with live settlement locked off (`ADVICE_SETTLED = []` in `packages/db/src/payments/settings.ts:2`, `contract.ts:1`, `fake.ts:1`; 46 tests in `test/t49-payments.test.ts`, `e2e/t49.spec.ts`), and T-50 wired subscription-invoice attempts (`packages/db/src/billing/attempts.ts:1`, `test/t50-payments.test.ts`). Still open: rotating the exposed Mengantar Partner Secret (`MENGANTAR_PARTNER_SECRET_ROTATED_AT`, `MENGANTAR_PARTNER_OLD_SECRET_REVOKED=1`), owner approval and sanitized sandbox capture for Mengantar writes/Partner API (`MENGANTAR_WRITE_ENABLED=1`, `OPEN-F7`..`OPEN-F9`), and AutoLaris sandbox credentials/calls (Q-1, `/submit` expiry & `callback_url` confirmation, vendor `advice` status/amount fields; not verified against live AutoLaris — owner decision + external fact).
- Primary requirement: PR-5
- Constraints: API-2, BILL-2, OBS-2, SEC-5, SEC-6
- Dependencies: T-5
- Done when: approved non-production, server-side test plan specifies a
  sanitized Mengantar estimate and AutoLaris creation/reconciliation evidence
  without credentials, orders, or production writes.

### T-7 — Define marketplace listing policy
- Status: Planned (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — later scope (`PR-6` Proposed in `docs/02-PRD.md:144`, `SA-04` `/admin/marketplace` Planned in `docs/04-SYSTEM-ARCHITECTURE.md:340`); no marketplace listing table, submission workflow or `SA-04` route exists in `apps/web` or `packages/db`. (T-52 added `affiliate_catalog` in `packages/db/src/affiliate/schema-affiliate.ts` for platform affiliate discovery under PR-28/ADR-0009, which hands off to single-store seller checkout and does not implement `bukalaris.com` marketplace listing or multi-seller checkout under Q-3; blocked on owner decision PR-6/Q-3 + unbuilt work.)
- Primary requirement: PR-6
- Constraints: DATA-3, IAM-3, BILL-3, UX-5
- Dependencies: T-3
- Done when: owner accepts listing eligibility, review states/reasons,
  takedown/appeal behavior, catalog sync ownership, and explicit prohibition of
  marketplace checkout before finance decision Q-3.

### T-8 — Define buyer account and affiliate data boundaries
- Status: Superseded (2026-10-27) — buyer identity, guest-to-account linking, recovery, privacy lifecycle and portal scope move to T-57/T-58 (ADR-0010, PR-7, IAM-4/IAM-14, DATA-12, PRIV-8). Affiliate attribution and no-PII affiliate reporting move to T-52–T-55 (ADR-0009). T-36 order-status links and T-43 per-store export/redaction remain separate completed/related work.
- Primary requirement: PR-7
- Constraints: DATA-4, IAM-4, PRIV-1, PRIV-2, UX-6
- Dependencies: T-1
- Done when: owner accepts guest-to-account linking, account recovery, data
  access/retention, affiliate attribution window, and no-PII affiliate view.

### T-9 — Design observability and security proof
- Status: Partial (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — implemented locally: correlation id + `TRUST_PROXY_REQUEST_ID=1` (`apps/web/src/proxy.ts:21-23`), allowlisted JSON logs + `system_log` sink + expanded `scrubText` stripping 8+ digit NIK/NPWP/bank runs and 40+ char tokens (`packages/db/src/ops/ops.ts:17-50`, T-23/T-62/T-68), per-action allowlist audit redaction with canary guard (`packages/db/src/ops/console-redaction.ts:1`, `test/t62-audit.test.ts`), restricted `personal_data_access_event` via `withPersonalDataAccess` (`packages/db/src/ops/console-access.ts:1`), job lag/dead-letter/replay-audit queries and `scheduler_heartbeat` (`packages/db/src/ops/jobs/observability.ts:22-87`, `scheduler.ts:1`, `SA-36` `/admin/ops`, T-62/T-74; `test/scheduler.test.ts`, `test/jobs-hardening.test.ts`), owner-pinned catalog-checked `retention_purge` functions (`packages/db/src/ops/jobs/retention.ts:1`, `test/retention.test.ts`), 79-table RLS isolation registry and negative tests (`packages/db/src/platform/isolation-registry.ts:53`, `test/rls.test.ts`, `test/rls-contract.test.ts`, T-59), capability grants/four-eyes/session-bound MFA (`packages/db/src/ops/capabilities.ts:1`, `test/capabilities.test.ts`, `test/capabilities-governance.test.ts`, T-60), per-surface host dispatch and cookies (`packages/db/src/platform/host.ts:210-423`, `test/host.test.ts`, `e2e/host-mode.spec.ts`, T-70), `mail_outbox` body purge and app-role revocation (`packages/db/src/ops/jobs/mail.ts:1`, `test/t73-mailer.test.ts`, T-73), and DB-backed rate limits (`RL-AUTOLARIS-CB`, `RL-PARTNER-MENGANTAR`, `RL-CLICK`, `RL-CODE`, `RL-ACCT-SEARCH`, `RL-ISSUE`, keyed phone fingerprints in `rate_limit.key`, T-45/T-48/T-49/T-52/T-57/T-63/T-68). Still open: external log/metric/alert sink and credentials (OBS-6), retention periods for log/audit/access/issue/signal/job classes (all purges OFF until owner sets periods), shared DB storage for Better Auth `RL-LOGIN`, session-bound CSRF token (DOM-6), T-59 contract step & T-59b separate operator auth tables, and synthetic checks against a deployed sink (owner decision + external fact + unbuilt work).
- Primary requirement: PR-5
- Constraints: OBS-1, OBS-2, OBS-3, SEC-1 through SEC-7, NFR-4
- Dependencies: T-1, T-4
- Done when: accepted signal/audit/redaction/rate-limit contract has named
  owners, safe synthetic checks, and a tenant-isolation negative test plan.

### T-10 — Specify the two built-in storefront themes
- Status: Partial (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — both built-in themes (`responsive` default, `mobile` capped at 480 CSS px via `[data-theme="mobile"] .sf-shell` in `apps/web/src/app/globals.css:136-169` and container queries in `apps/web/src/app/(storefront)/s/[store]/(shop)/layout.tsx:22-59`) are implemented (T-24), extended with `/s/[store]/promo` (`SF-12`, T-46), and verified at 320px and 1440px desktop without horizontal overflow (`e2e/content.spec.ts:105-160` including keyboard `Tab`/`Enter` add-to-cart at lines 151-160, `e2e/purchase.spec.ts`, `e2e/t46.spec.ts`, and LP theme-independence in `e2e/landing.spec.ts`). Still open: a dedicated 480px Playwright viewport project (only 320px and 1440px projects exist in `apps/web/playwright.config.ts`), full end-to-end checkout test run in the `mobile` theme, theme preview before publish on `SC-10` `/seller/settings`, `mobile` vs `mobile-480` enum alignment in `docs/openapi.yaml:4685` (unbuilt work), and design-owner visual sign-off on `UI-5` in `docs/10-DESIGN-SYSTEM-WHITELABEL.md` (owner decision).
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
- Status: Planned (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — T-42 delivered landing pages v1 (`SC-14`..`SC-16`, `SF-09` in `packages/db/src/storefront/landing.ts:1` and `apps/web/src/app/(storefront)/s/[store]/lp/[slug]/page.tsx:1` with typed blocks, compare-and-set draft revisions, immutable published pointers, and theme independence; `test/landing.test.ts`, `e2e/landing.spec.ts`), T-47 added demo seed LPs (`packages/db/src/demo/seed-demo.ts`, `test/t47-shipment-privacy.test.ts`), and T-52 wired affiliate attribution through `orderFromLanding` (`(storefront)/s/[store]/lp/actions.ts`, `test/t52-affiliate.test.ts`). No drag-and-drop visual builder (Puck spike), free layout composition around a locked form, or MCP server/tool code exists (`UX-7` Proposed; blocked on owner decision Q-9 form/builder scope + unbuilt work, with T-20).
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
- Evidence update (2026-11-04): ARCH-5 reconciled against the dirty tree over `2ddf5d2`; `pnpm map:check` passes with 102 route files, 124 current rows (117 implemented, including disabled/stub registrations). Every route has one exact-path owner. Guard mutation fixtures: 14 passed / 0 failed / 0 skipped, covering missing/phantom/ambiguous entries, planned-row concealment, duplicate IDs/owners, wrong URL, missing task/test/background locators and malformed tables. Existing worker registrations moved out of the future register; HTTP-23 duplicate and SA-17 ownership overlap removed. JOB-33 is an hourly disabled stub, not provider reconciliation; cleanup heartbeat remains absent. Structural/source evidence only, not a full symbol/runtime audit.
- Status: Done for `main` at `13f388f` (docs-scan, 2026-10-07) — ARCH-5 lists every route under `apps/web/src/app/**` and every background entry point exactly once with entry files, exported server operations, tables, capability, tests, task and status; retired/merged pages carry notes (AU-03, SA-01, SC-11, SC-20). Wave 4 rows flipped to Implemented and storefront paths moved to `s/[store]/(shop)/` at `c1adf27` (HTTP-16, JOB-07 added). Stays open as a maintenance rule ("How to keep this map current").
- Primary requirement: PR-10
- Constraints: ARCH-5, UX-8
- Dependencies: T-1, T-3
- Done when: every defined page has a stable ID and planned/implemented status;
  each developed page links to existing route/layout/component, service,
  schema/query, permission, test, and task owners at a checked code revision.
  Validate file links and route coverage against the actual repository; every
  page-changing task includes map maintenance. No placeholder claims code exists.

### T-13 — Specify Super Admin Log System and proof
- Status: Done via T-23 (merged 2026-10-07) — visible Log System nav entry, list/detail behind the `logs.read` grant, allowlisted filters, 24 h range cap, cursor paging, read audit, redaction before the sink, page/module mapping (`MODULE_MAP`), denied seller/operator-without-grant and DB-outage proof (`test/ops.test.ts`, `e2e/ops.spec.ts`). Open: stale/partial source states and retention (same-DB sink has no ingestion delay), external sink.
- Primary requirement: PR-11
- Constraints: OBS-5, UX-9, ARCH-5, IAM-1, IAM-5, NFR-4
- Dependencies: T-1, T-9, T-12
- Done when: existing UX/API/IAM/observability contracts define the visible
  button, restricted list/detail queries, safe projection, filters, correlation,
  page/module mapping, retention and query limits. Define synthetic sink-to-UI
  proof, denied access, redaction, and unavailable-source scenarios before
  implementation; do not treat a UI mockup as emitted-log evidence.

### T-14 — Specify concise product and advertising identity
- Status: Done for ids + aliases (merged 2026-10-07) — `catalog_id` from one sequence starting at 10000 on product and variant, immutable by trigger, string at every boundary (TS customType, Storefront API, `order_line.variant_catalog_id` snapshot); canonical storefront path by slug or catalog id with 308 from legacy db ids; slug aliases without chains. Open: feed export, OpenAPI field update, Meta item/group provider verification. Report `docs/tracks/catalog.md`. Main after wave-2a merges (2026-10-07): Vitest 104 passed, Playwright 56 passed + 2 skipped (every evidence step also asserts zero CSP violations).
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
- Status: Planned (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — lifecycle and operation contracts drafted (API-6, UX-11) and hosting direction set to Vultr + Coolify + Cloudflare (DECISIONS D-23, not provisioned); T-70 implemented the reserved label `cname` (`RESERVED_HOST_LABEL_LIST` in `packages/db/src/platform/host.ts:20`) and the fail-closed `customDomainStore` resolver seam in `resolveHostSurface`/`dispatchHostPath` (`packages/db/src/platform/host.ts:135,173-181,249`, proven by `test/host.test.ts:138-165`), and T-62 reserved the dormant P2 `/admin/domains` (`SA-19`) route slot (`packages/db/src/ops/console-routes.ts:40`). No custom-domain table, DNS/TLS verification workflow, routing-version cache invalidation, or `SC-18`/`SA-19` page exists yet (blocked on owner decision Q-8 custom-domain/SaaS TLS contract + unbuilt work).
- Primary requirement: PR-13
- Constraints: DOM-1, DOM-2, DOM-3, UX-11, ARCH-5, TEN-2, SEC-3
- Dependencies: T-1, T-2
- Done when: choose the domain/TLS provider and verify its official contract;
  define DNS instructions, ownership/certificate states, primary switching,
  removal/reassignment, tenant/cache isolation, canonical/feed URL updates,
  and failure recovery. Cover both store themes and independent LPs; map SC-18
  to actual code and tests when implemented. No live DNS mutation is authorized
  by completing this planning task.
- Added assertions (second documentation pass): the proxy's custom-domain resolver (T-70 slice 5) is invalidated by bumping a routing version in the same transaction as every domain mutation (bind, verify, unbind, primary change), and `cname` is a reserved label (08 DOM-5). A test shows a verified domain served and an unbound one refused on the next request after the mutation.

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
- Status: Partial (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — Storefront API v1 subset (`HTTP-05`..`HTTP-11` in `apps/web/src/app/api/storefront/v1/**`) is implemented, annotated `x-implemented` in `docs/openapi.yaml` (schemas `PublicProductSummary`, `PublicProduct`, `PublicVariant` synced with `catalog_id`), and hardened by T-59 (`authenticateChannel` and `exchangeHandoff` in `packages/db/src/storefront/channels.ts:126-213` resolve stores on the app pool via `resolve_channel_store`/`resolve_handoff_store` in `platform/resolvers.ts:36,42` under `FORCE ROW LEVEL SECURITY`), T-70 (`dispatchHostPath` in `packages/db/src/platform/host.ts:315,327` restricts `/api/storefront/v1/**` to the `app` host and `/checkout/h/[code]` to the `checkout` host, and `checkout-handoffs/route.ts:14` uses `surfaceOriginsFromEnv(process.env).checkoutOrigin`), T-14 (`catalog_id` and `product_slug_alias` resolution in `packages/db/src/storefront/storefront.ts:36-62`), and T-30 (`assertCartHasRoom` 30-line cap in `storefront.ts:98`). Proven by `test/channels.test.ts`, `test/rls-contract.test.ts:127`, `test/host.test.ts:57,64`, and `e2e/channels.spec.ts`. Still open: HTTP rate limiting on `/api/storefront/v1/**`, `Idempotency-Key` replay on cart/handoff mutations, product-list cursor pagination/search/collection filtering, and the remaining proposed Storefront/Checkout/Channel HTTP endpoints in `docs/openapi.yaml` (unbuilt work).
- Primary requirement: PR-14
- Constraints: API-7, ARCH-6, TEN-1, SEC-9
- Dependencies: T-1, T-4
- Done when: OpenAPI validates; every initial workflow has a schema or explicit
  owned gap; real route/auth adapters conform; negative access and replay checks
  pass in the repository. Headless flow uses T-19's platform checkout contract.

### T-17 — Resolve operator identity and membership
- Status: Partial (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — PR-15 is Accepted (D-21), ADR-0004/ADR-0008/ADR-0011 are Accepted (D-1, D-20, D-21); implemented locally: per-surface Better Auth instances (`local`, `owner`, `seller`, `affiliate`, `buyer`) with distinct secrets, exact `trustedOrigins`, and host-only `__Host-bl_owner`/`__Host-bl_seller`/`__Host-bl_aff`/`__Host-bl_buyer` cookies (`apps/web/src/lib/auth.ts:25-154`, `packages/db/src/platform/host.ts:210-222`, T-70; `test/host.test.ts`, `e2e/host-mode.spec.ts:132-200`), session-bound MFA (`session_mfa` hook in `auth.ts:128-133` and `operator()` gate in `apps/web/src/lib/context.ts`, T-60), platform capability grants, four-eyes `approval_request`, single-use step-up proofs, deterministic `FOR UPDATE` last-holder protection and immediate session revocation on grant/revoke (`packages/db/src/ops/capabilities*.ts`, T-60; `test/capabilities.test.ts`, `test/capabilities-governance.test.ts`, `e2e/capabilities.spec.ts`), Owner console staff/account governance `SA-23`/`SA-24`/`SA-38`/`SA-39`, atomic staff deactivation (`platform_operator.deactivated_at`), identity suspension (`user.suspended_at`), four-eyes MFA reset and `AU-06` support recovery (`packages/db/src/ops/accounts-governance*.ts`, T-63; `test/t63-accounts.test.ts`, `test/t63-staff.test.ts`, `e2e/t63.spec.ts`), plus `AU-01`..`AU-05` and `SC-19` (`test/lifecycle.test.ts`, `test/accounts.test.ts`, `e2e/accounts.spec.ts`). Still open: T-59b separate `restricted` operator identity tables with their own Better Auth schema and staff invitation/account-creation UI on `SA-38` (decided in D-20 item 6), self-service MFA disable/regenerate/QR UI on `AU-05`, and moving Better Auth sign-in/recovery rate limits from in-memory to shared DB storage across replicas (`RL-LOGIN`) (unbuilt work).
- Primary requirement: PR-14
- Constraints: PR-15, IAM-6, IAM-8, IAM-9, TEN-1, SEC-9
- Dependencies: T-1, T-3
- Done when: auth provider and PR-15 policy are accepted; login/recovery/store
  context/member workflows map AU-01 through AU-03 and SC-19/SC-20 to actual code
  and checks proving last-owner protection, revocation, expiry and denied access.

### T-18 — Establish release, data migration and recovery proof
- Status: Done for local scope (2026-10-07) — `pnpm verify`, `pnpm verify:docker`, CI workflow file (never executed; actions pinned to major tags, SHA pinning pending), backup + restore rehearsal scripts, media volume, `docs/RUNBOOK.md`. Staging/telemetry/restore-on-target evidence remains for deployment. Report `docs/tracks/release.md`.
- Primary requirement: PR-14
- Constraints: DEL-1, DEL-2, DEL-3, DR-1, DR-2, SEC-12, NFR-1 through NFR-5
- Dependencies: T-1, T-9, T-12, T-16, T-17, T-19
- Done when: actual repository scripts cover the verification plan in Delivery;
  staging critical-path, telemetry, DB migration and isolated restore evidence
  is recorded at a known revision; provider/finance/privacy gaps have owners
  and are resolved before the affected paths go live. No release occurs by implication.
- Added assertions (second documentation pass): offsite dumps are encrypted client-side before upload (OPEN, recommended, not decided; 14) and keep owners and ACLs; the provisional availability, RPO and RTO numbers in 14 are OPEN (recommended, not decided). After T-70 the synthetic probe is host-aware per OBS-6 and no longer tests path-mode URLs. The restore rehearsal asserts grants per role and replays erasure records (SEC-23; checked in T-59).

### T-19 — Deliver external storefront channel and hosted checkout contract
- Status: Partial (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — channel registration (`SC-21` `/seller/channels` in `apps/web/src/app/(seller)/seller/channels/page.tsx:1`), `blsk_<prefix>_<secret>` hashed tokens, one-use 10-minute checkout handoff (`HTTP-11`/`HTTP-12`, `SF-10` `/checkout/h/invalid`), and allowlisted post-checkout return links (`channelReturnTarget` in `packages/db/src/storefront/channels.ts:216-235`) are implemented and hardened by T-59 (`resolve_channel_store` and `resolve_handoff_store` on the app pool under `FORCE ROW LEVEL SECURITY` in `packages/db/src/platform/resolvers.ts:36,42` and `isolation-registry.ts:73-74`) and T-70 (separate checkout origin `surfaceOriginsFromEnv(process.env).checkoutOrigin` in `apps/web/src/app/api/storefront/v1/carts/[cartId]/checkout-handoffs/route.ts:14` and DOM-5 host dispatch in `packages/db/src/platform/host.ts:326-331`). Proven by `test/channels.test.ts`, `test/rls-contract.test.ts`, `test/host.test.ts`, `e2e/channels.spec.ts`, and `e2e/host-mode.spec.ts`. Still open: IAM-11 policy on whether revoking a channel invalidates an already-exchanged checkout cookie session (owner decision), plus Storefront API / handoff HTTP rate limiting and `Idempotency-Key` replay on `createCheckoutHandoff` (unbuilt work).
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
- Status: Planned (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — future milestone; documentation boundary defined (`PR-17`, `TD-6`, `DATA-6`, `API-9`, `IAM-12`, `UX-13` Proposed in `docs/17-UX-FLOWS-SCREEN-CONTRACTS.md:334`). Core store-scoped catalog, content, revision and audit services exist in T-51 bounded contexts under T-59 `FORCE ROW LEVEL SECURITY` (`packages/db/src/seller/commerce/catalog.ts`, `packages/db/src/storefront/content.ts`, `landing.ts`), but zero MCP server, SDK, tool schema, scoped connector grant or `UX-13` review/revoke UI exists in `apps/web` or `packages/db` (blocked on owner decision for MCP milestone/protocol pin + unbuilt work, and T-11 before LP tools).
- Primary requirement: PR-17
- Constraints: TD-6, DATA-6, API-9, IAM-12, UX-13, TEN-1, SEC-9
- Dependencies: T-1, T-3, T-4, T-17; T-11 before enabling LP tools
- Done when: pin verified protocol/SDK and tool schemas; implement core-backed
  read/draft/preview/publish operations with scoped grants and revision-bound
  human approval. Prove denied foreign access, revocation, conflict, replay,
  partial batch recovery and protected price/stock/customer fields with runnable
  tests. Show the review/revoke journey in Seller Admin and link audit evidence.

## Stack planning update — 2026-09-25

Superseded in part (2026-10-27): the `bos` host and the Astro public-rendering recommendation in the next paragraph are replaced by ADR-0008 (one Next.js application; `owner` for the Owner console, `app` for Seller Admin) and DECISIONS D-2. The paragraph is kept as dated history.

Decision: Next.js, TypeScript, shadcn/ui and Tailwind CSS are selected. The operator
and seller admin domains were fixed then (as Bos and Tenant Admin). Architecture recommends Astro public rendering,
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
- Status: Done (merged 2026-10-07) — dev mail outbox, recovery without enumeration, hashed single-use invitations with atomic account creation, session revocation on orphaned removal, operator TOTP enforced before /admin. Open: real email provider, MFA disable/regenerate UI, QR code. Report `docs/tracks/accounts.md`. Integration evidence on `main` (2026-10-07): Vitest 88 passed, Playwright 41 passed + 1 skipped after merging all wave-1 branches.
- Primary requirement: PR-15
- Constraints: IAM-5, IAM-8, IAM-9, NFR-4, SEC-1
- Dependencies: T-17
- Done when: recovery does not reveal account existence; invitations are
  hashed, expiring, single-use, store-bound and role-bounded; operators cannot
  open `/admin` without verified TOTP; removed members lose access on the next
  request; tests and e2e prove each denial case.

### T-23 — Correlation, structured logs, Log System and error pages
- Status: Done (merged 2026-10-07) — correlation id, allowlisted JSON logs, `system_log` sink, Log System list/detail behind `logs.read` grant with access audit, error pages with request id, `/api/ready`; DB-outage proof in `e2e/ops.spec.ts`. Open: external sink/alerting, retention job, inbound request-id trust (T-29). Report `docs/tracks/ops.md`. Integration evidence on `main` (2026-10-07): Vitest 88 passed, Playwright 41 passed + 1 skipped after merging all wave-1 branches.
- Primary requirement: PR-11
- Constraints: OBS-5, UX-9, IAM-1, NFR-4, NFR-5, SEC-10
- Dependencies: T-13
- Done when: requests carry a validated correlation id; sanitized events reach
  the Log System list/detail behind `logs.read`; empty and unavailable sources
  are distinct; a DB outage renders a friendly error page with the request id;
  `/api/ready` reports DB readiness.

### T-24 — Store settings and the two storefront themes
- Status: Done (merged 2026-10-07) — store settings and `responsive`/`mobile` (480px) themes via container queries; no overflow at 320px asserted. Report `docs/tracks/content.md`. Integration evidence on `main` (2026-10-07): Vitest 88 passed, Playwright 41 passed + 1 skipped after merging all wave-1 branches.
- Primary requirement: PR-8
- Constraints: UI-1, UI-3, UX-3, NFR-3, TEN-1
- Dependencies: T-10
- Done when: owners edit store profile and choose `responsive` (default) or
  `mobile` (≤480px); both themes render home, collection, product, cart,
  search and pages with no horizontal overflow at 320px; checkout is unchanged
  by the theme.

### T-25 — Collections, CMS pages, search and product media
- Status: Done (merged 2026-10-07) — collections, CMS pages (safe markdown-lite), search, product media with content sniffing and path-confined storage. Open: object storage, resizing. Integration evidence on `main` (2026-10-07): Vitest 88 passed, Playwright 41 passed + 1 skipped after merging all wave-1 branches.
- Primary requirement: PR-2
- Constraints: DATA-6, TEN-5, SEC-2, SEC-8, NFR-3
- Dependencies: T-24
- Done when: collections, pages and media are store-scoped with same-store
  constraints; uploads are validated by content; unpublished content is hidden;
  storefront search returns only the store's published products.

### T-26 — Super Admin store detail and creation
- Status: Done (merged 2026-10-07) — `/admin/stores/new` (existing owner email) and `/admin/stores/[id]`. Integration evidence on `main` (2026-10-07): Vitest 88 passed, Playwright 41 passed + 1 skipped after merging all wave-1 branches.
- Primary requirement: PR-1
- Constraints: IAM-5, UX-1
- Dependencies: T-3
- Done when: an operator creates a store with an existing owner account and
  sees status, counts and recent audit on `/admin/stores/[id]`; sellers are denied.

### T-27 — Database-enforced tenant isolation
- Status: Done (merged 2026-10-07) — roles bukalaris_owner/app/platform (bootstrap `packages/db/docker/05-roles.sql`, `scripts/db-roles.sh`), hand-written `0007_rls.sql`: `app_store_id()` + ENABLE/FORCE `tenant_isolation` on 26 tables, least-privilege grants; `withStore` sets `app.store_id` transaction-locally; cross-store resolvers on the platform pool; import-boundary test. Evidence on `main` (`0a3cfd8`): Vitest 137 passed under `bukalaris_app` (8 in `test/rls.test.ts`), Playwright 72 passed + 2 skipped, `verify:docker` policies=26, restore rehearsal rls_ok=yes (26/26 policies, app role 0 rows without context, 3/3 with). Report `docs/tracks/rls.md`.
- Primary requirement: PR-2
- Constraints: NFR-1, TEN-3, DATA-1, TD-2, DECISIONS D-4
- Dependencies: T-21, T-22, T-23, T-25
- Done when: the app runs as a non-owner role with RLS on every store-owned
  table, store context set per transaction inside the scope helpers, migrations
  run as the owner role, and the whole integration suite passes under the
  runtime role, including a test that a missing store context returns no rows.

### T-28 — Seller and Super Admin UI consistency pass
- Status: Done (merged 2026-10-07) — shared AdminShell (skip link, nav scrolling inside the header at 320px, aria-current), PageHeader/EmptyState/StatusBadge with Indonesian labels for every status, WIB dates, confirm dialogs on destructive actions, loading/error states only where no redirect/notFound sits below, data tables scroll inside their container; `e2e/ui.spec.ts` captures every seller/admin page at 320px and desktop. Open: dark mode not rendered, field-level server error mapping, `/seller/marketing` predates the shell patterns. Report `docs/tracks/ui.md`. Main after wave-2b merges (2026-10-07): Vitest 129 passed, Playwright 72 passed + 2 skipped (CSP guard on every evidence step).
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
- Status: Done (merged 2026-10-07) — nonce CSP with strict-dynamic, frame-ancestors none, nosniff/Referrer/Permissions, HSTS only on HTTPS with `ENABLE_HSTS=1`, no X-Powered-By; shadcn CLI moved to devDependencies (`pnpm audit --prod`: 1 moderate left, unreachable at runtime); inbound request id trusted only with `TRUST_PROXY_REQUEST_ID=1`. Report `docs/tracks/hardening.md`. Main after wave-2a merges (2026-10-07): Vitest 104 passed, Playwright 56 passed + 2 skipped (every evidence step also asserts zero CSP violations).
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
- Status: Done (merged 2026-10-07) — Postgres fixed-window limits (order 60/10 min per IP, 5/min per cart, 10/10 min per phone; cart 300/10 min per IP, 60/10 min per cart), 30-line cart cap, `pnpm --filter @bukalaris/db cleanup` for carts idle > `CART_IDLE_HOURS` (168). Open: IP dimension skipped without a trusted proxy header; cap is check-then-insert. Report `docs/tracks/checkout2.md`. Main after wave-2a merges (2026-10-07): Vitest 104 passed, Playwright 56 passed + 2 skipped (every evidence step also asserts zero CSP violations).
- Primary requirement: PR-4
- Constraints: SEC-16, NFR-1, NFR-5, Q-10, UX-4
- Dependencies: T-21
- Done when: order submission and cart mutation are rate limited per client
  network signal and per cart/phone with a retryable, user-readable response;
  a cart is capped (lines and quantity); carts idle beyond a configured age are
  deleted by a scheduled job without touching checked-out carts; tests prove
  limits, caps and cleanup boundaries.

### T-31 — Audit catalog and price changes
- Status: Done (merged 2026-10-07) — `catalog_audit` rows in the same transaction for product/variant create/update incl. price, stock, status; history panel on the product page. Main after wave-2a merges (2026-10-07): Vitest 104 passed, Playwright 56 passed + 2 skipped (every evidence step also asserts zero CSP violations).
- Primary requirement: PR-2
- Constraints: SEC-17, IAM-5
- Dependencies: T-1
- Done when: product and variant create/update/price/stock-field changes write
  an audit row (actor, store, object, before/after of price and status) in the
  same transaction; a seller-visible history on the product page; tests prove
  rows exist and are store-scoped.

### T-32 — Durable outbox and worker for post-commit side effects
- Status: Done (merged 2026-10-07) — `job` outbox, `FOR UPDATE SKIP LOCKED` claims with leases, backoff, worker process with LISTEN wake-up and graceful stop; payment instruction moved onto it. Deployment of the worker (same image, `node packages/db/src/worker.ts`) is pending in the deploy plan. Report `docs/tracks/jobs.md`. Integration evidence on `main` (2026-10-07): Vitest 88 passed, Playwright 41 passed + 1 skipped after merging all wave-1 branches.
- Primary requirement: PR-5
- Constraints: SEC-18, TD-3, NFR-2, NFR-5, ARCH-6
- Dependencies: T-21, T-23
- Done when: business writes enqueue side effects in the same transaction;
  a separate worker process (same image, different command) claims jobs with
  `FOR UPDATE SKIP LOCKED`, retries with backoff and idempotency keys, and
  records terminal failures; the payment-instruction call moves onto it;
  crash-in-the-middle and duplicate-claim tests pass.

### T-33 — Buyer personal-data lifecycle
- Status: Partial (re-checked 2026-10-28; report `docs/tracks/audit-partial.md`) — PR-4 is Accepted (D-21); the previous `shipment` inventory gap and the `D-10` `mail_outbox` app-role `UPDATE` ceiling are both closed: T-47 added `shipment.{tracking_history,provider_status,last_error}` to `BUYER_DATA_INVENTORY`, `exportBuyerData` and `redactOrders` (`packages/db/src/seller/commerce/privacy.ts:72-74`, `docs/13-COMPLIANCE-PRIVACY.md:73,97`), stripped new tracking polls on redacted orders (`packages/db/src/shipping/fulfillment.ts` `applyTracking`), and guarded `purchasePayload` in `packages/db/src/storefront/signals.ts` against hashing `[dihapus]` (`test/t47-shipment-privacy.test.ts`, 17 tests); T-45 added `checkout_session` to the inventory, export, redaction (`redactCheckoutSessions`, `SC-24`) and 30-day `cleanup.ts` purge (`privacy.ts:76-79`, `test/t45-abandoned.test.ts`); T-73 revoked all `bukalaris_app` privileges on `mail_outbox` and moved mail export/redaction to the store-bound `SECURITY DEFINER` functions `mail_privacy_export` and `mail_privacy_redact` (`packages/db/src/platform/isolation-registry.ts:194,348-349`, `test/t73-mailer.test.ts`); T-57 classified global `buyer*` tables as `handling: "global"` and keyed `rate_limit.key` phone lookups with `KEYRING_BUYER_FINGERPRINT` (`privacy.ts:85,97-102`, `test/t57-buyer.test.ts`). Still open: privacy-owner decision on `BUYER_DATA_RETENTION_DAYS` (Q-11; `redactStaleOrders` in `cleanup.ts` is implemented and tested in `test/privacy.test.ts` but stays off until set — owner decision), automated replay of `order_redaction`/erasure records in `scripts/db-restore-rehearsal.sh` (SEC-23/PRIV-4 — unbuilt work), and global buyer self-service export/deletion on `BA-06` (T-58, PRIV-8 — owner decision + unbuilt work).
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
- Status: Done for quotes (merged 2026-10-07) — phase 1 read client/margin/pickup area plus phase 2 checkout wiring: destination area search, gated courier options, server re-quote and order snapshot with CHECK fee = provider cost + margin. Real Mengantar used only when `MENGANTAR_API_KEY` is present at runtime; automated tests use the fake. Open: weight is 1 kg per line, shipment booking (write approval), Q-17. Main after wave-2a merges (2026-10-07): Vitest 104 passed, Playwright 56 passed + 2 skipped (every evidence step also asserts zero CSP violations).
- Primary requirement: PR-5
- Constraints: Q-12, Q-13, NFR-4, NFR-5, TEN-1, SEC-9, DATA-2
- Dependencies: T-21, T-32
- Done when: a server-only Mengantar client implements the read operations
  with timeouts, redacted logging and typed errors; one sanitized observed call
  per used operation is recorded in `docs/tracks/shipping.md`; sellers set a
  pickup area via area search; the Owner console sets the platform margin rule;
  checkout shows only couriers with `unsupported=false`, hides COD where
  `unsupported_cod=true`, and snapshots provider cost, margin and buyer fee on
  the order; tests use a recorded-fixture fake and prove the margin math,
  gating and that write methods refuse without the flag.

### T-35 — COD confirmation and risk signals
- Status: Done (merged 2026-10-07) — COD orders start `awaiting_confirmation`; confirm / hold / reject (reject restocks once); store-local risk signals (repeat phone, address completeness, amount > 2× store COD median). Provider receiver score not used (403). Main after wave-2a merges (2026-10-07): Vitest 104 passed, Playwright 56 passed + 2 skipped (every evidence step also asserts zero CSP violations).
- Primary requirement: PR-19
- Constraints: Q-10, Q-14, PRIV-2, PRIV-3, NFR-2, TEN-1
- Dependencies: T-21, T-34
- Done when: COD orders start in `awaiting_confirmation`; sellers confirm,
  hold or reject with a reason; risk reasons show receiver score (read-only
  provider call, cached per order), repeat unconfirmed/cancelled orders for the
  same phone in the same store, and address completeness; nothing auto-books an
  unconfirmed order; tests cover each state and cross-store isolation.

### T-36 — Email order notifications
- Status: Done (merged 2026-10-07) — optional buyer email; `order.notify` jobs enqueued in the same transaction as created/confirmed/shipped/cancelled transitions, at most once per event+recipient (unique row), escaped HTML/text emails via the dev Mailer; signed order-status link `/o/<id>.<exp>.<hmac>` (30 days, constant-time check). Open: real email provider + SPF/DKIM/DMARC, link revocation before expiry. Report `docs/tracks/notify.md`. Main after wave-2b merges (2026-10-07): Vitest 129 passed, Playwright 72 passed + 2 skipped (CSP guard on every evidence step).
- Primary requirement: PR-21
- Constraints: NFR-4, NFR-5, PRIV-4, Q-16
- Dependencies: T-22, T-32, T-21
- Done when: order created/confirmed/shipped/cancelled events enqueue one email
  per event and recipient through the outbox (dev outbox until a provider is
  chosen); buyer email is optional at checkout; a signed, expiring order-status
  link shows only that order; tests prove at-most-once per event and link expiry.

### T-37 — Seller ledger, COD remittance, payouts, and buyer refunds
- Status: Delivered locally 2026-10-28 against the fake Mengantar/AutoLaris adapters (working tree, not committed; migrations 0013 section T-37 and 0014; `packages/db/src/ledger/**`, seller `/seller/finance`, Owner `/admin/payouts`, `/admin/money`, `/admin/money/cod-reconciliation`, `/admin/stores/[id]/ledger`, `pnpm verify:ledger`; reports `docs/tracks/t37.md`, `t37b.md`). Independent security review done (BUILD-LOG); the P1 (release job starved stores beyond the first 200) and the P2 (a payout with an unknown transfer outcome could be re-claimed and re-credited) plus the P3s are fixed with named tests; 27 money invariants were each broken on purpose and a named test failed (table in `t37b.md`). DEFERRED (exact decision in `t37b.md`): shipping cashback (owner split rule and rate, T-48), affiliate commission in the sale amount (T-53), COD fee and its VAT and the store sales-tax price mode (owner COD fee schedule, T-65 wiring), transfer-evidence retention period (owner), HTTP-31 CSV export (no decision missing, not built), provider balance freshness on SA-26 (no source), a console setter for `destination_hold_hours` (SA-34 audited settings path), live COD (`ALLOW_COD_BOOKING=1`, Q-17), OPEN-F7/F8/F9, real transfers. The first four-eyes refund approval for a gateway-paid cancelled order is delivered (wave 2 review finding). Second independent review of the finish build (1 P2, 8 P3): fixed the P2 (the step-up code could be guessed without limit from a stolen owner session: 5 attempts per 15 minutes per user, 20 per store, every attempt counts, `limitStepUpAttempts`). DEFERRED P3s: restrict the platform grant on `payout_control` to the freeze columns with an UPDATE guard and make the hold hours owner-only, plus a restore step that freezes payouts as owner before the app starts (RUNBOOK note added); the demo-reset marker should also require the owner role; the DB should require an EXECUTED approval and a registry row for the evidence reference (today the service enforces both); `refunds_failed` counts a reopened-and-failed-again refund twice; the buyer refund form has no rate limit, audit row or notice; the payout holder-name check compares with `user.name`, which Better Auth `/update-user` can change (compare with a name the owner console fixed, or block the field); a dedicated authenticated upload route instead of the global 11 MB Server Action limit.
- Primary requirement: PR-23
- Constraints: PR-5, Q-17, BILL-1, BILL-4, BILL-5, DATA-7, DATA-14, TEN-1, TEN-3, NFR-2, UX-14, IAM-15, ADR-0006
- Dependencies: T-34, T-35, T-39, T-51, T-60, T-62, T-74
- Added assertions (D-21, 99ribu study; each needs a named automated test): (a) the ledger consistency invariants of DATA-7: `pnpm verify:ledger` (read-only) and a Vitest case recompute every store and prove one `sale` per order, at most one `return_reversal` per order, `available` never negative, every payout and payout reversal paired with a payout row, every released entry carrying `released_at` and `release_basis`, and no balance query joining `order`; (b) an unknown payout transfer outcome stays allocated, is never re-queued or re-credited until reconciliation proves no effect; (c) a bank-transfer evidence reference or artifact cannot be reused across payouts (database-enforced uniqueness, checked after normalising the reference); (d) a payout claim is an exclusive expiring lease, and the step-up proof is single-use and consumed inside the same transaction as the write (a failed write leaves it unconsumed until it expires); (e) gross-to-net-and-fees allocation uses integer largest-remainder so the parts always sum to the gross and no part is negative; (f) claim, release and reversal are proven under real PostgreSQL lock-barrier concurrency tests, not only sequential ones. This task also writes the lesson-to-test map required by D-20 (lesson, ADR/BILL id, test file and case).
- Notes: T-60 and T-62 supply the `payouts.process` and `refunds.process` grants and the `approval_request` four-eyes service, so the payout and refund approval path cannot ship earlier. T-51 is a dependency because the order, shipment and provider files this task changes move there (a freeze window on those files is not used). If the owner wants the ledger earlier than the Owner console shell, the approval slice can be split out of this task (recommended, not decided).
- Done when: `order_financials`, `ledger_entry`, `payout` and `refund` tables
  exist under FORCE RLS; checkout freezes `order_financials` and reconciles
  Mengantar booking deltas; the release rule follows D-14 (ADR-0006, DATA-7):
  a platform-account COD sale is booked `pending` at delivery (`completed`) and
  reaches `available` only through an applied `reconciliation_batch_item`; a
  prepaid sale is `pending` at paid and released at delivered; `ledger_entry`
  carries `release_basis` and `reconciliation_item_id` (CHECKs: a COD release
  needs an applied item); the Owner console batch (`reconciliation_batch`,
  `reconciliation_batch_item`, provider evidence references) is prepared by one
  staff member and approved by another through the four-eyes action
  `cod.reconcile_release` (capability `payouts.reconcile`); the preparer is never
  the approver; the provider-reconciliation poll stays off
  (`provider_reconciliation_enabled` default false) until the provider signal is
  observed; the H+1 delay is gone and no `cod_release_delay_hours` or
  `release_after` exists; the order-status writer lets `returned` (RTS) be
  reached only from in-transit states (`completed -> returned` does not exist),
  restores stock once, reverses a still-pending prepaid sale pending-against-pending,
  and never makes `available` negative; returns after delivery are outside the
  ledger scope in M3 (a four-eyes `adjustment`); all orders run in one unified
  Bukalaris-managed shipping and payment system (no `own_key` external seller
  keys and no System A / System B split, D-15), and `ledger_entry` also books
  the seller's share of shipping cashback (`kind = 'cashback'`, guarded by
  `ledger_one_cashback_per_order`, released only when delivered and reconciled);
  COD is offered only for courier services with `cod_allowed` and `return_free`
  in the data-driven `courier_service_policy` (currently SPX only, UNVERIFIED,
  live gate OPEN-F7;
  administered under T-48); booking reserves `shipping_debit` under the per-store
  advisory lock and refuses before the provider call when available balance is
  short, refuses prepaid orders before payment, derives COD from the order's
  payment method, keeps the reservation on transport failure and on cancellation
  acceptance, and writes `shipping_debit_reversal` only after provider
  confirmation or a definite rejection; the order-status writer has an explicit
  legal-transition table that accepts provider-driven forward jumps, records
  rejected transitions instead of dropping them, and refuses `completed ->
  cancelled`; sale credit skips `cancelled`/`returned` orders, a late payment on
  a terminal order is quarantined with a refund obligation, a `paid` payment is
  never regressed by a later `expired`/`failed` callback, and a terminal order
  accepts no new payment attempt; store-owner payout requests serialize on
  `pg_advisory_xact_lock` and snapshot bank details; Owner console staff decide
  payouts and non-COD buyer refunds only under `payouts.process` and
  `refunds.process` (IAM-15) through a DATA-14 `approval_request` (a second staff
  member approves, the requester cannot; the payload hash covers the payout or
  refund id, amount and bank snapshot, and the `payout` and `refund` rows carry the
  `approval_request_id`), and a manual `adjustment` needs `ledger.adjust` with
  the same approval; a read-only
  ledger verification command reports orphan entries and balance/sum
  disagreements without joining `order` in any balance sum; merchant and
  buyer surfaces display `Bukalaris Kirim` / `Bukalaris Bayar` (source-guarded);
  Vitest and Playwright prove double-callback idempotency, concurrent payout
  safety, no credit before delivered-and-reconciled, reconciliation batch four-eyes, late-callback
  quarantine, and cross-store isolation. Provider facts in ADR-0006 decision 10
  stay UNVERIFIED and gate live use, not local implementation.
- Review scope (2026-10-27, `docs/reviews/2026-10-27-code-vs-spec-gap-report.md`; its ids carry the `CR-` prefix): this task also owns the
  order-money correctness fixes the code review found, because the ledger is wrong without them:
  CRMON-01 (`order` total constraint and `placeOrder` host `order_financials`), CRMON-02 (`returned` state;
  one status writer with a legal-transition table that accepts provider-driven forward jumps, records
  rejected transitions and treats same-status as a no-op), CRMON-03 (no cancel while a booking is in
  flight, and no booking for a cancelled order), CRMON-04/CRMON-15 (a non-retryable `unknown` booking state
  with `GET /order` reconciliation, and a lease that cannot expire under the account lock),
  CRMON-05 (tracking rows matched to the booking's `ORDER_ID`), CRMON-09/CRMON-11 (live re-quote and booked-cost
  record at booking; COD amount basis equal between quote and booking), CRMON-14 (vendor names only on
  the ADR-0007 allow-list, source-guarded) and CRMON-16 (replace tests that assert the forbidden
  blind rebook, second creation and `shipped` RTS with tests of the new behaviour).
- Added assertions (second documentation pass; structures and rules are in ADR-0006, BILL-4, BILL-5, DATA-7 and the IAM-15 four-eyes matrix):
  - Four-eyes sits on approve-for-transfer (`requested -> processing`) for seller payouts and buyer refunds; the approver sees the bank snapshot; mark-paid only records evidence and needs no second approver; an unknown transfer outcome stays `processing`.
  - New structures: `shipment_cost` (append-once booked cost, so `order_financials` stays immutable), `order_line_financials`, `sale_amount_idr` on the sale entry, partial unique indexes for `payout`, `payout_reversal` and the `adjustment` business reference, a payout request key, `payout_destination`, the `refund` composition columns, and `approval_request_id` on payout, refund and adjustment. The allocation identity (payable = goods proceeds + included tax + added tax + shipping charged + COD fee + COD-fee VAT) is asserted on fixtures; the per-line largest-remainder allocation sums exactly.
  - Booking runs as quote, then one reserve transaction (the `shipping_debit` may net against the order's own pending sale), then the provider call after commit, never under a lock. The COD amount equality check at booking refuses with `cod_amount_mismatch`. Lock order is order row, store lock, ledger rows (two-key advisory form); release and return both lock the sale row, and release runs only `WHERE status='pending' AND NOT EXISTS reversal`, with a race test for each ordering.
  - COD credit comes only from the provider's DELIVERED status or the four-eyes action `cod.manual_complete` with evidence; a seller can never complete for credit. Returns and refunds are full-only in M3.
  - A change of payout destination needs step-up, notifies the old contact, checks the account-holder name, and starts a mandatory **72-hour hold** (`hold_until`, decided default 72 hours, Owner-configurable, D-19).
  - This task owns JOB-24 `ledger.release` (enqueued by T-74 JOB-21), feeds SA-26 from the `platform_money_position` view, and provides the payout-job freeze switch used after a restore (14, RUNBOOK).
  - Superseded by the owner decisions D-14, D-15 and D-19 (later on 2026-10-27): OPEN-F1, OPEN-F2 and OPEN-F5 are closed; nothing is credited before delivered-and-reconciled and in-transit returns never make `available` negative. OPEN-F4 (refund composition and disbursement) and OPEN-B1 (lapsed subscription periods) are closed by D-20 (2026-10-28). Still OPEN with recommended defaults, not decided here: COD booking when the available balance cannot cover the shipping debit (OPEN-F3), the courier cost of a prepaid parcel returned in transit (OPEN-F6; recommended: net it against the next released sale), the unverified SPX free-return terms (OPEN-F7, live gate), the meaning of the provider fields `isReconciliated` / `typeReconciliation` (OPEN-F8), and Partner API settlement/cashback sweep mechanics (OPEN-F9).
  - One unified Bukalaris money system (D-15): all stores ship under Bukalaris-provisioned Partner Mengantar accounts (`partner_managed`, with `platform_master` fallback; no `own_key` and no System A/B split; `SA-54` is retired into `SA-07`). The seller finance screen (UX-14) shows one unified balance and statement (including `cashback`).
  - Tests added by the final policy round: a return in transit never makes `available` negative; a COD `sale` or `cashback` entry cannot reach `available` without an applied reconciliation item; the batch approver is never the preparer; a delivered unreconciled order stays `pending`; batch replay releases once; a non-allowed courier service never offers COD; `provider_reconciliation_enabled` is false by default and the poll does nothing while it is false.
  - The Owner console COD reconciliation screen is SA-53 (reconciliation queue and batch detail), delivered on the T-62 shell; JOB-24 `ledger.release` releases reconciled COD/cashback entries and delivered prepaid sales.

### T-38 — Conversion signals (Meta, TikTok, Google)
- Status: Done in simulation (merged 2026-10-07) — `/seller/marketing` destinations with AES-256-GCM write-only tokens (AAD bound to store+provider), first-party click ids, pixels initialised once on storefront/checkout only, shared event ids, server Purchase (COD at creation, prepaid at "mark paid") through the outbox, value excludes shipping, variant catalog ids; delivery is `simulated` unless `SIGNALS_LIVE=1`. Provider contracts UNVERIFIED until the owner approves a test-event call. Open: Google offline conversions after delivery, consent review, email matching now possible with T-36 buyer email. Report `docs/tracks/signals.md`. Main after wave-2b merges (2026-10-07): Vitest 129 passed, Playwright 72 passed + 2 skipped (CSP guard on every evidence step).
- Primary requirement: PR-20
- Constraints: PR-12, Q-7, Q-15, NFR-4, PRIV-3, PRIV-5, TEN-1, SEC-11
- Dependencies: T-14, T-32, T-21
- Done when: per-store destination settings with encrypted write-only tokens;
  browser pixels initialised once with a shared event id per funnel event;
  server Purchase (COD at creation, prepaid at settlement) enqueued in the
  order transaction and delivered by the worker with idempotency and sanitized
  errors; seller health view; tests cover hashing/normalization, dedup ids,
  value excluding shipping, variant content ids, retry/permanent-failure paths
  and cross-store isolation; any real destination call uses a test-event code
  and is recorded as sanitized evidence.
- Added follow-ups (second documentation pass): Meta `autoConfig` is set to `false` (CRSEC-05); tokens sealed before the keyring change are read as key `k1`, and new envelopes carry a `key_id` (SEC-22).

## M2 wave 4 — 2026-10-07 (no new provider writes or approvals needed)

### T-39 — Shipment booking and tracking via the outbox
- Status: Done on the fake adapter (merged 2026-10-07, `1d94691`) — `shipment` table (one per order, FORCE RLS), `bookShipment`/`refreshTracking` in `packages/db/src/fulfillment.ts`, worker jobs `shipment.book`/`shipment.track` (ARCH-5 JOB-07), booking section on SC-13 and courier timeline on SF-11; exactly-once booking under duplicate clicks, lost leases and retries; only 409/429 retry a provider write, timeouts/5xx fail closed; insufficient balance → `awaiting_balance` → one `payUnpaid`; COD refused unless `ALLOW_COD_BOOKING=1` (Q-17); every Mengantar write still refused without `MENGANTAR_WRITE_ENABLED=1` — no Mengantar call was made. Evidence: `test/fulfillment.test.ts` (12), `e2e/fulfillment.spec.ts`, report `docs/tracks/fulfillment.md`. Gates on `main` after the wave 4 merges: pending verify (orchestrator `pnpm verify`; see STATUS.md). Open: create-order / `GET /order` / `payUnpaid` shapes and cargo/lite courier map UNVERIFIED until an approved write test; recovery from `booking`/uncertain results is manual; RTS/provider cancellation leaves the order `shipped` (no automatic restock); `.env.example` lacks `MENGANTAR_PICKUP_ADDRESS_ID`, `MENGANTAR_PICKUP_TIME_ID`, `ALLOW_COD_BOOKING`.
- Primary requirement: PR-5
- Constraints: Q-2, Q-17, NFR-2, NFR-5, TEN-1, DATA-2
- Dependencies: T-34, T-32, T-35
- Done when: a seller books shipment for a confirmed order; booking runs as an
  outbox job that calls the Mengantar create-order operation through the
  existing write lock (fake adapter unless `MENGANTAR_WRITE_ENABLED=1`, which is
  never set without owner approval), stores the provider reference and resi,
  handles insufficient balance (unpaid) and 409 concurrency by serialising per
  account; a read-only status job updates tracking states; the order moves to
  shipped from a real resi; buyer status page shows tracking; COD bookings stay
  disabled while Q-17 is open unless an explicit flag allows them; tests prove
  exactly-once booking under retries and duplicate clicks.
- Amended by T-37 (2026-10-27): booking additionally reserves the seller
  `shipping_debit` under the per-store advisory lock before the provider call,
  refuses prepaid orders before payment, derives COD from the order's payment
  method, and treats a transport failure or cancellation acceptance as unresolved
  until the provider confirms (ADR-0006 decision 7). Rebooking stays unsupported.
- Review caveat (2026-10-27): "Done on the fake adapter" does not cover ADR-0006 behaviour. Open defects
  recorded in the gap report: unknown outcomes are retryable `failed` (CRMON-04), the account-lock wait can
  outlive the 60 s lease (CRMON-15), tracking rows are not matched to the booking (CRMON-05), booking uses one
  platform pickup address for every store (CRMON-08), RTS never reaches `returned` (CRMON-02) and cancel can
  race a booking (CRMON-03). They are fixed under T-37 and T-48, not here.
- Added by the final policy round (D-15): the platform-account COD options offered at checkout and booking are filtered through the data-driven `courier_service_policy` (`cod_allowed` and `return_free`, DATA-9); a service that is not allowed never offers platform-account COD. The policy data and its administration are T-48.

### T-40 — Catalog feeds for Meta and Google
- Status: Done locally (merged 2026-10-07, `6393c70`) — `GET /feeds/<token>/meta.csv` and `/feeds/<token>/google.xml` (ARCH-5 HTTP-15): one item per variant of an active product with a cover, item id = variant catalog id, group = product catalog id, `<n> IDR`, availability from stock, canonical link, absolute image link; per-store revocable token (`feed_token`, hash only, one active), 60 fetches/store/hour; token management on `/seller/marketing` (owner). Evidence: `test/feeds.test.ts` (10), `e2e/feeds.spec.ts`, report `docs/tracks/feeds.md`. Gates on `main` after the wave 4 merges: pending verify (orchestrator `pnpm verify`; see STATUS.md). Open: nothing uploaded to Meta/Google, so platform acceptance is unverified; owner decision on Google `identifier_exists` (emit `no` or collect GTIN/MPN); no category/colour/size/sale-price attributes yet; no ETag/cache (fine at M2 sizes); products without an image are skipped.
- Primary requirement: PR-12
- Constraints: PR-20, Q-7, DATA-5, TEN-1, SEC-9
- Dependencies: T-14
- Done when: each store exposes token-protected Meta catalog and Google
  Merchant feeds whose item id is the variant catalog id string and group id
  the product catalog id, with title, description, absolute HTTPS image link,
  price in IDR, availability from stock, and link to the canonical product URL;
  only active products of that store; feed tokens are revocable; tests prove
  ids, escaping, isolation and token checks. No provider upload.

### T-41 — Seller performance dashboard
- Status: Done (merged 2026-10-07, `258b9c6`) — `/seller` (SC-01) shows orders, goods revenue, shipping collected apart from goods, AOV, COD confirmed/rejected rates, COD work queue, funnel from `signal_event` and top 5 products for today / 7 / 30 Asia/Jakarta days, with explicit empty states (`sellerDashboard` in `packages/db/src/dashboard.ts`). Evidence: `test/dashboard.test.ts` (7 cases, KPIs reconciled with raw order rows), `e2e/dashboard.spec.ts`, report `docs/tracks/dashboard.md`. Gates on `main` after the wave 4 merges: pending verify (orchestrator `pnpm verify`; see STATUS.md). Open: `(store_id, created_at)` index deferred until the KPI query is slow at real volume; funnel Purchase counts events, not orders.
- Primary requirement: PR-22
- Constraints: TEN-1, NFR-1, NFR-3
- Dependencies: T-21, T-35, T-38
- Done when: `/seller` shows store-scoped orders, revenue (integer IDR, goods
  vs shipping), COD confirmed/rejected/cancelled rates, funnel from signal
  events and top products for today / 7 / 30 days in Asia/Jakarta; numbers
  reconcile with order rows in tests; empty periods show an explicit empty state.

### T-42 — Landing pages v1 with order section
- Status: Done for v1 (merged 2026-10-07, `c0816b6`) — SC-14/15/16 builder (typed blocks, up/down buttons, publish/unpublish with audit), immutable `landing_page_revision` rows with DB-enforced draft/published pointers, public SF-09 `/s/[store]/lp/[slug]` outside the storefront shell (storefront routes moved into the `s/[store]/(shop)/` route group; `moduleForRoute` strips route groups), order section → store cart → hosted checkout, pixels reused. Evidence: `test/landing.test.ts` (8), `e2e/landing.spec.ts` (theme switch leaves the LP unchanged), report `docs/tracks/landing.md`. Gates on `main` after the wave 4 merges: pending verify (orchestrator `pnpm verify`; see STATUS.md). Open: drag-and-drop/MCP (T-11, T-20); no page deletion or revision history/restore UI; new storefront routes must live under `(shop)`; `ops.spec.ts` "database unreachable" depends on a seeded dev DB.
- Primary requirement: PR-9
- Constraints: ARCH-4, TD-4, UI-4, UI-6, TEN-1, PR-16, PR-20
- Dependencies: T-24, T-34, T-38
- Done when: sellers create store-owned landing pages from ordered, typed
  blocks (hero, image, text, benefits, testimonials, FAQ, countdown-free CTA,
  order section bound to one product's variants) with a draft revision and a
  published revision pointer; `/lp/<slug>` renders the published revision
  mobile-first and independent of the storefront theme; the order section adds
  to the store cart and hands off to hosted checkout (no protected fields on the
  LP); pixel events fire as on the storefront; switching store theme leaves the
  LP unchanged; tests cover isolation, publish/unpublish, reserved slugs and
  theme independence. Drag-and-drop editing and MCP stay for later (T-11, T-20).

### T-43 — Buyer data export and redaction (T-33 mechanism)
- Status: Done (merged 2026-10-07, `e580b64`) — PRIV-1 inventory in 13-COMPLIANCE-PRIVACY mirrored by `BUYER_DATA_INVENTORY`; owner-only `/seller/privacy` (SC-24) finds a buyer by phone/e-mail in the store, downloads JSON (HTTP-16) and redacts selected orders (`[dihapus]`, amounts and lines intact, `order_redaction` + `audit_log`, override with a reason for open orders); retention job in `cleanup.ts` disabled unless `BUYER_DATA_RETENTION_DAYS` is set (Q-11). Ceiling: app role `UPDATE` on `mail_outbox` (DECISIONS D-10). Evidence: `test/privacy.test.ts` (10), `e2e/privacy.spec.ts`, report `docs/tracks/privacy.md`. Gates on `main` after the wave 4 merges: pending verify (orchestrator `pnpm verify`; see STATUS.md). Open: `shipment` table not yet in the inventory/export/redaction; `purchasePayload` (`signals.ts`) would hash the `[dihapus]` placeholder after an override redaction of an open order; backups taken before a redaction still hold the data (restore must re-apply `order_redaction`); free-text notes not redacted; Q-11 retention periods.
- Primary requirement: PR-4
- Constraints: SEC-19, PRIV-1, PRIV-2, PRIV-4
- Dependencies: T-21
- Done when: the buyer-data inventory is recorded in 13-COMPLIANCE-PRIVACY; an
  owner exports one buyer's data (by phone/email within the store) as JSON and
  redacts contact fields of selected orders while amounts and lines stay
  intact; redaction is audited and irreversible; a retention job exists but is
  disabled until the owner sets retention days (Q-11).

### Demo data — local demo merchants and content (owner direction, no task number)
- Status: Done (merged 2026-10-07, `c1adf27`) — `pnpm db:seed:demo [-- --reset]` (ARCH-5 JOB-06, `packages/db/src/demo/**`) seeds four fictional stores with owners/staff, a demo operator, 51 products / 84 variants with generated PNG images, collections, CMS pages and 16 orders per store across all statuses through the real services; refuses production, non-loopback hosts and `*_e2e` databases; usage in `docs/DEMO.md`. Evidence: `test/demo.test.ts`, report `docs/tracks/demo.md`. Open: demo content for the wave 4 features (a landing page per store, a booked shipment with tracking, feed token, an export/redaction example); `shipping.test.ts` leaves its margin rule in the `_test` DB.

## M3 planned tasks — 2026-10-26 (Etalashop specification adoption)

### T-44 — Standard product taxonomy (Google Product Category) and feed attributes
- Status: Planned (specified 2026-10-26 in PR-24, DATA-8, UX-10)
- Primary requirement: PR-24
- Constraints: PR-12, DATA-5, DATA-8, TEN-1, UX-10
- Dependencies: T-14, T-40, T-51
- Done when: global reference table `product_taxonomy` is seeded idempotently
  from the Google Product Taxonomy; `product` gains nullable
  `google_category_id`, `google_category_path`, `brand`, `gtin`, `mpn`, `gender`
  and `age_group`; `/seller/products/[id]` offers a one-click deterministic
  Indonesian keyword auto-suggestion plus a searchable Base-UI `Dialog` picker;
  Meta CSV and Google Merchant XML feeds include `google_product_category`,
  variant `color`/`size` when present, and emit `g:identifier_exists = no`
  whenever `gtin` and `mpn` are absent. The suggester is deterministic, so Vitest asserts an exact
  match on every pair of a committed fixture set of Indonesian product titles and their expected
  `google_category_id` (a title with no confident match returns no suggestion, never a guess), the
  taxonomy seed is idempotent (a second run changes no row and keeps stored numeric ids), and the feed
  attributes follow the `identifier_exists` rule; Playwright verifies picker persistence and the feed
  output.

### T-45 — Abandoned checkout capture and 1-click WhatsApp recovery
- Status: Delivered locally 2026-10-28 (working tree, not committed; migration 0016 section T-45; `checkout_session`, `/seller/customers/carts` (SC-26), signed resume link `/checkout/r/[token]`; report `docs/tracks/t45.md`; 22 mutation checks). DEFERRED: legal basis (notice versus explicit opt-in, Q-11: one-line gate in `CaptureProgress`), who may contact buyers (currently owner and staff), the cleanup schedule must run at least every 15 minutes (ops), prefill on resume (product/privacy), a production `KEYRING_CHECKOUT_RESUME` key. HTTP-32 is a provisional id. Independent review done (3 P2, 6 P3): fixed: the WhatsApp target must be a canonical `628…` number (a number typed without a prefix produced `wa.me/81…`, a stranger abroad), the database owns the idle and purge clocks of `checkout_session` (a login role could backdate a row to abandon it at once or pre-age or future-date it) and a recovery needs an order of the same cart, a redacted order keeps no provider free text in `provider_status` after later polls and the poll takes the order row lock, the buyer name cannot carry a dot into the message, the Recovery Rate label says orders created. DEFERRED P3s: the retention redaction matches sessions by phone or e-mail whatever their age (match the order's own cart), the message says 7 days even when the session is purged earlier and stamps 'WA dibuka' for an emptied cart, the resume link replaces an existing cart cookie on a GET.
- Primary requirement: PR-25
- Constraints: PR-4, DATA-8, PRIV-1, PRIV-4, TEN-1, TEN-3, SEC-16, UX-15
- Dependencies: T-30, T-43, T-51
- Done when: hosted `/checkout` debounces buyer contact and cart progress into
  store-scoped `checkout_session` rows under FORCE RLS; `cleanup.ts` sweeps
  sessions idle >= 60 minutes from `active` to `abandoned` (`abandoned_at`
  stamped) and purges rows older than 30 days; completing an order marks a
  matching session `recovered` (`recovered_at` stamped without clearing
  `abandoned_at`); `/seller/customers/carts` (`SC-26`) displays 30-day Abandon
  Rate and honest Recovery Rate (`abandoned_at IS NOT NULL AND recovered_at IS
  NOT NULL`), ranks actionable carts by phone presence and time-decayed value,
  and opens `wa.me` with a signed 7-day resume link while recording `"WA
  dibuka"`; `checkout_session` is added to `BUYER_DATA_INVENTORY` for export and
  redaction; Vitest and Playwright cover the rates math, signed token resume,
  cross-store denial, and privacy redaction.

### T-46 — Store promotions: vouchers, free-shipping threshold, flash sales, and promo hub
- Status: Delivered locally 2026-10-28 (working tree, not committed; migration 0015 section T-46; `packages/db/src/promotions/**`, seller `/seller/promotions`, storefront `/s/[store]/promo`, checkout voucher field; report `docs/tracks/t46.md`). Independent review done; fixed: a concurrent double submit of ONE request now returns the one order (the second waited on the first's counter and got a voucher refusal), every phone spelling counts once for the per-buyer cap via the canonical key, the automatic free-shipping threshold never blocks a checkout and does not consume a free-shipping voucher it replaces. DEFERRED: custom hub slug (reserved paths and redirects decision), recycling a voucher use after cancellation or return (abuse versus fairness decision), sales-tax modes with discounts at checkout (T-65 wiring, `order_total_chk` needs an added-tax term), identity-bound voucher caps (T-58), an unpaid seller cannot stop a running promotion because `promotions.manage` is refused while read-only (decision: allow a disable-only write; recommended yes), banner image deletion shows a raw foreign-key error (refuse with a DomainError). Redeem limits (20 per 10 min per IP, 10 per 10 min per phone) are conservative defaults chosen by the builder, not owner figures.
- Primary requirement: PR-26
- Constraints: PR-2, PR-4, BILL-4, DATA-2, DATA-8, TEN-1, TEN-3, NFR-2, UX-16
- Dependencies: T-21, T-25, T-37
- Done when: `discount`, `flash_sale`, `flash_sale_item`, and `promo_hub` tables
  exist under FORCE RLS; `/seller/promotions` (`SC-27`) manages vouchers
  (`all`/`collection`/`product`; `percent`/`fixed`/`free_shipping`), automatic
  free-shipping threshold, flash-sale windows, and promo hub settings;
  `/s/[store]/(shop)/promo` (`SF-12`) renders the active banner, live flash
  sales, copyable vouchers, and discounted products; server-side checkout
  validates voucher rules and flash-sale time/stock windows atomically and
  records `goods_discount_idr` and `shipping_discount_idr` separately in
  `order_financials`; Vitest proves concurrent usage-cap/stock-cap enforcement
  and Playwright covers `/seller/promotions`, `/s/[store]/promo`, and checkout
  voucher application at 320px and desktop.
- Added assertions (second documentation pass): the discount and included-tax allocation is one pure function (BILL-4, per-line largest-remainder, integer IDR) with committed fixtures; in every fixture the per-line shares sum exactly to the order-level discount and tax, and `goods_discount_idr` and `shipping_discount_idr` equal the sums stored in `order_line_financials`.

### T-47 — Shipment privacy redaction, signal redaction guard, and wave-4 demo seed
- Status: Delivered locally 2026-10-28 (working tree, not committed; shipment privacy redaction in the inventory, export and `redactOrders`, `purchasePayload` placeholder guard, `.env.example`, demo seed with landing page, feed token and a booked fake shipment per store; report `docs/tracks/t45.md`). No deferred item.
- Primary requirement: PR-4
- Constraints: SEC-19, PRIV-1, PRIV-4, TEN-1, TEN-3
- Dependencies: T-39, T-42, T-43, T-51
- Done when: `shipment` (`tracking_history`, `provider_status`, `last_error`) is
  added to `BUYER_DATA_INVENTORY`, buyer JSON export, and `redactOrders`
  (stripping provider free-text descriptions while keeping status codes,
  timestamps, resi, and amounts); `purchasePayload` in `signals.ts` skips
  hashing placeholder `[dihapus]` values after an override redaction; `.env.example`
  documents `MENGANTAR_PICKUP_ADDRESS_ID`, `MENGANTAR_PICKUP_TIME_ID`,
  `ALLOW_COD_BOOKING`, and `BUYER_DATA_RETENTION_DAYS`; `pnpm db:seed:demo`
  includes a published landing page, a booked fake shipment with tracking, and a
  feed token per demo store. Tests: (1) a Vitest case on the buyer JSON export of an order with a
  shipment asserts that `tracking_history`, `provider_status` and `last_error` are present in the
  export, and the inventory test fails when a free-text `shipment` column is missing from
  `BUYER_DATA_INVENTORY`; (2) after `redactOrders` the provider free-text descriptions and
  `last_error` are stripped while status codes, timestamps, resi and amounts equal their
  pre-redaction values, and a second redaction run changes nothing; (3) `purchasePayload` for an
  order redacted with an override contains no hashed field derived from a `[dihapus]` value, while an
  unredacted order still produces the same hashed fields as before (golden values); (4) the demo seed
  yields, per demo store, one published landing page, one booked fake shipment with at least one
  tracking event and one active feed token, and a re-run is idempotent; (5) `.env.example` lists the
  four variables named above (a script test checks for them); (6) store A cannot export or redact
  store B's shipment rows under the RLS role.

## Goal Mode execution ledger — 2026-10-28 (owner: "lanjutkan development task keseluruhan")

Owner instruction (2026-10-28): continue the whole queue; build everything that needs no further owner decision, completing it on the orchestrator's recommendation; defer anything that needs an owner decision into this queue as an explicit blocked item. Rules of this run: tasks run in dependency order; each editing child runs isolated and its patch is inspected and integrated one at a time; sensitive work (RLS and roles, money, migrations, concurrency, authorization) gets a separate reviewer agent (this repository has no `.delivery/` ledger, so the reviewer record in `BUILD-LOG.md` is the boundary evidence); nothing is committed or pushed unless the owner asks; live provider calls, deployment, DNS, secrets and production grants stay out of scope.

Defaults taken on the orchestrator's recommendation (recorded as DECISIONS D-22, revisable by the owner): OPEN-F3 allow a COD booking with a `pending` shipping debit; OPEN-F6 net a returned prepaid parcel's carried debit against the next released sale of the same store; refund and subscription defaults of D-20; every numeric policy value that has no owner-decided figure is a named setting with a conservative default, never a literal rate.

Wave 1 result (2026-10-28, working tree): T-59 expand, T-60 and T-74 integrated into ONE migration `0011_chain_a_foundation.sql`; reviewed by two separate read-only agents (security-reviewer on RLS/roles/migration: 1 P1, 5 P2, 3 P3; reviewer on capabilities and jobs: 6 P2, 2 P3); every P1/P2 fixed in the tree except the items listed as DEFERRED on T-59, T-60 and T-74; regression tests in `packages/db/test/review-findings.test.ts`.

Parked state (2026-10-28, after commits `302cfa4` and `2ddf5d2`): hosting direction D-23 recorded (Vultr + Coolify + Cloudflare, no Supabase, deploy after local polish); UI/UX polish of Seller Admin, Owner console and public pages done by three review passes (`docs/tracks/ux-*.md`; the external design review of public pages is still open); old 'Partial' task statuses re-audited (`docs/tracks/audit-partial.md`). Current actionable follow-ups (2026-11-04): T-59b/T-59c and decision-free per-task fixes; T-80/T-81 stock and store-write protection, T-82/T-83 auth hardening, T-76/T-77 runtime/migration guards, T-84 container checks and T-85 verification. T-59 contract is NOT decision-free: it needs upgraded consumers and explicit owner approval. Feature continuations T-53 to T-55 and T-71/T-66 still obey their own policy/dependency gates. T-86/T-87 own outstanding spec and research reconciliation; T-88 to T-94 are policy/evidence-gated.

Wave 4 and 5 result (2026-10-28, working tree): T-46, T-48, T-68 (migration 0015) and T-45, T-47, T-52 plus the T-48 review fixes (migration 0016) integrated; independent reviews of T-37 finish, T-46/T-68 and T-48 found 1 P1 (0015 not applicable to a populated database), 4 P2 and 15 P3, all P1/P2 fixed with named tests; the step-up code limiter counts only failed codes. At this wave checkpoint T-52 and T-45/T-47 had not yet been independently reviewed; later reviews are recorded in their task Status lines and BUILD-LOG. This is historical, not the current review state. Evidence: DB suite 73 files, 1384 tests passed; lint, typecheck, `map:check`, `check-spec.py` and the traceability checker clean; populated-database upgrade, build, `verify:docker` and Playwright are recorded in BUILD-LOG.

Wave 3 result (2026-10-28, working tree): T-57, T-37, T-63 and T-50 integrated into migration `0013_chain_a_wave3.sql` (sections T-57, T-37, T-63, T-50) plus `0014_t37_finish.sql` (the T-37 completion and review fixes; it replaces nine guard definitions of 0013 with `CREATE OR REPLACE`); T-37 was delivered in two builds because the first stopped at its working budget. Two independent read-only reviews (T-37 money: 1 P1, 1 P2, 6 P3; T-50/T-57/T-63: 0 P1, 2 P2, 6 P3). All P1/P2 and the cheap P3s are fixed with named tests (`review-wave3.test.ts`, `t37b-review.test.ts`, additions to `t50-*`); the rest is DEFERRED on each task. Evidence: DB suite 57 files, 1005 tests passed; `pnpm lint`, `pnpm typecheck`, `pnpm map:check`, `check-spec.py` and the traceability checker (0 findings) clean; build, `verify:docker` and the full Playwright suite are recorded in BUILD-LOG after the last run.

Wave 2 result (2026-10-28, working tree): T-62, T-49, T-65 and T-73 integrated into ONE migration `0012_chain_a_wave2.sql` (sections T-73, T-65, T-49, T-62; the T-62 definition of `retention_set_period` is the last one and keeps the audit_log/access_event refusal); two separate read-only security reviews (payments: 1 P1, 2 P2, 4 P3; console/mail/tax: 0 P1, 3 P2, 10 P3); all P1/P2 and the cheap P3 fixed with named regression tests, the rest listed as DEFERRED on each task. Evidence: DB suite 39 files, 622 tests passed; `pnpm lint`, `pnpm typecheck`, `pnpm map:check` clean; build, `verify:docker` (70 tables, 38/38 policies, 0 registry differences) and Playwright 127 passed on the integrated tree BEFORE the review fixes (rerun after wave 3).

Wave plan (a wave starts only when the previous one is integrated and verified): wave 1 T-59 (expand step), T-60, T-74; wave 2 T-62, T-49, T-65, T-73 mailer interface; wave 3 T-37, T-57; wave 4 T-48, T-50, T-44/T-45/T-47; later waves follow the build order below. A task that finishes only partly keeps its own Status and lists the deferred slices in its Notes.

Deferred to later development (each needs an owner decision, an external fact or a production step; do not build before it is recorded):
- T-59b (operator tables as `restricted` plus an own Better Auth instance, after T-62) and T-59c (definer function for the store-less audit write and buyer identifiers, with T-57): planned follow-ups of the wave 1 review, no owner decision missing.
- T-59 contract migration (revoking the old table-wide grants) and the production role bootstrap: needs the new web version deployed first (expand/contract) and a production database change, so it needs explicit owner approval at deploy time.
- Operator identity in separate operator tables with its own Better Auth instance (T-59 follow-up "T-59b"): scheduled after T-62 because it rewrites the Owner surface sign-in; no owner decision missing.
- Live-provider behaviour: Q-17 legal review of holding seller COD funds, OPEN-F7 SPX free-return terms, OPEN-F8 provider reconciliation signal, OPEN-F9 Partner API settlement and cashback sweep, Mengantar write test, the Partner Secret rotation, AutoLaris sandbox evidence and vendor status codes, ad-platform test events: everything stays behind its existing gate and uses fake adapters.
- Retention periods for raw callbacks, clicks, logs and audit (OPEN, purge stays OFF), the email provider and sender domain (Q-16), VPS and DNS, tax rates and tax activation (OPEN-T*, dormant), PPN activation, compliance activation: owner or advisor decisions.
- Custom domains (T-15, Q-8 provider), marketplace listing (T-7), MCP builder (T-11, T-20), external affiliate sources (T-56): not accepted for development.

## M3 chains A and B — 2026-10-27 (owner decisions: hybrid shipping, subscription, platform affiliate, global buyer, restructure)

Build order (canonical: 02-PRD, 03-TECHNICAL-DESIGN and 04-SYSTEM-ARCHITECTURE link to this paragraph and do not restate it). It is derived from the `Dependencies:` lines below; whoever changes a dependency updates this paragraph in the same edit. Tasks on one step may run in parallel; a task starts only after every task it depends on has finished.

1. T-51 (restructure, move only). T-44, T-45 and T-47 depend only on T-51 plus finished M2 tasks, so they may run from step 2 on.
2. T-59 (RLS framework and narrow platform grants), T-60 (platform capability grants), T-61 (variant weight).
3. T-57 (buyer identity core), T-65 (tax foundation), T-70 (host dispatch, per-surface sessions, reserved labels), T-73 (real mailer and `mail_outbox` hardening), T-74 (periodic enqueuer, job hardening, retention framework).
4. T-49 (AutoLaris adapter contract), T-58 (buyer portal), T-62 (Owner console shell and approvals).
5. T-50 (subscription billing), T-37 (ledger, COD remittance, payouts, refunds; needs T-60 and T-62 for the approval path), T-63 (store and seller-team account governance), T-68 (issue reports queue), T-69 (Update Log, optional).
6. T-46 (promotions), T-48 (unified Partner Mengantar shipping accounts).
7. T-52 (affiliate data model and attribution).
8. T-53 (affiliate wallet and payouts).
9. T-54 (affiliate portal and Owner console affiliate administration), T-71 (earnings statements and invoice exports).
10. T-55 (affiliate storefront), T-66 (startup tax UI), T-72 (affiliate and buyer account governance).

Deferred and outside the order: T-56 (external affiliate sources), T-64 (Compliance center, after Compliance activation), T-67 (Phase 2 tax, after Tax activation), T-75 (PPN activation readiness). Chain names used elsewhere: Chain A = T-51, T-49, T-50, T-37, T-48 (with T-46); Chain B = T-52 → T-53 → T-54 → T-55; buyer identity = T-57 → T-58. T-59, T-60, T-61 and T-70 were review follow-ups and are accepted by the owner (2026-10-28, DECISIONS D-20); T-73 is still Proposed (pending owner confirmation). Accepted does not mean built: see each task's Status. All blocks other than the ones marked Done are Proposed specifications, not implementation evidence.

### T-48 — Unified Partner Mengantar shipping accounts and account-scoped reconciliation
- Status: Delivered locally 2026-10-28 against fake adapters (working tree, not committed; migrations 0015 section T-48 and 0016; `packages/db/src/shipping/**`, SA-07, SA-53, SC-22; reports `docs/tracks/t48.md`, `t48-fix.md`; 25 + 24 mutation checks). Independent review done; fixed: the 0015 migration failed on any database that already had orders (the account foreign keys are now `NOT VALID` and validated after the backfill; proven on a populated copy of the dev database), tracking stopped for good and a shipped parcel showed `awaiting_account` while the account was being recovered (status kept, tracking re-queued), the platform shipping discount was partly paid by the seller on a courier price rise (frozen `platform_shipping_discount_idr`, one funding formula, `verify:ledger` recomputes it), COD policy per service, hex keys in the key-purpose check, copy gaps with a repo-wide copy-guard test, the Partner client gate checks identity and the test config no longer opens it, stale pending reconciliation batches can be voided, margin approvals are bound to a revision, production sweeps are no-ops without a live adapter and the 409 retry is capped with a daily registration budget. DEFERRED: live Partner transport (owner rotation of the Partner Secret, OPEN-F9, provider documentation or one sanitized sandbox response), live partner booking, COD settlement and cashback sweep (OPEN-F9, write-test approval), effective shipping cashback (owner split rule and rate), partner-terms consent table (notice text), owner prompt for a fresh e-mail after repeated 409 (mailer, Q-16), routing e-mail domain (Q-16), OPEN-F7 and OPEN-F8 gates, SA-35 per-account health, browser specs for the batch-void button. Partner routing defaults OFF (`shipping_control.prefer_partner = false`) until OPEN-F9.
- Primary requirement: PR-27
- Constraints: PR-5, PR-23, BILL-4, BILL-5, BILL-6, DATA-9, UX-17, TD-7, TEN-1, TEN-3, Q-2, Q-12, Q-17, ADR-0006, ADR-0007
- Dependencies: T-34, T-39, T-37, T-51, T-61
- Notes: T-51 because the shipping files move there (CRMON-08 and CRMON-12 are fixed here); T-61 because live booking needs the real parcel weight instead of one kilogram per cart line (CRMON-10).
- Entry gate: before the first provider call of any kind (sandbox included) the Mengantar Partner Secret that was pasted into a chat during research is treated as exposed and rotated. The owner asks Mengantar for a replacement, it is stored only through the secret store, the old secret is confirmed revoked, and the rotation is recorded in RUNBOOK without the secret value.
- Done when: existing ARCH-5 SA-07 (`/admin/shipping`) and SC-22
  (`/seller/shipping`) are extended rather than duplicated. Owner console shipping
  setup (`SA-07`) centrally manages Partner Mengantar account provisioning,
  shows Partner API credential health without secret values, configures
  `courier_service_policy` (`cod_allowed`, `return_free`), and sets platform
  shipping discounts, margin rules, and shipping cashback split rules
  (`cashback_rule`, basis points / integer IDR). Bukalaris automatically
  provisions a new Partner-managed Mengantar seller account (`POST
  /api/partner/v1/sellers`, `externalUserId = 'store:' || store.id`,
  `kind = 'partner_managed'`) for every store — even sellers who previously had
  an older external Mengantar account must use the new Bukalaris-generated
  account (using a Bukalaris-controlled per-store routing email or fresh email
  if `409 EMAIL_ALREADY_REGISTERED` occurs; `own_key` / pasting external keys is
  not supported) — with `platform_master` as fallback. The selected
  `order.shipping_account_id` and immutable `shipping_account_kind`
  (`partner_managed` | `platform_master`) are snapshotted on `order` and
  `order_financials` (DATA-9), alongside `shipping_cashback_gross_idr`,
  `platform_cashback_idr`, and `seller_cashback_idr`; booking, balance reads and
  status polling use that snapshotted account only, with visible
  `awaiting_account` / `awaiting_balance` recovery and no silent account failover.
  The worker-only Partner API client signs the exact serialized request body
  using the documented SHA-256 construction and fresh unix-seconds timestamp,
  serializes calls under one shared database token bucket `partner:mengantar`
  (limit `RL-PARTNER-MENGANTAR`, 60 requests/minute and 1,000 registrations/day),
  and honours `Retry-After`. Provisioned `partner_managed` keys are sealed with
  AES-256-GCM under the `shipping_credentials` keyring with a `key_id` in each
  envelope and a re-seal job (JOB-23, SEC-22), write-only and redacted from
  every credential-bearing URL/log/trace. Key recovery fetches the current
  partner key via `/api/partner/v1/sellers/api-key` rather than re-registering;
  explicit account/key disablement (`SELLER_DEACTIVATED` / `API_KEY_DISABLED`)
  stops retries, quotes and unbooked shipments. Proposed ARCH-5 JOB-08 runs
  bounded partner `sellers/list` reconciliation within the existing worker;
  extended JOB-07 `shipment.book` / `shipment.track` use the snapshotted account
  and preserve account/store isolation and ADR-0006 status semantics. Unknown
  booking outcomes and cancellation use ADR-0006's actual Mengantar identifiers
  and reconciliation rules, never blind replay or an AWB cancellation
  assumption. The source/copy guard enforces white-label `Bukalaris Kirim`
  everywhere (allowing Mengantar only in the one-time Partner onboarding terms
  record and confirmation email if required by Partner API obligations). Vitest
  and Playwright prove Partner account provisioning (including `409` routing
  email handling), signed-body/budget handling, key lifecycle, no-failover
  snapshots, cashback allocation (`ledger_one_cashback_per_order` released on
  delivered + reconciled), and cross-store isolation. Production partner
  base/egress-IP registration, Public API rate limits, SPX free-return terms
  (`OPEN-F7`), COD reconciliation fields (`OPEN-F8`, JOB-33), and Partner API
  settlement/cashback sweep (`OPEN-F9`) remain UNVERIFIED live-use gates.

### T-49 — AutoLaris payment adapter contract and signed-reference callback
- Status: Delivered locally 2026-10-28 against the FAKE AutoLaris adapter (working tree, not committed; migration 0012 section T-49; `packages/db/src/payments/**`, callback route `/api/payments/autolaris/callback`; report `docs/tracks/t49.md`). Independent review done (BUILD-LOG); fixed: the demo-reset function is owner-connection only, app inserts start pending and empty, the app role cannot read callback bodies, callbacks are capped per attempt, the route checks the signature before rate limiting. DEFERRED: sandbox/real calls and vendor status codes (owner approval and a sanitized observed response), `/submit` details to confirm with AutoLaris (expiry, `callback_url` semantics, `courir_id: 1` account, IP whitelist), callback body retention period (privacy owner), QR image rendering, Owner console screens for unknown instructions and refund obligations (T-37), a refund obligation when a gateway-paid order is cancelled (T-37), subscription-invoice attempts (T-50), a per-reference live adapter wiring through ONE factory shared by handlers and reconcilers (a live adapter must not implement `recoverCreate`; until then only the fake exists).
- Primary requirement: PR-5
- Constraints: PR-18, BILL-1, BILL-2, BILL-4, BILL-7, DATA-10, TD-7, TEN-1, TEN-3, Q-17, ADR-0006
- Dependencies: T-21, T-32, T-51, T-74
- Added assertions (D-21 K and the 99ribu study): the callback is verify-by-pull, so a valid signed reference only records the body digest and enqueues a verification job that calls the provider inquiry; `paid` needs `rc` `00`, status `PAID` and a provider amount equal to the attempt's `total_idr`, everything else is `unknown` or pending and a callback alone never moves money (tests: valid and invalid signature, replayed callback, callback on a terminal order quarantined, generic words such as SUCCESS or DELIVERED never settle, amount mismatch refused); `reff_id` is persisted before any provider call and a retry replays the same one; exactly one instruction field is accepted in a create response; the enabled channel list comes only from the provider's list response; the raw callback body is redacted after the retention period (the period is OPEN and not hard-coded) while its digest stays. Live settlement stays operator-confirmed until the vendor status codes are observed in production.
- Notes: T-50 now follows this task and wires subscription-invoice attempts onto this contract; T-51 because `providers.ts` and its callers move there.
- Done when: the current `PaymentAdapter.createInstruction({storeId, orderId,
  amount}) -> {reference, instructions}` in `packages/db/src/providers.ts` is
  replaced end-to-end, including every caller, persistence path, worker and
  payment-instruction screen, without a compatibility shim. Input carries a
  previously persisted stable `reff_id`, selected `channel_code`, customer context
  (ID/name/phone/email), local payment-attempt total and expiry context; the attempt
  contract carries an owner kind (`order` or `subscription_invoice`) and an opaque owner id
  so one adapter serves both without sharing rows. This task wires buyer-order attempts
  only; T-50 wires subscription-invoice attempts on top of this contract, and platform
  invoices are never treated as buyer orders or seller proceeds. Structured instructions
  preserve reference, provider transaction ID, virtual account, unmodified QR payload,
  payment code, URL, `expiresAt`, amount, admin fee and total as applicable instead
  of flattening them into a string. Channels and account fee configuration come
  through runtime `GET /api/h2h/list_payment` (faked locally), never a hardcoded
  availability roster or bill-creating channel probe. The `/submit` path checks
  `rc === "00"` before reading `data`, atomically persists `transaction_id` and
  instructions after the call, never also calls `/create_payment` for the same
  checkout, and leaves unknown outcomes blocked for reconciliation/manual recovery
  rather than creating another bill. The proposed non-physical `courir_id: 1`
  request uses only the account-approved schema profile, with dummy required
  route/dimensions, `cod_value: "0"` and one summary row; Bukalaris account approval
  is required before any real use. `grand_total` is the intended buyer payable;
  Tokophi-observed fee-netting remains UNVERIFIED for Bukalaris until confirmed.
  Expiry encoding uses `YYYYMMDDHHMMSS` in WIB independent of server timezone,
  with returned expiry preserved; `/submit` acceptance of an explicit expiry must
  be confirmed rather than assumed from Tokophi's `create_payment` helper.
  Proposed ARCH-5 HTTP-17 (`POST /api/payments/autolaris/callback`) verifies a
  domain-tagged HMAC signed reference in the payment's callback URL, binds it
  to the resolved local attempt and provider transaction,
  compares signatures in constant time, matches `amount` to the local attempt
  total, rejects invalid/missing configuration and does not accept a reusable
  shared-secret URL token or an assumed custom provider header. It preserves
  idempotency, late-paid quarantine/refund obligations, and paid-state monotonicity
  under ADR-0006. The fake adapter models channel discovery, customer/expiry input,
  every instruction form, logical failures, unknown creation outcome and authenticated
  paid/expired callbacks; Vitest and Playwright prove those paths, wrong-reference
  and wrong-amount refusal, missing-secret failure, no duplicate bill/credit, WIB
  expiry, unchanged QR bytes, a contract-level owner-kind separation case (an order attempt never settles an invoice reference and the reverse; the invoice path itself is T-50) and cross-store denial.
  Real callback settlement stays disabled until a sanitized observed Bukalaris
  callback and AutoLaris confirmation close the `/submit.callback_url` payment-vs-
  tracking ambiguity: Tokophi's handled `trx_id`/`transaction_id`, `reff_id`,
  `PAID`/`EXPIRED` and `amount` are not a published provider guarantee. Advice uses
  provider `transaction_id` and remains observe-only (`02/FAILED` did not prove
  failure in Tokophi); no `inquiry_payment` endpoint is invented. Production IP
  whitelisting (skill reference: maximum five) and Bukalaris account configuration
  remain live-use prerequisites; no real call or provider credential is required
  or authorised to complete the fake/local contract.
- Added assertions (second documentation pass & Tokophi/99ribu AutoLaris blueprint): (1) `parseListPayment` parses `GET /api/h2h/list_payment` where absence from `data` is the sole disabled signal (never probe channels via `create_payment`); (2) `payment_fees` declares explicit `base` per channel (`QRIS` = 0.7% of goods omset `subtotal - goods_discount`, `VABCA` = Rp6.500 flat, other VA = Rp3.000 flat, e-wallet = 3.0% of payable); (3) `/submit` sends the 24-key dummy logistics payload with `courir_id: 1` (exact spelling), `grand_total = String(buyerPayableIdr)`, and WIB `+7h` arithmetic expiry (`expiryStampWib`), and validates `rc === "00"` plus exactly one populated instruction field $\le 2048$ chars; (4) two-phase `request_state = 'in_progress'` coordination commits before network I/O and concurrent callers with the same `request_key` poll `awaitStoredResult`; (5) callback HTTP-17 (on apex host, limit `RL-AUTOLARIS-CB`) verifies domain-tagged 128-bit HMAC `?cb=<reff>.<hmac128>`, binds `boundRef === attempt.reff_id` (403 on cross-order replay), rejects empty identity or $>1$ matches with 400, checks safe-integer amount equality (logging PII-redacted `payCallbackBodyShape` on mismatch), enforces SQL monotonicity `status <> 'paid'` (late `EXPIRED` never regresses `paid`), quarantines late `PAID` on `cancelled`/`returned` orders into a buyer refund without crediting seller/affiliate ledgers, and redacts raw callback bodies after 30 days; (6) JOB-25 (`POST /api/h2h/advice` with provider `transaction_id`, `ADVICE_MAX_POLLS = 24`) treats `rc=02 ket=FAILED` as pending, maps generic words (`SUCCESS`, `DELIVERED`, `PAID`) to `unknown`, keeps `ADVICE_SETTLED = []`, and forbids dead `/inquiry_payment` (404). Every prepaid order pays through our AutoLaris gateway (D-15).

### T-50 — Platform subscription billing, invoices and seller access policy
- Status: Delivered locally 2026-10-28 against the fake AutoLaris adapter and the fake mail transport (working tree, not committed; migration 0013 section T-50; `packages/db/src/billing/**`, seller `/seller/billing`, Owner `/admin/billing`; report `docs/tracks/t50.md`). Independent review done; fixed: an explicit invoice period is bounded by what is due now (one operator-created invoice for period 24 bought two years of coverage at the monthly price), a lapsed period cannot be paid by invoice id. DEFERRED: real dunning delivery (T-73 provider, Q-16), live VA/QRIS activation (T-49 gates), gateway-fee bearer (DATA-10 OPEN), annual plan and first-month promo (not decided), invoice CSV export (T-71/T-66), PPN tax-invoice documents (T-75), refund of duplicate or void-invoice payments (T-37), review P3s: one unique index per (store, period) across subscription and comp kinds plus the live-instruction check in `grantComp`, seller security clean-up while read-only (needs a split of `members.manage`, `integrations.manage` and `marketing.manage` into add and remove capabilities), `finance.payout` is refused while unpaid per BILL-7 (owner decision: allow payout requests or net the debt, recommended: allow, because the money is the seller's and the debt is a separate receivable), Local demo-operator capability scope was subsequently added in the UX pass (BUILD-LOG 2026-10-28); this does not grant production privileges. OWNER DEFAULT TAKEN: stores that exist when the migration runs start a fresh 3-day trial (nothing is deployed; reverse by editing the seed before the first production migration).
- Primary requirement: PR-18
- Constraints: BILL-7, DATA-10, UX-17, UX-18, IAM-5, TEN-1, TEN-3, NFR-2, ADR-0008, TD-7; one all-feature Rp175.000/store/month DPP plan, global PPN default OFF, trial/grace defaults 3 days each, no annual/promo assumption; never mix platform invoices with buyer orders or seller proceeds.
- Dependencies: T-51, T-60, T-49, T-65, T-74
- Notes: the existing outbox/payment infrastructure is reused. T-49 is built first, so the `/submit` contract exists when subscription attempts are wired; live VA/QRIS activation still needs T-49 acceptance and the owner-approved provider gates. T-65 supplies the effective `vat_output` `tax_policy_version` that the PPN switch reads. Automated dunning additionally requires T-73 (real mailer) and an approved PR-21/Q-16 sender with delivery-result integration; no dev-outbox/audit-only delivery claim.
- Done when: DATA-10 plan/config versions, one `store_subscription` per store, separate subscription invoices and `subscription_payment_attempt` rows (wired to the T-49 adapter with owner kind `subscription_invoice`) and independent operator `suspended_at` are implemented; cron, seller Pay and Owner console manual-create invoke one invoice creator. Integration tests start concurrent calls from all three entry points for one billing period and assert one invoice ID, one stable payment reference and at most one live/uncertain instruction, backed by actual DB unique indexes (not check-then-insert); expired payment instructions reuse the invoice through a new controlled attempt. Billing periods follow the BILL-7 billing period formula (anchor date, calendar months, stored `period_index`); tests cover a store whose anchor is the 31st and the clamped month ends. Time-controlled tests assert trial/active expiry to `past_due`, grace expiry to billing `suspended`, and confirmed payment/explicit comp coverage to `active` exactly once under callback replay. Direct API and browser tests prove Seller Admin becomes read-only from `past_due`, billing/payment actions remain usable, and data is retained; billing-only debt/suspension does not refuse buyer checkout, while operator suspension additionally refuses it. Paying never clears the operator timestamp; lifting it never clears debt. Comp grants produce audited Rp0 `kind=comp` invoices, correct explicit coverage and no revenue/provider/seller-ledger movement; manual mark-paid records bookkeeping only and grants no entitlement. PPN OFF/ON fixtures preserve existing invoice snapshots, calculate new tax only from the effective-dated `vat_output` `tax_policy_version` value (DATA-15, delivered by T-65; there is no hard PKP gate, see the PPN assertion below) and show DPP/PPN/total separately. Store A cannot list/open/pay store B invoices; unauthorized operators/staff cannot change plan, comp, suspension or invoice records. Provider-timeout/replay/exact-amount tests exercise the T-49 `/submit` adapter through `subscription_payment_attempt`, without treating a payment return as settlement. Vitest/integration and Playwright at 320px/desktop cover status banners, invoice detail/back, payment recovery, read-only denial and keyboard flow; record executed commands/results during implementation, not in this Proposed task. Production automated dunning remains gated until actual mail delivery evidence exists.
- Added assertions (second documentation pass, owner decision D-17, & Tokophi billing blueprint): the periodic invoice job JOB-09 is enqueued by T-74 JOB-21; `createSubscriptionInvoice` uses entropy-safe numbering (`SUB-<ts9><hex3>`) and real channel codes (`VABCA`, `QRIS`, never bare `"BCA"`), reuses pending invoices backed by a partial unique index, compares settlement to the attempt's `total_idr`, and extends `store_subscription.current_period_end` under a `SELECT ... FOR UPDATE` row lock from `max(now, current_period_end)` with month-end clamping; the unique index per period excludes `void` invoices; this task provides the billing-job freeze switch used after a restore (14, RUNBOOK). PPN is OFF by default (D-17): the Owner console switch needs `tax.manage`, a confirmation dialog (stating that legal and tax documents and PKP status are the owner's responsibility) and a required reason, and is audited; it is not four-eyes, there is no `billing.ppn_toggle` capability and no hard PKP gate. A switch applies to new invoices only and never rewrites an issued invoice. The rate is an effective-dated `vat_output` policy value (T-65) and is never in code; no 11% literal is computed or stored, and COD-fee VAT is 0 while PPN is off. The company (PT) legal documents are not issued, so invoice documents and e-Faktur readiness are deferred to T-75.

### T-51 — Restructure one Next.js app and database contexts without behavior changes
- Status: Done locally 2026-10-28 (code in the working tree, not committed; nothing deployed). Move-only restructure applied: `apps/web/src/app` routes sit in surface route groups `(platform)`, `(operator)`, `(seller)`, `(storefront)`, `(checkout)`, `(identity)`, `(public-services)` with unchanged URLs; `packages/db/src` is organized into `platform/`, `seller/commerce/`, `storefront/`, `shipping/` (with `mengantar/`), `payments/`, `ops/` and `ops/jobs/`. `schema.ts`, `client.ts`, `index.ts`, `migrate.ts`, `seed.ts`, `local-roles.ts`, `worker.ts` and `cleanup.ts` stay at the root as thin entry points, so the Coolify commands, the RUNBOOK commands and the Dockerfile needed no change. No `billing/`, `buyer/`, `affiliate/`, `tax/` or `(update-log)` scaffold exists (future-only contexts stay documented). Observed evidence (2026-10-27/28): route entries 64 before (47 pages, 17 handlers) and 64 after, 0 URL differences between the before and after route manifests; `pnpm --filter @bukalaris/db generate` reports "No schema changes, nothing to migrate" and `git status` shows no new or changed file under `packages/db/drizzle`; `pnpm map:check` ok (64 route files, 72 map rows); `pnpm lint`, `pnpm typecheck`, `pnpm build` green; DB suite 22 files / 229 tests green; Playwright suite green after the T-70 work (see T-70 for the final counts). ARCH-5 locators: 208 backticked path tokens were rewritten mechanically to the real new paths (a token is rewritten only when exactly one new location exists on disk). **Gaps recorded, not hidden:** (a) a golden table of the pre-move `proxy()` was not captured before the move; the move itself changed only imports in `proxy.ts`/`host.ts` callers, and T-70 then replaced the dispatch with the DOM-5 table (`packages/db/test/host.test.ts`), so before/after identity of the old proxy is argued, not measured; (b) the `*.localhost` Playwright project was delivered with T-70 (`e2e/host-mode.spec.ts`), not before the move; (c) `pnpm verify:docker` was not run (the standalone build that Playwright runs was); (d) the narrative parts of ARCH-5, BUILD-LOG, the track reports and the AGENTS.md "Parallel tracks" table still cite pre-move flat paths in places.
- Primary requirement: PR-14
- Constraints: PR-7, PR-10, PR-11, TD-7, ARCH-5, ARCH-6, ADR-0005, ADR-0008, ADR-0010, D-2, D-3, D-4, D-9, TEN-1, TEN-3, DOM-1, DOM-3, DOM-4, IAM-3, PRIV-2; one `apps/web` application; store remains the seller tenancy root; moves do not activate proposed hosts, implement subscription/affiliate/buyer/update-log behavior or change SQL definitions; migrations stay append-only. Production target hosts are `owner` (Owner console), `app` (Seller Admin), `affiliate` (Affiliate portal), `buyer` (Buyer account portal), `logs` (public Update Log), seller slugs and the configured platform checkout origin; `berkah` and `bos` are retired/reserved-unused. The reserved platform and infrastructure labels are documented here and in 08-DOMAIN-ROUTING and are enforced by T-70, not by this move-only task; the distinct affiliate storefront subtree is retained.
  Target boundary: document the proposed `(buyer-portal)/buyer/` route group, `/buyer` exact-host dispatch and `buyer/` data context owning platform-level buyer identity tables without empty routes/tables in this move-only task; buyer identity behavior belongs to ADR-0010 and PR-7. Owner console, Seller Admin, Affiliate portal and Buyer account portal each require separate host-only cookie scopes and session audiences, never shared or parent-domain sessions; buyer sessions grant no admin capability. T-51 preserves existing behavior while recording these feature-activation gates; it does not implement new login or identity behavior.
  Update Log boundary: document `logs.bukalaris.com` (public, read-only product Update Log; not the internal Log System `/admin/logs`, PR-11), the proposed `(update-log)/updates/…` route group, exact-host dispatch to `/updates` (GET/HEAD only; `/checkout*` and `/api/…` not served), reserved label `logs`, and the `platform/updates` sub-module as route/context documentation only: no route files, tables or proxy dispatch are created in this task. The Update Log carries no session, no authentication cookie and no personal data; authoring happens only in the Owner console on `owner.bukalaris.com`. The existing `proxy.ts` nonce CSP and request-id cookie are left unchanged (a cacheable public host needs a host-specific change in its own feature).
- Dependencies: T-1, T-2, T-12, T-27
- Notes: use the current merged M2 baseline. T-37, T-44, T-45, T-47, T-48, T-49 and T-61 depend on this task because they change files that move; T-70 (host dispatch, per-surface sessions, reserved labels) and the rest of the order follow it. T-37 is not absorbed into this restructure.
- Done when: a checked before/after inventory maps every existing route entry (baseline: 47 pages and 17 handlers, 64 total) and every ARCH-5 background entry one-to-one with stable page/HTTP/job IDs; any independently approved intervening additions are explicitly reconciled, and no effective URL/method is lost or duplicated. Existing route subtrees move under surface route groups with unchanged public paths, layout inheritance (including LP outside the shop shell and checkout outside all storefront shells), auth/action/handler behavior, host/path rewrites, `/checkout*` and `/api/…` bypasses, security headers, cookies and job payloads. `packages/db/src` is organized into platform, billing, buyer, seller/commerce, storefront, shipping, payments, affiliate and ops/jobs ownership boundaries without empty feature scaffolds: existing material is mechanically moved, future-only context ownership (including `platform/updates`) is documented, and actual feature files arrive in their own tasks. All callers, package exports, tests, Drizzle discovery, command/configuration and image-tracing references point to the new locations; obsolete flat paths and broad privileged compatibility re-exports are removed, not shimmed. Owner/app/platform role separation, forced store RLS, transaction-local `app.store_id`, compound foreign keys and restricted platform-pool access remain unchanged. Schema comparison produces no schema-change SQL from moves, all pre-existing migration files/history remain unchanged, and mixed `schema.ts` declarations are moved/extracted without duplicate definitions. The implementation owner records green `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm e2e` after the complete restructure, including existing tenant-negative, checkout, host/path and background-job coverage; move steps retain the previously green affected checks. The after-inventory shows the route entry count unchanged (64, plus any reconciled additions): no `(update-log)`, `(buyer-portal)`, `(affiliate-*)` or `updates` route file exists after T-51. ARCH-5 is regenerated against the resulting checked revision with real new locators, stable IDs and preserved implementation statuses; ADR-0008/TD-7 and Domain Routing document all eight surfaces (the seven product surfaces plus the public Update Log), the buyer context, the `platform/updates` placement, retired `bos`, reserved-label collision rules (including `logs`) and separate host/session activation requirements while distinguishing moves from proposed host/affiliate/billing/buyer/update-log behavior. The target host inventory and Mermaid surface map explicitly include `owner.bukalaris.com`, `buyer.bukalaris.com` and `logs.bukalaris.com`; no buyer session is documented as granting admin authority, and the Update Log is documented as distinct from the Log System.
  Move-proof artefacts (so that "unchanged" is shown, not asserted): before and after the move the implementation owner captures (a) a golden table of today's `proxy()` results for host × path × method, including `*.localhost` host mode and the `/checkout*` and `/api/…` bypasses, and the two tables are identical; (b) a Playwright project that runs the existing host-mode scenarios on `*.localhost` (the current Playwright config covers only localhost path mode); (c) a route-manifest diff showing no URL or method lost or duplicated; and (d) an empty `drizzle-kit generate` plus unchanged hashes of the existing migration files. The Coolify start commands and the RUNBOOK paths for `worker.ts` and `cleanup.ts` are updated in the same change (or root entry points are kept), and DEPLOY-COOLIFY and RUNBOOK are listed as update targets of this task.
- Added Done-when items (second documentation pass): the context list in ADR-0008 and TD-7 also includes the `tax/` data context and the `(public)` route group; `worker.ts` and `cleanup.ts` stay as thin root entry points. The behaviour changes CRUXR-02, CRSEC-01, CRSEC-02, CRSEC-03, CRSEC-05 and CRUXR-03 are not part of this task (T-70, T-59, T-62).

### T-52 — Implement platform affiliate data model and checkout attribution
- Status: Slices 1 to 3 and the added assertions delivered locally 2026-10-28 (working tree, not committed; migration 0016 section T-52; `packages/db/src/affiliate/**`, `GET /r/[token]`, checkout hook, JOB-20, JOB-27 registered OFF; report `docs/tracks/t52.md`; 33 mutation checks). DEFERRED: cross-origin click continuity (first-party storage and handoff decision; link attribution works on a shared origin, typed codes everywhere), window length (7 days placeholder), rate bounds (100 to 2000 bps placeholder), risk thresholds, platform fee on commission (not applied) and click retention period and notice text (owner decisions), the programme-limit writer and every screen (T-54), commission void/credit/hold/wallet (T-53), wiring the SA-18 queue to the fraud counters. Independent review done (2 P2, 5 P3): fixed: a buyer phone with no canonical Indonesian key (`+0812…`, `812…`) now suppresses and counts the commission (fail closed) instead of skipping the self-referral check, the click limiter checks the visitor's IP first and spends a link's budget only on capture-eligible navigations (HEAD, `<img>` and one noisy IP could use up a link's budget and flag its owner). DEFERRED P3s: a block or link revoke committed between the plan and the record can fail the order (lock the chosen link/code row or take a store-wide advisory lock), the variant touch trigger can deadlock orders that have no referral (enqueue an ID-only job instead of updating `affiliate_offer` inside the order transaction), the catalog projection keeps unpublished product data and does not react to store status changes, `blockAffiliate` reveals whether an affiliate id exists, the click retention sweep should also require `expires_at <= now()`.
- Primary requirement: PR-28
- Constraints: PR-7, DATA-11, IAM-3, IAM-13, PRIV-2, PRIV-7, BILL-8, TD-5, TD-7, ADR-0005, ADR-0009; one store per order, platform-owned affiliate identity, seller RLS unchanged, source `bukalaris` only. Attribution window, applicable platform-fee policy and production click retention/notice require owner acceptance; no imported defaults. Because all orders (prepaid and COD) run through Bukalaris's unified shipping and payment system (D-15, D-16), all opted-in seller orders are eligible for attribution and commission.
- Dependencies: T-51, T-59, T-50, T-48, T-49, T-37, T-57, T-70, T-74
- Notes: the affiliate window and privacy decisions are recorded in ADR-0009 (the retired T-8 no longer owns them); an optional buyer account is not required. T-57 supplies the canonical phone used for self-referral.
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Add the DATA-11 affiliate identity, seller settings/offers/blocks, catalog, link/click and attribution schema in the T-51 bounded contexts. Keep separate affiliate account references rather than seller-owned accounts. Add matching-store/matching-affiliate foreign keys, one `UNIQUE(order_id)` attribution, source `bukalaris`, globally unique normalized affiliate code, and immutable order-financial base/rate/commission snapshots. Outbox projection processes opt-in/change/withdrawal idempotently and ignores stale revisions without broadening seller-table RLS.
  - Slice 2 — Implement one server-side resolver shared by existing seller storefront/LP and platform checkout: valid typed code wins; otherwise last eligible server-captured click within the accepted window for the destination seller. Unknown/expired/revoked/blocked selectors do not fail an otherwise valid order; a chosen canonical-phone self-referral silently earns nothing and does not fall back to another affiliate. Opaque first-party click ids are server-timestamped and target-bound; carry them only through a validated checkout handoff, never through shared admin cookies or buyer PII in URLs. Approved retention cleanup removes raw clicks without deleting financial attribution evidence.
  - Slice 3 — In the order transaction, recheck current account, seller opt-in/block and rate bounds; reuse canonical checkout discount allocation, calculate eligible net-goods commission with integer IDR/basis points and one final floor, freeze line snapshots/total and deduct from the seller sale amount (`order_line_financials`). Non-opted-in lines earn zero; shipping/tax/gateway/platform fees are excluded. Rate changes never reprice old orders; order rollback leaves no orphan commission or deduction.
  - Execute focused Vitest policy tests plus real-PostgreSQL integration cases through `pnpm --filter @bukalaris/db test`: mixed product rates/discounts, zero base, typed/link precedence, exact window boundary, expiry, self-referral, blocked offer/account, tampered click target/time, stale/replayed outbox events and failed transaction rollback. Coordinate concurrent attempts against the same checkout/order and assert exactly one immutable attribution and deduction, including a direct duplicate insert rejected by the database. Store A cannot read/mutate B offers/blocks/order snapshots under the application RLS role; same-store success and intended cross-store public catalog discovery remain valid. Affiliate A cannot read B private attribution/click data or buyer PII.
  - Execute focused Playwright coverage through `pnpm --filter @bukalaris/web e2e`: link/code guest checkout and existing LP handoff preserve the selected seller and attribution; malformed/expired/self-referral selectors still place an order; duplicate submit does not duplicate commission. Assert affiliate-facing/public responses contain no buyer contact/order identifiers and forged cross-store click/handoff cannot change checkout authority. Record observed results only when executed; this task block claims no passing tests.
- Added assertions (second documentation pass): the click entry point is HTTP-27 `GET /r/[token]` on the apex host, captured on top-level navigation only with Sec-Fetch checks and the `__Host-bl_click` cookie, limited by `RL-CLICK` and `RL-CODE` (SEC-20). This task owns JOB-20 `affiliate.catalog.project` and JOB-27 `retention.affiliate_click` (off until the retention period is decided); a full `affiliate_catalog` rebuild command comes from T-74. The commission base is read from `order_line_financials`. Phase 1 fraud counters (click flood, self-referral, repeated code failures) feed the SA-18 risk queue; tests cover non-navigation requests, cookie stuffing and the rate limits.

### T-53 — Implement affiliate wallet, commission release and payouts
- Status: Planned (Proposed; live release/payout gated on accepted hold/tax/fee policies)
- Primary requirement: PR-28
- Constraints: BILL-8, DATA-11, IAM-13, PRIV-2, PRIV-4, PRIV-6, PRIV-7, NFR-2, ADR-0006, ADR-0009. Commission is eligible across all opted-in orders (prepaid and COD) only when the order is delivered AND the seller's sale is released (D-14), then after `affiliate_hold_days` (decided default: **3 days**, Owner-configurable in `SA-12`); pending attribution is not wallet cash. Commission platform fee and payout minimum/method remain OPEN. Tax rates are advisor-confirmed, versioned settings, never hard-coded or inferred from unverified secondary summaries.
- Dependencies: T-52, T-37, T-65, T-60, T-62, T-74
- Notes: T-65 supplies the tax tables and the payout tax hook, T-60 the `affiliate.payout.process` grant and T-62 the `approval_request` four-eyes service used when a payout is decided.
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Add signed append-only `affiliate_ledger_entry`, `affiliate_payout`, immutable payout allocations from DATA-11 (tax identity, tax settings and tax policy tables belong to T-65/DATA-15, not here). `affiliate_payout` carries the always-set `tax_setting_version_id` and the nullable `tax_computation_id` with the composite foreign key to the T-65 `tax_computation` and the CHECK that `tax_computation_id IS NULL` implies `tax_idr = 0 AND net_idr = gross_idr`; a real-PostgreSQL test rejects a payout whose amounts disagree with its computation. Partial unique credit/payout/reversal indexes enforce one effect per attribution/payout (there is no `commission_void` ledger kind). Derive balances from ledger sums without an inner order join. The existing single order-status writer sets the snapshotted delivery eligibility once, handles skipped provider transitions and calls commission effects transactionally; readiness is derived from the sale's released state plus `affiliate_hold_days`, not a stored state.
  - Slice 2 — Credit exactly once only after the order is delivered, the seller sale is released and `affiliate_hold_days` (default 3 days) have passed (the release job reads the sale's released state). A return or cancellation before delivery voids the attribution as a state change with no wallet entry; there is no `commission_void` ledger kind and no `unfunded` state. Paid-out commission is never reversed automatically: a late claim after payout is an explicit manual correction (`adjustment`). Support partial payouts through immutable commission allocations; release/payout writers share the per-affiliate transaction advisory lock and consistent row-lock order. Processing transfer stays in reconciliation until a confirmed outcome, never an assumed reversal.
  - Slice 3 — Implement own-wallet payout request and restricted platform processing: acquire the affiliate advisory lock, re-read available funds, call the T-65 payout tax hook (identity gate only when `tax_identity_required_for_payout` is ON, computation only when `withholding_enabled` is ON; startup defaults give tax 0 and net = gross), snapshot bank/gross/tax/net, reserve gross with one debit and allocations in the same transaction, and enforce `gross = withheld_tax + net_transfer` (withholding liability and remittance are deferred T-67). Marking paid records verified disbursement evidence with no second debit; rejection inserts one exact opposing reversal. Unknown transfer remains processing; later bank/policy edits cannot rewrite snapshots. Do not invent a provider payout endpoint.
  - Execute Vitest policy tests and real-PostgreSQL integration cases through `pnpm --filter @bukalaris/db test`: no release at shipped/payment-only, before/exactly-at/after the hold, repeated delivery/job, return before delivery voids without a wallet entry, payout races, simultaneous withdrawals, rejection replay and no-order payout entries included in wallet sums. Assert one-writer transition outcomes and no duplicate credit, debit or reversal. With the startup defaults a payout carries tax 0 and needs no identity; the gate and computation cases (missing identity, unconfirmed policy, fixture policies, immutable snapshots, no statutory rates asserted) are proved in T-65.
  - Execute focused Playwright coverage through `pnpm --filter @bukalaris/web e2e` on the existing buyer/seller order surfaces: place an attributed guest order, advance its legal fulfillment states, and inspect authoritative test-database outcomes to prove no wallet credit at shipped or before the seller sale is released and the hold has passed, one credit after the controlled release and hold gate, and no duplicate credit after repeated completion. Use synthetic accounts/policies and a controlled clock/job test seam; no sleep, real transfer or future portal UI is required for this slice. Seller B cannot advance seller A's order or trigger its commission effects.
  - Execute authorization and service-boundary tests: affiliate A cannot read/request B wallet/bank/payout (tax identity isolation is covered by T-65); seller A cannot reach affiliate finance; narrow worker/platform grants cannot mutate unrelated records. Full bank/phone/tax values never reach an unauthorized DTO, log or export. Clock-controlled click cleanup leaves ledger/withholding reconciliation unchanged. T-54 supplies browser acceptance for these completed services; no standalone payout UI or future live-provider result is claimed here.
- Added assertions (second documentation pass and owner decisions D-16 / D-19, 2026-10-27): the affiliate lock order is the two-key form in ADR-0009 (order row, store, affiliate); bank changes use the `affiliate_payout_destination` controls (step-up, notification of the old contact, account-holder-name check, and a mandatory **72-hour hold**, default 72 hours, Owner-configurable, D-19); four-eyes sits on approve-for-transfer under `affiliate.payout.process`, mark-paid only records evidence; JOB-26 `affiliate.commission.release` is enqueued by T-74 JOB-21; the payout-job freeze switch exists for restores. All opted-in orders (prepaid and COD) are eligible; an order in transit, returned or cancelled earns no commission; a credit is booked only after the order is delivered and its seller sale is released through T-37 reconciliation (D-14), then after `affiliate_hold_days` (decided default: **3 days**, Owner-configurable); a late claim after payout is an explicit manual correction (`adjustment`), never automatic.

### T-54 — Build affiliate portal, seller opt-in and Owner console affiliate administration
- Status: Planned (Proposed; consumes complete T-52/T-53 services and accepted UX-19/UX-20 screen contracts)
- Primary requirement: PR-28
- Constraints: DATA-11, BILL-8, IAM-1, IAM-3, IAM-13, PRIV-2, PRIV-6, PRIV-7, UX-19, UX-20, TD-7, ADR-0008, ADR-0009. Separate affiliate account/login/role, server-side authorization, platform ownership, aggregate-only referral outcomes and data-layer masking; no secret dashboard-link login or buyer-account substitute.
- Dependencies: T-53, T-60, T-70
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Implement the separate affiliate portal login/account and explicit role context, application/review status, own profile/link management and approved cross-store catalog discovery. Seller/Owner console sessions do not implicitly authenticate the portal; affiliate sessions cannot reach seller/Owner console powers. Show own aggregate referral outcomes, available/pending obligation totals and own wallet/payout history without individual buyer orders or raw click records. Surface pending/suspended/rejected/empty/error states and recovery per UX-19.
  - Slice 2 — Implement seller default rate, per-product explicit opt-in/override and individual affiliate block controls under own-store capabilities. Default is closed. Owner console bounds reject invalid rates; a seller cannot approve platform affiliate accounts or expose other sellers' settings. Publication/rate/withdrawal changes feed the catalog outbox and never reprice frozen commissions. Seller-account COD funding uncertainty is shown as the accepted gate, not advertised as funded earnings.
  - Slice 3 — Implement restricted Owner console affiliate review/suspension, platform rate/hold/window settings and payout processing/reconciliation views under separate grants. Advisor confirmation and open-policy decisions are real release gates, not prefilled production defaults. Provide the affiliate protected bank submission and own payout request flow using T-53 (the optional tax identity form is T-66); show missing-funding reasons, plus identity or policy reasons only when the T-65 flags are ON, without leaking protected identity. Audit approvals, blocks, policy changes and finance decisions; data-access projections mask bank/phone before HTML/RSC/JSON/export serialization.
  - Execute focused Vitest authorization/data-projection cases through `pnpm --filter @bukalaris/db test` and Playwright journeys through `pnpm --filter @bukalaris/web e2e`: affiliate application -> platform approval -> discovery of opted-in products from two seller stores -> link creation -> aggregate outcome -> own payout (no tax gate in startup mode); seller opt-in/override/block and Owner console suspension/review/payout rejection/paid bookkeeping. Prove same-context success and cross-store/cross-affiliate denied requests, stale-session revocation and insufficient-capability denial with no side effects. A seller block affects only that seller; account suspension stops new attribution without deleting earned money.
  - Inspect browser responses and authorized exports, not only visible text: no buyer name/phone/email/address/payment/order id/number or raw clicks are present in affiliate HTML, RSC/JSON or exported outcomes; no unmasked bank/phone/tax identity (where captured) reaches an unauthorized role. Direct URL/ID manipulation cannot read B storefront drafts, links, wallet or tax data (where captured). Mobile/desktop and keyboard flows expose required pending/success/error states from UX-19/UX-20. Record exercised results; UI screenshots alone do not prove RLS or masking.
- Added assertions (second documentation pass): this task owns AF-11 `/affiliate/apply` (limit `RL-AFF-SIGNUP`) and AF-01; the session cookie is `__Host-bl_aff`; affiliate MFA is offered at sign-up and step-up applies to bank and payout actions (IAM-13); after recovery or an MFA reset a payout hold applies; suspension unpublishes the affiliate storefront and deactivates its links; fraud counters feed the SA-18 risk queue.

### T-55 — Build affiliate storefront and seller-checkout handoff
- Status: Planned (Proposed; chain B follows approved portal/admin and UX-20 contracts)
- Primary requirement: PR-29
- Constraints: PR-6, PR-28, TD-5, TD-7, DATA-11, IAM-3, IAM-13, PRIV-2, PRIV-7, BILL-3, BILL-8, UX-20, ADR-0002, ADR-0008, ADR-0009. Cross-store discovery only; source `bukalaris` only; all purchases hand off to the selected seller's one-store checkout. No multi-seller cart, split order/settlement, external connector or affiliate buyer-data entitlement.
- Dependencies: T-54, T-70
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Implement own storefront handle/presentation and ordered item selection from `affiliate_catalog`, with explicit draft/publish/unpublish and server ownership checks. Use the proposed affiliate storefront namespace from ADR-0008, normalized unique handles and reserved-label rules. Public rendering reads safe published projection DTOs only; seller product ownership and seller storefront routing do not change.
  - Slice 2 — Show opted-in products from multiple seller stores with accurate seller identity and handoff destination. Withdrawn/unpublished/blocked/ineligible items cannot be purchased or attributed even with stale outbox data. Opening a product carries a target-bound first-party click through the accepted seller/custom-origin checkout handoff, preserving typed-code priority and no-error bad/expired/self-referral behavior from T-52. Selecting another seller cannot merge into or silently reassign an existing seller order; make separate seller checkout explicit. Do not trust affiliate catalog prices or browser affiliate/rate/store ids at submit.
  - Execute Vitest projection/ownership/target-binding cases and real-PostgreSQL isolation checks through `pnpm --filter @bukalaris/db test`; execute Playwright through `pnpm --filter @bukalaris/web e2e` for affiliate A publishing a storefront containing seller A and B products, distinct seller handoffs, custom seller origin -> platform checkout continuity, code override, expired click, unavailable product and withdrawn offer. Assert each resulting order has one seller and at most one immutable commission, with no cross-store cart/order read or mutation.
  - Prove affiliate B cannot mutate or publish A drafts/items, anonymous users cannot read drafts/private portal data, seller slug and affiliate handle namespaces cannot be confused, and forged destination/click identifiers cannot acquire another store's checkout authority. Public/affiliate responses and any outcomes/export carry no buyer PII/order identifiers, tax/bank details or portal session tokens. Validate mobile/desktop and keyboard purchase/handoff/error states under UX-20. DNS/TLS and deployed custom-domain continuity need observed environment evidence; local route tests alone do not claim production readiness.
- Added gate (second documentation pass): this task ships only after a probe host `probe.affiliate.<root>` serves a trusted `*.affiliate` certificate issued through DNS-01 (DEPLOY), because a one-label wildcard does not cover `<handle>.affiliate.<root>`.

### T-56 — Add external affiliate product sources
- Status: Planned (Deferred; no connector implementation, provider contract or accepted external source in phase 1)
- Primary requirement: PR-29
- Constraints: DATA-11, IAM-3, PRIV-2, BILL-3, BILL-8, ADR-0009. Phase 1 `source` is `bukalaris` only. Shopify and Etalashop/Tokophi are future candidates, not specified integrations. Reserving a source column grants no network, credential, seller-data or external checkout authority.
- Dependencies: T-55; separately accepted product/finance/security decision for the selected source
- Done when: Entry criteria are accepted before the task can be un-deferred: identify the actual source and product-rights/consent owner; verify its primary API, authorization, rate limits, revocation and webhook/reconciliation contracts; agree source/product identity and idempotent outbox/read-model mapping without weakening seller RLS; define authoritative price/availability and seller checkout handoff, attribution continuity, commission funding, refunds/returns, tax and payout reconciliation; accept privacy/processor/retention terms and threat/isolation review; define runnable Vitest contract/real-database isolation and Playwright checkout/no-PII acceptance. If multi-seller checkout is requested, close BILL-3 first. Only then revise this task into source-specific sliceable implementation work; until then no connector endpoint, credential scheme or settlement behavior is specified or claimed built.

### T-57 — Implement global buyer identity core and automatic checkout association
- Status: Slices 1 to 4 delivered locally 2026-10-28 (working tree, not committed; migration 0013 section T-57; `packages/db/src/buyer/**`; report `docs/tracks/t57.md`). Independent review done. DEFERRED (each needs an owner decision, listed in the report): OTP/magic-link proof and portal sessions (T-58: channel, provider, cost), recycled and shared numbers, merge UX and contested claims, global deletion and retention periods, minors, backfill of existing orders, authenticated prefill, checkout notice text, alert thresholds; review P3s: hard-code the bound-email policy flag in `buyer_resolve_order` instead of a parameter and limit platform UPDATE on `order` to named columns, rate-limit key spellings `+0812…` and bare `812…`; T-58 must grant a link only through proof of its `resolved_identifier_id` (an attacker who types a victim's phone with their own e-mail adds an observed alias). DEFAULT TAKEN: ADR-0010 step 6 `EMAIL_MATCH_REQUIRES_BOUND` = true (one constant, pinned by a test).
- Primary requirement: PR-7
- Constraints: DATA-4, DATA-12, IAM-4, IAM-14, PRIV-2, PRIV-4, PRIV-8, SEC-19, ADR-0005, ADR-0008, ADR-0010, JOB-10. Proposed names must match ADR-0010 section 3. Association is automatic and zero-friction at checkout, but is not verification, login, prefill or merge. OTP provider/channel, recycling, merge UX, deletion, minors and backfill remain OPEN; no production data is assumed.
- Dependencies: T-51, T-59
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Add one shared pure normalization module and migrate its callers deliberately: `08…`, `628…` and `+628…` produce one canonical `628…` phone; email keeps the existing trim/lowercase/validation contract without provider-specific alias rewriting. Reconcile the existing `normalizePhone` risk/privacy lookup semantics, signal/rate-limit keys and affiliate self-referral inputs without silently changing stored order snapshots or redaction behavior. Table-driven Vitest cases cover valid/invalid formats, separators, `+`, `00`, local `08`, duplicate representations and non-ASCII/over-length rejection.
  - Slice 2 — Add the exact proposed `buyer`, `buyer_identifier`, `buyer_order_link`, `buyer_identity_event` and `buyer_address` migrations: global `UNIQUE(kind, canonical_value)`, `UNIQUE(store_id, order_id)`, compound seller-order FK, same-buyer resolving-identifier FK, binding/access/status checks, one default address per buyer and append-only event privileges. Add own-buyer `FORCE ROW LEVEL SECURITY` using transaction-local `app.buyer_id` for `bukalaris_app`; explicitly document that `buyer_order_link.store_id` is provenance rather than the generic store policy and that `bukalaris_platform` bypasses RLS. Keep owner/app/platform grants narrow and add the new tables to schema/RLS/inventory tests.
  - Slice 3 — At seller checkout, write the existing immutable order snapshot and an ID-only `buyer.resolve` outbox intent in the same app-pool order transaction; add the platform-context resolver (JOB-10) that locks canonical keys deterministically, resolves phone first then email then provisional creation, never merges, never reassigns an owned identifier, attaches only unowned submitted identifiers as `observed`, writes `buyer_order_link(access_state='unverified')` and audit events atomically, and is idempotent under retry. If phone and email map to different buyers, phone wins and `phone_email_conflict` is appended without exposing the other buyer. Failure leaves a visible retriable job, never a failed guest order or duplicate buyer.
  - Slice 4 — Preserve zero buyer-visible friction and no leakage: checkout does not add signup, password or OTP; the response and any prefill endpoint reveal no stored name, address, order count, account existence, conflict status or cross-seller activity for an unverified phone/email. Affiliate self-referral keeps using canonical submitted order phone synchronously and later agrees with the resolved identity; sync lag, email conflict or later merge cannot alter a frozen commission. Define the export/redaction inventory and rate-limit/audit rules for identity tables, add T-43 inventory entries for global buyer data without making seller redaction a global lookup, and document how asynchronous backlog is observed.
  - Execute Vitest/PostgreSQL through `pnpm --filter @bukalaris/db test`: no identifier/order match, phone-only, email-only, same buyer both keys, different buyers (phone wins, no merge, email not moved), email already owned by another buyer, concurrent same phone/email orders, concurrent phone-vs-email conflict, replay of the same order, outbox crash/retry, duplicate unique-key insert rejection, check constraints, append-only audit and rollback with no partial attachment. Under the real `bukalaris_app` role prove store A context cannot read buyer tables or another store's order links, buyer A cannot read buyer B identifier/address/link rows, missing buyer context returns zero rows, and same-buyer reads succeed. Platform-resolver tests prove target-bound allowlisted operations do not accept caller-selected buyer/store reads.
  - Execute Playwright through `pnpm --filter @bukalaris/web e2e`: guest checkout still works with phone-only and phone+email; repeated checkouts at two seller stores create exactly one automatically linked buyer identity when the phone matches; submitting a victim phone with another email does not mutate the victim into an authenticatable alias or reveal any profile; unverified checkout/form responses are indistinguishable for existing and unknown contacts. Seller A views only A's order snapshot and cannot see another seller relationship. Use synthetic contacts only; observed results must be recorded only after execution. A backfill of existing M2/test orders is not part of this task unless the data owner accepts a separate migration with collision review.
- Added assertions (second documentation pass; ADR-0010 resolution rule): a buyer has one live phone, enforced by `buyer.primary_phone_identifier_id` and a partial unique index. When the submitted email matches a buyer that already has a different phone, a new buyer is created and `email_phone_mismatch` is logged. A test covers the victim-phone, attacker-email case and shows that the victim's later orders do not link to the attacker. OPEN, recommended, not decided: an email match accepts a first phone only when that email is `bound`.

### T-58 — Build buyer portal at buyer.bukalaris.com
- Status: Planned (Proposed; chain requires accepted UX-21 screen contracts, selected proof channel and ADR-0008 host routing)
- Primary requirement: PR-7
- Constraints: DATA-12, IAM-14, PRIV-2, PRIV-4, PRIV-5, PRIV-8, SEC-19, TD-7, ADR-0005, ADR-0008, ADR-0010, UX-21, BA-01 through BA-06. Passwordless means no signup form/password, not no proof. Buyer host has its own host-only cookie and grants no seller/admin/affiliate capability. OTP channel/provider/cost, authenticated prefill, merge UX, recycling policy, global deletion and minor handling are OPEN and must be resolved or explicitly gated before live use.
- Dependencies: T-57, T-70, T-73
- Notes: T-70 supplies exact-host dispatch and the per-surface session framework; T-73 supplies the real mailer and the purged outbox bodies that the magic links need.
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Activate the `buyer.bukalaris.com` surface on the T-70 foundation: its entry in the exact-host dispatch table (before seller-wildcard resolution), the reserved label `buyer`, and its separate buyer auth/session audience with host-only Secure HttpOnly cookie, trusted-origin/callback allowlist and CSRF protection. The passwordless proof request/verify flow is uniform for existing, unknown, observed, conflicting and revoked contacts, single-use, short-lived, attempt-bounded and shared-atomic rate-limited by identifier/operation/trusted network. The selected OTP/magic-link adapter is a bounded provider boundary with deterministic synthetic tests; no live provider is claimed verified. A new alias proof cannot unlock a phone owner's history unless account-binding and recycling/history gates in ADR-0010 pass.
  - Slice 2 — Implement BA-05 overview and BA-01 cross-seller order history/detail/tracking from confirmed own `buyer_order_link` rows through a narrow platform history projection with explicit stored store/order targets, session/link/redaction recheck on every read, buyer-scoped no-store caching and a safe DTO. Tracking reuses the existing buyer-safe status/resi/timeline contract; it exposes no seller-private, payment-secret, affiliate, other-store or global conflict data. T-36 signed links remain single-order, still work independently and never mint a buyer session.
  - Slice 3 — Implement BA-03 profile and BA-02 address book under authenticated own-buyer RLS, with fresh proof for identifier binding/removal and no automatic merge. Profile/address edits never rewrite immutable order snapshots. Any checkout prefill is a separate gated change after the OPEN decision; until then checkout remains guest-form based. Implement BA-06 own privacy export/closure request according to accepted PRIV-8 semantics, separate from seller T-43 export/redaction, with no-store/audited outputs and no raw tokens/contact values in audit logs.
  - Execute focused Vitest/PostgreSQL authorization and DTO tests through `pnpm --filter @bukalaris/db test` and Playwright through `pnpm --filter @bukalaris/web e2e`: sign in with each allowed proof method (synthetic adapter), view orders from two seller stores, open detail/tracking, edit profile/address and sign out; expired, reused, tampered, cross-purpose and wrong-identifier proofs fail uniformly; stale/revoked sessions cannot read or mutate; buyer B cannot request buyer A order/address IDs and receives not-found; seller/affiliate/admin sessions grant no buyer access and the buyer session grants none of theirs; no buyer cookie is sent to seller/custom/affiliate/Owner console hosts and no parent-domain cookie exists.
  - Prove that an attacker who checks out with a victim phone and an attacker email cannot verify that email to see the victim's orders or addresses; unconfirmed/restricted/disputed links remain hidden; seller A cannot learn the buyer also shops at seller B; T-43 store redaction is reflected in portal DTO/export; no HTML/RSC/JSON/export contains another buyer's identifiers, hashes or tokens. Verify mobile/desktop and keyboard states for login, expired proof, rate limit, empty history and restricted account under UX-21. Live OTP delivery, DNS/TLS and deployed cookie isolation need separate observed environment evidence; local route tests do not claim production readiness.
- Added assertions (second documentation pass): this task owns BA-01 to BA-06; the buyer cookie is `__Host-bl_buyer`; proof requests use `RL-OTP-REQ`, `RL-OTP-VERIFY` and per-destination delivery caps (toll-fraud protection); one-time links go through the T-73 mailer.

## Review follow-ups — 2026-10-27 (T-59, T-60 and T-61 accepted by the owner 2026-10-28, D-20)

From `docs/reviews/2026-10-27-code-vs-spec-gap-report.md`. T-59, T-60 and T-61 were confirmed by the owner on 2026-10-28 (DECISIONS D-20).

### T-59 — RLS framework and narrow platform grants for platform-owned tables
- Status: Expand step delivered locally 2026-10-28 (working tree, not committed, nothing deployed; migration 0011 section T-59; registry `platform/isolation-registry.ts`, resolver functions `platform/resolvers.ts`, contexts `platform/tenant.ts`, tests `rls.test.ts` and `rls-contract.test.ts`; report `docs/tracks/t59-rls.md`). Independent security review done (BUILD-LOG 2026-10-28); P1/P2 findings fixed or listed below. DEFERRED: (1) the CONTRACT step `packages/db/drizzle-pending/t59-contract.sql` (needs the new web version deployed everywhere and the owner's approval, D-22 item 4; proven only on a scratch schema by `rls-contract.test.ts`); (2) T-59b: operator, approval and break-glass tables become class `restricted` behind definer functions together with their own Better Auth instance (after T-62; until then the platform login can still write them, and the definer guards plus the capability checks are the compensating controls); (3) T-59c: replace the store-less audit GUC (`app.audit_writer`) and the buyer-identifier access by definer functions (with T-57); the GUC contexts are documented in ADR-0005 as protection against application bugs, not against arbitrary SQL as the app role; (4) production role bootstrap (DBA step, `docs/DEPLOY-COOLIFY.md`).
- Primary requirement: PR-28
- Constraints: ADR-0005 (and its 2026-10-27 amendment), ADR-0008, ADR-0009, ADR-0010, DATA-11, DATA-12, IAM-13, IAM-14, TEN-1, TEN-3, SEC-1, D-4, D-9
- Dependencies: T-51
- Done when: a per-table isolation registry classifies every existing table (`tenant`, `buyer`, `affiliate`, `platform`, `shared-read`) and the invariant test in `packages/db/test/rls.test.ts` asserts registry completeness and policy shape per class instead of "has `store_id` means tenant policy"; `app.buyer_id` and `app.affiliate_id` contexts with `withBuyer`/`withAffiliate` helpers fail closed and are covered by tests under the real `bukalaris_app` role (missing context returns zero rows, a foreign id is rejected, same-owner reads succeed); the `audit_log` policy admits store-less rows from defined writers; `bukalaris_platform` grants become per table and operation, restricted tables are reachable only through named resolver/worker functions and default privileges exclude future tables for the platform role; ADR-0005 decisions 2 and 4 are corrected in the same change (the `system_log` description and the resolver list); migrations are append-only (D-9) and the existing suite stays green; no fourth login role is added.
  Rollout safety (expand/contract): grants and REVOKEs that the previous web version still relies on are applied in two steps. The first migration adds the new roles, functions and policies (expand); the new web version is deployed; only then a follow-up migration revokes the old table-wide grants (contract), so the swap never leaves the running version without access. The same change updates `packages/db/docker/05-roles.sql`, the role SQL in DEPLOY-COOLIFY, the `verify:docker` policy-count assertion and the restore rehearsal's `rls_ok` check (both derived from the isolation registry, not a hard-coded count), and the rehearsal asserts per-role grants after a restore.
- Added Done-when items (second documentation pass; ADR-0005 amendment): the registry also has the classes `restricted` and `auth`; restricted tables are owned by the no-login role `bukalaris_restricted` and reached only through `SECURITY DEFINER` functions, and host, store, cart, token and handoff lookups run on the app pool through functions owned by the no-login role `bukalaris_resolver`; a test shows `bukalaris_platform` has no privilege on restricted tables and every access path is a registered function; the auth tables are classified in the registry and the operator identity uses **separate operator tables, not the seller account tables (decided by the owner 2026-10-28, D-20)**; field classification is driven by the `data_field_class` registry, not column-name heuristics; the restore rehearsal asserts grants per role and replays erasure records (SEC-23).

### T-60 — Platform capability grants for Owner console
- Status: Delivered locally 2026-10-28 (working tree, not committed; migration 0011 section T-60; `ops/capabilities*.ts`, `ops/schema-ops.ts`, bootstrap script `bootstrap:console`, session MFA hook in `apps/web/src/lib/auth.ts`; report `docs/tracks/t60-capabilities.md`). Independent review done; findings fixed (approval payload readable by the approver via `payload_canonical`, last-holder counts standing grants only, `ops.jobs.manage` enforced, definer guards with a pinned search_path, break-glass approver check). DEFERRED: four-eyes on `shipping.margin` and the approvals inbox (T-62), the break-glass duration CHECK (PRIV-9 maximum is undecided), a DB-level test of the MFA hook through the web sign-in (covered only by the web e2e), the bootstrap test through the owner-role path.
- Primary requirement: PR-15
- Constraints: IAM-8, IAM-13, IAM-15, SEC-7, TEN-3, ADR-0008, ADR-0009
- Dependencies: T-51
- Added assertions (D-21, 99ribu study; each needs a named automated test): MFA is bound to the session (a session created before enrolment or without a verified code is refused on operator routes even when the account flag is set); the last holder of a critical capability cannot be removed, with the holders locked in a deterministic order so two simultaneous demotions abort one of them; a grant change revokes that operator's sessions in the same transaction; an approval or reauthentication proof is single-use, bound to session, action and subject, and consumed atomically with the write.
- Done when: `operator_grant` carries explicit capabilities beyond `logs.read`, with `tenants.manage` and `audit.read` named by IAM-8 and every further name taken exactly from the IAM-15 catalogue (for example `shipping.manage`, `billing.manage`, `payouts.process`, `refunds.process`, `affiliate.accounts.review`, `affiliate.payout.process`, `tax.manage`); the seller-payout grants `payouts.process` and `refunds.process` never imply `affiliate.payout.process` and the reverse, and a Vitest case asserts both directions; every Owner console action and server operation checks its capability in addition to the operator and TOTP check (store create/suspend, shipping margin, store audit reads, and later subscription and affiliate administration); Owner console can grant and revoke with an audit row; the demo operator is seeded with a documented grant set; Vitest proves a grant-less operator is refused per action and cross-capability isolation, and Playwright proves the navigation hides what the operator may not use; T-37, T-50 and T-54 consume these grants rather than defining their own.
- Added Done-when items (final policy round; IAM-15): the capability `payouts.reconcile` and the four-eyes action `cod.reconcile_release` (COD reconciliation batch approval) are seeded in `four_eyes_rule`; `ops.issues.attachments` exists but is dormant in Phase 1 (no attachment is built); `billing.ppn_toggle` is not a capability and is not in the `four_eyes_rule` seed (the PPN switch uses `tax.manage` with confirmation and reason, T-50); the batch approver is never the preparer.
- Added Done-when items (second documentation pass; IAM-15): a bootstrap script creates the first `staff.manage` and `break_glass.approve` holders and refuses to run when two or more active `staff.manage` holders exist, writing `system_bootstrap` and `system_recovery` rows to `operator_grant_event` (`source`); the `four_eyes_rule` table is seeded from the IAM-15 four-eyes matrix action keys (including `cod.manual_complete`); `ops.jobs.manage` is a capability; identities with a `platform_operator` row are excluded from `accounts.*`; a CHECK limits break-glass capabilities to the allowlist and break-glass never satisfies four-eyes.

### T-61 — Variant weight and parcel weight for quotes and bookings
- Status: Done locally 2026-10-28 (working tree, not committed; nothing deployed). `variant.weight_grams` (NOT NULL, CHECK > 0, no column default; migration `0010` backfills existing variants with 1000 g so old quotes keep their "1 kg per unit" meaning until a seller sets a weight), required in `variantInput` and on the seller product and variant forms ("Berat (gram)"), filled by the seed (1000 g) and the demo seed (300 g); `parcelWeightKg` in `packages/db/src/shipping/shipping.ts` (sum of quantity × weight, rounded up to whole kg, minimum 1 kg) is the only weight rule: `shippingOptions` (quote) uses it, `placeOrder` re-quotes through the same path and snapshots the result in `order.weight_kg`, and the booking reads that snapshot, so the three agree; the old "1 kg per distinct cart line" rule is gone with `CartForShipping.items` (callers: checkout page, `placeOrder`). Observed: `pnpm typecheck`, `pnpm lint`, `drizzle-kit generate` (no further diff) clean; DB suite 22 files / 232 tests passed (new "parcel weight (T-61)" cases: rounding boundaries incl. exactly 1000 g and 1001 g, empty cart, multi-unit and multi-line sums, quote and order snapshot from variant weight, a lighter variant changing the quote, service and CHECK rejection of 0, fractional and missing weights); expectations of five existing tests moved to the new rule (2 units now weigh 2 kg, fee Rp 22.500 instead of 17.500); full Playwright run: 93 passed, 8 failed before the spec updates; after updating `purchase`, `channels`, `catalog`, `admin-product` and `ui` specs (new field) and scoping one ambiguous `alert` locator in `privacy.spec`, the five affected specs passed (13 + 4 tests), but the **whole Playwright suite was not re-run end to end after those fixes**. Not done / UNVERIFIED: rounding up and the provider minimum against Mengantar (no observed estimate or booking); "cannot be published without a weight" is enforced by the weight being mandatory on every variant, not by a separate publish check; the Storefront API (`weight_grams` is in `docs/openapi.yaml`) does not expose or accept weight yet; the demo seed was not run (`db:seed:demo` has its own Vitest `demo.test.ts`, which passed in the DB suite).
- Primary requirement: PR-5
- Constraints: BILL-4, DATA-2, DATA-13, T-34, ADR-0006 decision 7, TEN-1
- Dependencies: T-34, T-51
- Done when: `variant.weight_grams` exists (positive integer, set by the seller, required before a variant can be published) with the seller product form and demo seed filling it; one pure function derives the parcel weight in kilograms as the sum of quantity times variant weight and is used by the checkout quote, the order snapshot and the booking, replacing the current "one kilogram per distinct cart line" rule, so the quote and the booking describe the same parcel; rounding and the provider minimum follow the Mengantar contract and stay UNVERIFIED until an observed estimate or booking confirms them (the documented estimate and create-order fields carry weight in kilograms only, no dimensions); Vitest covers multi-unit lines, rounding boundaries and a quote/booking weight equality assertion, and Playwright covers the seller form validation; existing orders keep their snapshotted weight.

## Owner console, tax and update-log tasks — 2026-10-27

Owner console = the renamed Owner console (host `owner.bukalaris.com`). Startup mode is relaxed: Bukalaris is an online-store platform, not a marketplace; each seller manages their own store and taxes. Tax withholding, the tax ledger and the compliance center stay dormant until Tax activation (T-67) and Compliance activation (T-64) respectively. The canonical build order is the one at the top of the "M3 chains A and B" section above; it is derived from the `Dependencies:` lines and is not repeated here. T-64 and T-67 are deferred.

### T-62 — Owner console shell, navigation, capability-gated menu and "Lapor masalah" control
- Status: Delivered locally 2026-10-28 (working tree, not committed; migration 0012 section T-62; `ops/console*.ts`, `apps/web/src/lib/console-gate.ts`, `(operator)/admin/**`; report `docs/tracks/t62-console.md`). Independent review done; fixed: every transfer approval row shown is a recorded `full` access event. DEFERRED: staff and access screens SA-38/SA-39 (need the staff account-creation path of T-59b and an operator `active` state), the SA-50 triage queue (T-68), default `ops.issues.report` grant for every staff member (belongs to staff creation), `shipping.margin` four-eyes, alert-sink notification, the step-up proof is created and used inside one request so it adds no second verification in the console (decision 3 of the report; a separate re-verify screen belongs with T-59b).
- Primary requirement: PR-30
- Constraints: UX-22, IAM-15, IAM-5, IAM-9, IAM-10, PRIV-9, SEC-11, TEN-3, NFR-3, ARCH-5 (SA-14, SA-28, SA-34 to SA-39, SA-50 control), DATA-14, ADR-0005 (as amended by T-59), ADR-0008, ADR-0011, CRUXR-03. Naming rule: "Owner console" or "platform owner" for the platform and "store owner" for `membership.role = 'owner'`; existing ids (SA-xx, `/admin`, `platform_operator`) are not renamed. No impersonation, no password handling, no feature-flag screen. P2 and P1.5 items stay absent and not-found until activated.
- Dependencies: T-51, T-60, T-59, T-70
- Added assertions (D-21, 99ribu study): audit and issue-report viewers redact by a per-action allowlist, with an import-time assertion that no credential-like key can be allowlisted (tests with canary values); reading the audit log is itself audited and the response is `no-store`; the capability-gated menu hides empty groups.
- Notes: T-51 supplies the route groups; T-70 supplies exact-host dispatch, the per-surface session audiences and cookies and reserved-label enforcement (CRSEC-02, CRSEC-01); T-60 supplies the capability grants (IAM-8 and IAM-15 names); T-59 supplies the platform-class table registry. T-63, T-68 and T-69 follow this task.
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Route registry and gate. One registry maps every `/admin` page and handler to ARCH-5 id, capability, phase and menu placement. A single server helper is the first statement of every page, action and handler: it re-reads the `platform_operator` row and `operator_grant` rows from the database on each request (never from the cookie), checks the capability and phase activation, and renders the denied state or not-found. A dead-but-valid cookie routes to sign-out, not a redirect loop. A Vitest route test derives the page list from the `admin` directory and fails when a page lacks a registry entry (unlisted routes fail closed). The helper writes a denial audit row.
  - Slice 2 — Shell and navigation. Replace the flat three-item strip with the UX-22 grouped navigation filtered by capability (groups appear only with a permitted child, P2 and P1.5 items absent), header brand "Bukalaris · Owner", context chip, `<title>` and copy changes (including the remaining "Bos" brand copy in the admin layout and the Log System pages, CRUXR-03), skip link, `aria-current`, second-row group items and a 320px layout without horizontal overflow. Move the store list (SA-02) to `/admin/stores`, add the SA-14 dashboard at `/admin` with only the cards whose sources already exist (store counts by status that sum to the total; others show "not available yet", never 0), and update the existing e2e and ARCH-5 rows when this lands (the reserved label `owner` is enforced by T-70). Badge counts show "—" on source failure.
  - Slice 3 — Session isolation and approvals. Verify the Owner session cookie is host-only on `owner`, carries its own audience and is rejected on seller, affiliate, buyer and checkout hosts, and that their sessions are rejected here (CRSEC-02, delivered by T-70; this slice adds the cross-surface denial tests). MFA is required before any console data; add the fresh-authentication check for sensitive actions with a configured window. Add `approval_request` (DATA-14) with the four-eyes service (requester cannot approve, execute once, payload-hash snapshot, expiry, grant revocation cancels pending requests, `CHECK requested_by <> decided_by`), SA-28 inbox, and JOB-12 expiry sweeper. Add the staff and access screens SA-38/SA-39 on top of T-60 (invite, assign preset or capabilities, deactivate atomically revokes grants, requests and sessions; last `staff.manage` holder protected; self-grant refused; sensitive grants via approval).
  - Slice 4 — Audit and platform screens. One mutation wrapper checks the capability and writes the audit row (actor, capability, target, case, reason code, outcome) in the same transaction and refuses the action when the audit row cannot be written. Deliver SA-37 audit viewer (masked values, bounded range, cursor paging, own reads audited, no edit or delete), SA-34 platform settings (reserved labels read-only list, rate-limit policy view, host status), SA-35 provider health (present, last sanitized result, unknown; never a secret) and the SA-36 shell with backlog and failed-job sources that exist.
  - Slice 5 — "Lapor masalah" control. Add the shared `ReportIssue` shell component (header action, dialog, fields and picker as in UX-22), the client buffer for recent request ids (read from a new `x-request-id` response header), failed server actions and client errors, the `reportIssue` server action (versioned schema validation with unknown keys dropped, `scrubText`, 16 KiB cap, server-resolved page id from the route template, server-resolved log event links, idempotency by client request id, per-staff rate limit) and the `issue_report` and `issue_report_event` migrations (DATA-14, platform class, Owner staff only, no seller or affiliate role grant). The component takes a `surface` property; only `owner` is mounted. Capability `ops.issues.report` is default for every active staff member. The queue is T-68.
  - Execute Vitest through `pnpm --filter @bukalaris/db test` and `pnpm --filter @bukalaris/web test`: per capability allowed and denied calls (no grant, wrong capability, revoked, expired, seller/affiliate/buyer/store-owner session) with no side effect and a denial audit row; grant revocation takes effect on the next request; four-eyes cases (self-approval in UI and server, concurrent approve, expired, payload changed, requester revoked); audit-failure aborts the mutation; the route-registry test; reserved label `owner` rejected as a store slug; issue-report schema tests (secrets, e-mail, phone, query strings, oversize context, client-supplied page id and event ids ignored, rate limit and recovery under an injected clock, double submit returns one report, non-staff cannot create).
  - Execute Playwright through `pnpm --filter @bukalaris/web e2e`: a staff member with one capability sees exactly the matching groups and items and gets the denied state on every other direct URL; no-grant staff sees "no access"; the Owner cookie is not accepted on other hosts and vice versa (local host fixtures; production DNS/TLS and cookie isolation need separate observed evidence); the Lapor masalah dialog opens from two different pages (store list and Log System), submits with keyboard only at 320px, returns focus, and the stored reports carry the correct page ids and correlation ids; the existing store list, store detail, shipping and Log System journeys still pass at their new menu positions. Record only observed results.
- Added assertions (second documentation pass): the slice 3 cross-surface tests take their cells from the host and path matrix in 08 DOM-5; the Approvals screen shows the bank snapshot to the approver of an approve-for-transfer request; SA-19 has only a menu slot until T-64.
- Added assertions (owner decisions D-14 and D-15, final ids): the registered Owner console COD reconciliation id is SA-53 (COD reconciliation queue and batch detail, delivered with T-37); SA-54 is retired into SA-07 (`/admin/shipping`) because all orders run in one unified Bukalaris-managed system.

### T-63 — Account governance: stores and seller team accounts (lifecycle, optional verification, support actions, cases)
- Status: Delivered locally 2026-10-28 for stores and seller team accounts (working tree, not committed; migration 0013 section T-63; `ops/accounts-governance*.ts`, `(operator)/admin/{cases,accounts,risk,staff}`, `account/support-recovery/[token]`; report `docs/tracks/t63.md`). Independent review done; fixed: the platform login has no INSERT on `support_recovery_link` (links are created by `support_recovery_create()`), `console_reset_user_mfa` needs an executed four-eyes approval for store owners and staff, a case without a subject authorises no target. DEFERRED: staff invitation and account creation (T-59b: operator identity tables and their own Better Auth instance; until then the platform login can still write approval and operator tables, the definer functions raise the bar but do not close it), SA-17 store ledger statement and SA-53 (T-37 finish), resend verification (decision: enable Better Auth e-mail verification), break-glass duration maximum and review deadline (PRIV-9 OPEN), four SA-18 risk rules (need T-50/T-48/T-37/T-52 data), per-action fresh-code step-up (needs the SA-34 setting), affiliate and buyer kinds (T-72).
- Primary requirement: PR-30
- Constraints: IAM-15, IAM-10, PRIV-9, PRIV-2, DATA-14, UX-22, ADR-0005 (T-59 amendment), ADR-0011, SA-16 to SA-18, SA-20, SA-23, SA-24 (seller team kind). Startup relaxation: the verification record is optional and never blocks store creation, approval, activation, billing or payout; no tax gate here. No impersonation, no password or token display, no bulk personal-data export. Money, tax and break-glass specifics belong to their owning tasks.
- Dependencies: T-62, T-59, T-73
- Notes: T-73 (real mailer, purged outbox bodies) is required because support recovery links go through the outbox. SA-17 reads the store ledger when T-37 has delivered it and stays disabled with an explicit "not available yet" until then. The affiliate and buyer account kinds, SA-25 and affiliate suspension are in T-72.
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — DATA-14 core. Add `support_case`, `support_case_note` (append-only, scrubbed), `account_status_event` (append-only history), `support_action` (idempotency key, approver), `account_verification` (versioned, optional), `personal_data_access_event` (append-only), `break_glass_grant` and the audit-log extension columns (capability, purpose code, case id, subject kind and id, access level, outcome). All are platform-class tables under T-59: no `bukalaris_app` or affiliate grant, written through named services, with append-only privileges where stated.
  - Slice 2 — Store governance. Deliver SA-02/SA-03 lifecycle actions (create, approve, suspend, reactivate with reason and case; concurrent transitions yield one change; lifting suspension never clears debt and paying never clears suspension), SA-16 optional verification record with immutable versions and masked contact, SA-18 risk queue with flags derived from authoritative state (subscription state, not the effective status; shipping account `needs_key` or disabled; `awaiting_balance` or `awaiting_account` orders) and acknowledge with reason and expiry, SA-20 cases and notes, SA-17 as a read-only paged statement when T-37 exists. The risk and store views carry no personal data beyond masked contact.
  - Slice 3 — Account search and masking. Implement the masked projection interface per account kind with its seller team member implementation, and SA-23 search by canonical phone, e-mail or internal id returning masked hits for seller accounts, rate-limited, with the raw query never logged or audited (a keyed fingerprint may be). The affiliate and buyer kinds plug into the same interface in T-72; no affiliate or buyer hit exists before then. Masking happens in the data layer before serialization, including RSC, JSON and exports.
  - Slice 4 — Support actions and reveal. SA-24 diagnostic view for seller team members (status and history, memberships, approval state, restricted/closed state, MFA yes or no, active session count, last sign-in, open cases, counts without lines or balances unless the viewer holds the extra capability) and actions: recovery link to the verified contact (never shown to the operator), revoke all sessions, request MFA reset (four-eyes for store-owner accounts), resend verification, suspend or restore an identity, open case. Each action needs a case and reason, writes an audit row and a `support_action` row atomically, reports the written outcome, and after suspend the stale session cannot mutate. Implement the PRIV-9 reveal flow (purpose and case required, field-level, expiring, `personal_data_access_event` row) and the approval-gated break-glass elevation with automatic expiry, notification of audit-capability holders and a review record.
  - Slice 5 — Store ownership recovery (`members.recover`, four-eyes, evidence standard OPEN) as a case-driven action. Data-subject requests are handled as cases in this phase.
  - Execute Vitest and real-PostgreSQL integration through `pnpm --filter @bukalaris/db test`: allowed and denied cases per capability (SA-23/24 actions, reveal, break-glass), no password, link, token, OTP or API key in any DTO, log, audit reason or export, masking in HTML, RSC and JSON, a reveal without purpose and case refused and an expired reveal masked again, case notes scrubbed of contact and URL shapes, append-only enforcement (UPDATE and DELETE rejected on event tables under the real role), audit-failure aborts the action, concurrent suspend yields one transition, seller and affiliate sessions denied on every `/admin` account call, a store without any verification record can be created and approved (and paid out once T-37 exists).
  - Execute Playwright through `pnpm --filter @bukalaris/web e2e`: staff searches a seller team member by e-mail (case and spacing variants) and by internal id and reaches the same masked record; opens it, sends a recovery link (outcome text "queued, delivery not confirmed"), revokes sessions and watches the stale seller tab fail to mutate; creates, approves and suspends a store with and without a verification record; keyboard-only and 320px runs of the search and detail screens; denied direct URLs for each missing capability. Record only observed results.
- Added assertions (second documentation pass and owner decisions D-14, D-15, D-19; IAM-15): an MFA reset is four-eyes for store-owner accounts; staff accounts are reset only through `staff.manage` with four-eyes and never through `accounts.*`; buyer search and any per-store breakdown need a case and purpose; staff-executed store ownership recovery (`members.recover`) is decided disabled (returns not-found) in Phase 1 (D-19; sellers use self-service recovery). This task hosts SA-53 (queue of delivered unreconciled COD orders, batch detail with evidence references, prepare then approve by a different staff member under `cod.reconcile_release`; capability `payouts.reconcile`).

### T-72 — Account governance: affiliate and buyer accounts (search, diagnostics, suspension, buyer identifier and merge requests)
- Status: Planned (Proposed 2026-10-27; specification only; Phase 1 startup core; split from T-63 so that the store and seller-team slice does not wait for the affiliate and buyer portals)
- Primary requirement: PR-30
- Constraints: IAM-15, IAM-10, IAM-3, IAM-13, IAM-14, PRIV-9, PRIV-2, PRIV-6, DATA-14, UX-22, ADR-0009, ADR-0010, ADR-0011, SA-23 to SA-25. No impersonation, no password or token display, no direct buyer identifier edit, no bulk personal-data export. Staff-executed buyer merge (`merge.execute`) is decided disabled (returns not-found) in Phase 1 (D-19; buyers merge only via self-service possession proof of both identifiers).
- Dependencies: T-63, T-54, T-58
- Notes: T-54 provides the affiliate account services and T-58 (through T-57) the buyer resolver; this task reads both through narrow resolvers and adds no cross-store table grant.
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Affiliate and buyer account kinds in the T-63 masked projection interface: affiliate through the affiliate context, buyer through the ADR-0010 platform resolver. SA-23 search by canonical phone, e-mail or internal id now returns masked hits of every kind (rate-limited, raw query never logged, masking before serialization including RSC, JSON and exports), and SA-24 shows the kind-specific diagnostic view (affiliate: approval state, status history, suspended flag, open cases; buyer: restricted or closed state, open cases, counts without order lines or balances unless the viewer holds the extra capability).
  - Slice 2 — Support actions for these kinds under the T-63 slice 4 rules: recovery link or contact request to the verified contact (never shown to the operator), revoke sessions, suspend or restore an identity, restrict or unrestrict a buyer account, open case. Each action needs a case and reason and writes an audit row and a `support_action` row atomically; after suspend the stale session cannot mutate. Affiliate suspension and reactivation use `affiliate.accounts.review` with reason (stops new attribution, never deletes earned money).
  - Slice 3 — Buyer identifier and merge requests (SA-25) via the restricted ADR-0010 recovery service: list proofs on record, require self-service proof of both identifiers; staff-executed merge stays disabled (not-found) in Phase 1 (D-19).
  - Execute Vitest and real-PostgreSQL integration through `pnpm --filter @bukalaris/db test`: allowed and denied cases per capability (SA-23/24/25 for affiliate and buyer kinds), no password, link, token, OTP or API key in any DTO, log, audit reason or export, masking in HTML, RSC and JSON for affiliate and buyer DTOs, audit-failure aborts the action, concurrent suspend yields one transition, seller, affiliate and buyer sessions denied on every `/admin` account call, staff merge execution returns not-found in Phase 1, affiliate suspension stops new attribution without deleting earned money.
  - Execute Playwright through `pnpm --filter @bukalaris/web e2e`: staff searches a buyer phone in `08…`, `62…` and `+62…` forms and reaches the same masked record; suspends and restores an affiliate with a reason; verifies that staff merge execution is disabled; keyboard-only and 320px runs of the search and detail screens; denied direct URLs for each missing capability. Record only observed results.
- Added assertions (second documentation pass and D-19): an MFA reset is four-eyes for affiliate accounts; staff buyer merge execution is decided disabled (not-found) in Phase 1.

### T-64 — Compliance center (Phase 2, deferred): verification queue, takedown notices, complaints, privacy requests, incident register, registrations
- Status: Planned (Deferred, Phase 2; do not start until the activation criteria below are recorded; specification only)
- Primary requirement: PR-30
- Constraints: ADR-0011 §3 and §5, UX-22 (P2 screens), IAM-15 (P2 capabilities), PRIV-9, PRIV-4, PRIV-5, PRIV-8, DATA-14, SA-15, SA-21, SA-22, SA-29 to SA-33, SF-13, HTTP-18 to HTTP-20, JOB-11. Bukalaris is an online-store platform, not a marketplace; these workflows exist only for when licensing alignment or the owner's choice requires them. Statutory readings (PP 80/2019 notice and takedown, complaint handling, merchant identity; UU PDP 27/2022 breach notification, erasure and consent; PSE registration) are UNVERIFIED secondary-source items; the configured response and notification periods are advisor decisions and are never hard-coded. No automatic sending of notifications, no automatic closure.
- Activation criteria (all required, recorded in `DECISIONS.md` and in an audited platform setting): (a) an owner or advisor decision that the workflows apply, because licensing alignment classifies the platform accordingly (UNVERIFIED) or the owner opts in; (b) PSE/TDPSE and related registration status recorded by the owner (OPEN, never invented); (c) intake channel, response-time policy and retention policy approved by the privacy owner with numeric values; (d) a named incident coordinator and privacy contact (PRIV-5); (e) T-63 delivered (cases, status history, audit extension).
- Dependencies: T-63, T-62, T-59, T-58, T-43, T-54, T-74
- Notes: T-58 and T-43 provide the privacy-request execution services; T-54 provides affiliate disputes and offers; T-15 provides the domain data behind SA-19 (that screen stays absent until T-15 delivers).
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Activation switch. An audited setting activates the Compliance center and records actor, time and criterion; before activation every P2 route returns not-found, menu items are absent, SF-13 and HTTP-20 are not routable and JOB-11 does nothing. Deactivation hides the screens and keeps data.
  - Slice 2 — Verification queue (SA-15) and affiliate dispute and offer directories (SA-21, SA-22): cross-store queue with age and overdue marker over `account_verification`; reasoned decisions; activation introduces no activation gating by itself.
  - Slice 3 — Takedown notices and complaints (SA-29, SA-30, SF-13, HTTP-20): public intake form with uniform acknowledgement, rate limit, body cap and no personal-data echo; triage; action on the reported item only through the owning service (disable a product or store with a seller-visible reason, seller counter-response, reinstatement); due dates from the configured policy; cannot be closed without decision and reason.
  - Slice 4 — Privacy requests (SA-31, HTTP-18): queue with verification status, request type, due date from policy, execution through the existing T-43 and T-58 services, PRIV-4 retention-conflict escalation, single-use no-store export released only with a second approver (`privacy.export.approve`).
  - Slice 5 — Incident register (SA-32) and registrations (SA-33): incident with detection and awareness timestamps, affected data classes, containment, notification checklist and drafts, countdown from the recorded awareness time to the configured notification period, review record; registrations and retention table with owner-supplied values only; JOB-11 clock sweeper marks overdue and raises console alerts from an injected clock and never closes, sends or deletes.
  - Slice 6 — Audit export and domain overview: HTTP-19 `GET /admin/audit/export` (capability `audit.export` with an executed four-eyes approval, masked fields, bounded range, single-use no-store response, the export itself audited; extends the SA-37 viewer delivered by T-62) and SA-19 `/admin/domains` (read-only domain and TLS status through the owning domain services; not-found until T-15 delivers them). Both are P2 and not routable before activation. Tests: both routes return not-found before activation, the export is refused without `audit.export` or without a second approver, exported values are masked, the export is audited, and seller, affiliate and buyer sessions are denied.
  - Execute Vitest/PostgreSQL through `pnpm --filter @bukalaris/db test` and Playwright through `pnpm --filter @bukalaris/web e2e`: pre-activation not-found for every P2 route and the public intake; overdue calculation under an injected clock; closure refused without decision and reason; export single-use, no-store, expiring and refused without a second approver; intake uniform responses for valid, invalid and throttled input; a notice acts only through the owning service and cannot edit seller data directly; incident countdown equals the recorded awareness time plus the configured period; seller, affiliate and buyer sessions denied on every P2 `/admin` route. Record only observed results; no statutory conclusion is claimed.
- Added assertions (second documentation pass): the SF-13 intake follows SEC-21 (bot friction, reporter personal-data and retention rules, reporter URLs are never fetched, protection against malicious takedown requests) and `report` is a reserved route root (T-70).

### T-65 — Tax foundation: dormant policy engine, tax settings, payout tax hook and voluntary tax identity
- Status: Delivered locally 2026-10-28, slices 1 to 4 (working tree, not committed; migration 0012 section T-65; `packages/db/src/tax/**`; report `docs/tracks/t65-tax.md`). Independent review done; fixed: the database stamps the confirmation time, NULL-safe bracket checks, review evidence changes only with a status change, reseal key-id format, wider numeric-literal scan. DEFERRED: `affiliate_payout` wiring and the hook call (T-53), identity review/approve/revoke services (dormant), policy authoring and activation (T-67; T-50's PPN switch authors its own owner-decision `vat_output` version), Owner screens (T-66/T-62), statements and the document sequence allocator (T-71), key values and custody (`KEYRING_TAX_IDENTITY`, `IDENTITY_FINGERPRINT_KEY`) and JOB-23 registration, the privacy notice (OPEN-T9), retention of referenced identities (OPEN-T18), a database-level lock on the withholding flags until T-67 (today only `NODE_ENV=test` plus the CHECKs; a production process must never run with `NODE_ENV=test`), `restricted` class for tax tables (T-59b).
- Primary requirement: PR-31
- Constraints: BILL-7, BILL-8, BILL-9, DATA-11, DATA-15, IAM-15, PRIV-6, PRIV-10, NFR-2, ADR-0005 (and amendment), ADR-0009, ADR-0012. Startup defaults are OFF: no withholding, no collection, no payout gate on tax identity, no PKP/e-Faktur or seller tax KYC. Integer-IDR arithmetic only; no tax rate, base fraction, bracket or deadline in source, seeds or defaults (test fixtures are arbitrary numbers, never asserted as statutory). T-53 must not create `affiliate_tax_identity` or `tax_policy`; this task owns `tax_identity` and `tax_policy_version` (DATA-15).
- Dependencies: T-59, T-60
- Notes: T-59 supplies the `platform` and `affiliate` isolation classes and T-60 the `tax.*` capability grants. T-50 and T-53 depend on this task, so it depends on neither.
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Add the DATA-15 tier A tables only: `tax_setting` (migration seeds version 1 with `statements_enabled` ON and every other flag OFF; CHECKs tie `withholding_enabled` to the identity flag, an activation reference and a confirmed entity profile), `tax_entity_profile`, `tax_identity` (sealed columns not granted to `bukalaris_app`, own-subject RLS under `app.affiliate_id`, partial unique `approved`, keyed fingerprint, immutable versions), `tax_policy_version` (exclusion constraint on confirmed effective ranges; `btree_gist` through the superuser bootstrap or the documented advisory-lock fallback; no column defaults for any rate, fraction, bracket or day), `tax_computation`, `tax_document` plus `tax_document_sequence`, and append-only `tax_event`. The `affiliate_payout` columns that reference these tables (`tax_setting_version_id`, `tax_computation_id`, the composite foreign key and the CHECK) are added by T-53 slice 1, which consumes these tables. Register every table in the T-59 isolation registry (class `platform`, with the stated own-subject exceptions), REVOKE UPDATE/DELETE as specified, add no seed policy rows.
  - Slice 2 — Implement the pure computation module from the BILL-9 contract with BigInt/`numeric` intermediates: policy resolution on `as_of_date` (exactly one confirmed version or `no_effective_policy`), `floor`/`half_up`/`ceil` applied once to base and once to tax, bracket tax, `per_payment` and `cumulative_true_up` with clamp flag, `policy_invalid` refusal, and a deterministic `inputs_sha256`. Add a repository test that fails if a numeric tax parameter literal appears in non-test source under the tax module.
  - Slice 3 — Provide the payout tax hook as a service that T-53 calls inside its payout-request transaction (this task builds and tests the service against fixture payout ids; T-53 wires it to `affiliate_payout`): read the effective `tax_setting` once under the per-affiliate lock the caller holds; with defaults return tax 0, no computation and the setting-version snapshot; with `tax_identity_required_for_payout` return the refusal `tax_identity_missing` so the caller refuses before any debit; with `withholding_enabled` (fixture and test environments only) insert one `tax_computation` using the caller's pre-generated payout id and return the amounts for the payout row. Provide the transitions the caller invokes: rejection marks the computation `void`; paid marks it `recognized` (ledger accrual arrives in T-67). The setting service accepts `withholding_enabled = true` only with the recorded activation reference and a confirmed entity profile; the UI and API expose no activation control in this task (production activation is gated by the ADR-0012 section 5 criteria, not by code). T-50 reads the effective confirmed `vat_output` `tax_policy_version` through the same policy resolver.
  - Slice 4 — Voluntary identity service behind `identity_capture_enabled`: submit, replace (new version), withdraw (crypto-erase sealed columns and fingerprint when unreferenced), sealing with subject/version/kind-bound AAD and key custody outside the database, last-four mask, duplicate flag, `tax_event` per transition; no review or payout dependency in startup mode.
  - Execute Vitest through `pnpm --filter @bukalaris/db test`: fixture policy cases reproducing the BILL-9 illustration (flat, bracketed, cumulative true-up second payout), all three rounding modes at the half boundary, zero and maximum-bigint-adjacent gross, clamp, `policy_invalid`, no effective policy, the `vat_output` lookup returning exactly one confirmed version or none, concurrent hook calls serialized with correct year-to-date (the test simulates the caller's lock), replay returning one computation, and an assertion that defaults produce `tax_idr = 0` with no computation. Real PostgreSQL: overlapping confirmed ranges rejected, confirmed-row and issued-payload updates rejected, partial unique indexes, column-level grants (the app role cannot select sealed columns), RLS fail-closed without `app.affiliate_id`, no DELETE grant. Prove affiliate A cannot read affiliate B's identity. The payout composite foreign key is asserted in T-53; statement and payout-journey cases are in T-71.
- Added assertions (second documentation pass): the tax sealing keyring (`KEYRING_TAX_IDENTITY`) and the distinct fingerprint key (`IDENTITY_FINGERPRINT_KEY`) carry a `key_id`, with the tax ring covered by the JOB-23 re-seal run; the literal-scan test also covers checkout and `order_financials` code, so a VAT rate literal such as the COD-fee VAT cannot appear outside policy lookups.

### T-71 — Earnings statements, seller invoice export and Owner invoice register
- Status: Planned (Proposed; startup, small; ADR-0012 and BILL-9 specify the target, not implementation evidence; split from T-65 on 2026-10-27 because statements read the affiliate ledger delivered by T-53 and invoices delivered by T-50)
- Primary requirement: PR-31
- Constraints: BILL-7, BILL-8, BILL-9, DATA-11, DATA-15, IAM-15, PRIV-6, PRIV-10, NFR-2, ADR-0009, ADR-0012. Integer-IDR arithmetic only; statements carry no buyer data, order identifier or full tax identifier; no tax rate in source.
- Dependencies: T-65, T-53, T-50
- Notes: T-66 delivers the statement screens and downloads; this task delivers the generator, stored documents, exports and route handlers.
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Earnings statements: a statement builder over `affiliate_ledger_entry` only (no order join; totals for credits, voids, payouts gross/tax/net, reversals, adjustments, opening and closing balance, pending as information), the `tax.statement.generate` job for each Asia/Jakarta month and an annual statement in January, idempotent by the unique issued-document index and equal `payload_sha256` on replay, document numbers from `tax_document_sequence` in the issuing transaction, replacement by `revision + 1`, and PDF and CSV renders produced from the stored payload.
  - Slice 2 — Add the seller own-invoice CSV export and the Owner platform invoice-register export over stored invoice snapshots, each audited.
  - Execute Vitest and real-PostgreSQL tests through `pnpm --filter @bukalaris/db test`: statement job replay producing no second row and an identical hash, monthly statements summing to the annual statement, every figure equal to an independent ledger query, own-subject RLS (affiliate A cannot read affiliate B's statements), seller export limited to the seller's own store invoices, exports audited, and the T-53 payout with default settings carrying `tax_idr = 0` and net equal to gross with no tax rows.
  - Execute route-handler tests with authenticated test requests (browser coverage belongs to T-66): an own-statement download works in PDF and CSV with identical figures and a cross-affiliate id returns not-found. Record observed results only after execution; this block claims no passing tests.
- Added assertions (second documentation pass; final policy round): this task owns JOB-14 and the services behind HTTP-22, HTTP-28 and HTTP-29, plus the AF-10 and SC-31 data; the statement pending line counts only attributions that are delivered and not yet released or inside the hold, with no `unfunded` exclusion.

### T-66 — Startup tax UI: Owner tax overview, earnings statements, voluntary identity
- Status: Planned (Proposed; startup UI only; consumes T-65 and T-71 services and accepted UX-23 screens TX-01 to TX-03 and TX-P1 to TX-P3)
- Primary requirement: PR-31
- Constraints: UX-23, UX-22, UX-19, UX-18, BILL-9, DATA-15, IAM-15, PRIV-9, PRIV-10, ADR-0011, ADR-0012. Data-layer masking, capability-gated controls absent (not disabled) for operators without them, the Phase 2 screens stay out of navigation and return the not-activated page. No tax rate or legal conclusion in UI copy; statement wording is OPEN-T10 and notice wording is OPEN-T9.
- Dependencies: T-65, T-71, T-62, T-54, T-50
- Notes: T-62 supplies the Owner shell and capability-gated menu, T-54 the affiliate portal host, T-50 the seller billing UI.
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Owner TX-01 overview and settings (flags with history, editable `statements_enabled` and `identity_capture_enabled` with reason and notice confirmation, locked flags with the unmet activation checklist, PPN link), TX-02 statements list and detail with PDF/CSV download and reasoned replacement and the invoice-register tab, TX-03 identities list (masked, read-only in startup mode). Register the routes in the Owner nav under the "Pajak" group with the `tax.*` capability gating from IAM-15.
  - Slice 2 — Counterpart screens: affiliate earnings statements (TX-P1), the optional tax identity form with notice, masked read-back and withdraw (TX-P2), seller invoice export (TX-P3). Each follows UX-19/UX-18 shell and states.
  - Execute Vitest component/DTO tests and Playwright through `pnpm --filter @bukalaris/web e2e`: operator with only `tax.read` sees TX-01 to TX-03 without edit controls; `tax.manage` can toggle the two editable flags and the change is versioned and audited; a direct request to a dormant URL gives the not-activated page; statement download PDF and CSV carry the same figures; replacement keeps the old revision visible as replaced; affiliate sees only own statements; identity form shows only the last four characters after saving and withdraw erases the value; inspect HTML, RSC/JSON and exports to prove no full tax identifier, buyer data or order identifier appears. Mobile 320 px and keyboard-only flows cover empty, error and conflict states. Record observed results only after execution.
- Added assertions (second documentation pass): this task owns the screens AF-10 (TX-P1, download HTTP-28) and SC-31 (TX-P3, download HTTP-29) and the Owner TX screens, using the T-71 services.

### T-67 — Phase 2 tax: withholding, liability ledger, remittance, tax documents, filing pack, period close and full tax center (deferred)
- Status: Planned (Deferred; no implementation until the owner activates Phase 2; entry criteria below are gates, not defaults)
- Primary requirement: PR-31
- Constraints: ADR-0012 sections 3 and 5, BILL-9 W1 to W12, DATA-15 tier B, PRIV-10, IAM-15, UX-23, ADR-0005 (and amendment), ADR-0006, ADR-0009. Not legal or tax advice: every legal treatment comes from an advisor-confirmed policy version, never from code. Marketplace collection (PMK 37/2025) is out of scope; Bukalaris is not a designated collector.
- Dependencies: T-66, T-74
- Entry criteria (all required before this task is un-deferred): the owner decides to activate and records the reference; platform legal entity type, NPWP and PKP status supplied (OPEN-T1 to OPEN-T3); tax advisor and accountant named (OPEN-T4); e-Bupot/e-Faktur access evidence and the deposit procedure supplied (OPEN-T5, OPEN-T6); advisor answers for the policy-level OPEN items (OPEN-T11 to OPEN-T16); PRIV-10 notice and retention approved (OPEN-T9, OPEN-T18); payee notice period defined (OPEN-T8).
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Tier B schema and jobs: `tax_period`, `tax_ledger_entry`, `tax_remittance`, `tax_export_run` with the partial unique indexes, sign CHECKs, closed-period insert trigger and no UPDATE/DELETE grants; add `tax_period_id` to `tax_computation` and `tax_document`; jobs `tax.period.open`, `tax.reconcile`, `tax.document.issue`, `tax.deadline.alert`, all idempotent on their natural keys.
  - Slice 2 — Policy lifecycle and activation service (W2): draft, submit, advisor-confirmed confirm with a different approver for `commission_withholding`, retire, rollback by new version, `approval_request` four-eyes, and the activation action that creates the new `tax_setting` version with `effective_from` in the future and enforces every ADR-0012 criterion in the service.
  - Slice 3 — Recognition and ledger (W3, W4): on payout paid mark the computation `recognized`, assign the period and insert exactly one `accrual`; on rejection void with no ledger row; corrections, adjustments and the W10 treatments (`manual_review`, `no_tax_effect`, `reduce_base_current_period`) as signed rows referencing originals; outstanding liability derived from the ledger only.
  - Slice 4 — Remittance (W4): prepare, approve with a different operator, record paid with opaque billing code and receipt number, void and reverse, amount bounded by outstanding under the period lock; no provider or authority API.
  - Slice 5 — Documents (W5, W7, W11): withholding slips with data for e-Bupot-style filing, VAT invoices and credit notes under `pkp_gate_enabled` (PKP and non-PKP counterpart variants, UNVERIFIED formats), annual tax statements, numbering, replacement and cancellation, delivery to the payee portal, seller PKP/tax profile capture.
  - Slice 6 — Filing pack, reconciliation and period close (W6): CSV set per tax type and period revision with deterministic ordering, checks R1 to R7, close and four-eyes reopen with `revision + 1`, deadline settings from policy only, export audit with hash and purpose.
  - Slice 7 — Full tax center UI TX-04 to TX-10 and the TX-03 review actions per UX-23, hidden until activation, with masking, purpose-bound reveal and capability gating.
  - Execute Vitest and real-PostgreSQL integration through `pnpm --filter @bukalaris/db test`: replay of paid/recognition events inserts one accrual, concurrent accruals and remittances never exceed outstanding, a closed period refuses entries at the database, reopen without a second approver is refused, corrections never exceed originals, a rollback policy leaves earlier snapshots untouched, ledger sums equal recognized computations minus remittances for every period, slips equal computations by count and tax, deterministic export hashes, no inner-join balance, and no DELETE path. Use advisor-style fixture policies only; never assert statutory rates.
  - Execute Playwright through `pnpm --filter @bukalaris/web e2e` in a test environment with fixture activation: Owner activates (four-eyes), a payout is withheld and paid, the slip appears in the payee portal, the accountant exports the filing pack, remittance evidence is recorded by two operators, the period closes and reopens; cross-role masking (no full identifier in HTML, RSC/JSON or export for anyone without the break-glass reveal); keyboard and 320 px states. Record observed results only after execution; no production or advisor-approved result is claimed by this block.
- Added assertions (second documentation pass): this task owns JOB-15 to JOB-18.

### T-68 — Issue reports queue, export and function health
- Status: Slices 1, 2 and 4 and the export and sweep part of slice 3 delivered locally 2026-10-28 (working tree, not committed; migration 0015 section T-68; `ops/console-issues*.ts`, `/admin/issues`, HTTP-23 export; report `docs/tracks/t68-issues.md`). Independent review done; fixed: the database guard also covers INSERT and the identity columns of a report, CSV neutralises a leading TAB or CR. DEFERRED: HTTP-24 and attachments (dormant by D-18), real delivery to the alert sink (OBS-6: owner chooses the sink and credentials), the `issue_report` retention period (privacy owner), related Update Log entries (T-69), default `ops.issues.report` grant for every staff member (T-59b), the resolution note also lives in append-only event and audit rows (store a digest and length instead of the text before enabling retention).
- Primary requirement: PR-30
- Constraints: UX-22 (Issue reporting), IAM-15 (`ops.issues.report`, `ops.issues.manage`), PRIV-9, SEC-11, OBS-5, DATA-14 (`issue_report`, `issue_report_event`, `issue_report_attachment`), ADR-0005 (T-59 amendment), SA-14, SA-36, SA-50, HTTP-23, HTTP-24, JOB-13. Descriptions and context render only as text; no HTML or markdown; allowlisted stored fields only. Retention period and size or rate numbers are OPEN configuration, not hard-coded.
- Dependencies: T-62, T-23, T-74
- Notes: T-62 supplies the control, the table and the submit action; T-23 (Log System) is implemented.
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Queue and detail (SA-50): filters (status, category, severity, ARCH-5 page id, assignee, date range, has log link, bounded parameterised text search), counts, sort, detail with labelled context, resolved page id and its ARCH-5 title and task, links to SA-06 and SA-05 (shown as links only for `logs.read` holders), possible duplicates by `dedupe_key`, event history. Reads of list and detail are audited.
  - Slice 2 — Transitions and assignment: compare-and-swap status machine (new → triaged, duplicate, wont_fix; triaged → in_progress, resolved, duplicate, wont_fix; in_progress → triaged, resolved, wont_fix; resolved, wont_fix, duplicate → triaged), resolution note required for resolved, wont_fix and duplicate, duplicate target must exist and not be a duplicate itself (no self or cycle), assignee must hold `ops.issues.manage`, each change writes an `issue_report_event` and an audit row.
  - Slice 3 — Export and attachments: HTTP-23 CSV and JSON of the current filter, allowlisted columns, bounded row count, CSV cells starting with `=`, `+`, `-`, `@` neutralised, no-store, export audited with filter and row count; optional screenshot attachments (PNG or JPEG, size cap) re-encoded to strip metadata and served through HTTP-24 with authentication, `nosniff` and download disposition; JOB-13 retention sweep deletes or anonymises context and attachments after the configured retention.
  - Slice 4 — Function health: SA-36 table per ARCH-5 id (open by severity, oldest open age, 7-day count, 24-hour `system_log` error count for the mapped module) linking to the pre-filtered queue, an "unmapped" row, and the SA-14 "Masalah terbuka per halaman" card for `ops.issues.manage` holders only.
  - Execute Vitest/PostgreSQL through `pnpm --filter @bukalaris/db test`: transition matrix including invalid and concurrent transitions, duplicate cycle refusal, audit rows for transition, assignment, list read, detail read, export and attachment read, a staff member without `ops.issues.manage` refused on queue, export and attachment, non-staff sessions refused, CSV neutralisation of `=cmd`, stored description with `<script>` returned as inert text, per-page counts equal to an independent query on a fixture, retention sweep idempotent under an injected clock.
  - Execute Playwright through `pnpm --filter @bukalaris/web e2e`: file two reports from two different pages with the Lapor masalah control, find both in the queue under the correct ARCH-5 ids with correct correlation ids, open the linked Log System event, assign, triage, mark one duplicate of the other with a note, export JSON and CSV, and see the SA-36 counts change; the queue and the control pass keyboard-only and 320px checks; a staff member without `ops.issues.manage` sees the control but not the queue and gets the denied state on the direct URL. Record only observed results.
- Added assertions (second documentation pass; decided by D-18 on 2026-10-27): no screenshot attachments are built in Phase 1 (the optional attachment part of slice 3 and HTTP-24 stay dormant); `scrubText` also strips NIK, NPWP and bank-number patterns, with canary tests; reports are limited by `RL-ISSUE` and a new report notifies the alert sink (OBS-6).

### T-69 — Update Log: authoring, public site at logs.bukalaris.com, feed and what's-new indicator (optional, Phase 1.5)
- Status: Planned (Proposed 2026-10-27; specification only; optional, build only when a public changelog is wanted; no Phase 1 task depends on it)
- Primary requirement: PR-30
- Constraints: UX-22 (Update Log), IAM-15 (`updates.write`, `updates.publish`), DATA-14 (`update_log_entry`, `update_log_revision`, `update_log_entry_issue`, `update_log_public`, `update_log_seen`), ADR-0005 (T-59 amendment: public read uses only the published-only `shared-read` projection), ADR-0008 (the `logs` host label and dispatch), SA-51, SA-52, UL-01, UL-02, HTTP-25, JOB-19. This is not the internal Log System. The public host sets no cookie, runs no analytics, makes no third-party request and exposes no personal-data field, author identity, release revision or issue-report id.
- Dependencies: T-62, T-51, T-70, T-59, T-74
- Notes: T-70 supplies the `logs` host dispatch (until then the public pages are reachable only on the internal prefix in local development); T-59 supplies the published-only `shared-read` projection grants; T-68 is needed only for the optional issue-report links.
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Data and state machine. Add the DATA-14 update-log tables; states draft → scheduled or published, scheduled → draft or published, published → unpublished, unpublished → published; every edit inserts an immutable revision; an edit to a published entry leaves the previously published revision live until "Publish update"; slug immutable after first publish; the publish and unpublish transaction writes and removes the `update_log_public` row; no hard delete. `updates.write` cannot schedule, publish or unpublish; unpublish needs a reason; optional four-eyes platform setting (default off) routes publication through `approval_request`.
  - Slice 2 — Authoring screens SA-51 and SA-52: list by state, editor with title, summary, restricted-markdown body, category, audience tags, version label, entry date, pinned flag, optional release revision and issue links (staff only), server-rendered sanitised preview, revision history with restore-as-new-revision, schedule in Asia/Jakarta, publish now, publish update, unpublish, optimistic concurrency conflict that keeps the draft. JOB-19 publishes due scheduled entries exactly once and audits the system actor.
  - Slice 3 — Sanitised rendering. Use a maintained markdown parser and HTML sanitiser (no hand-written regex sanitiser): allowed headings 2 to 4, paragraphs, emphasis, lists, inline and block code, block quotes and `https:` links with `rel="noopener noreferrer nofollow"`; raw HTML is escaped, `javascript:` and `data:` links dropped, images disallowed in this phase; sanitised HTML is stored on the revision and re-sanitised on render.
  - Slice 4 — Public site and feed: UL-01 list (pinned first, Asia/Jakarta date grouping, GET filters by audience and category that work without JavaScript, fixed page size with stable next links), UL-02 entry permalink, identical not-found for unknown, draft, scheduled and unpublished slugs, HTTP-25 JSON Feed 1.1 with published entries only; response validators and revalidation on publish and unpublish within the configured staleness; strict CSP, `nosniff`, no `Set-Cookie`; semantic HTML, `<time datetime>`, 320px, keyboard and visible focus, `lang="id"`.
  - Slice 5 — Logs-host proxy profile and revalidation. The proxy gives `logs.bukalaris.com` a host-specific profile: a static CSP without per-request nonces or inline script, no `bl_rid` request-id cookie and no `Set-Cookie` of any kind, GET and HEAD only, and the `Cache-Control` for the configured staleness (the global nonce CSP and request-id cookie of the other hosts do not apply here). Next.js revalidation runs inside the web process and the worker cannot call it, so Owner console publish and unpublish actions revalidate in-process, and the scheduled publish of JOB-19 uses the authenticated internal handler HTTP-30 `POST /api/internal/updates/revalidate` (service credential, never routable on a public host); if that handler is not built, time-based staleness is the only mechanism and the unpublish delay equals the configured staleness. Tests: a golden proxy case for the logs host (no `Set-Cookie`, no nonce, no `bl_rid`), HTTP-30 refused without the credential and on any public host, and a scheduled publish becoming visible within the configured staleness.
  - Slice 6 — "Apa yang baru" indicator in the Owner console shell: count of published entries with audience `platform` newer than the staff member's `update_log_seen` time, latest five on open with links to the public site, marks seen, omitted on zero or source failure; the shell component takes an `audience` and a seen-state adapter so other surfaces can adopt it later without a shared cross-host cookie.
  - Execute Vitest/PostgreSQL through `pnpm --filter @bukalaris/db test` and `pnpm --filter @bukalaris/web test`: draft, scheduled-not-due and unpublished entries never selected by the public queries or the feed (including a direct slug request and a warm-cache case after unpublish within the configured staleness); a scheduled entry appears only at or after its time and after JOB-19, once, with a repeat run a no-op; markdown with `<script>`, `<img onerror>`, `javascript:` links and raw HTML renders inert in page, feed and preview; the feed validates as JSON Feed 1.1 and lists only published entries; a schema scan proves no personal-data column in `update_log_public`; edits create revisions, editing a published entry does not change the live page until Publish update; `updates.write` cannot publish; seller, affiliate, buyer and non-staff sessions cannot reach authoring; with four-eyes on, the publisher cannot approve their own publication; the public responses contain no `Set-Cookie`.
  - Execute Playwright through `pnpm --filter @bukalaris/web e2e`: author a draft, preview, schedule, publish, edit after publication and publish the update, unpublish and see the public page and feed drop it; filter by audience and category with JavaScript disabled; the list and entry pages pass keyboard-only and 320px checks; the Owner header indicator count changes after publishing a `platform` entry and clears after opening it. DNS/TLS and the deployed cookie-free behaviour of `logs.bukalaris.com` need separate observed environment evidence; local route tests do not claim production readiness. Record only observed results.
- Added assertions (second documentation pass): feed and permalink URLs use the configured `LOGS_ORIGIN` (canonical origin), and `/updates` answers not-found on every other host.

### T-70 — Exact-host dispatch, per-surface sessions and cookies, and reserved-label enforcement
- Status: Slices 1, 2, 3 and 4 delivered locally 2026-10-28 (working tree, not committed, nothing deployed); slice 5 is only a fail-closed seam. Observed results: `pnpm map:check` ok, `pnpm lint` and `pnpm typecheck` clean, `pnpm build` ok, DB suite 22 files / 229 tests passed (new `packages/db/test/host.test.ts`: the DOM-5 golden table of 31 host × path × method rows over 9 hosts, reserved-label, origin and cookie-name cases, 42 tests), Playwright 101 passed and 2 skipped in 11.3 min (new `e2e/host-mode.spec.ts`, 9 tests, run by the `host-mode` project against a second server whose origins are `<surface>.localhost`). **Slice 1** (reserved labels): the 16 labels of 08 DOM-5 (`owner`, `app`, `checkout`, `affiliate`, `buyer`, `logs`, `www`, `api`, `mail`, `status`, `docs`, `assets`, `cdn`, `cname`, `berkah`, `bos`) are refused by `slugFromHost`, `createStore`, the Owner console store-creation input and, as route roots including `report`, by the CMS page slug list; `app.<root>/login` never resolves as store `app`. Not done: no affiliate handle code exists yet, so T-52 must call `validClaimableLabel` (`platform/host.ts`); no store-rename path exists; there is no automated pre-activation check for existing stores that already use a reserved label (a plain `SELECT slug FROM store` against the list is the manual check, OPEN). **Slice 2** (exact-host dispatch): `apps/web/src/proxy.ts` calls the pure `dispatchHostPath`; Owner, Seller, Checkout, Affiliate, Buyer, Logs, affiliate-store and store hosts follow the matrix, other surfaces' prefixes and every `404` cell answer a real 404, the Logs host is GET/HEAD only and sets no cookie, probes answer on every host, apex path mode is retired for a non-local `STORE_ROOT_DOMAIN` and kept on plain `localhost`. Verified both as a pure table and over HTTP with forged `Host` headers. **Slice 3** (per-surface sessions): `apps/web/src/lib/auth.ts` builds one Better Auth instance per surface with its own origin, a secret derived by HMAC domain separation (or explicit `AUTH_SECRET_<SURFACE>`), a trusted-origin list of exactly that origin and `__Host-bl_owner|seller|aff|buyer` session cookies (Secure, HttpOnly, `Path=/`, no `Domain`, asserted from `Set-Cookie`); the instance comes from the request host only. Cross-surface test: a session cookie of each of the five auth surfaces (owner, app, affiliate, buyer, plain localhost) is refused by each of the other four under its own and under the target's cookie name. Non-safe `/api/auth/*` requests need the surface's exact `Origin`, refuse `Sec-Fetch-Site: cross-site` and refuse a cookie request without `Origin`. Store preference, store cart and post-checkout cart cookies take their `__Host-` names in production. Not done: session-bound CSRF tokens (the Origin and Fetch-Metadata checks stand in, see DOM-6), the legacy-cookie read for open carts (nothing is deployed), a separate audience claim (separation rests on secret and name), and the T-59 role design for the auth tables (T-59 is not built). The Owner console UI was not driven under host mode (operator MFA); its sessions were exercised at API level. **Slice 4** (per-host origins): `surfaceOriginsFromEnv` (`PLATFORM_ORIGIN`, `OWNER_ORIGIN`, `APP_ORIGIN`, `CHECKOUT_ORIGIN`, `AFFILIATE_ORIGIN`, `BUYER_ORIGIN`, `LOGS_ORIGIN`, each falling back to `PLATFORM_ORIGIN` then `BETTER_AUTH_URL`) now feeds feed URLs and member invitations (`APP_ORIGIN`), buyer order-status links in mails (`CHECKOUT_ORIGIN`), the checkout handoff URL (`CHECKOUT_ORIGIN`), the seller product URL (`storeBaseUrl`, the store's own host) and each surface's auth `baseURL` (so recovery links follow the surface; not separately tested); in production a missing Owner, Seller, Affiliate or Buyer origin makes that auth instance refuse to start. The worker reads the same variables, so it needs them in its environment. **Slice 5** (custom-domain resolver): `resolveHostSurface` accepts a lookup callback, fails closed on error or no match and the proxy passes none, so an unknown host is 404; the cache and its invalidation on bind, verify, unbind and primary change are not built (T-15). Owner console branding was renamed from "Bos" to "Owner" in the shell and page titles. Not run: `pnpm verify:docker`; production-mode checks beyond the standalone build.
- Primary requirement: PR-14
- Constraints: PR-7, PR-28, PR-30, ADR-0005 (and amendment), ADR-0008, ADR-0010, ADR-0011, 08-DOMAIN-ROUTING (host and path matrix), SEC-3, SEC-9, TEN-2, DOM-1, DOM-3, DOM-4, IAM-3, IAM-5, CRSEC-01, CRSEC-02, CRSEC-05, CRUXR-01, CRUXR-02. CRSEC-03 stays with T-59, CRUXR-03 with T-62; the Meta `autoConfig` part of CRSEC-05 is a T-38 follow-up.
- Dependencies: T-51, T-59 (T-59 was **not** delivered when T-70 was implemented on 2026-10-28: the task ran ahead of the canonical order, so the T-59 role design for the auth tables, referenced by slice 3, is still open and must be applied to the per-surface auth instances when T-59 lands)
- Notes: this task blocks T-62, T-54, T-55, T-58 and T-69, which assume exact-host dispatch and per-surface sessions. The full scope text is owned by ADR-0008 section 3 and the host and path matrix in 08-DOMAIN-ROUTING; the slices below are the delivery split.
- Done when: every slice below is delivered and the Vitest and Playwright runs it lists pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded; slice 5 (custom-domain resolver cache) waits for T-15.
  - Slice 1 — Reserved labels. The reserved platform and infrastructure labels listed in 08-DOMAIN-ROUTING (including `owner` as the active Owner console label, `app`, `checkout`, `affiliate`, `buyer`, `logs`, `cname` and the retired `berkah` and `bos`) are enforced in host parsing, store creation and rename, and affiliate handle claims; a platform label is never turned into a store slug. Test: every reserved label is refused as a store slug and a handle, and `app.<root>/login` never resolves to `/s/app/login`.
  - Slice 2 — Exact-host dispatch in `proxy.ts` per ADR-0008 section 3 and the host and path matrix: each surface host rewrites to its internal prefix; other surfaces' prefixes return not-found; `/checkout*` is served only on the checkout host after activation; `/api` follows the per-host allowlist; apex `/admin`, `/seller` and `/s/…` are retired after host activation as the matrix specifies. A golden table test covers host × path × method for every row of the matrix.
  - Slice 3 — Per-surface sessions: one auth instance per surface with its own origin, secret and `__Host-` cookie name (host-only, Secure, HttpOnly), an audience checked server-side, a trusted-origin and callback allowlist and CSRF protection that does not rely on the cookie alone; the auth tables are accessed under the T-59 role design. Cross-surface denial tests: an Owner session on seller, affiliate, buyer and checkout hosts and the reverse, for every pair of surfaces.
  - Slice 4 — Per-host base origins: feed URLs, order-status links, invitations, recovery links, checkout handoff and the seller "storefront URL" displays are built from per-surface base-origin settings and no longer from `BETTER_AUTH_URL` (CRUXR-02); a feed or `/o/` link built for the `app` host works after dispatch is active.
  - Slice 5 — Custom-domain resolver for the proxy: a narrow lookup behind a cache with invalidation on bind, verify, unbind and primary change; the host parser never imports the privileged pool (ADR-0008); a lookup error fails closed. Until T-15 delivers custom domains the resolver returns no match.
  - Execute Vitest and Playwright: the golden proxy table, a Playwright `*.localhost` host-mode project covering the Owner console, Seller Admin, storefront and checkout hosts, the cross-surface session denials above, and a check that no third-party pixel script can run on a host that serves an admin surface. Record only observed results.
- Added Done-when items (second documentation pass; 08 DOM-5 and DOM-6): the reserved labels include `cname` and `report` is a reserved route root; existing store and handle claims are checked first; the golden table covers every row of the host × path matrix, with a negative case for each `404` cell (apex `/admin`, `/seller`, `/s/<store>`, `/checkout`, a surface prefix on a foreign host, `/o/` redirected from `app`, `/feeds/` on `app`, logs host GET/HEAD only, `/api/health` on every host); the cookie names are `__Host-bl_owner`, `__Host-bl_seller`, `__Host-bl_aff`, `__Host-bl_buyer`, `__Host-bl_order_cart` and `__Host-bl_click`, with CSRF tokens that are session-bound and not cookie-only; `BETTER_AUTH_URL` is retired in favour of `PLATFORM_ORIGIN`, `OWNER_ORIGIN`, `APP_ORIGIN`, `CHECKOUT_ORIGIN`, `AFFILIATE_ORIGIN`, `BUYER_ORIGIN` and `LOGS_ORIGIN` plus per-surface secrets, and production startup fails closed on a missing or duplicated secret and names the variable; `ORDER_LINK_SECRET` no longer falls back to a session secret; legacy cookie names are read once for cart carry-over and then replaced; the shared database-backed auth limiter (`RL-LOGIN`) replaces the in-memory one.

### T-73 — Real mailer delivery and `mail_outbox` hardening
- Status: Delivered locally 2026-10-28 except the real provider adapter (working tree, not committed; migration 0012 section T-73; `platform/mail-transport.ts`, `ops/jobs/mail.ts`; report `docs/tracks/t73-mailer.md`). Independent review done; fixed: local mail in production requires every surface origin on loopback, the dev outbox needs a loopback request host, recipient and subject header safety, definer scope check by role allow-list, privacy export links mails by `order_id`. DEFERRED: the provider adapter, sender domain, SPF/DKIM/DMARC evidence and bounce webhook (Q-16, owner), callers for buyer-proof and support-recovery mail (T-58, T-63), platform `DELETE` on `mail_outbox` until the T-59 contract step, a retention period for delivery rows (owner decision), delivery jobs for legacy order mails created before this migration (nothing is deployed).
- Primary requirement: PR-21
- Constraints: PR-21, NFR-4, PRIV-4, SEC-5, SEC-11, ADR-0005 (and amendment), DECISIONS D-10, Q-16
- Dependencies: T-22, T-59
- Notes: T-63 (support recovery links) and T-58 (buyer proof links) depend on this task because both put one-time URLs into the outbox; automated dunning in T-50 also needs it.
- Done when: a real mailer adapter behind the existing Mailer boundary delivers through the provider the owner selects under Q-16 (provider, sender domain and SPF/DKIM/DMARC evidence are OPEN; local tests use a fake transport); messages that carry one-time links (invitations, recovery, buyer proof, support recovery) have their bodies purged after delivery or expiry; `mail_outbox` is brought under the T-59 table registry, the table-wide `bukalaris_app` UPDATE grant (DECISIONS D-10) and any app-role SELECT of message bodies are revoked, and the buyer-data redaction of T-43 moves to a platform-side function; delivery results (accepted, bounced, failed) are recorded without storing the body. Vitest and real-PostgreSQL tests prove that the app role cannot SELECT any one-time-link body, that redaction still reaches every copy, purge idempotency and bounce recording; the e2e invitation and recovery journeys still pass with the fake transport. Record only observed results.

### T-74 — Periodic enqueuer, job-system hardening and retention framework
- Status: Delivered locally 2026-10-28 (working tree, not committed; migration 0011 section T-74; `ops/jobs/{scheduler,manage,observability,retention}.ts`, worker loop, `scripts/db-restore-rehearsal.sh` guards; report `docs/tracks/t74-jobs.md`). Independent review done; findings fixed (`ops.jobs.manage` enforced in every management service, retention periods only through the audited `retention_set_period()` and an append-only `retention_policy_event`, scheduler uses the database clock and reports `skewed`, `effect_absent` resets the attempt budget, the worker runs `reconcileUnknownJobs`). DEFERRED: a setter for the `audit_log` retention period (refused by the database until operator identity is restricted in T-59b and the change needs four-eyes), monthly partitioning of the log tables (not additive; owner approval at deploy), the access-event class (T-62), Owner console screens and alert delivery (T-62, OBS-6 sink OPEN), retention periods (owner decision; the purge stays OFF), the contract step for DELETE grants (T-59).
- Primary requirement: PR-5
- Constraints: SEC-18, TD-3, NFR-2, NFR-5, ARCH-5 (JOB-21, JOB-22, JOB-28 to JOB-32), IAM-15 (`ops.jobs.manage`), ADR-0005 (and amendment)
- Dependencies: T-51, T-59
- Added assertions (D-21, 99ribu study; each needs a named automated test): (a) the job state set includes `unknown` and `dead` as first-class constrained values, and a job that crashed after its external call was dispatched becomes `unknown` and is reconciled, never re-dispatched, while a crash before dispatch is requeued (a `markDispatched` fence); (b) a retention purge is off by default, runs only as the table owner through a function with a fixed `search_path`, refuses a spoofed catalog (temporary-schema `pg_class` test) and, using the PostgreSQL catalog, never purges a row that a foreign key still references; (c) retention sweeps are coordinated through the database (one sweep per period via `UNIQUE(kind, key)`), not per-process memory; (d) the restore rehearsal refuses to restore onto the live cluster and verifies artifact references and decryption of escrowed credentials.
- Notes: T-59 is needed for the purge-function grants. The periodic jobs of other tasks depend on this one because nothing else enqueues them: JOB-24 `ledger.release` (T-37), JOB-25 AutoLaris advice poll (T-49), JOB-26 `affiliate.commission.release` (T-53), JOB-09 (T-50), and the sweepers of T-64, T-67, T-68 and T-69.
- Done when: every slice below is delivered and the injected-clock Vitest cases it lists pass (`pnpm --filter @bukalaris/db test`), with observed results recorded.
  - Slice 1 — Periodic enqueuer (JOB-21): one scheduled process inserts periodic jobs with the existing `UNIQUE(kind, key)` where the key is the period, so two enqueuer instances, a restart or a repeated tick create exactly one job per period, plus a liveness heartbeat that the health view and alerts read. Tests with an injected clock: two concurrent enqueuers produce one job per period, a missed tick is caught up once, and a stopped heartbeat is reported.
  - Slice 2 — Job hardening (JOB-22): per-kind lease and heartbeat, priority (money before identity before bulk, so a bulk catalog publish cannot starve payment and shipment jobs), a terminal `dead` state after the maximum attempts, an audited requeue under `ops.jobs.manage`, and a full-rebuild command for the `affiliate_catalog` projection (consumed by T-52). Tests: a long job keeps its lease through the heartbeat, priority order under load, `dead` after the maximum attempts, requeue refused without the capability and audited with it, rebuild idempotent.
  - Slice 3 — Retention framework (JOB-28 to JOB-32): monthly partitions for log-type tables (`signal_event`, `system_log`, `audit_log`, access events, `job`) and one named purge function per class with narrow grants. Every purge stays OFF until the owner decides the retention periods (OPEN; no period is hard-coded or defaulted). Tests: purge disabled by default, an enabled purge removes only partitions older than the configured period, and the app role cannot call the purge functions.
  - Observability (OBS-6, OBS-7): lag metrics and alerts per job kind, dead-letter counts and replay audit; retention jobs JOB-28 to JOB-32 are owned here and JOB-27 by T-52.

### T-76 — Runtime database identity proof at boot
- Status: Planned (portfolio scan 2026-11-01, G1; `docs/research/2026-11-portfolio-scan/README.md`)
- Primary requirement: PR-3
- Constraints: SEC-25, SEC-1, NFR-1, ADR-0005 (and amendment)
- Dependencies: T-59
- Done when: the web process and the worker refuse to serve when their pool connects as superuser, as a `BYPASSRLS` role or as a role other than the expected one (`bukalaris_app` / `bukalaris_platform`), with a message that names the variable and never the URL; `/api/ready` stays 503 until the proof passed; Vitest cases with the owner URL, a `BYPASSRLS` scratch role and the correct roles pass (`pnpm --filter @bukalaris/db test`), observed results recorded.

### T-77 — Migration journal guard and provider fixture provenance
- Status: Planned (portfolio scan 2026-11-01, G2 and G3)
- Primary requirement: PR-14
- Constraints: DEL-2, NFR-2
- Dependencies: None
- Done when: a check run by `pnpm verify` (and CI) fails on a journal `when` that does not strictly increase, a journal entry without its `.sql` file, a `.sql` file without a journal entry, and a duplicate index or tag; every provider fixture under `packages/db/test` carries a captured-or-synthetic marker (capture date, environment, sanitized source) and a test fails for an unmarked fixture; both checks are shown failing once on a deliberately broken copy, observed results recorded.

### T-78 — Scannable QRIS instruction on checkout confirmation and subscription payment
- Status: Planned (portfolio scan 2026-11-01, G4)
- Primary requirement: PR-4
- Constraints: UX-12 (QRIS instruction contract), NFR-3, BILL-2, BILL-7, UI-10
- Dependencies: T-49, T-50
- Done when: SF-08 and the seller subscription payment panel render the QRIS payload as a server-generated QR image (no client script, payload never interpreted as markup) with a quiet zone, an accessible name with the amount, the total including the admin fee, the WIB expiry and a copy fallback; Playwright at 320 px and 1366 px decodes the rendered image back to the stored payload and checks the visible total equals `payment_attempt.total_idr` (`pnpm --filter @bukalaris/web e2e`), observed results recorded. A new dependency, if any, is justified per `native-first` in the track report.

### T-79 — Off-box monitoring, backup health and deploy proof before the pilot
- Status: Planned (portfolio scan 2026-11-01, G5 to G7); needs hosting (D-23) before its production half can run
- Primary requirement: PR-14
- Constraints: DR-1, DR-2, OBS-6, DEL-1, D-19, D-23
- Dependencies: T-74; production half after provisioning is approved
- Done when: `scripts/bukalaris-probe.sh` exists and checks the endpoints of 14 "Off-box HTTP readiness and smoke probe" locally against `pnpm dev` and the Docker image; the backup job reports unhealthy on a stale newest dump and on a failed offsite upload, and prunes by age (Vitest or shell test on a temp directory); the restore rehearsal includes the media volume; the RUNBOOK pre-production rows added on 2026-11-01 each have a recorded command and result once the environment exists. Local parts are recorded with observed results; production parts stay unticked until executed.


## Review follow-ups — 2026-11-04 (D-24)

Planned development contracts, not execution evidence. Accepted parent requirements own technical corrections; Gated/Conditional entries cannot implement new policy before the named owner resolves it. Existing task IDs remain unchanged; T-59b/T-59c remain slices of T-59. Dependencies on partial T-59/T-70/T-74 consume already delivered expand/host/scheduler interfaces, not deferred contract/custom-domain/retention activation; production approvals remain separate.

Common contract for T-80 to T-94: Allowed Paths are scope ceilings, not instructions to create every file; update only matching contract/map sections and evidence. Canonical Contract Owners: the primary requirement and listed numbered specs. Accepted Invariants: tenant isolation, server-derived stock/money, live-provider locks and append-only migrations. Non-Scope: live calls, secrets, production writes, commit/push and unrelated features. Escalation Conditions: required out-of-scope paths, unresolved policy or data loss. Reopen Conditions: named regression failure, code/spec conflict or changed provider evidence. Protected Paths for R3/R4: existing migrations, historical money snapshots, auth/tenant boundaries; no weakening. New migrations require clean/populated isolated upgrade proof. R3/R4 completion requires independent review; auth/money invariants require failing mutation evidence. UI changes require narrow/wide real-browser proof. Record observed commands/results in BUILD-LOG and the task; no anticipated PASS.

### T-80 — Prevent stale product edits from overwriting stock
- Status: Done locally (2026-11-04, branch `task/t80-stock-safe-edit` over `70a97c1`). Metadata writes exclude stock; creation retains initial stock and the editor links to audited inventory. Explicit stock-writing mutation failed expected 4 / received 5; exact source restored, recovery checks passed (134), then full DB PASS (74 files / 1393 tests). Final lint/typecheck/build and 18 browser checks at 320/1440 px passed. Independent code review findings fixed; independent changed-area visual PASS. Map/spec/traceability checks pass. Initial missing-fixture failures and their recovery are retained in the evidence; no migration, live call, deploy or new policy. Evidence: `docs/tracks/t80-stock-safe-edit.md`, BUILD-LOG. Full application E2E/Docker readiness remains outside this scoped acceptance.
- Primary requirement: PR-2
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-31
- Risk Level: R3
- Allowed Paths: `packages/db/src/seller/commerce/{catalog,orders}.ts`, `apps/web/src/app/(seller)/seller/products/**`, seller `actions.ts`, catalog/orders/tenant DB tests and touched catalog/orders E2E; docs 05/17
- Done when: Reuse audited `adjustStock` or tested compare-and-set for existing stock; keep initial stock on creation. A sale-versus-edit barrier test preserves the decrement; settings saves never reset stale stock. Prove non-negative, audited, authorized adjustment and cross-store denial; run DB/touched E2E and record a named failing mutation then restored pass.
- Visual Contract: Existing variants expose a clear inventory path; creation still accepts initial stock.

### T-81 — Restrict application updates on the tenant-root store row
- Status: Done (2026-11-04, local `task/t81-store-column-grants` over `dd7511e`; report: `docs/tracks/t81-store-column-grants.md`). Four-column app UPDATE allowlist; protected own/foreign SQL denials, valid settings and platform lifecycle verified. Full DB 74 files/1400 tests, restored focused 4 files/82 tests, lint/typecheck, fresh Docker and populated migration/parity/idempotence PASS. Deliberate broad-grant mutation failed the named status denial; exact six-file restoration and restored pass verified. Independent R4/closure reviews clear. Technical hardening accepted in D-24/U65, not a demonstrated browser exploit; no production contract/deploy/push.
- Primary requirement: PR-1
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-59
- Risk Level: R4
- Allowed Paths: `packages/db/src/platform/{isolation-registry,platform}.ts`, `packages/db/src/storefront/content.ts`, new migration and generated metadata under `packages/db/drizzle/`, `packages/db/drizzle-pending/t59-contract.sql`, RLS/content/lifecycle tests, `scripts/_registry.sh`; docs 06/12/ADR-0005
- Done when: Inventory every store UPDATE caller and define minimum column grants/guards. Direct SQL as the app role cannot change lifecycle/security columns on its own or another store; valid seller settings and intended platform suspension still work. Prove registry parity, clean/populated migration and `pnpm verify:docker`. Explicitly plan expand/contract compatibility; do not apply T-59's production contract by implication.

### T-82 — Deliver session-bound CSRF protection for surface mutations
- Status: Done locally 2026-11-05 (uncommitted; see Current acceptance). History: WWW prerequisite verified/reviewed/closed before safe application into this worktree. Combined gate b75bfc25b passed clean static/build and requested320/390/1280 named regressions. Stream-close diagnostic remains OPEN. Test-only response-completion b8ce42677 FAILED: lint/typesPASS,320 timeout90s,390/1280 UNRUN; whole-response waits unproven, not an accepted fix. Independent review2d686aab P1/BLOCK on completion-wait candidate; bd86ba924 attributed5s failure to B addition completion (request failed before teardown, cartUIvisible); bd0950ad4 failed added EOF diagnostic only; recipientquantity1/Notice PASS, matched200 actions exactERR_ABORTED beforecleanup. Follow-up24d3e594 closes diagnosticP1, flags extraEOF oracleP2; corrected, minimum320px b6507181d PASS exactPOST counts/pageerror0/denial+recovery; same stream-close digest recurred during recipient reload, cause unattributed. Narrow b4bbcb1e3 PASS; existing LogSystem aggregate classifies captured error productGET. Review22835841 closes diagnosticP1/P2/noissueswithnotes; exactcause retainedunknown, #24fullproof resumed, no app/log-suppression changes. Original-entry guards/recovery implemented; prior cart checks PASS at 320/1440. The old WWW flag candidate passed 19 cases but was BLOCKED for normalization spillover. The approved localhost alignment now passes lint/types,26/26 host cases and standalone/dev loopback proof in b6a8a7839, including WWW320/390/1280 JSoff/on. Post-task review9cf4e59a found no code blocker; documentation P2 corrected and b2213c8d closure CLEAR. Combined named T-82 source/matrix b75bfc25b PASS; stream-close diagnosis OPEN, b8ce42677 completion-wait approach FAILED; review2d686aab P1/BLOCK, bd86ba924 B-completion diagnostic FAILED; bd0950ad4 diagnostic FAILED with semanticdenial/recoveryPASS and exactbrowserabort; follow-up24d3e594 diagnosticP1closed/EOF-oracleP2corrected, minimum b6507181d PASS with recurrent streamwarning, b4bbcb1e3 scopedPASS, renderGETobservation retained;22835841 closesdiagnosticbranch only; see sibling `t82-www-routing` STATUS.md. Newly requested 320/390/1280 confirmations, overall verification and final independent acceptance remain pending. Existing D-20/DOM-6 gate before non-local exposure remains closed. See [track report](tracks/t82-session-csrf.md).
- Current acceptance: ACCEPTED LOCALLY 2026-11-05 — final independent review 4d65c038 ACCEPT WITH NOTES (no P0/P1), combined verification b5a1c4326 and P2 follow-ups bf4997347 green; #31 (inherited T-70, baseline b7d3ffedc) fixed by D-25. Uncommitted; not deployed. Earlier history: BLOCK (final review 05ebe330; gaps remained partial). Subsequent targeted passes b9705f13a, b5dfe2d1e, b70459018, b05dd1776 and b7c1f6198 cover review assertion fixes/authPost, MFA lifecycle, duplicate cookies, direct configured checkout and configured landing mutation respectively, not full acceptance. Seller-host redirect #31 is a confirmed P1 UI blocker (ba615e88b): mutation persists, session remains live, correct editor is advertised, but login renders; fresh editor GET succeeds. Source review 5e0f1649 found no safe concrete fix, corrected the unproven Host-filter hypothesis; installed/standalone framework files match. Await owner approval for bounded internal metadata proof; no framework/auth/host compensation authorized. Invalid-capability checkout refusal ba8bfbe61 and nonstandard-caller refusals bb3d917b0 (upload, finance step-up, invitation, console formAction approval, argument-only issue report) now PASS. Metadata proof b68c9673e established #31's mechanism: the post-action redirect render arrives with Host=localhost (surface local, no session) while x-forwarded-host keeps app.localhost; fix needs an owner decision. No T-83 advance, staging, commit, push or deploy.
- Primary requirement: PR-15
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-70
- Risk Level: R4
- Allowed Paths: `apps/web/src/lib/auth*.ts`, `apps/web/src/lib/context.ts`, `apps/web/src/proxy.ts`, affected mutation adapters under `apps/web/src/app/**`, `packages/db/src/platform/host.ts`, auth/host tests and E2E; docs 07/08/12
- Done when: Inventory cookie-authenticated mutation boundaries; reuse pinned framework/Better Auth controls where sufficient, add only missing session-bound validation and retain Origin/Fetch-Metadata checks. HTTP/browser tests reject missing, forged, stale-session and cross-surface tokens without mutations; valid login/recovery/server actions work. Explicitly justify signed-callback exemptions; tokens never enter URLs/logs. Run focused auth tests, lint/typecheck and affected E2E with named mutation evidence.

### T-83 — Share authentication rate limits across application instances
- Status: Done locally 2026-11-05 — T-83 accepted locally (2026-11-05): Better Auth's atomic rateLimit.customStorage now runs on the shared Postgres fixed-window counter (authRateLimitStorage over hit), keys auth:<surface>:<sha256(ip|path)>, client IP from the CLIENT_IP_HEADER-trusted header, Better Auth's numeric rules unchanged, counter failure refuses 429 with a one-window retry (D-26). Evidence: DB 76/76 (b620c9645); HTTP two independent production servers on one DB share one sign-in budget, uniform refusal, failing store → 429 then recovery, accounts/auth-csrf 30/30 at 320+desktop (bfd28462c); mutation proofs — per-process memory storage fails the two-server test (expected 429, received 401) and a fail-open store fails both the DB and HTTP refusal tests, each restored by fingerprint, rebuilt and rerun green (b12d202b1, bc3c52d2f; artifacts t83-shared-limit-mutation/, t83-failopen-mutation/); final gate b5180862b: no leftover mutant, map/lint/types, DB 87/87, clean build, host-mode 35/35, accounts+auth-csrf+t82-callers 34/34 at 320+desktop. Independent review d6365bea ACCEPT WITH NOTES (no P0/P1); notes applied: deploy gate CLIENT_IP_HEADER=cf-connecting-ip and no Traefik trustedIPs in xff mode, D-26 wording (pseudonymous digest), accepted ceilings (fixed-window 2x boundary, per-unique-path rows → T-90, hung-DB waits for timeout), window-aligned DB tests, fail-open mutation. Not pushed or deployed.
- Primary requirement: PR-15
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-70
- Risk Level: R4
- Allowed Paths: `apps/web/src/lib/auth.ts`, existing counter/storage owner under `packages/db/src/`, focused auth/rate-limit tests and accounts E2E; docs 07/16
- Done when: Verify the installed Better Auth storage interface and reuse shared DB counters. Two independent auth instances share login/reset budgets across restart with safe surface/IP keys; counter-store failure refuses unsafe auth requests with a recoverable bounded response, not a bypass. Preserve current numeric bounds and non-enumeration. Run HTTP/DB/accounts E2E and a named failing mutation; broader failure-mode changes wait for T-90.

### T-84 — Prove worker and cleanup in the Docker verification gate
- Status: Done locally 2026-11-05 — T-84 accepted locally (2026-11-05): `pnpm verify:docker` now runs the outbox worker and the one-shot cleanup from the built `migrate` image as `bukalaris_platform` on its scratch database and proves: process user `app`, one safe queued job (`approval.expire`, key verify-<id>) done and its fixture request expired, scheduler heartbeat, graceful SIGTERM (exit 0, `stopped` line, no process-level error lines), web image has no packages/db/src, `NODE_ENV=production` baked into the migrate image, and cleanup exit 0 removing exactly the idle fixture cart while keeping the fresh one, buyer-data retention off; bounded waits (30 s SQL polls, `docker stop -t 15`, `timeout 60`). Identity is logged (image ids, HEAD, dirty-tree digest). Evidence: b68113827 first green; review-fixed gate b3fb37e44 — VERIFY_BREAK=worker (effect=no heartbeat=no, 127 poll errors), effect (unregistered kind, effect=no) and cleanup (exit 1, carts 2->2) each fail with their named reason; clean run PASS (identity web=f5974cd2703f migrate=48416cc04261 tree=e6ffd7c dirty=5c7bbb617f13); 0 leftover containers/databases. Independent review f8972630 ACCEPT WITH NOTES; both P1 fixed (identity recorded; migrate stage now ENV NODE_ENV=production — previously a production worker from that stage would silently use local mail and the fake shipping partner) and P2s fixed (fixture through the real approval guard, idle-vs-fresh cart assertion, named cleanup container in the trap, stale docs). Docs corrected: worker/cleanup run from the `migrate` stage (`node src/worker.ts`), not the web image (DEPLOY-COOLIFY, a shared edit outside T-84's listed paths; RUNBOOK). Notes: the scheduler's own minute tick also expires the fixture, so only the queued-job half of the effect is shown failing on its own; job-level failures (e.g. shipping.credentials.reseal shipping_key_unavailable) are info-level and do not fail the gate; the worker does not fail-closed on missing ORDER_LINK_SECRET/INTEGRATION_TOKEN_KEY at start (pre-existing). The E2E `relation "job" does not exist` noise is a harness ordering effect: Playwright starts the worker webServer before globalSetup drops and re-migrates the schema; not a production defect; fix belongs to playwright.config/global-setup (outside T-84 paths), tracked as a follow-up.
- Primary requirement: PR-14
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-74
- Risk Level: R3
- Allowed Paths: `scripts/{verify-docker.sh,_lib.sh}`, `apps/web/Dockerfile` only if required for proof, RUNBOOK and docs 15
- Done when: `pnpm verify:docker` starts the built worker on its disposable DB, proves one safe queued effect plus scheduler heartbeat, executes bounded cleanup with retention off and checks intended roles and shutdown. Deliberately failed worker/effect/cleanup fails the gate; use bounded condition waits. No live provider or non-scratch database is touched. Record image/tree identity, commands and observed effects.

### T-85 — Re-establish full verification on the current integrated tree
- Status: Done locally 2026-11-05 — run b89148283 on a clean detached worktree at 141e030 (identity: web 4961fe329cfd, migrate d0b4800bb8df; frozen install; isolated DBs bukalaris_t85_test/_e2e; dev placeholder secrets; no provider credentials, fake adapters; MAIL_MODE local): `pnpm verify` — map ok, lint, typecheck, DB 76 files / 1428 tests passed, build ok, E2E 263 = 261 passed, 2 skipped (pre-existing environment-bound cases: ops DB-unreachable page, HSTS behind a TLS proxy), 0 failed at mobile-320, desktop and host-mode; `pnpm verify:docker` passed incl. worker/cleanup. Earlier runs found and fed T-95 (unmapped WWW route), T-97 (T-82 duplicate-submit regression) and T-98 (limiter test window). The same commit then failed GitHub CI on a CI-secret-dependent fingerprint scrub (T-99). Changed-surface narrow/wide inspection is covered by the E2E viewports; the independent public design review remains open under T-28.
- Primary requirement: PR-14
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-28
- Risk Level: R1
- Allowed Paths: `BUILD-LOG.md`, `STATUS.md`, `docs/TASKS.md`, `docs/evidence/ux/**`; application code read-only
- Done when: Record HEAD plus dirty-tree identity/environment/provider substitution; run `pnpm verify` and `pnpm verify:docker` on authorized isolated local databases. Record complete counts, skips and failures; skipped money/auth cases are not green. Inspect changed surfaces at narrow/wide sizes; independent public design review stays open under T-28 until done. Changes during verification invalidate affected evidence; no completion with unresolved failures. Fixes need separately scoped tasks.
- Visual Contract: Real changed-surface renders, keyboard and error states; no inference from a green build.

### T-86 — Finish ADR, specification status and OpenAPI reconciliation
- Status: Planned (Documentation remainder; owner disposition required for unaccepted ADRs)
- Primary requirement: PR-14
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-1, T-12
- Notes: closes T-4's documentation remainder; does not wait for T-4 to finish the same work first.
- Risk Level: R0
- Allowed Paths: `docs/02-PRD.md`, numbered docs 03 to 17, `docs/ADR-*.md`, `docs/openapi.yaml`, `docs/README.md`, `docs/DECISIONS.md`
- Done when: Obtain owner disposition for ADR-0001..0003 (Accepted or explicitly superseded, never guessed), note ADR-0007's historical filename, and distinguish document proposals from accepted sections/local code. Complete T-4 order/payment/shipment state and implemented-route OpenAPI parity against actual handlers/tests without inventing HTTP wrappers for server actions. Run spec/traceability/map checks and operation-by-operation review; unresolved decisions keep that slice open.

### T-87 — Assign every remaining portfolio lesson and deferred finding
- Status: Planned (Research disposition, not blanket implementation approval)
- Primary requirement: PR-14
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: None
- Risk Level: R0
- Allowed Paths: `docs/research/2026-11-portfolio-scan/**`, `docs/TASKS.md`, `docs/DECISIONS.md`, affected numbered spec sections
- Done when: Inventory every remaining U-item, source P2/P3 finding and per-task deferred review item with stable source reference, code recheck, requirement and disposition: covered with evidence, existing task, new atomic task, owner/external gate, duplicate or not applicable. Reconcile source totals; new tasks need one accepted primary and runnable acceptance. Verify search-only claims first. Route legal/consent claims through a current-official-source brief and qualified review, never customer promises. Run docs checks; no silently dropped findings or inferred runtime evidence.

### T-88 — Bound unpaid stock reservations and release them exactly once
- Status: Planned (Gated: product/finance must approve Q-10 expiry, backorder, COD exclusion and late-payment policy in docs 05/11; provider timing needed before live use)
- Primary requirement: PR-4
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-49, T-74, T-80
- Risk Level: R4
- Allowed Paths: `packages/db/src/seller/commerce/{checkout,orders}.ts`, `packages/db/src/payments/**`, relevant jobs/worker/schema/new migrations and DB tests; docs 05/11/17
- Done when: After policy acceptance, reuse the existing order/attempt lifecycle before adding a reservation table. Expiry releases eligible unpaid stock once in the terminal-transition transaction. Barrier tests cover pay-versus-expire, replay, late-paid quarantine/refund, unrelated-store/COD exclusion and no double-restock. Run DB/concurrency tests, mutation checks and clean/populated migration proof. No guessed provider timing.

### T-89 — Make seller collected-money and order KPIs unambiguous
- Status: Planned (Gated: product/finance approve metric recognition, refund and time basis in docs 11/17)
- Primary requirement: PR-22
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-41, T-37
- Risk Level: R3
- Allowed Paths: `packages/db/src/seller/commerce/dashboard.ts`, seller dashboard/page components and dashboard DB/E2E tests; docs 11/17
- Done when: One documented predicate per metric yields independently reconciled unpaid/paid prepaid, collected/uncollected COD, cancellation/return/refund and WIB-boundary totals. Distinguish gross order value, collected money and available ledger balance; do not silently change historical meaning. Run DB/tenant denial and narrow/wide browser checks.
- Visual Contract: Clearly labelled metrics, basis and period text, correct IDR formatting and honest unavailable states.

### T-90 — Specify and test rate-limit dependency failure behavior
- Status: Planned (Gated: security/product approve per-bucket dependency-down policy in docs 12/16; blanket fail-open not adopted)
- Primary requirement: PR-14
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-30
- Notes: implements T-9's open failure-policy slice; T-9 completion is not a prerequisite for its own follow-up.
- Risk Level: R4
- Allowed Paths: Existing rate-limit owner/callers under `packages/db/src/**`, affected API routes/tests; docs 12/16
- Done when: Inventory auth, callback, checkout, click and public API buckets; injected counter failure proves each approved response and bounded signal. Signature/auth, exact amount, idempotency, stock and live-provider locks never fail open; no retry storm, identifier leak or permanent owner lockout. Run focused DB/HTTP tests and named auth/money mutation checks.

### T-91 — Deliver an operator payment-anomaly queue without state overrides
- Status: Planned (Gated: product/finance approve categories, actions, capabilities and route in docs 11/17/ARCH-5; G10)
- Primary requirement: PR-14
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-49, T-50, T-62, T-37
- Risk Level: R4
- Allowed Paths: `packages/db/src/{payments,billing,ledger,ops}/**`, scoped Owner money/billing routes/tests; docs 04/11/17
- Done when: Reuse existing money/refund screens if sufficient. Otherwise bounded queue/detail covers second-paid, paid-on-void/terminal and amount mismatch with audited evidence access. Recovery reuses verification/refund services and four-eyes, never direct status edits. Replay/concurrent actions create no duplicate credit/refund; unauthorized access is denied. Run DB/E2E and mutation checks.
- Visual Contract: Evidence, unknown outcome and allowed next step; no retry button for uncertain external effects.

### T-92 — Verify parcel dimensions before changing quote and booking inputs
- Status: Planned (Gated: integration verifies official units/volumetric minima; product approves multi-item packing; no live call authorized)
- Primary requirement: PR-4
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-61
- Risk Level: R3
- Allowed Paths: `packages/db/src/shipping/**`, affected catalog/checkout schema/adapters only after contract approval, related tests; docs 05/09/17
- Done when: First establish whether dimensions are needed; if not, close with verified rationale and no scaffolding. If needed, approve schema/backfill and use one shared quote/booking derivation with immutable snapshots and labelled captured/synthetic fixtures; old orders unchanged. Prove multi-unit/line rounding, quote/booking parity, tenant denial and populated upgrade.

### T-93 — Verify storefront activation gates before self-service onboarding
- Status: Planned (Conditional: U75 is search-only evidence; product/security approve any new review lifecycle first)
- Primary requirement: PR-1
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-26, T-70
- Risk Level: R3
- Allowed Paths: `packages/db/src/platform/{platform,scoped,host}.ts`, affected public read adapters/tests; docs 06/08/17
- Done when: Inspect actual creation/publishing paths; prove suspension and foreign/unknown-host denial over real routes. If no self-service/review entry exists, record not applicable now and explicit onboarding reopen condition, without speculative tables. If reachable, implement only the accepted server-side activation/cache predicate; feed/media/checkout/direct URLs cannot bypass it. Run lifecycle/host/tenant and browser negative tests.

### T-94 — Define and prove a staged HSTS rollout
- Status: Planned (Gated: platform approves full host/TLS inventory, duration, ramp and subdomain scope; D-23 not replaced)
- Primary requirement: PR-14
- Constraints: D-24; TEN-1, DEL-3; existing live/approval gates stay unchanged
- Dependencies: T-29, T-70
- Risk Level: R3
- Allowed Paths: `apps/web/src/lib/security-headers.ts`, header tests/E2E, DEPLOY-COOLIFY, RUNBOOK and docs 08/12
- Done when: HTTPS-only fixtures/browser tests prove accepted short-to-long policy, explicit includeSubDomains gate, no accidental HTTP/local policy and no preload enrollment. Document that rollback cannot erase cached browser HSTS. Production ramp stays unticked until owner-approved target-host/TLS evidence exists; T-15 owns custom-domain policy.

### T-75 — PPN activation readiness (deferred)
- Status: Planned (Deferred; owner decision D-17, 2026-10-27; do not start until the entry criteria hold; specification only)
- Primary requirement: PR-18
- Constraints: PR-18, PR-31, BILL-7, BILL-9, DATA-10, DATA-15, IAM-15, ADR-0012, DECISIONS D-17. PPN is OFF by default; no 11% or other rate is computed or hard-coded; the rate is always an effective confirmed `vat_output` policy value. Not tax advice.
- Dependencies: T-50, T-65, T-71
- Entry criteria (all required before this task is un-deferred; ADR-0012 section 9, OPEN-T20): the company (PT) legal documents are issued; platform PKP status is confirmed; an accountant is named; an invoice and e-Faktur export is built and verified with the accountant (UNVERIFIED); the `vat_output` rate policy is confirmed by the accountant or an advisor. These criteria gate this task, not the PPN switch itself: the switch needs only `tax.manage`, a confirmation and a reason (T-50, D-17).
- Done when: every slice below is delivered and its Execute bullets pass (`pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), with observed results recorded and no result claimed before it is executed.
  - Slice 1 — Readiness checklist: the Owner console shows the five entry criteria as an informational checklist next to the PPN switch (never a gate), each with the recorded reference and date; recording a criterion needs `tax.manage` and is audited. Tests: the switch still works with an empty checklist, and the checklist changes are audited.
  - Slice 2 — Invoice documents: PPN invoices (DPP, PPN, total shown separately, a tax document number from `tax_document_sequence`) and credit notes for the subscription, plus the export for the accountant, produced from stored invoice snapshots. Document format and e-Faktur compatibility stay UNVERIFIED until the accountant confirms them; nothing is sent to any tax system.
  - Execute Vitest/PostgreSQL through `pnpm --filter @bukalaris/db test` and Playwright through `pnpm --filter @bukalaris/web e2e` in a test environment with fixture policies only: toggle OFF to ON with all criteria, invoice totals equal DPP plus policy PPN under the policy's rounding, no literal rate in source (the T-65 literal-scan test covers this module), the export equals stored snapshots. Record observed results only after execution; no statutory result is claimed.

### T-95 — Map the WWW redirect route to a Log System module
- Status: Done locally 2026-11-05 (found by T-85)
- Primary requirement: PR-14
- Constraints: D-24; existing live/approval gates stay unchanged
- Dependencies: T-82 (added `/api/internal/www-redirect`, HTTP-33)
- Risk Level: R1
- Allowed Paths: `packages/db/src/ops/ops.ts` (`ROUTE_PREFIXES`, `MODULE_MAP`), BUILD-LOG/STATUS/TASKS
- Done when: `packages/db/test/ops.test.ts` "maps each page.tsx/route.ts … to a known module" passes with the WWW route mapped to HTTP-33 (not exempted); the full DB suite passes.
- Evidence: ops.test.ts 7/7 and db typecheck clean on 2026-11-05. The full suite rerun is part of the repeated T-85.

### T-96 — Close the Next.js/zod/vite audit advisories
- Status: Done locally 2026-11-05 (found by GitHub CI run 41968197087)
- Primary requirement: PR-14 (SEC-15)
- Risk Level: R3
- Change: next/eslint-config-next 16.3.8 → 16.4.5, zod 4.6.5 → 4.6.7, pnpm override vite 8.3.5 (dev peer of vitest).
- Evidence: `pnpm audit --prod --audit-level high` exit 0 (1 moderate esbuild via drizzle-kit, unchanged). Full verify on the upgraded tree (run be1f96845): map ok, lint, typecheck, DB 76 files / 1427 tests passed (notify.test.ts included; the earlier T-85 timeouts were load), build ok, E2E 259 passed / 2 skipped (pre-existing ops DB-down and HSTS proxy cases) / 2 failed — `t52.spec.ts` "a duplicate submit yields one order…" at 320 and desktop, a T-82 regression tracked as T-97, not caused by the upgrade; host-mode incl. #31/D-25 421 matrix and all T-82 cases passed on 16.4.5; verify:docker with worker passed (web 10d30b259af6, migrate 21f436ca7c32). Independent review 3ef33d6b ACCEPT WITH NOTES: lockfile consistent, D-25/#31/T-82 framework assumptions unchanged in 16.4.5 source; P1 docs applied (DECISIONS D-1 rows, D-25 re-verification, hardening.md audit-after section); P2 override removal condition recorded. Remaining full-audit highs are dev tooling only (shadcn CLI, eslint-plugin-react-hooks) and do not ship.

### T-97 — Keep the idempotent duplicate checkout submit after T-82
- Status: Done locally 2026-11-05 — `submitCheckout` accepts a duplicate submit of the same rendered form only when Origin/Host pass, the token is the MAC of this exact cart (same surface, origin, store, cart id) and this store already holds the order for this cart under the form's own idempotency key; `placeOrder` then only replays. `captureProgress` and every other cart action stay strict. Evidence: bb084acf1 lint/types, DB checkout 37/37 (new `orderForIdempotentReplay` isolation test), build, t52+auth-csrf+purchase 40/40 at 320+desktop; mutations bc216343e + b29a1201b — M1 no replay (t52 + replay assertion fail), M2 key-blind (rekey refusal fails), M3 token-blind (forged-token refusal fails), each restored by fingerprint, rebuilt, 40/40 positive. Independent review 976a47cb ACCEPT WITH NOTES (no P0/P1); P2s applied (forged-token case + M3). Known limit: a resubmit after the browser has dropped the cart cookie is still refused (correct).
- Primary requirement: PR-1 (checkout), PR-15
- Risk Level: R4 (money + CSRF)
- Dependencies: T-82
- Done when: a double submit of one rendered checkout form shows the same order confirmation (one order, one attribution, one deduction) while every T-82 checkout refusal (forged, foreign/closed cart, cross-store) still refuses; named mutation evidence and independent review.

### T-98 — Keep the fixed-window limiter tests inside one window
- Status: Done locally 2026-11-05 (found by T-85 run bd192aaff)
- Primary requirement: PR-14 (T-30, SEC-16 tests)
- Risk Level: R1 (test-only; no limiter or application change)
- Finding: `packages/db/test/checkout2.test.ts` "order submission is limited per cart … and per phone" failed once in the full T-85 run under host load (the 11th same-phone order resolved). Five isolated runs and two deliberate near-boundary starts did NOT reproduce it, so the root cause is unproven; the test is structurally exposed because it counts up to fixed-window limits (`hit`, database clock: phone 600 s, cart 60 s, IP 600 s) and a run that straddles a boundary restarts the count.
- Change: `freshDbWindow(windowSec, needSec)` waits for a fresh database window when too little of the current one remains, before the per-phone/per-cart and IP-boundary counts; the two affected tests get a 90 s timeout. No assertion relaxed.
- Evidence (t98-proof): three near-boundary starts passed; a mutant raising the per-phone limit by one (10 → 11) failed the named test; restored by fingerprint, `checkout2.test.ts` 12/12. If T-85 fails here again, the cause is something else and is investigated, not retried.

### T-99 — Show keyed search fingerprints verbatim in access evidence
- Status: Done locally 2026-11-05 (found by GitHub CI run 42001611408)
- Primary requirement: PR-14 (T-62/T-63 access evidence, DATA-14)
- Risk Level: R1
- Finding: `consoleAccessEvents` scrubbed every `target_id` that was not a UUID with `scrubText`, whose `[digits]` rule replaces 8+ digit runs. The account-search target id is a 16-hex HMAC fingerprint; whenever it happened to contain 8 consecutive digits the Owner console audit view showed it mangled (`e[digits]a7ba90`). Stored data was never affected. Present since T-63; surfaced on CI only because its secret yields different fingerprints.
- Change: `isOpaqueId` (UUID or lowercase hex 16–64) is shown verbatim; other target ids are still scrubbed.
- Evidence (t99-proof): a new deterministic test that picks a query whose fingerprint has an 8-digit run fails on the unfixed code (`'[digits]af7a394'` vs `'748121035af7a394'`) and passes on the fix; t63-accounts, ops, t62-console 57/57.
