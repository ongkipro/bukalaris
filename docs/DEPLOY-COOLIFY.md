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

Values live only in Coolify secrets; never in the repository or image. The
table is the complete list of `process.env.*` reads in `apps/web` and
`packages/db` on `main` (2026-10-07; grep `process\.env\.` and the
`env.MENGANTAR_*` reads in `packages/db/src/mengantar/adapter.ts` and
`mengantar/booking.ts`; re-checked after the wave 4 merge at `c1adf27`). Three
processes share the image: **Web** (`node server.js`), **Worker**
(`node packages/db/src/worker.ts`) and **Cleanup** (`node packages/db/src/cleanup.ts`);
**Migrate** is the separate `migrate` image stage.

Variables that only planned tasks will read are listed separately under
"Planned variables" below; they do not exist in the current build.

| Variable | Web | Worker / Cleanup | Migrate | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | required | — | — | Postgres URL on the private network **as role `bukalaris_app`** (NOBYPASSRLS; row-level security applies to every request, ADR-0005). Never the owner or a superuser |
| `PLATFORM_DATABASE_URL` | required | required | — | Same database **as role `bukalaris_platform`** (BYPASSRLS): the Owner console, the cross-store resolvers, the outbox worker and cleanup. Worker and cleanup use only this one |
| `MIGRATION_DATABASE_URL` | — | — | required | Same database **as role `bukalaris_owner`** (schema owner). The migrator has no fallback to `DATABASE_URL`: the app role may not alter the schema |
| `DATABASE_POOL_MAX` | optional | optional | — | Default 10 (per pool) |
| `BETTER_AUTH_SECRET` | required | required | — | Session cookie signing. Generate per environment (`openssl rand -base64 32`); never reuse the `.env.example` placeholder. The worker needs it only as the `ORDER_LINK_SECRET` fallback |
| `BETTER_AUTH_URL` | required | required | — | Origin of the one-host **local path mode** (plain `localhost`: `/admin`, `/seller`, `/s/<slug>` on one host) and the development fallback for every per-surface origin below. Since T-70 the web app has one Better Auth instance **per surface** (`owner`, `app`, `affiliate`, `buyer`; `apps/web/src/lib/auth.ts`), chosen from the request host, each with its own origin, derived secret and `__Host-` cookie names; with a non-local `STORE_ROOT_DOMAIN` the apex path mode is retired and this variable is no longer the sign-in origin. The worker still reads it for order and seller links only when the per-surface origins below are unset. Local-only behavior verified 2026-10-28; nothing here is deployed |
| `PLATFORM_ORIGIN`, `OWNER_ORIGIN`, `APP_ORIGIN`, `CHECKOUT_ORIGIN`, `AFFILIATE_ORIGIN`, `BUYER_ORIGIN`, `LOGS_ORIGIN` | optional locally, **required in production per active surface** | required for e-mail links | — | Exact public origin of each surface without a trailing slash (08 DOM-5 "Base origin by link type"): `OWNER_ORIGIN` Owner console links and the Owner auth origin; `APP_ORIGIN` Seller Admin, member invitations (`seller/actions.ts`), catalog feed URLs and the Seller auth origin; `CHECKOUT_ORIGIN` buyer order-status links (`/o/…`) in mails and the checkout handoff URL; `PLATFORM_ORIGIN` the apex and the local path-mode storefront base; `AFFILIATE_ORIGIN` and `BUYER_ORIGIN` the future portals' auth origins; `LOGS_ORIGIN` the Update Log (not read yet, T-69). In production a missing `OWNER_ORIGIN`, `APP_ORIGIN`, `AFFILIATE_ORIGIN` or `BUYER_ORIGIN` makes that surface's auth instance refuse to start (fail closed); the other origins fall back to `PLATFORM_ORIGIN`, then `BETTER_AUTH_URL`. Storefront URLs come from the store's own host (`storeBaseUrl`), never from these |
| `ORDER_LINK_SECRET` | required | required | — | HMAC-SHA256 key for buyer order-status links in e-mails (`/o/<id>.<expiry>.<hmac>`, 30-day expiry). Generate per environment (`openssl rand -base64 32`); rotating it invalidates every link already sent. Falls back to `BETTER_AUTH_SECRET` when unset (dev convenience). Removing that fallback in production is still open (see "Secrets in production"); T-70 did not change it |
| `STORE_ROOT_DOMAIN` | required | — | — | e.g. `bukalaris.com`; `toko-a.bukalaris.com` serves store `toko-a` (`apps/web/src/proxy.ts`). Default `localhost`. Reserved platform labels (`owner`, `app`, `checkout`, `affiliate`, `buyer`, `logs`, `www`, `api`, `mail`, `status`, `docs`, `assets`, `cdn`, `cname`, `berkah`, `bos`) are refused as store slugs and never resolve as a store; exact platform hosts are matched before the store subtree and the host × path matrix of 08 DOM-5 decides what each host serves (T-70, `packages/db/src/platform/host.ts`, golden table `packages/db/test/host.test.ts`). The CRSEC-01 blocker is closed in code; DNS, TLS and wildcard certificates for these hosts remain UNVERIFIED, and an existing store already using a reserved label must be migrated by the owner before activation (there is no automatic reassignment) |
| `INTEGRATION_TOKEN_KEY` | required | required | — | 32 bytes, base64 (`openssl rand -base64 32`) or 64 hex chars. AES-256-GCM key sealing the per-store Meta/TikTok server tokens (T-38). Today there is no key id in the sealed envelope, so rotating it makes stored tokens unreadable and sellers re-enter them; the planned key ring (T-48, "Key ring and rotation") fixes this and this key becomes entry `k1` of the `integration_tokens` ring. Never reuse the `.env.example` placeholder |
| `SIGNALS_LIVE` | optional | optional (worker) | — | `1` lets the outbox worker call Meta Conversions API / TikTok Events API for real; the web app reads it only to label delivery mode on `/seller/marketing`. Unset = simulation (events recorded as `simulated`, nothing leaves the host). Enable only after the owner approves a test-event call and the provider contract is verified (docs/tracks/signals.md) |
| `MENGANTAR_API_KEY` | optional | optional (worker) | — | When set, checkout area search and courier quotes call the real Mengantar API (read-only operations); unset = `fakeMengantar` fixture adapter. The worker's shipment booking/tracking (T-39) uses the real adapter only when this **and** `MENGANTAR_PICKUP_ADDRESS_ID` are set, else the fake booking adapter. Pass only through the secret store, never files or logs |
| `MENGANTAR_BASE_URL` | optional | optional (worker) | — | Overrides the Mengantar base URL (default in `packages/db/src/mengantar/client.ts`) |
| `MENGANTAR_WRITE_ENABLED` | never in production until approved | never until approved (worker) | — | `1` unlocks Mengantar write operations (create order, `payUnpaid`, upsert origin, …) in the client; shipment booking runs in the worker, so that is where it would take effect. Stays unset until the owner approves a write test (T-39 request/response shapes are unverified); with credentials but no flag a booking fails with a "booking disabled" message and no request is sent (`test/fulfillment.test.ts`) |
| `MENGANTAR_PICKUP_ADDRESS_ID` | — | optional (worker) | — | Platform's registered Mengantar pickup address id used for every booking (T-39). Required together with `MENGANTAR_API_KEY` for the real booking adapter; unset = fake booking adapter. Not in `.env.example` yet |
| `MENGANTAR_PICKUP_TIME_ID` | — | optional (worker) | — | Optional pickup time slot id sent with bookings. Not in `.env.example` yet |
| `ALLOW_COD_BOOKING` | never until Q-17 is decided | never until Q-17 is decided | — | `1` allows Mengantar booking of COD orders; unset = refused in the seller action and re-checked by the worker, the UI shows the Q-17 notice. Not in `.env.example` yet |
| `MEDIA_DIR` | preset | — | — | Image default `/data/media`; mount a persistent volume there (see "Media volume") |
| `ENABLE_HSTS` | optional | — | — | `1` once TLS terminates at the reverse proxy and it forwards `x-forwarded-proto: https`. Adds `Strict-Transport-Security: max-age=31536000; includeSubDomains` (no `preload`) and `upgrade-insecure-requests`; both are sent only on requests that arrived as HTTPS, so a plain-http hit can never pin a host. Unset by default |
| `TRUST_PROXY_REQUEST_ID` | optional | — | — | `1` only when the reverse proxy sets or overwrites `x-request-id` on every forwarded request (Traefik/Coolify do not by default — verify before enabling). With it, a well-formed inbound id (`^[A-Za-z0-9_-]{8,64}$`) is kept for log correlation; without it the app always mints its own, so a client cannot choose the id its log lines carry. Unset by default |
| `APP_ENV` | optional | — | — | Environment label in every log line and `system_log` row (`lib/log.ts`); default `production` when `NODE_ENV=production`, else `development` |
| `RELEASE_REVISION` (or `SOURCE_COMMIT`) | recommended | — | — | Release revision recorded on every log event for the Log System's attribution (`lib/log.ts`); set it to the deployed commit in the build/deploy configuration (either name is read; unset → `null`) |
| `WORKER_POLL_MS`, `WORKER_BATCH` | — | optional (worker) | — | Poll interval (default 2000, clamped 100–30000 ms; `pg_notify` wakes it earlier) and claim batch (default 10, 1–100) |
| `CART_IDLE_HOURS` | — | optional (cleanup) | — | Idle-cart age for `cleanup.ts` (default 168, integer ≥ 1) |
| `BUYER_DATA_RETENTION_DAYS` | — | optional (cleanup) | — | Enables the buyer-data retention step of `cleanup.ts` (T-43): redacts contact data of `completed`/`cancelled` orders not updated for this many days (integer ≥ 1; junk fails loudly). Unset = disabled; set only with the privacy owner's approved period (Q-11). Not in `.env.example` yet |
| `DEV_OUTBOX` | never in production | — | — | `1` exposes `/dev/outbox` (stored dev mail) in a production build. Leave unset |
| `NODE_ENV` | preset | preset | preset | `production` in the image; guards `seed.ts`, `local-roles.ts`, cookie `secure`, CSP dev allowances |
| `PORT`, `HOSTNAME` | preset | — | — | Image defaults `3000`, `0.0.0.0` |

