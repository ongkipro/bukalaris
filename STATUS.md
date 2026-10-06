# Bukalaris — status

Updated: 2026-10-06. Milestone: M1 (repository, stack baseline, vertical slice).
This file owns current status. Evidence: `BUILD-LOG.md`, `docs/TASKS.md`
("M1 implementation evidence"). Nothing is committed yet — the owner approves
the first commit.

## In progress — M2 wave 2a (started 2026-10-07)

`checkout2` (T-34 phase 2 checkout shipping wiring, T-35 COD confirmation,
T-30 abuse controls), `catalog` (T-14 five-digit string catalog ids + slug
aliases, T-31 catalog audit), `hardening` (T-29 security headers, dependency
hygiene, request-id trust). Next (wave 2b): T-36 email notifications, T-38 ad
conversion signals, T-27 RLS + DB roles, T-28 seller/admin UI pass.

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
- Gates on `main`: lint 0, typecheck 0, Vitest 88 passed, build 0, Playwright
  41 passed + 1 skipped, `verify:docker` exit 0 (30 tables, health 200,
  HEALTHCHECK healthy, non-root, media volume writable).

## Not done / known gaps (2026-10-07)

- Not deployed; `docs/DEPLOY-COOLIFY.md` is an unexecuted draft (worker and
  migrate jobs must be added to it; migrations run as a separate job).
- Providers: Mengantar reads observed live; writes (booking, origin upsert)
  locked pending owner approval; AutoLaris still fake; receiver score API is
  403 for this account; `MENGANTAR_ORIGIN_AREA_ID` vs pickup address area mismatch to confirm.
- No COD remittance ledger (Q-17), no real email provider, no ad signals yet (T-38).
- No PostgreSQL RLS / separate DB roles (T-27); no security headers until T-29 merges.
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
