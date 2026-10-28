# Bukalaris — status

Updated: 2026-10-28 (Goal Mode, uncommitted working tree on top of `8748533`: M3 chain A foundation and the first half of chain B prerequisites are implemented locally: T-51, T-61, T-70, T-59 (expand step), T-60, T-74, T-62, T-49, T-65, T-73 (provider adapter OPEN), T-57, T-37, T-63, T-50; migrations 0011 to 0014; every provider is a fake adapter; nothing is deployed). Milestone: M2 complete locally; M3 chain A delivered locally, chain B (T-48, T-52 to T-56, T-58, T-72) and the remaining Owner screens are next.
This file owns current status. Evidence: `BUILD-LOG.md`, `docs/TASKS.md`
("M1 implementation evidence", M2 task statuses, M3 planned tasks) and the track reports in
`docs/tracks/`. The wave 4 merges are local commits on `main` (not pushed); nothing is deployed.

## In progress

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
the header of `docs/TASKS.md` ("M3 chains"); tasks T-48..T-69 and T-71..T-75 are all Proposed specification (T-75, PPN activation readiness, is deferred), none
implemented. **Implemented locally on 2026-10-28 (working tree, not committed, nothing deployed):** T-51 (surface route
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

## Not done / known gaps (2026-10-07)

- Not deployed; `docs/DEPLOY-COOLIFY.md` is an unexecuted draft (worker and
  migrate jobs must be added to it; migrations run as a separate job).
- Providers: Mengantar reads observed live; writes (booking, origin upsert)
  locked pending owner approval; AutoLaris still fake; receiver score API is
  403 for this account; `MENGANTAR_ORIGIN_AREA_ID` vs pickup address area mismatch to confirm.
- Shipment booking (T-39): create-order / `GET /order` / `payUnpaid` request and
  response shapes and the courier map are unverified until an approved write
  test; a booking stuck in `booking` or with an uncertain result needs manual
  recovery (seller checks the Mengantar dashboard); a returned/cancelled
  shipment leaves the order `shipped` (no automatic restock).
- Feeds (T-40): not accepted by Meta or Google yet (no upload allowed); owner
  decision on Google `identifier_exists` (emit `no` or collect GTIN/MPN).
- Privacy (T-43): the `shipment` table (`tracking_history` may hold receiver
  data from the provider) is not yet in the buyer-data inventory, export or
  redaction; `purchasePayload` in `signals.ts` would hash the `[dihapus]`
  placeholder after an override redaction; backups taken before a redaction
  still hold the data; retention periods (Q-11) owed, so the retention job
  stays off. App role has table-wide `UPDATE` on `mail_outbox` (DECISIONS D-10).
- Landing pages (T-42): new storefront routes must live under
  `apps/web/src/app/s/[store]/(shop)/` to keep the store shell; no page
  deletion or revision history UI; drag-and-drop/MCP later (T-11, T-20).
- Dashboard (T-41): `(store_id, created_at)` order index deferred until the
  KPI query is slow at real volume.
- Demo seed: no demo content yet for wave 4 features (landing page, booked
  shipment, feed token, export/redaction example).
- `.env.example` lacks the wave 4 variables `MENGANTAR_PICKUP_ADDRESS_ID`,
  `MENGANTAR_PICKUP_TIME_ID`, `ALLOW_COD_BOOKING`, `BUYER_DATA_RETENTION_DAYS`
  (documented in `docs/RUNBOOK.md` / `docs/DEPLOY-COOLIFY.md`).
- No COD remittance ledger (Q-17), no real email provider; ad signals run in simulation until a test-event call is approved.
- Local `.env` `DATABASE_URL` on `main` still uses the superuser (bypasses RLS in `pnpm dev`); switch it to `bukalaris_app` by hand.
- Single app/origin for admin, storefront and checkout (D-2); no Astro storefront.
- Rate-limit storage for auth is in memory (single instance only).
- e2e evidence screenshots live in `docs/evidence/m1/` for every milestone and
  are re-rendered on each run (restore before committing).

## Open decisions (2026-10-07)

Defaults taken are reversible; details in `docs/DECISIONS.md` and `docs/02-PRD.md`.

| Decision | Current default / state | Owner |
|---|---|---|
| Q-6 auth provider | Better Auth 1.7.7 (ADR-0004), pending architecture owner confirmation | Architecture owner |
| Q-10 checkout policy | Stock decremented at submit; seller cancel restocks once (before shipping); transfer "mark paid" is manual; COD confirmation step in place (T-35) | Finance owner |
| Q-1 AutoLaris account | Undecided; fake adapter | Finance owner |
| Q-2 Mengantar account | Platform-owned (derived from Q-12 shipping margin) | Finance owner |
| Q-14 cross-store COD risk data | Store-scoped only | Privacy + product owner |
| Q-17 COD remittance to sellers | Undecided — blocks the first real COD shipment; COD booking refused unless `ALLOW_COD_BOOKING=1` | Finance + legal owner |
| Q-11 buyer-data retention periods | Undecided — retention job off (`BUYER_DATA_RETENTION_DAYS` unset) | Privacy owner |
| Tenant root | Store is the tenant root (D-3) | Data owner |