Test-only variables (never set in a deployment): `TEST_DATABASE_URL`,
`E2E_DATABASE_URL`, `E2E_APP_DATABASE_URL`, `E2E_PLATFORM_DATABASE_URL`,
`E2E_OWNER_DATABASE_URL`, `E2E_PORT`, `E2E_DB`.

Secrets to generate per environment (never shared between staging and
production): three database passwords (`bukalaris_owner`, `bukalaris_app`,
`bukalaris_platform`), `BETTER_AUTH_SECRET`, `ORDER_LINK_SECRET`,
`INTEGRATION_TOKEN_KEY`, and `MENGANTAR_API_KEY` (issued by the provider).

## Planned variables (not read by the current build)

Nothing in this table exists in the current build or in `.env.example`. Each row
names the task that introduces it; that task adds the row to the table above in
the same change. Names are proposals until then. Values live only in Coolify
secrets.

| Variable | Used by | Task | Notes |
|---|---|---|---|
| `PLATFORM_ORIGIN`, `OWNER_ORIGIN`, `APP_ORIGIN`, `AFFILIATE_ORIGIN`, `BUYER_ORIGIN`, `LOGS_ORIGIN`, `CHECKOUT_ORIGIN` | Web, Worker | T-70 delivered (see the main table); `LOGS_ORIGIN` is first read by T-69 | Moved to the main table above |
| `AUTH_SECRET_OWNER`, `AUTH_SECRET_SELLER`, `AUTH_SECRET_AFFILIATE`, `AUTH_SECRET_BUYER` | Web | T-70 delivered; the affiliate and buyer sessions are exercised by T-54, T-58 | Optional per-surface session-signing secrets. When unset each surface derives its secret from `BETTER_AUTH_SECRET` by HMAC domain separation (`bukalaris-auth-surface:<surface>`), so a cookie of one surface never verifies on another; set explicit values to rotate one surface independently |
| `AFFILIATE_ROOT_DOMAIN` | Web | T-55 | Root of `<handle>.<root>`, normally `affiliate.<STORE_ROOT_DOMAIN>`; needs the `*.affiliate` certificate (see Domains) |
| `CUSTOM_DOMAIN_CNAME_TARGET` | Web | T-15 | Fallback CNAME target for custom domains (08 DOM-3 guardrail 1); the label `cname` is reserved |
| `INTERNAL_ORIGIN`, `INTERNAL_REVALIDATE_SECRET` | Web, Worker | T-69 (optional, HTTP-30) | Internal service URL of the web process, not routed publicly, and a purpose-separated secret; unused when Update Log freshness is time-based |
| `KEYRING_SHIPPING_CREDENTIALS` | Web, Worker | T-48 | Sealing ring for the API keys of the Bukalaris-provisioned `partner_managed` store accounts (ADR-0007 decision 6); see "Key ring and rotation" |
| `KEYRING_TAX_IDENTITY`, `IDENTITY_FINGERPRINT_KEY` | Web, Worker | T-65 | Sealing ring for voluntary tax identity and the distinct HMAC key for its duplicate fingerprint (ADR-0012) |
| `MENGANTAR_PARTNER_ID`, `MENGANTAR_PARTNER_SECRET`, `MENGANTAR_PARTNER_BASE_URL` | Worker only | T-48 | Partner API credentials (ADR-0007). The secret is secret-store only and is **rotated before the first call** (entry gate). The web process never holds them and never calls the partner API |
| `MENGANTAR_WEBHOOK_SECRET` | Web | T-48 (HTTP-26) | HMAC key of the platform account's webhook, separate from the API key; sandbox and production use different values and URLs |
| AutoLaris credentials and callback secret (names fixed by T-49) | Web, Worker | T-49 (HTTP-17) | Provider credentials and the HMAC key of the per-payment signed reference; provider contract UNVERIFIED, real calls only after owner approval |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `BACKUP_ENCRYPTION_RECIPIENT` | Backup job only | T-18 follow-up (DR-1) | Offsite dump upload (14). The recipient is a public key (the private key stays offline); never present in the web or worker environment |
| Mailer provider settings | Web, Worker | T-73 | Provider OPEN under Q-16 |
| Scheduler tick and catch-up settings | Worker | T-74 (JOB-21) | Names fixed by T-74 |

