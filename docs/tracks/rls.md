# Track report — `rls` (M2 wave 3: T-27 database-enforced tenant isolation, ADR-0005)

Branch `m2/rls`, worktree `~/Projects/bukalaris-wt/rls`, dev database `bukalaris_rls`
(ports 3260 dev / 3261 e2e). Local only: no deploy, no remote database, no secrets. Every
role password in this track is a documented local placeholder (equal to the role name).

Outcome: the web app runs as the non-owner role `bukalaris_app` with `FORCE ROW LEVEL
SECURITY` and a `tenant_isolation` policy on all 26 store-owned tables; every store-scoped
operation runs inside a transaction that sets `app.store_id`; migrations run as the schema
owner; the whole Vitest suite (129 pre-existing tests + 8 new) and the whole Playwright suite
pass with the app pool as `bukalaris_app` and the platform pool as `bukalaris_platform`.

## Roles and grants

| Role | Attributes | Used by | Password source |
|---|---|---|---|
| `bukalaris_owner` | LOGIN, BYPASSRLS, owns every schema object and the database | `MIGRATION_DATABASE_URL` → `packages/db/src/migrate.ts` (no fallback to `DATABASE_URL`) | local placeholder `bukalaris_owner`; production secret |
| `bukalaris_app` | LOGIN, NOBYPASSRLS, owns nothing, per-table grants below | `DATABASE_URL` → `db()` (web request pool, Better Auth adapter) | local placeholder `bukalaris_app`; production secret |
| `bukalaris_platform` | LOGIN, BYPASSRLS, SELECT/INSERT/UPDATE/DELETE on every table (+ default privileges for future ones) | `PLATFORM_DATABASE_URL` → `platformDb()`: OperatorScope, worker, cleanup, seed, cross-store resolvers | local placeholder `bukalaris_platform`; production secret |

Where roles are created (decision): **not in a migration**. `BYPASSRLS` can only be granted by
a superuser and the migrator is deliberately not one, so roles are a bootstrap step:
`packages/db/docker/05-roles.sql` (idempotent `DO` block) runs from the compose init on a fresh
volume, from the Vitest/Playwright global setups (`prepareLocalDatabase`, so an existing
volume gets them too), from `scripts/verify-docker.sh` and from `scripts/db-roles.sh`
(existing dev database: roles + ownership transfer of every table/sequence/function to
`bukalaris_owner`). Production: a DBA runs the three `CREATE ROLE` statements with generated
passwords (docs/DEPLOY-COOLIFY.md "Database roles"). Migration `0007_rls.sql` checks that the
roles exist and raises a readable exception otherwise.

`bukalaris_owner` has BYPASSRLS on purpose: migrations with data backfills (like
`0003_catalog_guards.sql`) must see every row; with `FORCE ROW LEVEL SECURITY` the plain owner
would silently update zero rows. FORCE stays on every table anyway as defence if the attribute
is ever removed.

Per-table privileges of `bukalaris_app` (the migration and `rls.test.ts` "holds exactly" test
encode the same table):

