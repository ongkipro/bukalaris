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
| `docs/` | Design pack (`02` to `17`), `TASKS.md`, `DECISIONS.md`, deploy plan, runbook; ADRs in `docs/adr/`; track reports in `docs/tracks/`; dated reviews and research in `docs/reviews/`, `docs/research/`; superseded material in `docs/archive/`; route-by-route map in `docs/04-SYSTEM-ARCHITECTURE.md` ARCH-5 |
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

## Conventions added by the Goal Mode run (2026-10-28)

- **Owner console:** every `/admin` page and server action starts with the console gate (`apps/web/src/lib/console-gate.ts`); a new page is registered in
  `packages/db/src/ops/console-routes.ts` and gets an ARCH-5 row (9-column Pages table). Services take an `OperatorScope` and call `requirePlatformCap` first;
  protected personal data is read through `withPersonalDataAccess`; sensitive actions use four-eyes (`requestApproval`/`consumeApproval`) with the approver
  reading `payload_canonical`.
- **Isolation registry:** every table needs an entry in `packages/db/src/platform/isolation-registry.ts` and every `SECURITY DEFINER` function an entry in
  `DEFINER_FUNCTIONS` (pinned `search_path = pg_catalog, pg_temp`, schema-qualified names including INSERT/UPDATE/DELETE targets, `execute: []` for owner-only
  functions such as every `reset_demo_*`). After a registry change regenerate the GRANT block of `packages/db/drizzle-pending/t59-contract.sql` from
  `registryRows()`; `rls.test.ts`, `rls-contract.test.ts` and `pnpm verify:docker` enforce both.
- **Migrations:** append-only; the generated structure comes from `pnpm --filter @bukalaris/db generate`, hand-written SQL (RLS, grants, triggers, definer
  functions, seeds) goes in a `-- ===== <task>` section after it. A migration that adds a foreign key to a populated table must backfill first
  (`NOT VALID`, then `VALIDATE`). Prove a new migration on a populated copy of the dev database (`create database ... template bukalaris`), not only on the empty test database.
- **Money and auth tests:** a test for an invariant is only accepted after the invariant was broken once on purpose and a named test failed (mutation check,
  recorded in the track report). Reviews of sensitive work are done by a separate agent; findings and fixes are recorded in `BUILD-LOG.md` and on the task in `docs/TASKS.md`.
- **UI:** reuse `PageHeader`, `EmptyState`, `StatusBadge`, `Notice`, `SubmitButton`, `ConfirmSubmit`, `CopyButton`; money is `Rp 1.234.567` right-aligned with tabular
  numerals, dates are WIB; minimum target 24 px; 320 px must reflow without horizontal scroll. Screenshots go under `docs/evidence/` (the rewritten baseline PNGs are noise: do not stage them).
- **Hosting (D-23):** Vultr + Coolify + Cloudflare, no Supabase; nothing is provisioned. `CLIENT_IP_HEADER` selects the single trusted client-IP header.

## History

The M2 parallel-track ownership table is archived in `docs/archive/AGENTS-m2-tracks.md`. Track reports stay in `docs/tracks/`.
