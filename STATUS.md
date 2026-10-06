# Bukalaris — status

Updated: 2026-10-06. Milestone: M1 (repository, stack baseline, vertical slice).
This file owns current status. Evidence: `BUILD-LOG.md`, `docs/TASKS.md`
("M1 implementation evidence"). Nothing is committed yet — the owner approves
the first commit.

## In progress — M2 (started 2026-10-06)

Parallel tracks on local branches (see `docs/TASKS.md` M2 queue, AGENTS.md
"Parallel tracks"): `orders` (T-21), `accounts` (T-22), `ops` (T-23),
`content` (T-24..T-26), `channels` (T-16/T-19), `release` (T-18). Nothing from
these branches is merged or verified on `main` yet. Wave 2 after merge: T-27
RLS, T-28 UI pass, T-14 catalog IDs.

## What works on `main` (verified locally)

- Repository and stack: pnpm workspace, `apps/web` (Next.js 16.3.8, React
  19.2.8, TS 6.0.3, Tailwind 4.3.3, shadcn 4.21.1), `packages/db` (Drizzle
  0.45.3 + SQL migration, postgres.js). Postgres 17 via `docker-compose.yml`
  on `127.0.0.1:5442`. Versions: `docs/DECISIONS.md` D-1.
- Tenancy: store-scoped data access (`packages/db/src/scoped.ts`) with
  compound store foreign keys; storefront resolves an active store by
  `<slug>.<STORE_ROOT_DOMAIN>` host or `/s/<slug>` path.
- Operator auth (Better Auth, ADR-0004): email/password, sign-up disabled,
  sign-in rate limit active; owner/staff membership with last-owner protection.
- Seller Admin: product + variant CRUD (integer IDR, stock), list/detail,
  members.
- Storefront: product list/detail, server cart (one cart cookie per store).
- Hosted `/checkout`: server-derived price/stock/fee/total, idempotency key,
  atomic stock decrement; COD and simulated transfer; fake Mengantar/AutoLaris
  adapters (no network calls).
- Super Admin: store list, suspend/reactivate with audited reason; suspended
  store storefront returns 404 and checkout/seller admin are blocked.
- Gates (final round, 2026-10-06): `pnpm lint`, `typecheck`, `test` (22
  integration tests), `build`, `e2e` (10 Playwright tests, 320px + desktop),
  both `docker build` targets all pass. REVIEW R-1..R-11 resolved.
- Images: web 301 MB, migrate 273 MB; both run as non-root and were proven
  against a fresh database on the compose network.

## Not done / known gaps

- Not deployed anywhere; `docs/DEPLOY-COOLIFY.md` is an unexecuted draft
  (migrations need a separate step before the web deploy — Coolify's
  pre-deployment hook runs in the old container).
- Providers are fakes; no provider contract or sandbox verified (T-5, T-6).
- No PostgreSQL RLS or separate runtime/migration DB roles (D-4).
- One app/origin/cookie namespace for admin, storefront and checkout (D-2);
  no Astro storefront, no second theme, no external channel/handoff.
- Auth: no recovery, invitations, email verification, MFA; rate-limit store
  is in memory.
- No seller order list, inventory screen, collections, CMS, domains, Log System.
- No custom error page when the database is unreachable (routes return 500).

## Open product decisions affecting M1

Safe reversible default taken; details in `docs/DECISIONS.md`.

| Decision | Default taken in M1 | Owner |
|---|---|---|
| Q-6 auth provider | Better Auth 1.7.7 (ADR-0004), pending architecture owner confirmation | Architecture owner |
| Q-10 stock reservation / late payment / COD confirmation | Decrement at submit, no reservation expiry, no cancel/restock; COD = `placed`, transfer = `awaiting_payment`; nothing marks paid (D-5) | Finance owner |
| Q-1/Q-2 provider account ownership | Not decided; fakes only | Finance owner |
| Tenant root (TENANT vs STORE) | Store is the tenant root (D-3) | Data owner |