| Table | app | Why |
|---|---|---|
| `user`, `session`, `account`, `verification`, `two_factor` | SIUD | Better Auth adapter on the app pool |
| `store` | S, U | settings/theme (owner), storefront shell; create/suspend are operator-only |
| `membership` | SIUD | list/change members, accept invitation |
| `store_invitation` | S, I, U | create/revoke/accept (accept = UPDATE) |
| `product`, `variant`, `collection`, `page`, `store_pickup_area` | S, I, U | no deletes in the service layer |
| `product_slug_alias`, `collection_product` | S, I, D | aliases re-claimed / membership replaced by delete+insert |
| `media` | SIUD | image rows are deleted |
| `catalog_audit` | S, I | append-only history, read by the seller |
| `cart` | S, I | deletion only by cleanup (platform) |
| `cart_line` | SIUD | |
| `order` | S, I, U | status transitions; never deleted |
| `order_line`, `order_status_history`, `stock_adjustment` | S, I | append-only |
| `storefront_channel`, `checkout_handoff` | S, I, U | revoke / consume are UPDATEs |
| `job` | S, I | enqueue inside store transactions (`RETURNING id`); claim/complete is the worker |
| `signal_destination` | S, I, U | seller settings |
| `signal_event`, `order_signal_context` | S, I | enqueued by the app, delivered/purged by worker/cleanup |
| `audit_log` | I | append-only for the app; operators read via platform |
| `rate_limit` | S, I, U | T-30 counters (no store) |
| `shipping_margin_rule` | S | checkout quote reads the platform rule |
| `mail_outbox` | S, I | dev Mailer + dev outbox viewer |
| `system_log` | I + SELECT(`id`) | log sink; `RETURNING id` only |
| `platform_operator`, `operator_grant`, `order_notification` | — | operator / worker paths only (fail closed) |

