# Bukalaris — status

Updated: 2026-11-04 (documentation reconciliation and development backlog after the portfolio review; D-24, tasks T-80 to T-94). The application has not been changed or re-verified by this pass. Current checkout: uncommitted changes on top of `2ddf5d2`; M3 chain A delivered locally and chain B partly against fake adapters. Nothing is deployed. Task status is scoped delivery, not production acceptance.
This file owns current status. Evidence: `BUILD-LOG.md`, `docs/TASKS.md`
("M1 implementation evidence", M2 task statuses, M3 planned tasks) and the track reports in
`docs/tracks/`. The wave 4 merges are local commits on `main` (not pushed); nothing is deployed.

## In progress

**Documentation follow-up 2026-11-04 (owner: apply the recommendations, turn missing work into development tasks, and improve the system map).** The earlier docs-only pause is superseded for this bounded pass. D-24 records the disposition of the review; T-80 to T-94 own missing technical, verification and policy-gated work. Priority: stock lost-update protection (T-80), store-column grants (T-81), CSRF and shared auth limits (T-82/T-83), runtime/migration guards (T-76/T-77), then the current-tree verification baseline (T-85). T-84 adds worker/cleanup container proof; T-86 finishes spec/API alignment; T-87 owns full research triage. These tasks are planned, not implemented by this documentation pass. T-12 map maintenance is verified for this pass: 102 exact-owned routes, 124 current rows (117 implemented including disabled/stub entries), plus 14 passing guard fixtures; task inventory is now 94. Spec/traceability checks pass. No application tests/build/E2E/database check was run. Business/provider/legal choices stay gated on their named owner. No commit, provisioning or live-provider permission is implied.

**Parked 2026-11-01 (owner: "catat dulu, kita lanjut nanti"; documents only, development not started).** Etalashop and TokoΦ,
both their documents and their built and live systems, were studied to complete the Bukalaris documents
(`docs/research/2026-11-portfolio-scan/`). The first pass sampled the two large TokoΦ logs; the full read of the whole TokoΦ and Etalashop
Markdown corpus was completed the same day (12 lanes, every file to its last line; Etalashop is an older subset of TokoΦ;
`docs/research/2026-11-portfolio-scan/full-read/`). Owner direction: expect many further decisions, and choose the more modern
system design where it beats the TokoΦ/Etalashop pattern instead of copying it (lessons are inputs, not templates).
Resume with, in order (all documents, no code):
(1) close the open questions already decided elsewhere (Q-1 by ADR-0006, Q-5/Q-6 by D-1 and ADR-0004, Q-13, Q-16 email) and merge
the duplicate Q-12/Q-13/Q-15/Q-16 rows in `02-PRD.md`; (2) settle ADR-0001..0003 (Accepted or Superseded by ADR-0008) and note in
ADR-0007 that its file name says "hybrid" while the content is unified (D-15); (3) sync the Status lines of documents 03 to 17 with
D-20/D-21; (4) one owner decision list with a recommendation per item, recorded as D-24, built from the full read
(`docs/research/2026-11-portfolio-scan/full-read/SYNTHESIS-P1.md`, candidates D1 to D10, unique lessons U1 to U84) and: the ten Proposed PRs (PR-3, PR-6, PR-7,
PR-18, PR-23 to PR-27, PR-29 to PR-31), the scan candidates (payment anomaly queue, per-store COD conditions, consent under
PP 33/2026) and where a more modern design should replace an inherited pattern.

**Docs pass 2026-11-01 (owner: scan the portfolio, perfect the docs).** Research and its verification are in `docs/research/2026-11-portfolio-scan/`; owner documents and tasks T-76 to T-79 were updated; no code changed. Conflicts fixed: `/api/ready` wording and the missing probe script (14), Q-10 (02-PRD), the ADR-0005 amendment status, the README scope paragraph and this file's header.