### Secrets in production (fail closed)

In production (`NODE_ENV=production`) the web, worker and migrate processes
refuse to start when a required secret is missing, empty, a `.env.example`
placeholder, shorter than 32 bytes of entropy or identical to the secret of
another purpose, and the error names the variable, never the value. There is no
fallback between purposes: `ORDER_LINK_SECRET` must not fall back to a session
secret, each surface has its own session secret, and the sealing rings and the
fingerprint key are distinct. Owners: T-70 for session and link secrets, T-48 and
T-65 for the rings. Test: start each process with each required variable removed
and assert a non-zero exit that names that variable.

### Key ring and rotation

Each sealing purpose (`integration_tokens`, `shipping_credentials`,
`tax_identity`) has its own ring, so rotating one cannot strand another. A ring is
a comma-separated list of `<key_id>:<base64 of 32 bytes>`; the first entry is the
current key. Every sealed envelope stores the `key_id` beside the ciphertext;
decryption selects the key by that id, and an unknown id fails closed (the
credential is unusable, never guessed). Legacy Meta and TikTok envelopes without
an id are read as `k1`, the current `INTEGRATION_TOKEN_KEY`. Rotation:

1. Generate a key, prepend it with a new id and deploy web and worker; new seals
   use it, old envelopes still open.
