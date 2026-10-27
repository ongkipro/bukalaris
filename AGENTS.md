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
| `apps/web` | Next.js App Router app, routes grouped by surface (`src/app/(platform)`, `(operator)` Owner console `/admin`, `(seller)` Seller Admin `/seller`, `(storefront)` `/s/<slug>` or `<slug>.<STORE_ROOT_DOMAIN>`, `(checkout)` hosted `/checkout`, `(identity)` login/account/invite, `(public-services)` buyer order status `/o/<token>` and `/dev/outbox`; route groups never appear in URLs), Storefront API `/api/storefront/v1`, `/api/{auth,health,ready,signals}`. `src/proxy.ts` applies the exact-host dispatch of `docs/08-DOMAIN-ROUTING.md` DOM-5; `src/lib/auth.ts` has one auth instance per surface (`owner`, `app`, `affiliate`, `buyer`; plain `localhost` keeps the one-host path mode) |
| `packages/db` | Drizzle schema (`src/schema.ts` plus `src/**/schema-*.ts`), append-only SQL migrations (`drizzle/`), DB client with three roles (ADR-0005), store-scoped services in bounded contexts under `src/`: `platform/` (scopes, tenant, host dispatch and reserved labels, accounts, membership, store lifecycle), `seller/commerce/` (catalog, checkout, orders, dashboard, privacy), `storefront/` (storefront reads, content, landing, channels, signals, feeds), `shipping/` (`mengantar/` client, booking, fulfillment), `payments/` (provider adapters), `ops/` and `ops/jobs/` (Log System, outbox, notifications); thin root entry points `src/worker.ts` (outbox worker), `src/cleanup.ts`, `src/migrate.ts`, `src/seed.ts`; integration tests |
| `docs/` | Design pack, ADRs, decisions, deploy plan, runbook, track reports (`docs/tracks/`); route-by-route map in `docs/04-SYSTEM-ARCHITECTURE.md` ARCH-5 |
| `BUILD-LOG.md` | Append-only phase log (what changed, commands, results, open issues) |
| `REVIEW.md` | Senior reviewer notes — read at the start of every phase; resolve open items first |

## Commands

Requires Node >= 20.9 (24 used), pnpm (version pinned in `package.json`
`packageManager`), Docker.

```bash
pnpm install
docker compose up -d db          # Postgres 17 on 127.0.0.1:5442
cp .env.example .env             # local-only dev values, never real secrets
scripts/db-roles.sh              # only for a compose volume created before T-27 (creates the three roles, transfers ownership)
pnpm db:migrate                  # apply packages/db/drizzle migrations as bukalaris_owner (MIGRATION_DATABASE_URL)
pnpm db:seed                     # two demo stores + operators (local only, idempotent)
pnpm dev                         # http://localhost:3000 ; storefront /s/toko-a or http://toko-a.localhost:3000
pnpm --filter @bukalaris/db worker   # outbox worker (payment instruction, e-mails, ad signals); e2e starts it itself
pnpm --filter @bukalaris/db cleanup  # one-shot idle-cart / counter / signal-context cleanup
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm e2e                         # after `pnpm build`; uses bukalaris_e2e (wiped + seeded each run)
pnpm map:check                   # system-map drift guard: every route file has an ARCH-5 row (docs/04), no ghost entry files
pnpm verify                      # map:check → lint → typecheck → test → build → e2e
pnpm verify:docker               # builds both images, migrates a throwaway DB, smoke-tests the container
docker build -f apps/web/Dockerfile -t bukalaris-web .
docker build -f apps/web/Dockerfile --target migrate -t bukalaris-migrate .
```

