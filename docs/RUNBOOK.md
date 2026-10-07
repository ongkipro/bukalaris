# Bukalaris — local operations runbook

Local development and release rehearsal on one machine. Nothing here deploys
anything; production steps live in `docs/DEPLOY-COOLIFY.md` (draft, not
executed). Commands run from the repository root unless stated. Scripts in
`scripts/` are Bash and talk to Postgres through the compose container
(`bukalaris-db-1` on network `bukalaris_default`), because the database
listens on `127.0.0.1:5442` only.

## Start / stop

```bash
docker compose up -d db --wait      # Postgres 17 (project name is fixed to "bukalaris" in docker-compose.yml)
pnpm install --frozen-lockfile
cp .env.example .env                # first time only; dev placeholders, never real secrets
scripts/db-roles.sh                 # only for a compose volume created before T-27 (roles + ownership; idempotent)
pnpm db:migrate && pnpm db:seed     # migrate as bukalaris_owner, seed through the platform role; seed is idempotent
pnpm dev                            # http://localhost:3000 (PORT in .env for worktrees)
pnpm db:seed:demo                   # optional: four fictional demo stores (docs/DEMO.md); `-- --reset` rebuilds them
pnpm --filter @bukalaris/db worker  # outbox worker (payment instruction, order e-mails, ad signals, shipment booking/tracking); `-- --once` for a single pass
pnpm --filter @bukalaris/db cleanup # one-shot: idle carts (> CART_IDLE_HOURS, default 168), old rate-limit windows, signal context > 30 days; buyer-data retention only when BUYER_DATA_RETENTION_DAYS is set (off by default, Q-11)
docker compose stop db              # keeps the volume; `down -v` wipes every local database
```

`pnpm dev` runs the web app only. Transfer orders stay `awaiting_payment`
without a reference, no e-mail lands in `/dev/outbox` and no ad signal is
delivered and no shipment is booked or tracked until the worker runs; the e2e config starts it automatically as a
second `webServer`. Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`,
`e2e`, `db:generate`, `db:migrate`, `db:seed`, `db:seed:demo`, `db:backup`,
`db:restore-rehearsal`, `verify`, `verify:docker` (`package.json`); worker and
cleanup have no root alias (`packages/db/package.json`).

Parallel git worktrees: each has its own `.env` with `bukalaris_<track>`
databases and its own dev/e2e ports (AGENTS.md "Parallel tracks"). All of them
share the one compose container.

## Database roles (T-27, ADR-0005)

The app connects as `bukalaris_app` (`DATABASE_URL`, row-level security applies),
Super Admin/worker/cleanup as `bukalaris_platform` (`PLATFORM_DATABASE_URL`,
BYPASSRLS) and the migrator as the schema owner `bukalaris_owner`
(`MIGRATION_DATABASE_URL`). Locally the passwords equal the role names
(`packages/db/docker/05-roles.sql`); a fresh compose volume creates the roles and
owner-owned databases itself, the Vitest/Playwright setups do it for their
disposable databases, and `scripts/db-roles.sh [db]` upgrades an existing dev
database (creates roles, transfers ownership of every table/sequence/function to
`bukalaris_owner`; then run `pnpm db:migrate`). A worker started without
`PLATFORM_DATABASE_URL`, or a migration without `MIGRATION_DATABASE_URL`, fails
at start with the variable's name. Symptom of a wrong role: a seller/storefront
page that renders empty lists everywhere means the request did not run in a store
context (see `packages/db/src/tenant.ts`); `permission denied for table …` means
a code path reached a table the app role has no grant on (`docs/tracks/rls.md`
has the grant table).

## Verify (release gate)

| Command | What it proves | Typical duration (2026-10-06, this machine) |
|---|---|---|
| `pnpm verify` | `lint` → `typecheck` → `test` (Vitest, `*_test` DB) → `build` → `e2e` (Playwright against the standalone build and the `*_e2e` DB); stops at the first failure | ~110 s |
| `pnpm verify:docker` | builds `bukalaris-web:local` and `bukalaris-migrate:local`, creates a throwaway `bukalaris_verify_<id>` DB owned by `bukalaris_owner`, migrates it as the owner (`MIGRATION_DATABASE_URL`), counts the `tenant_isolation` policies (≥ 26), starts the web image as `bukalaris_app` + `bukalaris_platform`, checks `/api/health` 200, `/s/nope` 404 (DB-backed route), `/login` 200, Docker `HEALTHCHECK` healthy, process user `app`, writable `MEDIA_DIR` volume; drops the DB, container and volume afterwards | ~175 s (≈160 s of it image builds; cached layers make reruns faster) |

`.github/workflows/ci.yml` runs the same two gates on GitHub (file only until a
remote exists). `VERIFY_PORT=3170 pnpm verify:docker` also publishes the
container on `127.0.0.1:3170` while the check runs; `IMAGE_TAG=<tag>` changes
the image tag.

## Image smoke test by hand

```bash
docker build -f apps/web/Dockerfile -t bukalaris-web .
docker build -f apps/web/Dockerfile --target migrate -t bukalaris-migrate .
docker run --rm --network bukalaris_default \
  -e MIGRATION_DATABASE_URL=postgres://bukalaris_owner:bukalaris_owner@db:5432/bukalaris bukalaris-migrate