2. The re-seal job (JOB-23) rewrites every envelope under the current id.
3. Verify that no envelope carries the old id.
4. Remove the old entry from the ring, but keep the old key in the offline backup
   until every retained database backup (14 days on-box, 30 days offsite) that
   holds envelopes under it has expired, because restoring such a backup needs it.

Losing a key without a backup makes its envelopes unreadable: sellers re-enter
their Mengantar and Meta/TikTok credentials. The offline key backup and its
rehearsal are in 14-SLA-DISASTER-RECOVERY.

### Partner calls: egress IP and budget

- Production Partner API calls are accepted only from an allow-listed source IP
  (ADR-0007). Production egress IP: **not recorded; no VPS exists.** When the VPS
  is provisioned, record the public IPv4 here (an address is not a secret) and in
  the DR runbook (14, "Host replaced"), and have Mengantar allow it before the
  first call. A replacement host changes the IP.
- Partner calls are made by the worker only. A seller-connect action enqueues a
  job instead of calling the API from the web process, because an in-process
  serializer cannot enforce a budget shared by two processes or by replicas. A DB
  token bucket keyed `partner:mengantar` (a `rate_limit`-style row shared by every
  process) enforces the shared budget (60 requests per minute, ADR-0007,
  UNVERIFIED) and a job that cannot get budget reschedules itself with
  `next_attempt_at` instead of waiting out the 60 s lease.