Databases (all in the compose container): `bukalaris` (dev), `bukalaris_test`
(Vitest, truncated per test), `bukalaris_e2e` (Playwright); worktrees use
`bukalaris_<track>[_test|_e2e]`. The app connects as `bukalaris_app` (RLS),
Super Admin/worker/cleanup as `bukalaris_platform`, the migrator as
`bukalaris_owner`; local passwords equal the role names (`docs/RUNBOOK.md`
"Database roles"). Seed users (local only): `admin@`, `owner-a@`, `staff-a@`,
`recovery-a@` (reserved for the recovery e2e), `owner-b@` `bukalaris.local`,
password `bukalaris-dev-123`; `admin@` holds the `logs.read` grant and must
enrol TOTP on first login before `/admin` opens. Sign-in is rate limited
(3 per 10 s per IP) when running a production build.

Smoke-testing the image: Postgres listens on 127.0.0.1 only, so run containers
on the compose network (`--network bukalaris_default`, host `db:5432`) with the
role URLs from `docs/RUNBOOK.md` "Image smoke test by hand" — never the compose
superuser as `DATABASE_URL` (it bypasses RLS).

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

> Historical ownership table. File names below are the M2 flat names; since T-51 (2026-10-28) they live
> under `packages/db/src/<context>/` and `apps/web/src/app/(<surface>)/` (see "Layout"); the ARCH-5 map
> in `docs/04-SYSTEM-ARCHITECTURE.md` carries the real paths.

Tracks run in separate git worktrees (`~/Projects/bukalaris-wt/<track>`, branch
`m2/<track>`); the orchestrator merges them into `main` locally. No push.