**Parked 2026-10-28 (owner: stop here for now).** Working tree after commit `2ddf5d2` holds, uncommitted: hosting direction D-23 and the deploy-doc refresh,
`CLIENT_IP_HEADER`, the UI/UX polish of Seller Admin, Owner console and public pages (reports `docs/tracks/ux-*.md`), and the audit of the old 'Partial' task
statuses (`docs/tracks/audit-partial.md`). Open next, none needs the deploy: (1) T-59 contract step and T-59b/T-59c hardening, (2) the deferred P3 backlog listed per task
in `docs/TASKS.md`, (3) worker and cleanup inside `verify:docker`, (4) the affiliate chain T-53 to T-55 and T-71/T-66, (5) a design review of the public pages
(the external review step of `design-gate.py` has not run), (6) provisioning (Vultr, Coolify, Cloudflare) only after the domain exists and the owner asks.

**Goal Mode run 2026-10-28 (owner: continue the whole queue, build what needs no decision, defer the rest).** Implemented locally and
independently reviewed (three review rounds, every P1/P2 fixed with a named test): T-59 expand step, T-60, T-74, T-62, T-49, T-65, T-73
(except the real mail provider), T-57, T-37, T-63, T-50. Evidence per task is in `docs/TASKS.md` and `BUILD-LOG.md`; last full gates:
DB 73 files / 1388 tests, Playwright 207 passed / 0 failed, `verify:docker` 133 tables / 75 policies / 0 registry differences, restore rehearsal green,
migration 0011..0016 applied to a populated copy of the dev database. Also built since: T-46, T-48, T-68, T-45, T-47, T-52. Owner-decision and external-fact items are recorded as DEFERRED on each task and in
the ledger section of `docs/TASKS.md`; defaults taken on the orchestrator's recommendation are DECISIONS D-22 items 1 to 9.

Nothing running in parallel: M2 waves 1–4 are merged into `main` (wave 4 on
2026-10-07). On 2026-10-26, the M3 specification pass (`ADR-0006`, `PR-23`..`PR-26`,
`BILL-4`..`BILL-5`, `DATA-7`..`DATA-8`, `UX-14`..`UX-16`, `T-37`, `T-44`..`T-47`)
was recorded in `docs/` from the Etalashop reference pack, adapted for Mengantar.
Subscription billing is no longer deferred: `PR-18` is Proposed at Rp175.000 per store per
month (DPP), see `BILL-7`, `DATA-10`, `T-50`. On 2026-10-27 the owner also decided: seller money is
credited only for delivered and reconciled parcels (D-14, replacing the H+1 rule of D-11), unified
Bukalaris-managed shipping where Bukalaris generates a Partner Mengantar seller account per store and
controls all shipping discounts, margin, and cashback (`ADR-0007`, D-15; no `own_key` and no two-system split),
affiliate commission across all opted-in prepaid and COD orders only for delivered and reconciled parcels
with a 3-day hold default (`ADR-0009`, D-16), PPN off by default and Owner-switchable with no rate in code (D-17),
no issue-report screenshots in Phase 1 (D-18), decided 72-hour payout destination hold, self-service recovery,
and startup SLA/DR baseline (D-19), a global buyer identity (`ADR-0010`), and
the host map `owner` / `app` / `affiliate` / `buyer` / `logs`.bukalaris.com (`ADR-0008`; the interim `berkah` label was never deployed and is retired), the
Owner console (formerly Super Admin / Bos) managing sellers, affiliates and accounts (`ADR-0011`),
an online-store posture with tax and compliance relaxed for the startup phase (`ADR-0012`, D-12,
D-13), a 'Lapor masalah' issue-report button and an Update Log host. The canonical build order is
the header of `docs/TASKS.md` ("M3 chains"); tasks T-48..T-69 and T-71..T-75 were all Proposed specification on 2026-10-26 (T-75, PPN activation readiness, is deferred);
the current per-task status is the `Status:` line of each task in `docs/TASKS.md`. **Implemented locally on 2026-10-28 (working tree, not committed, nothing deployed):** T-51 (surface route
groups in `apps/web`, bounded contexts in `packages/db/src`; routes 64 before and after, no schema change) and T-70 (exact-host
dispatch per DOM-5, reserved labels, one auth instance and `__Host-` cookie names per surface, per-surface link origins).
Observed: `pnpm map:check` ok, lint and typecheck clean, `pnpm build` ok, 229 db tests (22 files) passed, Playwright 101
passed and 2 skipped including the new `*.localhost` host-mode project; details and the recorded gaps are in `docs/TASKS.md`
(T-51, T-70) and `BUILD-LOG.md`. Reviews: `docs/reviews/2026-10-27-code-vs-spec-gap-report.md` (code versus spec; lint,
typecheck and 186 db tests passed at the time) and `docs/reviews/2026-10-27-doc-audit-report.md` (102 findings
from four documentation audits, fixes applied, policy items recorded as OPEN with recommended
defaults). Drift guards: `pnpm map:check`, `python3 docs/check-spec.py`.
Demo: `pnpm db:seed:demo` store Batik Nusantara (seller admin + storefront run for real);
affiliate, subscription and seller-affiliate screens are static mockups in `docs/mockups/`.