## Worker and cleanup (not yet planned in Coolify)

The outbox worker is a long-running second process of the same image
(`packages/db/src/worker.ts`, T-32): one Coolify application or service from
the same Dockerfile with the command overridden to
`node packages/db/src/worker.ts`, no domain, exactly one replica (claims use
`FOR UPDATE SKIP LOCKED`, so more replicas are safe but unnecessary), env
`PLATFORM_DATABASE_URL`, the per-surface origins (`OWNER_ORIGIN`, `APP_ORIGIN`, `CHECKOUT_ORIGIN`; `BETTER_AUTH_URL` only as the local fallback), `ORDER_LINK_SECRET`,
`INTEGRATION_TOKEN_KEY`, optional `SIGNALS_LIVE`, `WORKER_POLL_MS`,
`WORKER_BATCH`, and for shipment booking/tracking (T-39) `MENGANTAR_API_KEY`,
`MENGANTAR_PICKUP_ADDRESS_ID`, optional `MENGANTAR_PICKUP_TIME_ID` (writes stay
locked without `MENGANTAR_WRITE_ENABLED=1`; COD needs `ALLOW_COD_BOOKING=1`). It logs JSON lines, stops gracefully on SIGTERM and retries
while the database is unreachable. Without it, transfer orders never receive a
payment instruction, no order e-mail is sent and no ad signal is delivered, and no shipment is booked or tracked.

Cleanup (`node packages/db/src/cleanup.ts`, T-30/T-38) runs once and exits:
schedule it (Coolify scheduled task or cron, e.g. daily) with
`PLATFORM_DATABASE_URL` and optional `CART_IDLE_HOURS`; the buyer-data
retention step runs only when `BUYER_DATA_RETENTION_DAYS` is set. The worker and
cleanup command paths do not move when T-51 reorganises `packages/db/src`
(ADR-0008 keeps `worker.ts` and `cleanup.ts` as root entry points). The outbox has
no scheduler of its own today: periodic jobs (JOB-09, JOB-11 to JOB-14, JOB-19)
exist only once the periodic enqueuer JOB-21 (T-74) runs inside the worker with
a liveness heartbeat; until then no such job runs. Cleanup stays a scheduled
one-shot and records its last success in the same heartbeat so a missed run is
visible. Neither process is part of `verify:docker` yet.

