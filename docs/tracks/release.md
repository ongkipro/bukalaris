# Track report — `release` (T-18, M2 wave 1)

Branch `m2/release`, worktree `~/Projects/bukalaris-wt/release`, 2026-10-06.
Local only: nothing deployed, pushed or executed on a remote; the CI workflow is
a file. Dev DB `bukalaris_release`, dev port 3160, e2e port 3161.

## Changed files

| File | Change |
|---|---|
| `package.json` | scripts `verify`, `verify:docker`, `db:backup`, `db:restore-rehearsal` |
| `scripts/_lib.sh` | shared helpers (compose container access, `.env` lookup without printing, `bukalaris*` name guard) |
| `scripts/verify-docker.sh` | image gate: build both targets, migrate throwaway DB, run web image, health/route/HEALTHCHECK/user/media checks, cleanup |
| `scripts/db-backup.sh` | `pg_dump -Fc --no-owner --no-acl` via the compose container → `var/backups/<db>-<UTC>.dump`, readability check with `pg_restore --list` |
| `scripts/db-restore-rehearsal.sh` | restore newest dump into a scratch DB, per-table counts vs source, migrations journal + orphan-store check, drop scratch DB |
| `.github/workflows/ci.yml` | `verify` job (Postgres 17 service, pnpm from `packageManager`, Node from `.nvmrc`, Playwright Chromium, `pnpm verify`, traces on failure) and `image` job (`docker compose up -d db --wait` + `scripts/verify-docker.sh`) |
| `apps/web/Dockerfile` | fixed uid/gid `10001` for `app` in `migrate` and `runner`; `ENV MEDIA_DIR=/data/media`; `/data/media` pre-created and owned by `app` |
| `docker-compose.yml` | `name: bukalaris` so the container is `bukalaris-db-1` / network `bukalaris_default` from any worktree |
| `.gitignore` | `var/` (backups, media) |
| `.dockerignore` | `var`, `.github`, `*.md` |
| `docs/RUNBOOK.md` | new: start/stop, verify, image smoke, media volume, backup, restore rehearsal, secret rotation, logs, pre-production checklist |
| `docs/DEPLOY-COOLIFY.md` | `MEDIA_DIR` row, "Media volume" section, backup tooling paragraph; status still "nothing executed" |

Outside the track's ownership table: nothing. `docs/evidence/m1/*.png` were
rewritten by the e2e runs and restored with `git checkout` before committing.

## Decisions / defaults

- `pnpm verify` is a plain `&&` chain (fail fast, zero new code); e2e runs
  last because it needs the build. CI calls the same script instead of
  repeating the steps, so the gate list has one owner.
- Image gate checks HTTP from inside the container with busybox `wget`, so no
  host port is published by default (`VERIFY_PORT` opt-in) and parallel
  worktrees cannot collide; DB/container/volume names carry `<epoch><pid>`.
  `--health-interval=2s` is passed at `docker run` so the gate waits seconds,
  not 30 s, while still executing the image's own `HEALTHCHECK` command.
- The throwaway DB is only migrated (the migrate image has no seed deps), so
  the DB-backed route proof is `/s/nope` → 404 (store lookup hits Postgres).
- Fixed uid/gid 10001 for `app` so bind-mount instructions can name a number;
  a named volume inherits ownership from the pre-created `/data/media`.
- Postgres client tools run inside `bukalaris-db-1` (host has no `pg_dump`),
  guaranteeing the same major version as the server; `DB_CONTAINER`/`PG_USER`
  override for other containers.
- Restore rehearsal compares every `public` table dynamically so merged tracks'
  new tables are covered without editing the script.
- Backup retention/offsite copy, and the `.github` workflow's SHA pinning, are
  left open on purpose (below).
- `.dockerignore` gained `*.md`, `.github`, `var`: none are needed in the build
  context.

## Commands and results (all exit 0 unless stated)

Environment: Node v24.18.0, pnpm 11.22.0, Docker 29.8.2, Compose v5.6.0,
Postgres 17.11 (`postgres:17-alpine`), base image `node:24-alpine` (re-pulled
during this run, digest `sha256:ebfe2f90…`).

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile --offline` | already up to date |
| `pnpm db:migrate` / `pnpm db:seed` (bukalaris_release) | migrations applied 2.5 s; seed done 2.7 s; store 2, user 4, product 4, variant 5 |
| `pnpm lint` | pass, 7.9 s |
| `pnpm typecheck` | pass, 12.3 s |
| `pnpm test` | pass (22 tests), 8.5 s |
| `pnpm build` | pass, 23.3 s |
| `pnpm e2e` | 10 passed (mobile-320 + desktop), 48.1 s |
| `pnpm verify` (whole chain) | see "Final run" below |
| `actionlint .github/workflows/ci.yml` | no findings (actionlint 1.7.12) |
| `pnpm verify:docker` | built in 159.0 s: **web 301 MB, migrate 273 MB** (unchanged vs M1); migrate image "migrations applied" + idempotent re-run; 14 public tables; `health=200 s_nope=404 login=200 healthcheck=healthy user=app media=writable`; total 173.3 s; cleanup confirmed (no `bukalaris_verify*` DB, container or volume left) |
| `docker run --rm bukalaris-web:local id` | `uid=10001(app) gid=10001(app)`; `/data/media` `drwxr-xr-x app app`; `MEDIA_DIR=/data/media` |
| `pnpm db:backup` | `var/backups/bukalaris_release-20261006T163624Z.dump`, 33,580 bytes, pg_dump 417 ms, 88 TOC entries, 14 public tables |
| `pnpm db:restore-rehearsal` | pg_restore 433 ms (first run 621 ms); 14 tables compared, all equal — account 4, audit_log 2, cart 0, cart_line 0, membership 3, order 0, order_line 0, platform_operator 1, product 4, session 0, store 2, user 4, variant 5, verification 0; migrations journal 1 row; orphan store rows 0; scratch DB dropped |

Bug found and fixed during the rehearsal: the first version streamed the
table list on stdin into a `while read` loop whose body called `docker exec
-i`, which swallowed the rest of the list (only `account` was compared). Fixed
with `mapfile` before the loop; the output now prints `tables_compared=14`.

### Final run

`pnpm verify` executed as one command after all edits: exit 0 in 110.9 s (lint, typecheck, 22 Vitest tests, build, 10 Playwright tests).

## Open issues

- CI actions are pinned to major tags (`actions/checkout@v7`, `pnpm/action-setup@v4`,
  `actions/setup-node@v7`, `actions/cache@v6`, `actions/upload-artifact@v7`).
  Full-SHA pinning is pending until the tag→SHA mapping is verified from the
  upstream releases; no SHA was invented. The workflow has never run (no
  remote); `pnpm/action-setup` reading `packageManager` and the service
  container port mapping are unexecuted assumptions to confirm on first run.
- Backups stay on the local disk under `var/backups/`; retention, encryption
  and offsite copy depend on Q-11 (RPO/RTO) and the storage vendor.
- Media on local disk means one web replica; upgrade path is an object-store
  adapter behind the same media key (content track's `lazy:` note).
- The gate scripts assume the compose container name `bukalaris-db-1`; a
  compose project started before `name: bukalaris` was added keeps its old
  name only if it was started from a differently named directory (the main
  checkout already produced `bukalaris-db-1`).
- Secret rotation is documented, not automated; there is no session table
  purge because Better Auth cookies simply fail to verify after rotation.