Owner input still needed before live production calls: Q-17 legal sign-off on
holding seller COD funds (the platform advances COD cash for the unverified
Mengantar remittance lag), Mengantar write-test approval and sandbox capture of
tracking status codes, ad-platform test-event approval, email provider, VPS/DNS
for deployment.

Business direction (owner, 2026-10-06): revenue = shipping margin through a
platform-owned Mengantar account; first segment = COD sellers nationwide; ad
signals follow the TokoΦ/AdsBookCMS concept; email notifications first.
Blocking before any real COD shipment: Q-17 COD remittance (finance + legal);
Mengantar writes stay disabled until the owner approves a write test.

## What works on `main` (verified locally, 2026-10-07)

- M1 slice (auth, store-scoped catalog, storefront, cart, hosted checkout,
  Super Admin suspend) plus merged M2 wave 1:
  - Seller orders lifecycle + inventory with audited stock adjustments (T-21).
  - Password recovery, member invitations, session lifecycle, operator TOTP MFA (T-22).
  - Correlation ids, JSON logs, Log System (`/admin/logs`), error pages, `/api/ready` (T-23).
  - Store settings, two themes, product images, collections, CMS pages,
    search, Super Admin store create/detail, UI/UX pass (T-24..T-26).
  - Storefront API v1 with channel tokens and one-use checkout handoff (T-16/T-19 subset).
  - Transactional outbox + worker; payment instruction via outbox (T-32).
  - Mengantar read client, platform margin, seller pickup area (T-34 phase 1).
  - `pnpm verify`, `pnpm verify:docker`, backup/restore rehearsal, runbook (T-18).
  - Wave 2a: security headers + nonce CSP (T-29), five-digit string catalog ids
    + slug aliases + catalog audit (T-14, T-31), Mengantar shipping in checkout
    with margin snapshot (T-34), COD confirmation + risk signals (T-35),
    rate limits + cart caps/cleanup (T-30).
  - Wave 2b: email order notifications + signed status links (T-36), ad
    conversion signals in simulation (T-38), seller/admin UI pass (T-28).
  - Wave 3: PostgreSQL RLS with owner/app/platform roles (T-27, ADR-0005).
  - Wave 4 (merged 2026-10-07; migrations `0008_wave4.sql` + hand-written
    `0009_wave4_rls.sql`, five new tables, all store tables under FORCE RLS):
    - Shipment booking and tracking through the outbox on the fake adapter;
      Mengantar writes still locked, COD booking refused while Q-17 is open (T-39).
    - Token-protected Meta CSV and Google Merchant RSS catalog feeds (T-40).
    - Seller dashboard at `/seller`: KPIs, COD work queue, funnel, top products (T-41).
    - Landing pages v1 with immutable revisions and an order section at
      `/s/<slug>/lp/<page>`, independent of the store theme; storefront routes
      moved into the `(shop)` route group (T-42).
    - Buyer data export and audited redaction; retention job off by default (T-43).
    - Local demo data: `pnpm db:seed:demo` (four fictional stores, `docs/DEMO.md`).
- Gates on `main` before wave 4 (`0a3cfd8`): lint 0, typecheck 0, Vitest 137
  passed (as the RLS-bound app role), build 0, Playwright 72 passed + 2 skipped
  with a CSP-violation guard on every evidence step, `verify:docker` exit 0
  (26 policies), backup + restore rehearsal rls_ok=yes.
