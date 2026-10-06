# Bukalaris — status

Updated: 2026-10-06. Milestone: M1 (repository, stack baseline, vertical slice).
This file owns current status. Evidence: `BUILD-LOG.md`, `docs/TASKS.md`
("M1 implementation evidence"). Nothing is committed yet — the owner approves
the first commit.

## In progress — M2 wave 3 (2026-10-07)

`rls` (T-27): PostgreSQL RLS with owner/app/platform roles per ADR-0005. Waves
1, 2a and 2b are merged (see below).

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
- Gates on `main` (`3e53efe`): lint 0, typecheck 0, Vitest 129 passed, build 0,
  Playwright 72 passed + 2 skipped with a CSP-violation guard on every evidence step.

## Not done / known gaps (2026-10-07)

- Not deployed; `docs/DEPLOY-COOLIFY.md` is an unexecuted draft (worker and
  migrate jobs must be added to it; migrations run as a separate job).
- Providers: Mengantar reads observed live; writes (booking, origin upsert)
  locked pending owner approval; AutoLaris still fake; receiver score API is
  403 for this account; `MENGANTAR_ORIGIN_AREA_ID` vs pickup address area mismatch to confirm.
- No COD remittance ledger (Q-17), no real email provider; ad signals run in simulation until a test-event call is approved.
- No PostgreSQL RLS / separate DB roles until T-27 merges.
- Single app/origin for admin, storefront and checkout (D-2); no Astro storefront.
- Rate-limit storage for auth is in memory (single instance only).
- e2e evidence screenshots live in `docs/evidence/m1/` for every milestone and
  are re-rendered on each run (restore before committing).

## Open decisions (2026-10-07)

Defaults taken are reversible; details in `docs/DECISIONS.md` and `docs/02-PRD.md`.

| Decision | Current default / state | Owner |
|---|---|---|
| Q-6 auth provider | Better Auth 1.7.7 (ADR-0004), pending architecture owner confirmation | Architecture owner |
| Q-10 checkout policy | Stock decremented at submit; seller cancel restocks once (before shipping); transfer "mark paid" is manual; COD confirmation step coming with T-35 | Finance owner |
| Q-1 AutoLaris account | Undecided; fake adapter | Finance owner |
| Q-2 Mengantar account | Platform-owned (derived from Q-12 shipping margin) | Finance owner |
| Q-14 cross-store COD risk data | Store-scoped only | Privacy + product owner |
| Q-17 COD remittance to sellers | Undecided — blocks the first real COD shipment | Finance + legal owner |
| Tenant root | Store is the tenant root (D-3) | Data owner |
