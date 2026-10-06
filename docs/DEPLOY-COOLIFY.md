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
| `DATABASE_URL` | required | — | Postgres URL on the private network **as role `bukalaris_app`** (NOBYPASSRLS; row-level security applies to every request, ADR-0005). Never the owner or a superuser |
| `PLATFORM_DATABASE_URL` | required (web + worker) | — | Same database **as role `bukalaris_platform`** (BYPASSRLS): Super Admin, the outbox worker/cleanup and the cross-store resolvers. The worker uses only this one |
| `BETTER_AUTH_SECRET` | required | — | Generate per environment (`openssl rand -base64 32`); never reuse the `.env.example` placeholder |
| `BETTER_AUTH_URL` | required | — | Exact public origin of the admin/checkout host, e.g. `https://app.bukalaris.com`; a mismatch makes sign-in return 403 (origin check) |
| `ORDER_LINK_SECRET` | required | — | HMAC-SHA256 key for buyer order-status links in e-mails (`/o/<id>.<expiry>.<hmac>`, 30-day expiry). Generate per environment (`openssl rand -base64 32`); rotating it invalidates every link already sent. Also needed by the worker process (it renders the mails). Falls back to `BETTER_AUTH_SECRET` when unset (dev convenience) |
| `STORE_ROOT_DOMAIN` | required | — | e.g. `bukalaris.com`; `toko-a.bukalaris.com` serves store `toko-a` |
| `MIGRATION_DATABASE_URL` | — | required | Same database **as role `bukalaris_owner`** (schema owner). The migrator has no fallback to `DATABASE_URL`: the app role may not alter the schema |
| `DATABASE_POOL_MAX` | optional | — | Default 10 |
| `MEDIA_DIR` | preset | — | Image default `/data/media`; mount a persistent volume there (see "Media volume") |
| `ENABLE_HSTS` | optional | — | `1` once TLS terminates at the reverse proxy and it forwards `x-forwarded-proto: https`. Adds `Strict-Transport-Security: max-age=31536000; includeSubDomains` (no `preload`) and `upgrade-insecure-requests`; both are sent only on requests that arrived as HTTPS, so a plain-http hit can never pin a host. Unset by default |
| `TRUST_PROXY_REQUEST_ID` | optional | — | `1` only when the reverse proxy sets or overwrites `x-request-id` on every forwarded request (Traefik/Coolify do not by default — verify before enabling). With it, a well-formed inbound id (`^[A-Za-z0-9_-]{8,64}$`) is kept for log correlation; without it the app always mints its own, so a client cannot choose the id its log lines carry. Unset by default |
| `INTEGRATION_TOKEN_KEY` | required (web + worker) | — | 32 bytes, base64 (`openssl rand -base64 32`) or 64 hex chars. AES-256-GCM key sealing the per-store Meta/TikTok server tokens (T-38). Rotating it makes stored tokens unreadable: sellers re-enter them. Never reuse the `.env.example` placeholder |
| `SIGNALS_LIVE` | optional (worker) | — | `1` lets the outbox worker call Meta Conversions API / TikTok Events API for real. Unset = simulation (events recorded as `simulated`, nothing leaves the host). Enable only after the owner approves a test-event call and the provider contract is verified (docs/tracks/signals.md) |
| `PORT`, `HOSTNAME` | preset | — | Image defaults `3000`, `0.0.0.0` |

## Database roles (once per database, before the first migration)

Three roles (ADR-0005, `docs/tracks/rls.md`). `BYPASSRLS` can only be granted by a
superuser, so this is a DBA step on the Coolify Postgres (as the `postgres` user),
not a migration. Generate three passwords (`openssl rand -base64 32`), store them
in Coolify secrets only, and make the application database owned by the owner role:

```sql
CREATE ROLE bukalaris_owner LOGIN BYPASSRLS PASSWORD '<owner secret>';
CREATE ROLE bukalaris_app LOGIN NOBYPASSRLS PASSWORD '<app secret>';
CREATE ROLE bukalaris_platform LOGIN BYPASSRLS PASSWORD '<platform secret>';
ALTER DATABASE bukalaris OWNER TO bukalaris_owner;   -- or CREATE DATABASE … OWNER bukalaris_owner
```

The role names are fixed (migration `0007_rls.sql` grants to them by name and
refuses to run when they are missing). Local development uses the same statements
with placeholder passwords equal to the role names (`packages/db/docker/05-roles.sql`).

## Migration step (before the new web version)

Command (runs `node src/migrate.ts` as the schema owner, idempotent):

```bash
docker run --rm --network <coolify-private-network> -e MIGRATION_DATABASE_URL=… bukalaris-migrate
```

Why not Coolify's "Pre-deployment command" field: per the Coolify docs it runs
in the **current (old)** application container before replacement and is
**skipped on the first deployment**, so it would run the old code's
migrations. "Post-deployment" runs in the new container only **after** the
deployment is marked complete (traffic already on the new version) and its
failure does not fail the deploy. Plan instead:

1. A second Coolify application from this repository, Dockerfile build pack,
   target stage `migrate` (Coolify supports a Dockerfile target build stage),
   no domain, `MIGRATION_DATABASE_URL` only. Run/deploy it first; it exits after
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
- RLS and separate DB roles: implemented locally (ADR-0005, T-27); the production
  roles still have to be created by hand (see "Database roles").
- Log System, audit views, observability sink (T-9, T-13).

## Rollback

Redeploy the previous web image. A code rollback never reverts data; fix
forward with a new migration.