- Gates on `main` after wave 4 (`c1adf27`): lint 0, typecheck 0, Vitest
  186 passed (21 files), build 0, Playwright 92 passed + 2 skipped,
  `verify:docker` exit 0 (42 tables, 31 tenant policies, health 200,
  HEALTHCHECK healthy).

## Current outstanding work (reconciled 2026-11-04)

- **Security and inventory:** product editing can overwrite a sale's stock decrement (T-80); the app role has table-wide UPDATE on its own store row (T-81, DB defense in depth, not a demonstrated browser exploit). T-59 has delivered only expand: the contract migration needs all consumers upgraded and explicit owner approval. T-59b separate operator identity and T-59c definer hardening remain unbuilt; T-82/T-83 track session-bound CSRF and shared auth limits. D-20 requires the CSRF work before non-local exposure.
- **Verification:** BUILD-LOG records 74 files / 1391 DB tests after UX polish, but the subsequent full build and E2E were stopped before completion. No full current-tree application verification is claimed. T-85 re-establishes the baseline; T-84 adds worker and cleanup to container proof; the independent public-page design review remains open under T-28.
- **Runtime and operations:** T-76 role proof, T-77 migration journal / fixture provenance, T-78 scannable QRIS and T-79 off-box monitoring / backup / deploy evidence are planned. Restore-time erasure replay remains open under T-33; production purge periods remain unset. Evidence from an earlier build is historical, not proof of the latest tree.
- **Remaining product work:** taxonomy T-44; affiliate wallet, portal and storefront T-53 to T-55; buyer portal T-58; statements and startup tax UI T-71/T-66; affiliate/buyer governance T-72. Delivered-local tasks keep their per-task deferred slices. Optional/deferred: marketplace T-7, custom domains T-15, MCP/visual builder T-11/T-20, external sources T-56, Compliance T-64, Phase 2 tax T-67, Update Log T-69 and PPN documents T-75.
- **External gates:** Q-17 legal custody review; Mengantar Partner Secret rotation and approved write tests; OPEN-F7/F8/F9 provider terms, reconciliation and cashback evidence; AutoLaris account/sandbox/vendor codes; ad-platform test events; mail provider/sender configuration; hosting and DNS approval. No live transaction or deployment is authorised by task completion.
- **Documentation:** T-86 owns remaining ADR-0001..0003 disposition, document-level status lines and OpenAPI parity; T-87 classifies all remaining research lessons and deferred review findings before creating more tasks. No research recommendation becomes accepted policy merely by being listed.

Resolved historical gaps (do not reopen): T-47 covers shipment privacy inventory/export/redaction, the signal placeholder guard, wave-4 demo content and example-environment additions; T-73 removes app-role mail-body privileges (real transport remains open); T-37 delivers a local ledger/payout/refund path; T-61 replaces the old 1 kg-per-line quote rule; T-70 delivers exact-host dispatch and per-surface sessions. The M2 implementation evidence above and dated track reports remain historical.

## Current decisions and external facts

| Item | Decided / still open | Owner / task |
|---|---|---|
| Stack and auth (Q-5/Q-6) | Pinned repository stack and Better Auth decided; production hosting direction is D-23, not provisioned | Architecture / T-18, T-79 |
| AutoLaris (Q-1) | Platform-managed ownership direction in ADR-0006; commercial account, profile and sandbox evidence still open | Finance + integration / T-5, T-6, T-49 |
| Checkout (Q-10) | Server stock decrement and terminal-payment/refund rules implemented locally; reservation expiry/backorder policy still open | Product + finance / T-88 |
| COD custody (Q-17) | Delivered-and-reconciled release decided; legal custody and provider settlement facts still gate real COD | Finance + legal / T-37, T-48 |
| Retention and risk sharing (Q-11/Q-14) | Retention periods undecided; COD risk remains store-scoped | Privacy / T-33, T-74 |
| Email (Q-16) | Email-first decided; real provider and sender domain open, WhatsApp integration deferred | Product / T-73 |
| Portfolio candidates | Recommendations and task links in D-24; gated items remain unaccepted | Named owners / T-87 to T-94 |