No default table privileges for `bukalaris_app` (deliberate deviation from "future tables
covered by default privileges"): a new table is unreachable by the app until its migration
grants access and, when it has `store_id`, enables RLS. `rls.test.ts` fails on any table that
has `store_id` without forced RLS + policy, on any table missing from the store-less decision
list, and on any grant drift. Sequences (identity columns, `catalog_id_seq`) are granted
USAGE/SELECT to both roles now and by default for future ones.

## Table-by-table policy decisions

Policy for every table below except `store`: `USING (store_id = app_store_id()) WITH CHECK
(store_id = app_store_id())`, `ENABLE` + `FORCE ROW LEVEL SECURITY`.
`app_store_id()` = `nullif(current_setting('app.store_id', true), '')::bigint` (STABLE SQL
function; `nullif` because a custom setting reads back as `''`, not NULL, once a session has
set it in an earlier transaction — verified on Postgres 17).

| Table | RLS | Decision |
|---|---|---|
| `store` | yes, `id = app_store_id()` | tenant root (TEN-6): a store is visible only inside its own context |
| `membership`, `product`, `variant`, `product_slug_alias`, `catalog_audit`, `cart`, `cart_line`, `order`, `order_line`, `order_status_history`, `stock_adjustment`, `store_invitation`, `collection`, `collection_product`, `page`, `media`, `storefront_channel`, `checkout_handoff`, `store_pickup_area`, `order_notification`, `signal_destination`, `signal_event`, `order_signal_context` | yes | store-owned rows |
| `job` | yes | has `store_id`; the app only enqueues inside store transactions, the worker (platform, BYPASSRLS) claims across stores. ADR-0005 listed it as "stays without RLS"; the rule "every table with `store_id`" wins because nothing on the app pool needs cross-store job access |
| `audit_log` | yes (nullable `store_id`) | seller actions insert with the context store; operator rows (`store_id` NULL, e.g. `logs.list`, `password.reset`, margin edits) are written and read only through the platform pool. The app pool can never read audit rows |
| `system_log` | **no** | diagnostics with an untrusted-context `store_id` and no FK; written by the server boundary without a store (`recordLogEvent`), read only by operators. App has INSERT only |
| `user`, `session`, `account`, `verification`, `two_factor` | no | Better Auth, no store. Joined by seller queries for names/e-mails (members, history); user rows are not tenant data but are readable by the app role |
| `platform_operator`, `operator_grant` | no | platform-only; app has no privilege, so `operatorScope(db(), …)` on the app pool fails instead of returning null |
| `rate_limit` | no | abuse counters keyed by IP/cart/phone, no store |
| `mail_outbox` | no | dev-only mailer sink |
| `shipping_margin_rule` | no | one platform-wide row, read by checkout |
| `catalog_id_seq` | n/a | USAGE for both roles (product/variant inserts take `nextval`) |

## Code: pools and context

- `packages/db/src/client.ts`: `db()` (app) and `platformDb()` (platform), both lazy; `createDb(url, name)` names the missing variable.
- `packages/db/src/tenant.ts`: `withStore(exec, storeId, fn)` opens a transaction on `exec`, runs `select set_config('app.store_id', $1, true)` and remembers the transaction in a `WeakMap`; a nested call for the same store reuses it (no savepoint, no second `set_config`), a nested call for a *different* store throws (`set_config(…, true)` cannot be narrowed back on savepoint release). `inStore(scope, fn)` passes `fn` a copy of the scope whose `exec` is that transaction, so service bodies kept their shape.
- `packages/db/src/scoped.ts`: `sellerContext` and `storefrontScope` resolve through `platformDb()` (which stores is this user a member of / which store has this slug — cross-store by definition) and return scopes bound to the caller's executor; `operatorScope(exec, …)` requires the platform pool. Signatures unchanged.
- Every service function that takes a `SellerScope`/`StorefrontScope` wraps its store-owned statements in `inStore`. Functions that already opened `scope.exec.transaction(…)` now open `inStore(scope, ({ exec: tx }) => …)` — same transaction, context set first.
- `apps/web`: `lib/context.ts` gives `operatorScope` the platform pool and exports `isOperator()`; `lib/auth.ts` writes the account-level `password.reset` audit row through the platform pool. Nothing else in `apps/web` references `platformDb` (test-enforced).

### Pool usage map

| Function | Pool | Why |
|---|---|---|
| `sellerContext`, `storefrontScope` (lookup only) | platform | resolver: user → stores, slug → store; returns the resolved store only |
| `operatorScope`, every `OperatorScope` function (`platform.ts`, `ops.ts`, `content.ts` store detail/create, `shipping.ts` margin rule) | platform (`op.exec`) | Super Admin reads across stores (ADR §1) |
| `checkout.cartStore(cartId)` | platform | resolver: cart → store id (checked-out carts included) |
| `checkout.checkoutSummary`, `placeOrder`, `getBuyerOrder`, `channels.channelReturnTarget` | app, in the cart's store context | hosted checkout has no scope; store comes from the cart |
| `channels.authenticateChannel` | platform for `token_prefix → (store_id, token_hash)`; then app in context | token → store; constant-time compare unchanged |
| `channels.exchangeHandoff` | platform for `code_hash → store_id`; then app in context | the one-use consume, channel and cart checks run atomically in context |
| `accounts.invitationStore` (`previewInvitation`, `acceptInvitation`) | platform for `token_hash → store_id`; then app in context | the `FOR UPDATE` on the invitation stays in the same transaction as the membership insert |
| `notify.getOrderForLink` | platform for `order id → store_id`; then app in context | signed buyer link |
| `membership.changeMember` orphan check (`revokeSessionsIfOrphaned`) | platform, **after commit** | needs every store's memberships; a store context hides them. lazy: not atomic with the removal; a crash in between leaves sessions that every request denies anyway (membership is checked per request) |
| `jobs.runOnce/claimBatch/completeJob/failJob`, all job handlers, `worker.ts` | platform | the worker claims across stores and uses only `PLATFORM_DATABASE_URL` |
| `cleanup.ts` (`cleanupIdleCarts`, `purgeSignalContext`) | platform | maintenance across stores |
| `seed.ts` | platform | creates stores/operators; store-scoped writes still go through scopes (context set anyway) |
| `signals.browserSignals(exec, storeId)` | app, `withStore(storeId)` | storeId is server-derived (scope or the buyer's own order) |
| `checkout.hit/enforceLimits/limitCartMutation`, `ops.recordLogEvent`, `shipping.getMarginRule`, `accounts.dbMailer/listOutbox/countLiveSessions` | app, no context | store-less tables |
| Better Auth adapter | app | auth tables have no store |

## Local, test, e2e and Docker wiring

- `docker-compose.yml` mounts `05-roles.sql` then `10-dbs.sql` (databases created `OWNER bukalaris_owner`, dev db re-owned).
- `packages/db/src/local-roles.ts` (dev/test only, throws in production): `localRoleUrl(adminUrl, role)` derives the owner/app/platform URL of the same database (local placeholder convention), `prepareLocalDatabase` (roles, database, ownership), `wipeLocalDatabase` (new public schema owned by the owner).
- Vitest `global-setup.ts`: prepare → wipe → migrate as owner. `helpers.ts`: `db` = app role (every service), `platform` = platform role (fixtures, raw inspection, worker calls, operators), `admin` = superuser (truncation only). Existing test files only changed where they inspected or seeded raw rows (`db.select/insert/…` → `platform.…`) or ran the worker.
- Playwright: `global-setup.ts` prepares the e2e database, migrates as owner, seeds via platform; `playwright.config.ts` starts the web server with `DATABASE_URL` = app role + `PLATFORM_DATABASE_URL`, the worker with `PLATFORM_DATABASE_URL` only.
- `scripts/verify-docker.sh`: roles, throwaway database owned by the owner, migrate image with `MIGRATION_DATABASE_URL`, web image with app + platform URLs, asserts ≥ 26 `tenant_isolation` policies.
- `scripts/db-roles.sh [db]`: existing dev database upgrade (roles, `ALTER DATABASE OWNER`, `ALTER TABLE/SEQUENCE/FUNCTION … OWNER TO bukalaris_owner`; `REASSIGN OWNED BY` is refused for the bootstrap superuser, verified).
- `.env.example`: `DATABASE_URL` is now the app role (one changed line — flagged below), `PLATFORM_DATABASE_URL` and `MIGRATION_DATABASE_URL` appended; `TEST_DATABASE_URL`/`E2E_DATABASE_URL` stay superuser URLs the setups derive from.
- Docs: `docs/DEPLOY-COOLIFY.md` (three variables, "Database roles" DBA step, migrate command), `docs/RUNBOOK.md` (roles section, start sequence, smoke test, checklist), `apps/web/Dockerfile` (one comment line).

## Performance note

Every store-scoped operation now costs one transaction: `BEGIN` + `select set_config(…)` before
the first statement and `COMMIT` after the last — two extra round trips for operations that
were already transactional, three for what used to be a single statement (all on the same
pooled connection, no extra lock). Cross-store entry points add one platform-pool lookup
(cart, token, code, order id, membership, slug) before the context transaction. The policy
predicate is `store_id = <STABLE function>`, evaluated once per statement, so existing
`(store_id, …)` indexes are used unchanged. Not measured against a baseline here (local only).

## Commands and results

All from the worktree root on 2026-10-07 (local machine, compose Postgres 17; database
names `bukalaris_rls*`; the test/e2e setups create roles and databases themselves).

| Command | Result |
|---|---|
| `pnpm lint` | 0 errors, 0 warnings (apps/web eslint) |
| `pnpm typecheck` | 0 errors (`@bukalaris/db` tsc; `@bukalaris/web` next typegen + tsc) |
| `pnpm test` | Vitest **15 files, 137 passed** (129 pre-existing + 8 in `rls.test.ts`), ~40 s; app pool = `bukalaris_app`, platform pool = `bukalaris_platform`, migrations as `bukalaris_owner` |
| `pnpm build` | Next.js production build, compiled successfully, 33 static pages |
| `pnpm e2e` | Playwright **72 passed, 2 skipped** (7.3 min); web server `DATABASE_URL` = app role + `PLATFORM_DATABASE_URL`, worker `PLATFORM_DATABASE_URL` only. Evidence PNGs re-rendered and restored with `git checkout -- docs/evidence` before committing. Two `poll_failed` lines from the worker at start-up are the pre-existing race with the global setup (database being created/migrated); it retries |
| `pnpm verify:docker` | `health=200 s_nope=404 login=200 healthcheck=healthy user=app media=writable policies=26 total_ms=77448`; images web 308 MB / migrate 274 MB; 37 public tables, 26 `tenant_isolation` policies; throwaway db created `OWNER bukalaris_owner`, migrated via `MIGRATION_DATABASE_URL`, web run as app + platform roles |
| `scripts/db-roles.sh bukalaris_rls` then `MIGRATION_DATABASE_URL=… pnpm --filter @bukalaris/db migrate` | existing dev database upgraded: "roles present, database and all public/drizzle objects owned by bukalaris_owner", `migrations applied`; psql: 26 policies, 37/37 tables owned by `bukalaris_owner` |

`rls.test.ts` (8 tests): every table with `store_id` (+ `store`) has ENABLE + FORCE RLS and
the policy and every other table is in the store-less list; `bukalaris_app` holds exactly the
grants of the table above (pg_catalog `relacl`/`attacl`); role attributes (app NOBYPASSRLS,
owner/platform BYPASSRLS, none superuser); app without context reads 0 rows (or is denied)
on all 26 store-owned tables while the platform pool sees the populated ones; in A's context
only A is visible and an insert/update with B's `store_id` fails with 42501 while a foreign
row simply is not there; the context is transaction-local on the same connection and
switching stores inside a transaction throws; app cannot read operator tables; `platformDb`
appears in `apps/web/src` only in `lib/context.ts` and `lib/auth.ts`.

## Deviations and shared edits (for the orchestrator)

- `.env.example`: besides the appended variables, the existing `DATABASE_URL` line now uses
  `bukalaris_app` (the point of the task is that the app runs as that role; with the
  superuser URL RLS would be bypassed in local dev and nobody would notice).
- The worktree `.env` is protected by a deny rule in this environment, so it was **not**
  edited: the two appended lines of `.env.example` (`PLATFORM_DATABASE_URL`,
  `MIGRATION_DATABASE_URL` for `bukalaris_rls`) and the `DATABASE_URL` role change still have
  to be applied by hand before `pnpm dev` on this worktree. Gates did not need them (test/e2e
  setups derive role URLs; `db-roles.sh` + migrate were run with the variable on the command line).
- Shared files touched minimally: `apps/web/Dockerfile` (comment), `docker-compose.yml`
  (init mounts), `scripts/verify-docker.sh`, `docs/DEPLOY-COOLIFY.md`, `docs/RUNBOOK.md`
  (allowed by the track row), `packages/db/src/{worker,cleanup,seed,migrate}.ts` (pool choice),
  every test file (platform pool for fixtures), `apps/web/src/lib/{context,auth}.ts`,
  `apps/web/src/app/account/security/page.tsx`, `apps/web/e2e/global-setup.ts`,
  `apps/web/playwright.config.ts`. `.github/workflows/ci.yml` needs no change: both global
  setups create the roles on the service container themselves.
- `job` has RLS although ADR-0005 §2 listed it among the exceptions (reason in the table above).
- Default privileges for `bukalaris_app` were deliberately not granted (fail closed + test).

## Open issues

- Production roles/passwords and `ALTER DATABASE … OWNER` are a manual DBA step; nothing is
  deployed (DEPLOY-COOLIFY stays a draft).
- `changeMember`'s session revocation is post-commit (see pool map). Upgrade path if atomicity is
  ever required: a `SECURITY DEFINER` function owned by `bukalaris_owner`.
- `scripts/db-backup.sh` / `db-restore-rehearsal.sh` still use the compose superuser; a restore
  into a database owned by `bukalaris_owner` with `--no-owner --no-acl` recreates policies but not
  the grants — rerun migration 0007's GRANT block (or re-migrate) after a real restore. Not
  rehearsed in this track.
- Latency of the extra round trips is unmeasured; measure on the first deployed environment.