## Database roles (once per database, before the first migration)

Five roles (ADR-0005 and its 2026-10-28 amendment, `docs/tracks/rls.md`, `docs/tracks/t59-rls.md`). `BYPASSRLS`
can only be granted by a superuser, so this is a DBA step on the Coolify Postgres (as the `postgres` user), not a
migration. Generate three passwords (`openssl rand -base64 32`), store them in Coolify secrets only, and make the
application database owned by the owner role. Only three roles can log in; the two `NOLOGIN` roles own database
objects and never hold a connection:

```sql
CREATE ROLE bukalaris_owner LOGIN BYPASSRLS PASSWORD '<owner secret>';
CREATE ROLE bukalaris_app LOGIN NOBYPASSRLS PASSWORD '<app secret>';
CREATE ROLE bukalaris_platform LOGIN BYPASSRLS PASSWORD '<platform secret>';
CREATE ROLE bukalaris_restricted NOLOGIN NOBYPASSRLS;   -- owns restricted tables; reached only through definer functions
CREATE ROLE bukalaris_resolver NOLOGIN BYPASSRLS;       -- owns the narrow cross-store resolver functions (SELECT only)
GRANT bukalaris_restricted TO bukalaris_owner;          -- the migrator must be able to create objects owned by them
GRANT bukalaris_resolver TO bukalaris_owner;
ALTER DATABASE bukalaris OWNER TO bukalaris_owner;      -- or CREATE DATABASE … OWNER bukalaris_owner
```

`bukalaris_restricted` MUST stay `NOBYPASSRLS`: only the resolver reads across stores. Migration 0011 refuses to run
when the roles are missing, when the owner is not a member of both, or when `bukalaris_restricted` bypasses RLS. The
role names are fixed (migrations grant to them by name). Local development uses the same statements with
placeholder passwords equal to the role names (`packages/db/docker/05-roles.sql`).

Public host and store lookups run on the app pool through the resolver functions, so `PLATFORM_DATABASE_URL`
serves only the Owner console and the worker. Because restricted tables and the definer functions are owned by the
no-login roles, every backup and restore keeps owners and ACLs (14 restore rules); `scripts/db-restore-rehearsal.sh`
and `pnpm verify:docker` compare the result with the isolation registry. Migration 0011 is the **expand** step: it
leaves the platform login's old table-wide grants in place so the previous web version keeps working during a rolling
deploy. The **contract** step (`packages/db/drizzle-pending/t59-contract.sql`) is NOT part of the migrations and
needs the owner's approval (D-22 item 4, TASKS T-59). A `REVOKE` that the previous web version still needs is always
a contract migration that runs after the new version is serving (15 DEL-2).

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
   web version keeps working between (1) and (2); grant `REVOKE`s are contract
   migrations applied after the new web version serves traffic.

## Web application

- Build pack: Dockerfile, file `apps/web/Dockerfile`, build context = repo
  root, final stage (`runner`). Exposed port 3000.
- Health check: path `/api/health` (liveness, no DB call). The image also has
  a Dockerfile `HEALTHCHECK` using busybox `wget` on `127.0.0.1:3000/api/health`.
- Zero-downtime swap (adopted from Etalashop ADR 0017): keep consistent
  container naming and configure `start_interval: 2s` on the container
  healthcheck so Traefik cuts traffic over as soon as the new container answers
  `/api/health` (reducing the swap window to ~7–8 s), while `migrate` runs as a
  separate pre-deploy step rather than blocking routed app startup.
- Never run migrations from the web container on boot.

## Domains, DNS and TLS (Q-8 open; needs DNS approval)