| Track | Owns (create/edit freely) | May also edit |
|---|---|---|
| `orders` | `packages/db/src/orders.ts`, `schema-orders.ts`, `apps/web/src/app/seller/{orders,inventory}/**` | `order` table + its CHECKs in `schema.ts` |
| `accounts` | `packages/db/src/accounts.ts`, `schema-accounts.ts`, `apps/web/src/app/{login,account,invite}/**`, `apps/web/src/app/seller/members/**`, `apps/web/src/lib/auth.ts` | Better Auth tables in `schema.ts`, `membership.ts`, member actions in `seller/actions.ts` |
| `ops` | `packages/db/src/ops.ts`, `schema-ops.ts`, `apps/web/src/app/admin/logs/**`, `apps/web/src/lib/log.ts`, `apps/web/src/instrumentation.ts`, `app/{error,global-error,not-found}.tsx` | `apps/web/src/proxy.ts` (correlation id only) |
| `channels` | `packages/db/src/channels.ts`, `schema-channels.ts`, `apps/web/src/app/api/storefront/**`, `apps/web/src/app/checkout/h/**`, `apps/web/src/app/seller/channels/**` | `docs/openapi.yaml` (only the operations it implements) |
| `release` | `.github/workflows/**`, `scripts/**`, `apps/web/Dockerfile`, `.dockerignore`, `docs/RUNBOOK.md` | root `package.json` scripts, `docker-compose.yml`, `docs/DEPLOY-COOLIFY.md` |
| `jobs` | `packages/db/src/jobs.ts`, `schema-jobs.ts`, `packages/db/src/worker.ts`, `packages/db/test/jobs.test.ts` | `packages/db/src/checkout.ts` (move the post-commit payment call onto the outbox only), `packages/db/package.json` scripts |
| `shipping` | `packages/db/src/shipping.ts`, `schema-shipping.ts`, `packages/db/src/mengantar/**`, `apps/web/src/app/seller/shipping/**`, `apps/web/src/app/admin/shipping/**`, `packages/db/test/shipping.test.ts` | capability map in `scoped.ts` (additions only) |
| `checkout2` (wave 2a) | `packages/db/src/{checkout,orders,shipping}.ts`, `schema-orders.ts`, `schema-shipping.ts`, `order` table in `schema.ts`, `apps/web/src/app/checkout/**`, `apps/web/src/app/s/[store]/{actions.ts,cart/**}`, `apps/web/src/app/seller/orders/**` | capability map (additions) |
| `catalog` (wave 2a) | `packages/db/src/{catalog,storefront}.ts`, `product`/`variant` tables in `schema.ts`, `apps/web/src/app/seller/products/**`, `apps/web/src/app/s/[store]/products/**`, storefront product links | `packages/db/src/seed.ts` (ids only) |
| `hardening` (wave 2a) | `apps/web/next.config.ts`, `apps/web/package.json` deps, `apps/web/src/proxy.ts`, `apps/web/src/lib/request-id.ts`, security header tests | root `package.json`, `.github/workflows/ci.yml` (audit step) |
| `notify` (wave 2b) | `packages/db/src/notify.ts`, `schema-notify.ts`, notification job handlers, `apps/web/src/app/o/**` (signed order-status page), email templates | minimal hooks in `orders.ts`/`checkout.ts` (enqueue only), optional buyer email field in `apps/web/src/app/checkout/**`, `accounts.ts` Mailer |
| `signals` (wave 2b) | `packages/db/src/signals.ts`, `schema-signals.ts`, `apps/web/src/app/seller/marketing/**`, `apps/web/src/components/pixels/**`, click-id capture | minimal hooks in `checkout.ts`/`orders.ts` (enqueue only), `apps/web/src/lib/security-headers.ts` `THIRD_PARTY`, storefront/checkout layouts (pixel mount only), seller nav entry |
| `ui` (wave 2b) | `apps/web/src/app/seller/**` and `apps/web/src/app/admin/**` presentation (not `seller/marketing/**`), `apps/web/src/components/**` (not `pixels/**`), status/copy helpers | e2e selectors that legitimately change |
| `rls` (wave 3) | `packages/db/src/{client,scoped}.ts`, a new `packages/db/src/tenant.ts`, hand-written RLS migration(s), `docker/`/compose init for roles, `packages/db/test/rls.test.ts`; transaction wrapping inside every service file in `packages/db/src/` | `apps/web` call sites that construct scopes or pools, `.env.example` (append), `docs/DEPLOY-COOLIFY.md`, `docs/RUNBOOK.md` |
| `fulfillment` (wave 4) | `packages/db/src/fulfillment.ts`, `schema-fulfillment.ts`, `packages/db/src/mengantar/**` (booking/tracking), booking UI on `apps/web/src/app/seller/orders/[id]/**`, tracking on `apps/web/src/app/o/**` | `orders.ts` (shipped transition from a resi), `jobs` handler registration in `worker.ts` |
| `feeds` (wave 4) | `packages/db/src/feeds.ts`, `schema-feeds.ts`, `apps/web/src/app/feeds/**` (route handlers) | feed URLs section in `apps/web/src/app/seller/marketing/**` |
| `dashboard` (wave 4) | `packages/db/src/dashboard.ts`, `apps/web/src/app/seller/page.tsx` + `seller/_dashboard/**` | `apps/web/src/components/nav-link.tsx` (exact match for `/seller`) |
| `landing` (wave 4) | `packages/db/src/landing.ts`, `schema-landing.ts`, `apps/web/src/app/seller/landing-pages/**`, `apps/web/src/app/s/[store]/lp/**` | `apps/web/src/components/pixels/**` (reuse only), `proxy.ts` only if `/lp` needs it |
| `privacy` (wave 4) | `packages/db/src/privacy.ts`, `schema-privacy.ts`, `apps/web/src/app/seller/privacy/**`, `docs/13-COMPLIANCE-PRIVACY.md` (inventory section) | `cleanup.ts` (retention job, disabled by default) |
| `demo` (wave 4) | `packages/db/src/demo/**` (demo seed + generated placeholder images), root/db `package.json` script `db:seed:demo`, `docs/DEMO.md` | none |
| `docs-scan` (wave 4, main) | `docs/**` except track reports, `README`-level docs, `AGENTS.md` sections other than the ownership table | none — no code |
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