docker run -d --name web-smoke --network bukalaris_default -p 127.0.0.1:3170:3000 \
  -v bukalaris-media:/data/media \
  -e DATABASE_URL=postgres://bukalaris_app:bukalaris_app@db:5432/bukalaris \
  -e PLATFORM_DATABASE_URL=postgres://bukalaris_platform:bukalaris_platform@db:5432/bukalaris \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" -e BETTER_AUTH_URL=http://localhost:3170 \
  -e STORE_ROOT_DOMAIN=localhost bukalaris-web
curl -i http://localhost:3170/api/health          # 200 {"ok":true}
docker inspect -f '{{.State.Health.Status}}' web-smoke   # healthy after ~30 s
docker rm -f web-smoke
```

Containers must join `bukalaris_default` and use host `db:5432`; `localhost:5442`
does not exist inside a container.

## Media volume

Product images are files under `MEDIA_DIR` (web image default `/data/media`,
local dev default `./var/media`, both git-ignored). The image pre-creates
`/data/media` owned by uid/gid `10001:10001` (user `app`), so:

- a Docker named volume mounted at `/data/media` works without any chown
  (Docker copies the ownership from the image on first use);
- a host directory (bind mount) needs `chown 10001:10001 <dir>` once;
- the volume is part of the backup set (`tar` the directory or snapshot the
  volume together with a database dump), and one web replica at a time.

## Backup

```bash
pnpm db:backup                       # DATABASE_URL from env or .env
scripts/db-backup.sh postgres://bukalaris:bukalaris@localhost:5442/bukalaris_e2e   # any local database
```

Writes `var/backups/<db>-<UTC timestamp>.dump` (`pg_dump -Fc --no-owner
--no-acl` inside the container) and prints size, duration and the number of TOC
entries (`pg_restore --list` proves the file is readable). `var/` is
git-ignored; copying dumps off the machine, retention and encryption are not
automated (Q-11). The script refuses database names outside `bukalaris*`.
Against another Postgres container: `DB_CONTAINER=<name> PG_USER=<user>`.

## Restore rehearsal

```bash
pnpm db:restore-rehearsal            # newest var/backups/*.dump
scripts/db-restore-rehearsal.sh var/backups/<file>.dump
```

Restores into `bukalaris_restore_<time>_<pid>`, prints per-table row counts of
the restored copy next to the live source database, checks that the Drizzle
migrations journal exists and that no store-owned row points at a missing
store, then drops the scratch database (also on failure). Exit code 1 when a
count differs or a check fails. Counts differ legitimately when the source
changed after the dump was taken. A real restore into a live database is a
separate, approved action (DR-1); this script never writes to the source.

## Rotating `BETTER_AUTH_SECRET`

The secret signs Better Auth session cookies. Rotating it signs every operator
out; nothing stored in the database depends on it (passwords are hashed
separately).

1. Generate: `openssl rand -base64 32`.
2. Local: replace the value in `.env`, restart `pnpm dev` or the container.
   Deployed: update the Coolify secret, redeploy the web application.
3. Verify: existing sessions receive 401 and a fresh sign-in works
   (`/login`). Rate limiting (3 sign-ins per 10 s per IP in production builds)
   applies while you test.

Rotate immediately if the value was ever printed, committed or pasted into a
prompt. Never write a secret into docs, memory or the repository.

## Reading logs

- Dev server: the terminal running `pnpm dev`.
- e2e: `apps/web/test-results/` (traces are retained on failure; CI uploads them
  as the `playwright-traces` artifact).
- Containers: `docker logs -f <container>`; database: `docker logs -f
  bukalaris-db-1`; health history: `docker inspect -f '{{json
  .State.Health}}' <container> | jq`.
