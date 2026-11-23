# Bukalaris — local operations runbook

Local development and release rehearsal on one machine. Nothing here deploys
anything; production steps live in `docs/DEPLOY-COOLIFY.md` (draft, not
executed). Commands run from the repository root unless stated. Scripts in
`scripts/` are Bash and talk to Postgres through the compose container
(`bukalaris-db-1` on network `bukalaris_default`), because the database
listens on `127.0.0.1:5442` only.

> **Direction change (D-27 to D-31, 2026-11-14, ADR-0013 to ADR-0016):** the commands and local behaviour in this runbook describe the code as it runs today (one root domain, platform-managed shipping and payments on fake adapters, platform payouts) and stay valid until the named tasks land. The target differs in four places, each marked at its section: a store's own Mengantar and AutoLaris keys instead of platform credentials (T-104 to T-107), bank transfer to the seller's own account (T-113), two root domains with checkout on the store host (T-102, T-103), and no platform payout or COD reconciliation for a `seller_owned` store. No command changes.

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
`db:restore-rehearsal`, `map:check`, `verify:ledger`, `verify`, `verify:docker`
(`package.json`); worker, cleanup and `bootstrap:console` have no root alias
(`packages/db/package.json`).

Parallel git worktrees: each has its own `.env` with `bukalaris_<track>`
databases and its own dev/e2e ports (AGENTS.md "Commands": `bukalaris_<track>[_test|_e2e]`;
the M2 track table is archived in `docs/archive/AGENTS-m2-tracks.md`). All of them
share the one compose container.

## Database roles (T-27, ADR-0005)