- Target host map (ADR-0008, Accepted 2026-10-28 as a decision; implemented locally only by T-51 and T-70, nothing deployed): `owner.bukalaris.com` Owner console
  (formerly Super Admin / Bos; the interim `berkah` and `bos` labels were never deployed), `app.bukalaris.com` Seller Admin,
  `affiliate.bukalaris.com` Affiliate portal, `buyer.bukalaris.com` Buyer portal,
  `logs.bukalaris.com` public product Update Log (ADR-0008; not the internal Log System),
  `<slug>.bukalaris.com` storefronts, plus the platform checkout origin. Reserved platform
  labels (never claimable as store slugs or affiliate handles): `owner` (active), `berkah` and `bos` (retired, reserved-unused),
  `app`, `affiliate`, `buyer`, `logs`, `checkout`, `cname` and the infrastructure labels. DNS records,
  certificates, reserved labels and per-host cookie isolation are UNVERIFIED and need DNS
  approval (Q-8); the CRSEC-01 blocker is closed in code by T-70 (reserved labels and exact-host
  dispatch), but the hosts themselves stay UNVERIFIED until DNS and TLS exist.
- Admin + checkout: one auth host per surface since T-70 (Owner `OWNER_ORIGIN`, Seller `APP_ORIGIN`, checkout `CHECKOUT_ORIGIN`); apex path mode (`/admin`, `/seller`, `/s/<store>`, `/checkout`) answers 404 whenever `STORE_ROOT_DOMAIN` is not a local domain.
- Storefronts: wildcard `*.<STORE_ROOT_DOMAIN>` must point to the server and be
  attached to the web application; `src/proxy.ts` maps the subdomain to a store.
  A wildcard certificate needs a DNS-01 challenge with a DNS provider API token
  in the reverse proxy — choose the DNS provider and verify the proxy setup
  before relying on it. Custom seller domains are out of M1 scope (T-15).
- Affiliate storefronts (T-55): `*.<STORE_ROOT_DOMAIN>` is one label deep and
  does **not** cover `<handle>.affiliate.<root>` (two labels). Plan a separate
  certificate for `*.affiliate.<root>` issued by DNS-01 (same DNS-provider token
  requirement), a DNS wildcard record `*.affiliate`, and a Traefik router for one
  label under `affiliate.<root>` (`HostRegexp`; the syntax differs between
  Traefik major versions, verify the one Coolify runs) attached to the web
  application and ordered after the exact `affiliate.<root>` router. T-55 does not
  ship until a probe host `probe.affiliate.<root>` serves a browser-trusted
  certificate and the AffStore column of 08 DOM-5 holds. UNVERIFIED: whether the
  chosen DNS provider and Coolify's certificate resolver can issue a second
  wildcard.
- Exact platform hosts (`owner`, `app`, `checkout`, `affiliate`, `buyer`, `logs`
  and the apex) have their own Traefik routers, which take precedence over the
  storefront wildcard router; their certificates may come from the one-label
  wildcard. `www` redirects to the apex.
- Client IP topology (**OPEN, chosen before the first launch**): the per-IP
  limits (16-OBSERVABILITY-RATE-LIMITING) trust exactly one client-IP header,
  decided by the topology. Direct to Traefik: the last hop of `x-forwarded-for`
  set by Traefik. Behind Cloudflare: `CF-Connecting-IP`, only when the origin
  accepts connections from Cloudflare ranges alone (otherwise the header is
  forgeable and per-IP limits collapse onto edge IPs). Record here the chosen
  topology and the trusted-proxy list (CIDRs): **not chosen, no list recorded.**

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
- Scheduled backups to S3-compatible storage (vendor open). Startup baseline decided
  by D-19: 99.5 % availability target, hourly encrypted `pg_dump` (RPO 1 hour), RTO
  4 hours proven by a restore rehearsal; these are internal targets, no SLA is
  promised to sellers unless the owner publishes one. Retention durations remain
  Q-11. A restore rehearsal into a scratch database is required before a pilot
  (14-SLA-DISASTER-RECOVERY DR-1).