- `/api/health` is liveness only (no DB call); `/api/ready` makes one bounded
  (2 s) database round trip and answers 503 when it fails. A database outage
  shows up as the friendly error page with a request id on data routes, as
  `ready` 503 and in the container log, not in the health check.
- Every response carries `x-request-id` (minted in `src/proxy.ts`; an inbound
  id is honoured only with `TRUST_PROXY_REQUEST_ID=1`) and the same id is in
  every JSON log line (`request_id`). `warn`/`error`/`fatal` events are also
  stored in `system_log` and readable at `/admin/logs` by an operator with the
  `logs.read` grant (filter by request id to follow one request; the seed
  grants it to `admin@bukalaris.local`). The worker and cleanup log JSON lines
  to stdout only (`event: job | poll_failed | cleanup | cleanup_failed`).

## Pre-production checklist

Cross-link: `docs/DEPLOY-COOLIFY.md` (nothing executed yet). Tick every row
with a recorded command and result before the first live deploy.

- [ ] `pnpm verify` and `pnpm verify:docker` green at the release commit.
- [ ] CI workflow executed on the remote at least once; action pins moved from
      major tags to verified full commit SHAs (`.github/workflows/ci.yml`).
- [ ] Migrate image run first against the target database, then the web
      deploy (Coolify pre-deployment hook is **not** used — it runs in the old
      container and is skipped on the first deploy).
- [ ] Persistent volume at `/data/media` on the web application; ownership
      `10001:10001` for bind mounts.
- [ ] Database backup schedule in place; `scripts/db-backup.sh` and
      `scripts/db-restore-rehearsal.sh` rehearsed against the target
      Postgres container (`DB_CONTAINER=…`) with the result recorded.
- [ ] Restore procedure re-applies buyer-data redactions: a backup taken
      before a redaction still holds the contact data, and replaying
      `order_redaction` after a restore is not automated yet (T-43,
      `docs/13-COMPLIANCE-PRIVACY.md`).
- [ ] Secrets set in Coolify only (`BETTER_AUTH_SECRET`, `ORDER_LINK_SECRET`,
      `INTEGRATION_TOKEN_KEY` fresh per environment, `BETTER_AUTH_URL` equal to
      the public origin, `STORE_ROOT_DOMAIN`; full table in
      `docs/DEPLOY-COOLIFY.md` "Required environment variables").
- [ ] Worker process deployed from the same image (`node packages/db/src/worker.ts`)
      and cleanup scheduled (`docs/DEPLOY-COOLIFY.md` "Worker and cleanup").
- [ ] Database roles created by hand with generated passwords and the database
      owned by `bukalaris_owner` (`docs/DEPLOY-COOLIFY.md` "Database roles");
      `DATABASE_URL` = app role, `PLATFORM_DATABASE_URL` = platform role,
      `MIGRATION_DATABASE_URL` = owner.
- [ ] Open product gates from `docs/DEPLOY-COOLIFY.md` "Pre-go-live gates"
      (providers, Q-10, Q-11, auth hardening, RLS, logging) have owners.