The app connects as `bukalaris_app` (`DATABASE_URL`, row-level security applies),
the Owner console, worker and cleanup as `bukalaris_platform` (`PLATFORM_DATABASE_URL`,
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
context (see `packages/db/src/platform/tenant.ts`); `permission denied for table …` means
a code path reached a table the app role has no grant on (`docs/tracks/rls.md`
has the grant table).

**Upgrading to migration 0011 (chain A foundation).** Stop every outbox worker BEFORE migrating and start the new
build afterwards: the previous worker still writes job status `failed`, which 0011 turns into `dead` and the new
constraint no longer accepts. The migration also needs the five roles of `docs/DEPLOY-COOLIFY.md` "Database roles".

## Verify (release gate)

| Command | What it proves | Typical duration (2026-10-06, this machine) |
|---|---|---|
| `pnpm verify` | `map:check` → `lint` → `typecheck` → `test` (Vitest, `*_test` DB) → `build` → `e2e` (Playwright against the standalone build and the `*_e2e` DB); stops at the first failure | ~110 s on 2026-10-06; much longer since M3 (263 E2E tests): E2E alone about 27 min locally, the whole CI job about 40 min on the GitHub runner (T-100, 2026-11-15) |
| `pnpm verify:docker` | builds `bukalaris-web:local` and `bukalaris-migrate:local`, creates a throwaway `bukalaris_verify_<id>` DB owned by `bukalaris_owner`, migrates it as the owner (`MIGRATION_DATABASE_URL`) twice (the second run proves idempotence), compares the number of policies in `public` with the isolation registry and fails on any registry difference (`scripts/_registry.sh`, T-59), starts the web image as `bukalaris_app` + `bukalaris_platform`, checks `/api/health` 200, `/s/nope` 404 (DB-backed route), `/login` 200, Docker `HEALTHCHECK` healthy, process user `app`, writable `MEDIA_DIR` volume; then (T-84) runs the worker and cleanup from the `migrate` image as `bukalaris_platform`: one `approval.expire` job done and its fixture request expired, scheduler heartbeat, graceful SIGTERM (exit 0, no error lines), cleanup exit 0 removing exactly one idle fixture cart with buyer-data retention off; `VERIFY_BREAK=worker\|effect\|cleanup` must make it fail; drops the DB, containers and volume afterwards | ~175 s (≈160 s of it image builds; cached layers make reruns faster) |

`.github/workflows/ci.yml` runs the same two gates on GitHub on every push to
`main` and every pull request (job `verify`: `pnpm verify`; job `image`:
`scripts/verify-docker.sh`); the CI state is tracked in T-100. `VERIFY_PORT=3170 pnpm verify:docker` also publishes the
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
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" -e ORDER_LINK_SECRET="$(openssl rand -base64 32)" \
  -e BETTER_AUTH_URL=http://localhost:3170 -e STORE_ROOT_DOMAIN=localhost bukalaris-web
curl -i http://localhost:3170/api/health          # 200 {"ok":true}
docker inspect -f '{{.State.Health.Status}}' web-smoke   # healthy after ~30 s
docker rm -f web-smoke
```

Containers must join `bukalaris_default` and use host `db:5432`; `localhost:5442`
does not exist inside a container.

> **Direction change (D-28, 2026-11-14, ADR-0014):** the smoke test above sets one root (`STORE_ROOT_DOMAIN=localhost`), which stays valid: local development keeps one root for both jobs. In production the target is two settings, `PLATFORM_ROOT_DOMAIN` (`bukalaris.com`) and `STORE_ROOT_DOMAIN` (`bukalaris.id`). Not implemented (T-102, T-103).

## Media volume

Product images are files under `MEDIA_DIR` (web image default `/data/media`,
local dev default `./var/media`, both git-ignored). The image pre-creates
`/data/media` owned by uid/gid `10001:10001` (user `app`), so:

- a Docker named volume mounted at `/data/media` works without any chown
  (Docker copies the ownership from the image on first use);
- a host directory (bind mount) needs `chown 10001:10001 <dir>` once;
- the volume is part of the backup set (`tar` the directory or snapshot the
  volume together with a database dump), and one web replica at a time.

Buyer proof-of-transfer images (T-113, bank transfer) are a second, private
store under `PRIVATE_MEDIA_DIR` (required in production; locally
`<repo>/var/private-media`, git-ignored). Mount a separate persistent volume
there for the web container and the cleanup command (the same path in both),
owned by `10001:10001`. Never mount it under `MEDIA_DIR`: the public media route
must not reach it. The cleanup command deletes the files 90 days after the order
closed (retention class `payment_proof`; change the period with
`setRetentionPeriod`) and keeps the database rows; back the volume up with the
database dump, and treat the backup as personal data.

## Backup

```bash
pnpm db:backup                       # DATABASE_URL from env or .env
scripts/db-backup.sh postgres://bukalaris:bukalaris@localhost:5442/bukalaris_e2e   # any local database
```

Writes `var/backups/<db>-<UTC timestamp>.dump` (`pg_dump -Fc` inside the container;
owners and ACLs are kept on purpose, because the role grants are part of tenant
isolation and a dump without them restores a database the app role cannot read;
never add `--no-owner` or `--no-acl`) and prints size, duration and the number of TOC
entries (`pg_restore --list` proves the file is readable). `var/` is
git-ignored; copying dumps off the machine and retention are not automated
(Q-11), and encrypting them before they leave the machine is decided (D8 / D-19, 14;
the encrypting step is not built yet). The script refuses database names outside `bukalaris*`.
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

The rehearsal today checks per-table row counts, the migrations journal, store
orphans and the `tenant_isolation` policy count plus the app role's read with and
without a store context (`rls_ok`). It does not yet assert grants per role, replay
erasure records or cover platform-owned tables; T-59 extends it (14 restore
rules).

### After any real restore (not a rehearsal)

> **Direction change (D-27, D-29, 2026-11-14, ADR-0013, ADR-0015):** the payout freeze and the reconciliation of seller and affiliate payouts in steps 1 and 4 apply only to money Bukalaris holds. A store on seller-owned accounts has no platform payout, refund or COD batch, and affiliate commission is paid by the seller outside Bukalaris; T-53 is superseded, so the affiliate freeze named in step 1 is not added. The billing freeze for subscription invoices and steps 2 and 3 stand. The steps below describe the earlier model and remain correct for the code as it runs today. Not implemented (T-107, T-109).

1. Keep the web application and the worker stopped, or payout, billing and
   provider-write jobs frozen, until step 4 is done. The payout freeze exists (T-37: `payout_control.frozen`, switch on `/admin/payouts`;
   the database refuses payout and refund transitions and COD batch apply while it is on). A restored dump normally carries the
   unfrozen row: set `frozen = true` as the owner role BEFORE the application starts (`update payout_control set frozen = true`);
   T-50 has its own billing freeze (`billing_control.jobs_frozen`), T-53 will add the affiliate one.
2. Check isolation on the restored database: grants per role and policies against
   the registry (once T-59 extends the script). The roles must exist before the
   restore.
3. Replay the erasure and restriction records newer than the dump:
   `order_redaction` replay is not automated yet (T-43), buyer erasure, click
   purges and tax crypto-erasure follow PRIV-4.
4. Reconcile against bank and provider evidence: every `requested`, `processing`
   and `paid` payout (seller and affiliate), subscription invoice and refund. A
   payout that shows `requested` but was already transferred is marked from the
   evidence, never paid again; unknown outcomes stay `processing`. Only then
   unfreeze and start the worker, and record who, when and which evidence.

## Rotating `BETTER_AUTH_SECRET`

The secret is the base of every auth secret: the one-host `local` surface uses it
directly, and the Owner, Seller, Affiliate and Buyer surfaces derive theirs from it
unless `AUTH_SECRET_<SURFACE>` is set (`surfaceSecret` in `apps/web/src/lib/auth.ts`);
cart and checkout CSRF tokens are keyed with it directly (`apps/web/src/lib/auth-csrf.ts`).
Rotating it signs out every session on the surfaces whose secret comes from it and
invalidates every rendered form token (the user reloads the page). Passwords are
hashed separately and are not affected, but stored data does depend on it:

- **TOTP secrets and backup codes.** Better Auth 1.7.7's two-factor plugin encrypts
  `two_factor.secret` and the backup codes with the surface secret (read from the
  installed package, `better-auth/dist/plugins/two-factor/index.mjs`; not reproduced
  by a test). A rotation that changes a surface secret leaves every TOTP enrolment of
  that surface unreadable, so its users cannot pass MFA until their second factor is reset and
  enrolled again; when no `staff.manage` holder can sign in any more, the
  out-of-band procedure of "Console bootstrap and recovery" below applies. An
  explicit `AUTH_SECRET_<SURFACE>` keeps that surface's secret unchanged when the
  base rotates.
- **Fallbacks.** `ORDER_LINK_SECRET` has none since T-126: the worker and a
  production web server refuse to run without it, and changing it invalidates every
  order-status link already mailed (`packages/db/src/ops/jobs/notify.ts`). When
  `ACCOUNT_SEARCH_FINGERPRINT_KEY` is unset, new account-search fingerprints no longer
  match those in earlier audit rows (`packages/db/src/ops/accounts-governance.ts`).
  Set it explicitly before the first production rotation.

1. Generate: `openssl rand -base64 32`.
2. Local: replace the value in `.env`, restart `pnpm dev` or the container.
   Deployed: update the Coolify secret, redeploy the web application.
3. Verify: existing sessions receive 401 and a fresh sign-in works
   (`/login`). Rate limiting (3 sign-ins per 10 s per IP in production builds)
   applies while you test.

Rotate immediately if the value was ever printed, committed or pasted into a
prompt. Never write a secret into docs, memory or the repository.

## Rotating the Mengantar Partner Secret (entry gate of T-48)

> **Direction change (D-27, D-31, 2026-11-14, ADR-0013):** the owner chose on 2026-11-14 not to rotate this secret and accepts the exposure (D-31, owner answer 1). The Partner model is superseded: no `seller_owned` store uses the Partner Secret, and a call made with a seller's own key is not gated by it. The secret stays valid at the provider, and the T-48 entry gate in the code still refuses every Partner call without rotation evidence; both are left as they are. This procedure is therefore not a launch gate for a `seller_owned` store. It is kept because it is the only way to open the Partner path if a platform-held mode ever returns. Not implemented (T-104 to T-107).

The Partner Secret was pasted into a chat on 2026-10-27 (ADR-0007), so it counts
as exposed and is replaced before the first partner call, sandbox included.

1. Ask Mengantar to replace the Partner Secret (replacement on request is
   documented in ADR-0007).
2. Put the new value only in the secret store (`MENGANTAR_PARTNER_SECRET`); never
   in a chat, a document or the repository.
3. Redeploy the worker (the web process never holds it).
4. Make one bounded read-only partner call from the allow-listed production egress
   IP and check it succeeds.
5. Record the rotation date in DEPLOY-COOLIFY "Pre-go-live gates" (the date, never the value).

## Rotating a sealing key (key ring)

Follow DEPLOY-COOLIFY "Key ring and rotation": prepend the new key id to the ring,
deploy web and worker, let the re-seal job (JOB-23) rewrite the envelopes, verify
that no envelope carries the old id, and drop the old key only after every
retained backup that holds envelopes under it has expired. Keep the offline key
backup in step (14, secrets and keys backup).

> **Direction change (D-27, 2026-11-14, ADR-0013):** the `shipping_credentials` ring will seal each store's own Mengantar key and a new `payment_credentials` ring each store's own AutoLaris key. The same rotation procedure applies to both; losing either ring without a backup means every affected seller re-enters that key. Not implemented (T-104).

## Console bootstrap and recovery (T-60: script exists; the two named people are an owner action)

IAM-15 sensitive grants need an approver who already holds the capability and is
neither the requester nor the grantee, so the first holders of `staff.manage` and
`break_glass.approve` cannot be created inside the product, and the product
cannot recover when the last holder leaves or loses their TOTP device. This
procedure is out of band by design.

- **People.** Two named people take part in every run: the operator who runs the
  script and a witness. Names: **not assigned yet (owner action before the
  pilot)**; record them here as name and role, never with credentials.
- **Tool.** `pnpm --filter @bukalaris/db bootstrap:console -- --holder <email> --runbook "<entry>" [--recovery]` (T-60) runs on the server
  with `MIGRATION_DATABASE_URL`, never from the web application and never with the platform login. It refuses to run
  while two or more active `staff.manage` holders exist (bootstrap); for
  recovery it refuses unless both people confirm that no active holder can sign in.
  It selects exactly one existing sign-in identity by verified e-mail, creates the
  `platform_operator` row, grants `staff.manage` and `break_glass.approve` and
  writes one `operator_grant_event` per grant with source `system_bootstrap`
  (recovery: `system_recovery`) and no approval request.
- **Procedure.** (1) Both people present; the target identity is confirmed out of
  band. (2) Dry run, output read aloud. (3) Real run. (4) The new holder signs in
  and enrols TOTP. (5) The event rows are counted against the plan and a log entry
  (date, who, reason) is signed by the witness and kept outside the repository.
- **After.** The product enforces the matrix and the last active `staff.manage`
  holder cannot be removed (UX-22); recommended, not decided: keep at least two
  active holders so a lost TOTP device does not need recovery. Bootstrap and
  recovery events appear in the audit viewer, notify every `audit.read` holder
  and are reviewed at the next access review.
- **Staff MFA reset** goes only through `staff.manage` with four-eyes
  (`mfa.reset`), never through `accounts.support`. If no holder can sign in, this
  same script is the only path, again by two named people and recorded as
  `system_recovery`.

## COD reconciliation batch (built locally by T-37 and T-48 against fake adapters: `packages/db/src/ledger/reconciliation.ts`, Owner console `/admin/money/cod-reconciliation`; not run on real provider evidence yet)

> **Direction change (D-27, 2026-11-14, ADR-0013):** this procedure does not apply to a store on seller-owned accounts, the only mode in the first release (D-31): COD cash goes from the provider to the seller's own account, no sale is held or released by Bukalaris and no reconciliation batch exists for such a store (ADR-0013 section 8). The sentence "There is no seller-owned account COD" is reversed. The built code stays, unused; this runbook applies only to money Bukalaris holds, which is none for order payments in the first release. The text below describes the earlier model. Not implemented (T-105, T-107).

Rule (ADR-0006): the seller's sale for a COD order is released to
the seller's available balance only when the parcel is delivered **and** the cash
has been reconciled against provider evidence. There is no seller-owned account COD
(D-15: one unified Bukalaris-managed system; cash custody on `partner_managed` accounts is the `OPEN-F9` gate). Which Mengantar fields prove
reconciliation (order `isReconciliated`, invoices of `typeReconciliation`) is
UNVERIFIED, so until it is observed this procedure runs on evidence that finance
reads from the provider statement, and JOB-33 stays off.

- **Who.** Two different Owner console staff: a preparer (capability
  `payouts.reconcile`, with `finance.read`) and an approver who holds the same
  capability and is not the preparer (four-eyes approval, action
  `cod.reconcile_release`, IAM-15). Break-glass never substitutes for the approver.
- **Cadence.** At least once per working day, and before any manual payout approval
  that depends on COD proceeds. Record the batch date and operator names in the
  batch (SA-53), not in a chat.
- **Evidence.** The provider's remittance statement or reconciliation invoice for
  the period, kept as an opaque reference (file name or statement id) plus its
  total. Never paste bank account numbers, keys or buyer data into the batch or
  into this runbook.
- **Steps.** (1) Open the queue (SA-53): delivered COD orders not
  yet reconciled, with the expected remittance from our ledger. (2) Create a batch
  from the provider statement (a `source = provider` batch from JOB-33 exists only
  once `provider_reconciliation_enabled` is true, OPEN-F8; until then this Owner
  console batch is the only release path). (3) Compare per order: expected versus evidenced amount, and the batch total
  against the statement total. (4) The preparer submits the batch; the approver
  reviews the order list and totals (the approval binds the batch id, list hash and
  totals) and confirms. (5) The confirmed orders' sales are released by JOB-24 at its
  next run; check the released count equals the confirmed count.
- **On a mismatch.** Do not confirm that order. Hold it with a reason (amount
  differs, missing from the statement, duplicate, returned after delivery) and
  keep its sale `pending`. Confirm the rest of the batch only if the totals of the
  confirmed subset still match the evidence. Chase the provider for a missing or
  short remittance and record the reference. A mismatch is never auto-closed and
  never fixed with a ledger adjustment unless a four-eyes `ledger.adjust` is
  approved with its own reason. A hold older than the accepted age (OPEN) appears
  in the risk queue.
- **Freeze.** If the totals disagree by more than the owner's tolerance (OPEN), or
  the evidence looks wrong or duplicated, stop confirming batches and pause seller
  payout approvals that rely on COD proceeds until the cause is found. After a
  database restore, reconciliation batches stay frozen with the payout jobs until
  every open batch is re-checked against the provider (14, restore rules).
- **Never.** Release a COD sale because the courier says `DELIVERED` alone, from a
  tracking status, or by a SQL update; confirm your own batch; reuse one statement
  for two batches.

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

> **Direction change (D-27, D-28, D-31, 2026-11-14, ADR-0013, ADR-0014):** read the rows below with these changes. (1) Root domain: production needs `PLATFORM_ROOT_DOMAIN` and `STORE_ROOT_DOMAIN`, two zones and two wildcard certificates (T-102). (2) Partner Secret: the rotation row is no longer a launch gate for `seller_owned` stores; the owner accepted the exposure and the gate in the code keeps the Partner path closed (D-31). (3) Key rings: add `payment_credentials` beside `shipping_credentials` (T-104). (4) Egress IP: the allow-list row concerned Partner calls; whether AutoLaris applies an IP allow-list to calls on seller keys from this hosting is UNVERIFIED (ADR-0013 "Consequences"). (5) Payout freeze: applies only to money Bukalaris holds. (6) Mengantar production readiness: the quote runs on a store's own key after a recorded sandbox pass and an Owner console switch per provider (ADR-0013 decisions 33 and 34). The rows below describe the earlier model. Not implemented (T-102 to T-107).

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
      `INTEGRATION_TOKEN_KEY` fresh per environment, `STORE_ROOT_DOMAIN`, and the
      public per-surface origins `OWNER_ORIGIN`, `APP_ORIGIN`, `CHECKOUT_ORIGIN`,
      `PLATFORM_ORIGIN` plus `AFFILIATE_ORIGIN`, `BUYER_ORIGIN`, `LOGS_ORIGIN` for each
      surface that is live; `BETTER_AUTH_URL` is only the local one-host path-mode
      origin and development fallback; full table in
      `docs/DEPLOY-COOLIFY.md` "Required environment variables"; T-70 is implemented
      locally, not deployed; also the key rings from "Variables read by the build
      since M3 chain A"; a missing required secret is meant to stop the process in
      production, which the build does not yet do for every secret, see
      `docs/DEPLOY-COOLIFY.md` "Secrets in production").
- [ ] Worker process deployed from the `migrate` image stage (`node src/worker.ts`)
      and cleanup (`node src/cleanup.ts`) scheduled (`docs/DEPLOY-COOLIFY.md` "Worker and cleanup").
- [ ] Database roles created by hand with generated passwords and the database
      owned by `bukalaris_owner` (`docs/DEPLOY-COOLIFY.md` "Database roles");
      `DATABASE_URL` = app role, `PLATFORM_DATABASE_URL` = platform role,
      `MIGRATION_DATABASE_URL` = owner.
- [ ] Open product gates from `docs/DEPLOY-COOLIFY.md` "Pre-go-live gates"
      (providers, Q-10, Q-11, auth hardening, RLS, logging) have owners.
- [ ] Mengantar Partner Secret rotated before the first partner call and the date
      recorded (section "Rotating the Mengantar Partner Secret").
- [ ] Offline key backup made and its restore rehearsed (14, secrets and keys
      backup); production egress IP recorded and allow-listed.
- [ ] Console bootstrap done by two named people and the names recorded (section
      "Console bootstrap and recovery").
- [ ] Restore rehearsal covers grants per role and erasure replay (T-59), and the
      post-restore payout freeze has been rehearsed.
- [ ] JOB-21 scheduler heartbeat alert active before the first billing period.

Added by the portfolio scan of 2026-11 (G5 to G7, task T-79; `docs/research/2026-11-portfolio-scan/`):

- [ ] Deploy proof is a signal that must change: the running image tag of web and worker
      equals the release commit, read back after the deploy and recorded with the before value;
      every surface answers from the new image on two consecutive polls (a rolling swap can show
      one false green), and a redirect to sign-in (3xx) counts as healthy.
- [ ] Environment variables are set in Coolify before the merge that needs them, and the compose
      file forwards each one; no `${X:+...}` or other alternate-value form anywhere in the compose
      file, comments included (Coolify's parser rejects it although `docker compose config` accepts it).
- [ ] Runtime role proof (SEC-25) passes in production for the web process and the worker.
- [ ] One real e-mail reaches an external inbox through the production transport, with SPF and
      DKIM passing (a placeholder key once left a sibling product unable to send any mail).
- [ ] Mengantar production readiness: one non-mutating rate quote on the production account
      returns couriers for a real route before shipping is switched on, and the COD estimate is
      probed at two or more `COD_AMOUNT` values with the exact parameter casing (a wrong name
      silently returns a zero COD fee).
- [ ] Off-box probe installed, hosting balance alert active, backup age and offsite health
      checks live, and the media volume plus Coolify's own database included in the restore
      rehearsal (14, "Monitoring and backup lessons").
