# Bukalaris — agent and developer instructions

Bukalaris (bukalaris.com — "Buka toko langsung laris") is a multi-tenant
commerce platform for Indonesian sellers. This repository owns the code and the
design pack in `docs/` (copied from the staged pack on 2026-10-06; the old
folder is a frozen snapshot with a `MOVED.md` pointer).

## Source of truth

Repository code and executable checks > `STATUS.md` / `docs/TASKS.md` /
`docs/DECISIONS.md` > the rest of `docs/`. Docs marked "Proposed" are not
implementation evidence. Edit docs only inside this repository.

## Layout

| Path | Owns |
|---|---|
| `apps/web` | Next.js App Router app: Seller Admin (`/seller`), Super Admin (`/admin`), storefront (`/s/<slug>`), hosted `/checkout` |
| `packages/db` | Drizzle schema, SQL migrations, DB client, store-scoped data access, commerce services, integration tests |
| `docs/` | Design pack, ADRs, decisions, deploy plan |
| `BUILD-LOG.md` | Append-only phase log (what changed, commands, results, open issues) |
| `REVIEW.md` | Senior reviewer notes — read at the start of every phase; resolve open items first |

## Commands

Requires Node >= 20.9 (24 used), pnpm (version pinned in `package.json`
`packageManager`), Docker.

```bash
pnpm install
docker compose up -d db          # Postgres 17 on 127.0.0.1:5442
cp .env.example .env             # local-only dev values, never real secrets
pnpm db:migrate                  # apply packages/db/drizzle migrations
pnpm db:seed                     # two demo stores + operators (local only, idempotent)
pnpm dev                         # http://localhost:3000 ; storefront /s/toko-a or http://toko-a.localhost:3000
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm e2e                         # after `pnpm build`; uses bukalaris_e2e (wiped + seeded each run)
docker build -f apps/web/Dockerfile -t bukalaris-web .
docker build -f apps/web/Dockerfile --target migrate -t bukalaris-migrate .
```

Databases (all in the compose container): `bukalaris` (dev), `bukalaris_test`
(Vitest, truncated per test), `bukalaris_e2e` (Playwright). On an existing
volume created before `bukalaris_e2e` existed, the e2e global setup creates it.
Seed users (local only): `admin@`, `owner-a@`, `staff-a@`, `owner-b@`
`bukalaris.local`, password `bukalaris-dev-123`. Sign-in is rate limited
(3 per 10 s per IP) when running a production build.

Smoke-testing the image: Postgres listens on 127.0.0.1 only, so run containers
on the compose network: `--network bukalaris_default` with
`DATABASE_URL=postgres://bukalaris:bukalaris@db:5432/<db>`.

## Rules

- Local only: no deploy, no DNS, no live provider calls (Mengantar/AutoLaris are
  fake adapters), no real secrets. `.env.example` holds dev placeholders only.
- No git commit/push unless the owner asks. No `Co-Authored-By`/AI trailers.
- Tenant isolation: every store-owned read/write is a function in
  `packages/db/src/*.ts` that takes a scope object and filters by
  `scope.storeId`. Scopes are only created in `packages/db/src/scoped.ts`:
  `sellerContext(exec, userId, preferredStoreId?)` → `SellerScope` (verified
  membership in an active store; the preference is honoured only with
  membership), `storefrontScope(exec, slug)` → `StorefrontScope` (active store
  by slug; the slug comes from the host via `src/proxy.ts` or the `/s/<slug>`
  path), `operatorScope(exec, userId)` → `OperatorScope` (platform operator).
  Checkout derives the store from the cart row. Never pass a browser-supplied
  store id into a query.
- Money is integer IDR (`bigint` columns, `number` in TS within safe range).
  Checkout derives price/stock/total server-side; client sends variant ids and
  quantities only.
- Lazy senior: minimum code that holds; no speculative abstractions or extra
  dependencies for a few lines. Record deliberate ceilings in `docs/DECISIONS.md`.
- Never claim something works without running it; record evidence in
  `BUILD-LOG.md` and `docs/TASKS.md`.

## Parallel tracks (M2)

Tracks run in separate git worktrees (`~/Projects/bukalaris-wt/<track>`, branch
`m2/<track>`); the orchestrator merges them into `main` locally. No push.

| Track | Owns (create/edit freely) | May also edit |
|---|---|---|
| `orders` | `packages/db/src/orders.ts`, `schema-orders.ts`, `apps/web/src/app/seller/{orders,inventory}/**` | `order` table + its CHECKs in `schema.ts` |
| `accounts` | `packages/db/src/accounts.ts`, `schema-accounts.ts`, `apps/web/src/app/{login,account,invite}/**`, `apps/web/src/app/seller/members/**`, `apps/web/src/lib/auth.ts` | Better Auth tables in `schema.ts`, `membership.ts`, member actions in `seller/actions.ts` |
| `ops` | `packages/db/src/ops.ts`, `schema-ops.ts`, `apps/web/src/app/admin/logs/**`, `apps/web/src/lib/log.ts`, `apps/web/src/instrumentation.ts`, `app/{error,global-error,not-found}.tsx` | `apps/web/src/proxy.ts` (correlation id only) |
| `content` | `packages/db/src/content.ts`, `schema-content.ts`, `apps/web/src/app/seller/{collections,pages,settings}/**`, `apps/web/src/app/s/**`, `apps/web/src/app/checkout/**` (presentation), `apps/web/src/app/admin/stores/**`, `globals.css` | `store` table in `schema.ts`, `seller/products/**` (images) |

Rules for every track:
- Do not edit another track's files, `seller/layout.tsx`, `admin/layout.tsx`
  (navigation is pre-populated), `packages/db/src/index.ts` or the root
  configs. If a shared change is unavoidable, make it minimal and list it in
  your track report.
- Each track uses its own `.env` (databases `bukalaris_<track>`,
  `bukalaris_<track>_test`, `bukalaris_<track>_e2e`; ports in `.env`).
- Migrations: run `pnpm db:generate` in your branch to test; the orchestrator
  regenerates one consolidated migration at merge.
- Tests: Vitest file `packages/db/test/<track>.test.ts`, Playwright spec
  `apps/web/e2e/<track>.spec.ts`. Run lint, typecheck, test, build and e2e
  before every commit; commit on your branch only.
- Report: `docs/tracks/<track>.md` (what changed, commands + results,
  decisions/defaults taken, open issues). Do not edit BUILD-LOG/STATUS/TASKS;
  the orchestrator does.