- Local tooling exists and was rehearsed on a dev database (`docs/RUNBOOK.md`
  "Backup" / "Restore rehearsal"): `scripts/db-backup.sh` (pg_dump custom
  format; **owners and ACLs are kept on purpose**, because the role grants are
  part of tenant isolation and a dump without them restores a database the app
  role cannot read) and `scripts/db-restore-rehearsal.sh` (restore into a scratch
  DB, per-table row-count comparison, orphan check, RLS check, drop). Never add
  `--no-owner` or `--no-acl`. The same two commands run against the Coolify
  Postgres container with `DB_CONTAINER=<container name>`; production restores
  need explicit approval and never go into a shared test environment (DR-1).
  The restore rules (grants per role, erasure replay, payout freeze and
  reconciliation) are in 14-SLA-DISASTER-RECOVERY, and the roles must exist on
  the target cluster before a restore (see "Database roles"). Offsite copies are
  encrypted before upload (decided, D8 / D-19); the R2 variables are in
  "Planned variables".

## Pre-go-live gates (status 2026-10-07)

- Providers: Mengantar reads verified against the real API (sanitized evidence
  in `docs/tracks/shipping.md`); Mengantar writes locked until the owner approves
  a write test (T-39); AutoLaris still the fake adapter (T-5, T-6). Q-17 COD
  remittance blocks the first real COD shipment.
- Q-10 checkout policy defaults taken (DECISIONS D-5, T-35); recovery objectives
  decided by D-19 (RPO 1 h, RTO 4 h, to be proven by rehearsal; retention durations
  still Q-11); restore rehearsal exists locally (`scripts/db-restore-rehearsal.sh`)
  and must be repeated against the target Postgres.
- Auth: recovery, invitations and operator TOTP are implemented (T-22). Per-surface
  origins, secrets and `__Host-` cookies (T-70; ADR-0004, D-2) are implemented locally and
  uncommitted, not deployed, and still need production origins and DNS/TLS; Better Auth's
  rate-limit storage is in memory per process (one web replica, or configure
  `secondaryStorage`); confirm the client-IP header the reverse proxy sets so
  the per-IP checkout limits (`x-forwarded-for` last hop / `x-real-ip`) cannot be forged.
- RLS and separate DB roles: implemented (ADR-0005, T-27); the production roles
  still have to be created by hand (see "Database roles").
- Log System and audit are implemented (T-23); an external log sink/alerting
  and retention are not (16-OBSERVABILITY "Implemented").
- Worker and cleanup processes are not in this plan's Coolify setup yet (see
  "Worker and cleanup"); without the worker no payment instruction, e-mail or
  ad signal leaves the outbox.
- E-mail: only the dev outbox exists (`mail_outbox`); a provider with
  SPF/DKIM/DMARC is required before notifications reach buyers (T-36 open).
- Mengantar Partner Secret: it was pasted into a chat on 2026-10-27 (ADR-0007).
  Ask Mengantar to replace it and store only the new value in the secret store
  **before the first partner call, sandbox included** (entry gate of T-48).
  Record the rotation date here when done (never the value): not yet done.
- Secrets: fail-closed startup, purpose-separated keys and the key ring
  (T-70, T-48) are in place, and the offline key backup has been rehearsed,
  before the first sealed seller credential is stored in production.
- Scheduler: the JOB-21 enqueuer runs in the worker and its heartbeat alert is
  active before the first subscription billing period.
- Restore: the restore rules of 14 (grants per role, erasure replay, payout
  freeze) have been rehearsed on the target Postgres once T-59 has landed.
- Hosts: T-70 evidence exists before any second host is routed, and the
  `*.affiliate` certificate exists before T-55; the production egress IP is
  recorded and allow-listed before the first partner call.

## Rollback

Redeploy the previous web image. A code rollback never reverts data; fix
forward with a new migration. Contract migrations (grant `REVOKE`s, drops) only
run after the new version is serving, so they are never undone by redeploying
the old image.
