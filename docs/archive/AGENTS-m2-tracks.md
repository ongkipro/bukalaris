# Parallel tracks (M2) — historical ownership table

Moved unchanged from `AGENTS.md` on 2026-11-15 (T-114). The file names are the M2 flat names and no longer exist; since T-51 the code lives under `packages/db/src/<context>/` and `apps/web/src/app/(<surface>)/`. Kept as a record of who owned what during M2. Not a current rule.

## Table as it stood

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
