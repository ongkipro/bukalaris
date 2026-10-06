# Deploy plan — Vultr VPS + Coolify (DRAFT, not executed)

Status: **Draft only, 2026-10-06. Nothing in this document has been executed.**
No VPS, Coolify instance, database, DNS record, certificate, secret or
deployment exists. Every step needs explicit owner approval (production/live
gate). Coolify behaviour quoted below was read from the official Coolify docs
(coollabsio/coolify-docs via Context7) on 2026-10-06; re-check the current UI
labels when executing.

## Artifacts (exist and are locally verified)

| Image | Build (repo root) | Local proof |
|---|---|---|
| Web | `docker build -f apps/web/Dockerfile -t bukalaris-web .` (final stage `runner`) | 301 MB; non-root `app`; `/api/health` 200, storefront, host mode and sign-in against Postgres on the compose network (BUILD-LOG) |
| Migrate | `docker build -f apps/web/Dockerfile --target migrate -t bukalaris-migrate .` | 273 MB (node:24-alpine + `packages/db` + 27 MB prod deps); applied all migrations to a fresh database and is safe to re-run (BUILD-LOG) |

## Required environment variables

Values live only in Coolify secrets; never in the repository or image.

| Variable | Web | Migrate | Notes |
|---|---|---|---|
| `DATABASE_URL` | required | required | Postgres URL on the private network. M1 uses one role for both (DECISIONS D-4 plans separate runtime/migration roles) |
| `BETTER_AUTH_SECRET` | required | — | Generate per environment (`openssl rand -base64 32`); never reuse the `.env.example` placeholder |
| `BETTER_AUTH_URL` | required | — | Exact public origin of the admin/checkout host, e.g. `https://app.bukalaris.com`; a mismatch makes sign-in return 403 (origin check) |
| `STORE_ROOT_DOMAIN` | required | — | e.g. `bukalaris.com`; `toko-a.bukalaris.com` serves store `toko-a` |
| `MIGRATION_DATABASE_URL` | — | optional | Overrides `DATABASE_URL` for the migrator when roles are split |
| `DATABASE_POOL_MAX` | optional | — | Default 10 |
| `MEDIA_DIR` | preset | — | Image default `/data/media`; mount a persistent volume there (see "Media volume") |
| `PORT`, `HOSTNAME` | preset | — | Image defaults `3000`, `0.0.0.0` |

## Migration step (before the new web version)

Command (runs `node src/migrate.ts`, idempotent):

```bash
docker run --rm --network <coolify-private-network> -e DATABASE_URL=… bukalaris-migrate
```

Why not Coolify's "Pre-deployment command" field: per the Coolify docs it runs
in the **current (old)** application container before replacement and is
**skipped on the first deployment**, so it would run the old code's
migrations. "Post-deployment" runs in the new container only **after** the
deployment is marked complete (traffic already on the new version) and its
failure does not fail the deploy. Plan instead:

1. A second Coolify application from this repository, Dockerfile build pack,
   target stage `migrate` (Coolify supports a Dockerfile target build stage),
   no domain, same `DATABASE_URL`. Run/deploy it first; it exits after
   "migrations applied".
2. Then deploy the web application. Gate (2) on (1) succeeding.
3. Migrations follow expand/contract (15-DELIVERY-MIGRATIONS DEL-2) so the old
   web version keeps working between (1) and (2).

## Web application

- Build pack: Dockerfile, file `apps/web/Dockerfile`, build context = repo
  root, final stage (`runner`). Exposed port 3000.
- Health check: path `/api/health` (liveness, no DB call). The image also has
  a Dockerfile `HEALTHCHECK` using busybox `wget` on `127.0.0.1:3000/api/health`.
- Never run migrations from the web container on boot.

## Domains, DNS and TLS (Q-8 open; needs DNS approval)

- Admin + checkout: one hostname in M1 (single app, DECISIONS D-2), equal to
  `BETTER_AUTH_URL`.
- Storefronts: wildcard `*.<STORE_ROOT_DOMAIN>` must point to the server and be
  attached to the web application; `src/proxy.ts` maps the subdomain to a store.
  A wildcard certificate needs a DNS-01 challenge with a DNS provider API token
  in the reverse proxy — choose the DNS provider and verify the proxy setup
  before relying on it. Custom seller domains are out of M1 scope (T-15).

## Media volume (product images)

The web image stores uploads on local disk under `MEDIA_DIR` (default
`/data/media`, pre-created in the image and owned by the fixed uid/gid
`10001:10001`, user `app`). Without a volume, images vanish on every deploy.

- Coolify: add a persistent storage entry on the web application with
  destination `/data/media` (a Docker named volume). A fresh named volume copies
  the directory's ownership from the image, so no chown is needed. For a host
  directory (bind mount) run `chown 10001:10001 <host dir>` first.
- One web replica only while media is on local disk (no shared storage);
  the upgrade path is an object-store adapter behind the same media key.
- Back up the volume together with the database (`docs/RUNBOOK.md` "Backup").
- Local proof: `pnpm verify:docker` mounts a throwaway volume at `/data/media`
  and writes to it as `app`.

## PostgreSQL and backups

- Coolify-managed PostgreSQL 17, private network only, no public port.
- Scheduled backups to S3-compatible storage (vendor open). RPO/RTO and
  retention are Q-11; a restore rehearsal into a scratch database is required
  before a pilot (14-SLA-DISASTER-RECOVERY DR-1).
- Local tooling exists and was rehearsed on a dev database (`docs/RUNBOOK.md`
  "Backup" / "Restore rehearsal"): `scripts/db-backup.sh` (pg_dump custom
  format, `--no-owner --no-acl`) and `scripts/db-restore-rehearsal.sh` (restore
  into a scratch DB, per-table row-count comparison, orphan check, drop). The
  same two commands run against the Coolify Postgres container with
  `DB_CONTAINER=<container name>`; production restores need explicit approval
  and never go into a shared test environment (DR-1).

## Pre-go-live gates (not met in M1)

- Providers: real Mengantar/AutoLaris adapters with sandbox evidence (T-5, T-6).
- Q-10 checkout policy; Q-11 recovery objectives and restore rehearsal.
- Auth: recovery, invitations, MFA for operators, separate admin origin/cookie
  namespace (ADR-0004); rate-limit storage shared across instances; confirm the
  client-IP header the reverse proxy sets so the per-IP limit cannot be forged.
- RLS and separate DB roles (DECISIONS D-4).
- Log System, audit views, observability sink (T-9, T-13).

## Rollback

Redeploy the previous web image. A code rollback never reverts data; fix
forward with a new migration.
