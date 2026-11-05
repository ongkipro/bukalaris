# Build log

Append-only. One entry per phase: what changed, commands run, results, open issues.

## 2026-10-06 — Phase 0: repository (T-1)

Changed:
- `git init -b main` in `~/Projects/bukalaris` (previously `git rev-parse
  --show-toplevel` resolved to `$HOME`'s accidental empty repo; now resolves to
  this folder).
- Copied `~/Documents/work/prd/bukalaris/` → `docs/` (`cp -a`, nothing moved or
  deleted). Added `~/Documents/work/prd/bukalaris/MOVED.md` pointing here.
- Added `AGENTS.md`, `STATUS.md`, this `BUILD-LOG.md`.

Commands and results:
- `git rev-parse --show-toplevel` → `/home/ongki/Projects/bukalaris`.
- `diff -r ~/Documents/work/prd/bukalaris docs` → no differences (before MOVED.md).
- `cd docs && python3 check-spec.py` → `PASS proposed API: 50 paths, 63
  operations; refs, auth boundaries and local file links`.

Open issues:
- Nothing committed (owner approval required).
- `AGENTS.md` lists commands that Phase 1/2 create; they are not yet runnable.

## 2026-10-06 — Phase 1: stack baseline (T-1)

Changed:
- Root pnpm workspace (`package.json`, `pnpm-workspace.yaml`, `.gitignore`,
  `.dockerignore`, `.nvmrc`, `.env.example`). REVIEW R-2: `.gitignore` written
  before the first install.
- `apps/web` scaffolded with `create-next-app@16.3.8` (App Router, TS, Tailwind,
  ESLint, `src/`), then `shadcn@4.21.3 init -d` (style `base-nova`). Removed
  `next/font/google` (system font stack), demo assets, nested workspace file.
  `next.config.ts`: `output: "standalone"`, `outputFileTracingRoot` = repo root,
  `transpilePackages: ["@bukalaris/db"]`, loads root `.env` when present.
  `/api/health` liveness route.
- `packages/db`: Drizzle schema (`src/schema.ts`: Better Auth core tables,
  store, platform_operator, membership, product, variant, cart, cart_line,
  order, order_line, audit_log; compound `(store_id, id)` FKs, CHECKs for
  money/stock/status/slug), generated migration `drizzle/0000_*.sql`, migrator
  `src/migrate.ts`, client `src/client.ts`.
- `docker-compose.yml` (postgres:17-alpine, 5442:5432, creates `bukalaris_test`).
- `apps/web/Dockerfile` (multi-stage; `runner` = standalone server as non-root,
  `migrate` target for one-off migrations).
- `docs/DECISIONS.md` (D-1 versions, D-2 single Next app / Astro deferred
  ceiling, D-3 store as tenant root). REVIEW R-1: `docs/README.md` status points
  at the repository and `STATUS.md`.
- Versions checked with `npm view` on 2026-10-06; Better Auth table fields
  checked with `getAuthTables()` from the installed 1.7.7 package; Next 16
  proxy/standalone behaviour read from bundled `node_modules/next/dist/docs`.

Commands and results:
- `pnpm install` → done (esbuild build script allowed; sharp/unrs-resolver not built).
- `docker compose up -d db` → healthy; databases `bukalaris`, `bukalaris_test` exist.
- `pnpm db:generate` → 14 tables; `pnpm db:migrate` → "migrations applied"; `\dt` lists 14 tables.
- `pnpm lint` → pass (eslint on apps/web). `pnpm typecheck` → pass (db: tsc; web: `next typegen && tsc`, also from a clean `.next`).
- `pnpm build` → pass (routes `/`, `/_not-found`).
- `docker build -f apps/web/Dockerfile -t bukalaris-web:p1 .` → pass (296MB);
  `docker run -p 3901:3000` → `/api/health` `{"ok":true}`, `/` renders `<h1>Bukalaris</h1>`.
- `cd docs && python3 check-spec.py` → PASS (after README edit).

Open issues:
- `pnpm test` has no tests yet (Phase 2).
- `packages/db` has no ESLint config; it is covered by `tsc` only.
- Dev DB was reset once (`drop schema public cascade`) after regenerating the
  first migration — local dev data only, nothing else lived there.
- Nothing committed.

## 2026-10-06 — Phase 2: vertical slice (PR-1..PR-5 subset)

REVIEW items resolved first: R-3 (Postgres bound to 127.0.0.1), R-4 (no
`public/` added → no COPY needed; re-proved image smoke), R-5 (tests go through
route-level services), R-6 (parallel-transaction stock test strengthened).

Changed:
- `packages/db/src/`: `scoped.ts` (SellerScope/StorefrontScope/OperatorScope,
  capabilities, `DomainError`), `host.ts` (host → slug), `catalog.ts`,
  `storefront.ts` (published reads, cart), `checkout.ts` (`placeOrder`,
  `checkoutSummary`, `getBuyerOrder`), `providers.ts` (Mengantar/AutoLaris
  interfaces + fakes), `membership.ts` (last-owner protection with row locks),
  `platform.ts` (store list, suspend/reactivate + audit), `seed.ts`.
  Schema: `order.cart_id` unique; product slug optional (canonical = slug ?? id;
  all-digit slugs reserved). Migration regenerated (nothing was ever deployed).
- `packages/db/test/`: tenant isolation, checkout, lifecycle (21 tests).
- `apps/web`: Better Auth (`src/lib/auth.ts`, `/api/auth/[...all]`), `/login`
  (client form posting to the auth endpoint so origin check + rate limit
  apply), Seller Admin `/seller/products{,/new,/[id]}`, `/seller/members`,
  Super Admin `/admin`, storefront `/s/[store]{,/products/[slug],/cart}`,
  hosted `/checkout` + `/checkout/confirmation`, `src/proxy.ts` (store host
  rewrite, forged internal header stripped, `/s/<slug>` prefix redirect on the
  store host). Playwright: `playwright.config.ts`, `e2e/*` (own DB, standalone server).
- Docs: ADR-0004, DECISIONS D-4..D-7, DEPLOY-COOLIFY.md (draft), 04 page map
  locators, TASKS statuses + evidence, STATUS.md, AGENTS.md, docs/evidence/m1/*.png.

Bugs found by running things (all fixed and covered):
- Concurrent duplicate checkout: a submit starting after the first committed
  saw an empty cart and failed instead of returning the same order.
- Docker build prerendered `/admin` and failed: `auth()` (needs DATABASE_URL)
  was evaluated before `headers()`; now `headers()` is awaited first.
- Server-action login bypassed Better Auth's rate limiter (verified in its
  router source); login now posts to the HTTP endpoint. Observed 429 after 3
  wrong-password attempts.
- Better Auth origin check returned 403 when `BETTER_AUTH_URL` did not match
  the serving port (e2e now sets it).
- Host-mode `/s/<slug>` links double-prefixed; proxy now redirects keeping the host.
- E2E was non-deterministic on the shared dev DB (stock exhausted); moved to a
  disposable `bukalaris_e2e` database.

Commands and results (final run, fresh dev DB):
- `pnpm db:migrate`, `pnpm db:seed` → exit 0.
- `pnpm lint` → exit 0. `pnpm typecheck` → exit 0.
- `pnpm test` → 3 files, 21 tests passed (5 consecutive green runs earlier).
- `pnpm build` → exit 0 (16 routes + proxy).
- `pnpm e2e` → 8 passed (mobile-320 + desktop), screenshots in `docs/evidence/m1/`.
- `docker build` web + migrate targets → exit 0. On the compose network: migrate
  image "migrations applied"; web container `/api/health` 200, `/s/toko-a` 200,
  product 200, `/s/nope` 404, `/seller` 307, host `toko-b.localhost` 200, host
  `/s/toko-a/cart` → 307 `http://toko-a.localhost:3902/cart`, host `/seller` 404,
  sign-in 200 then `/seller/products` 200, sign-up 400; process user `app`.
- `cd docs && python3 check-spec.py` → PASS.

Open issues:
- See STATUS.md "Not done / known gaps" (RLS, single origin, fakes only,
  auth recovery/MFA, no DB-down error page, large migrate image).
- `next start` warns with `output: standalone`; e2e and Docker use the
  standalone `server.js`, `pnpm start` remains a convenience only.
- Nothing committed.

## 2026-10-06 — Verification (brief checklist → evidence)

REVIEW.md: no open items at the start of this phase.

| Brief requirement | Evidence |
|---|---|
| Cross-tenant read/write denial | `packages/db/test/tenant-isolation.test.ts` (6 tests, incl. DB FK `variant_product_fk`); e2e owner-b gets 404 on owner-a's product |
| Checkout price tampering rejected | `checkout.test.ts` "rejects client-supplied prices…" (strict schema rejects `total`/`unitPrice`/`shippingFee`/`lines`, unknown courier); e2e injected hidden `total=1` ignored, total Rp 193.000 |
| Idempotent duplicate submit | `checkout.test.ts` 5 concurrent + 1 sequential replay → one order, stock decremented once; same key + other payload → `idempotency_conflict` |
| Stock never negative under concurrent checkout | `checkout.test.ts` 12 parallel orders on stock 3 → 3 succeed, rest `out_of_stock`, final stock 0; CHECK `stock >= 0` |
| Suspended store blocked | `lifecycle.test.ts` (storefront null, checkout `store_unavailable`, seller context `suspended`, audit reason); e2e `/s/toko-b` 404 while suspended |
| Last-owner protection | `lifecycle.test.ts` remove/demote last owner rejected, concurrent mutual removal leaves exactly one owner, staff forbidden |
| `pnpm lint`, `typecheck`, `test`, `build`, `docker build` | all exit 0 in the final run (Phase 2 entry) |
| Browser evidence 320px + desktop | `pnpm e2e` 8 passed; `docs/evidence/m1/{mobile-320,desktop}-*.png` (18 screenshots, 716 KB) |
| Docs updated | `docs/TASKS.md` statuses + "M1 implementation evidence" (fingerprint `edc2552fc9cf325c`), `docs/04-SYSTEM-ARCHITECTURE.md` "M1 implementation locators" (paths checked to exist), `STATUS.md`, `docs/DEPLOY-COOLIFY.md` (draft) |

Rules check: no deploy, no DNS, no live provider calls (fake adapters; Next and
Better Auth telemetry disabled; no Google font fetch), no real secrets
(`.env` holds `.env.example` placeholders and is git-ignored; container smoke
used a throwaway `openssl rand` secret that was never printed), no sudo, no
global installs, no git commit or push.

## 2026-10-06 — Final round: REVIEW R-7..R-11

Changed:
- R-7: `AGENTS.md` describes the real scope API (`sellerContext`,
  `storefrontScope`, `operatorScope`); grep of all Markdown for drift.
- R-8: per-store cart cookie `bl_cart_<storeId>`; `/checkout?store=<slug>`
  resolves the active store server-side and accepts the cart only if it belongs
  to that store (`apps/web/src/lib/storefront.ts`, `s/[store]/actions.ts`,
  `s/[store]/cart/page.tsx`, `checkout/page.tsx`, `checkout/actions.ts`;
  `checkoutSummary` returns `storeId`). DECISIONS D-6 updated.
- R-9: `sellerContext` falls back to the first active membership.
- R-10: slim `migrate` Docker target (pnpm deploy of `packages/db` with prod
  deps); `better-auth` moved to db devDependencies; DB client silences
  Postgres NOTICE output.
- R-11: `docs/DEPLOY-COOLIFY.md` rewritten (still a draft, nothing executed).

Commands and results:
- New tests: `lifecycle.test.ts` fallback test; e2e "carts of two stores
  coexist…". Mutation check for R-8: temporarily restoring a single `bl_cart`
  cookie made the new e2e fail (1 failed); restored the fix, rebuilt.
- Full run (fresh dev DB): `pnpm install --frozen-lockfile`, `db:migrate`,
  `db:seed`, `lint`, `typecheck`, `test` (3 files, 22 passed), `build`, `e2e`
  (10 passed), `docker build` web and migrate, `check-spec.py` PASS — all exit 0.
- Images: `bukalaris-web:m1` 301 MB, `bukalaris-migrate:m1` 273 MB (was 1.84 GB;
  `/app/node_modules` 27.4 MB; user `app`).
- Compose-network smoke on a fresh `bukalaris_smoke` DB (dropped afterwards):
  migrate "migrations applied" exit 0, re-run exit 0; web `/api/health` 200,
  `/` 200, `/login` 200, `/s/nope` 404, `/seller` 307; Docker HEALTHCHECK
  `healthy`.
- Code fingerprint (see docs/TASKS.md): `f64e666598bef5ac`.

Open issues: unchanged from STATUS.md "Not done / known gaps". Nothing committed.

## 2026-10-06 — M2 wave 1 started (parallel tracks)

Owner direction (Paduka Ongki): continue development in parallel, local first,
including UI/UX and system; commits allowed locally (no push).

Changed (main):
- `bea3d8f` M1 baseline commit; `d86a4d4` M2 prep (per-track module/schema
  stubs, pre-populated seller/admin navigation incl. Log System button,
  disposable test DBs created/wiped by Vitest setup, `E2E_PORT`).
- Worktrees `~/Projects/bukalaris-wt/{orders,accounts,ops,content}` on
  branches `m2/<track>`, each with own `.env` (DBs `bukalaris_<track>*`,
  dev/e2e ports 3110/3111 … 3140/3141); one background agent per track.
- `docs/TASKS.md`: M2 queue T-21..T-28 (one primary requirement each) and
  status updates on T-14 (five-digit string catalog IDs, from shared memory
  "Commerce catalog identity"), T-16, T-18, T-19. Suite checker:
  `check-traceability.py docs` → PASS files=25 declarations=191 tasks=28 findings=0.
- `docs/04-SYSTEM-ARCHITECTURE.md`: 18 page rows marked "In progress — M2
  `m2/<track>`"; new rows AU-04 (/invite/:token), AU-05 (/account/security).
- Wave 1b prepared: stubs + ownership rows for tracks `channels` (T-16/T-19)
  and `release` (T-18); seller nav entry `/seller/channels`.

Open issues:
- PR-1/2/4/15 remain `Proposed`; acceptance is an owner decision after evidence.
- Wave 2 (after merge): T-27 RLS + DB roles, T-28 seller/admin UI pass, T-14
  catalog IDs, consolidated migration.

## 2026-10-06 — Merge m2/orders (T-21)

Reviewed diff (ownership respected; shared edit: 4-line capability addition in
`scoped.ts`). Logic check: order row `FOR UPDATE` before status check makes
cancel-restock exactly-once; variant lock order matches checkout. Orchestrator
re-ran on the branch: lint 0, typecheck 0, Vitest 34 passed, build 0,
Playwright 14 passed. Merged `--no-ff`; branch migration replaced by
consolidated `packages/db/drizzle/0001_m2_schema.sql` (regenerated per merge
until wave 2 ends); Vitest on main after merge: 34 passed.
Follow-ups: status names shown raw in an error message (T-28 copy pass); e2e
`evidence()` writes to `docs/evidence/m1/` for every milestone and rewrites
existing PNGs on each run (evidence churn) — make the folder configurable.

## 2026-10-06 — Gap analysis (business, security, system)

Sources: shared memory (business direction "Indonesia Commerce Portal OS",
catalog-identity rule), design pack, code on `main`, `pnpm audit --prod`.
- PRD: new "Business model and growth loop" proposal; PR-18 plans/entitlements,
  PR-19 COD risk control, PR-20 server-side ad conversion signals, PR-21 order
  notifications, PR-22 seller dashboard (all Proposed); decisions Q-12..Q-16.
- 12-SECURITY: observed findings SEC-14..SEC-19 (headers, prod dependency
  advisories, checkout/cart abuse, catalog audit gap, no outbox, buyer PII lifecycle).
- TASKS: T-29..T-33 for those findings (wave 2); no tasks for unaccepted PR-18..22.
- `check-traceability.py docs` → PASS files=26 declarations=207 tasks=33 findings=0;
  `check-spec.py` → PASS.

## 2026-10-06 — Owner decisions, release merge, shipping track

- Merged `m2/release` (T-18) after independent re-run in its worktree:
  lint 0, typecheck 0, `pnpm verify:docker` exit 0 (web 301 MB, migrate
  273 MB, health 200, `/s/nope` 404, HEALTHCHECK healthy, user app, media
  writable, throwaway DB/container/volume cleaned), backup 33,580 bytes and
  restore rehearsal 14/14 tables equal. Reviewed destructive commands: drops
  only target script-generated scratch names behind a `bukalaris*` guard.
  Main after merge: Vitest 34 passed.
- Owner decisions recorded in 02-PRD.md: Q-12 shipping margin, Q-13 COD sellers
  nationwide, Mengantar API allowed for development via `secrets-env` (reads
  live; writes stay disabled pending explicit approval), Q-15 TokoΦ/AdsBookCMS
  signal concept, Q-16 email first. Derived: Q-2 platform-owned Mengantar
  account; new Q-17 COD remittance (finance + legal) before any real COD shipment.
  PR-5 (Mengantar), PR-19, PR-20, PR-21 → accepted for implementation; PR-18 deferred.
- Research: read-only review of `~/Projects/tokophi` and `~/Projects/adsbookcms`
  tracking implementations → PR-20 signal contract (events, COD/prepaid
  purchase timing, dedup ids, variant content ids, hashing, outbox, consent);
  Q-7 resolved to variant-level ids. Mengantar toolkit `~/Projects/mengantar-documentation`
  and skill `mengantar-api` used for the shipping design (contract unverified until observed).
- Tasks: T-34 shipping quotes + margin (track `shipping` launched), T-35 COD
  confirmation/risk, T-36 email notifications, T-37 remittance ledger (blocked
  on Q-17), T-38 conversion signals. Suite checker: PASS files=28
  declarations=212 tasks=38 findings=0.
- Memory: three verified lessons captured as candidates via `ai-learn capture`
  (Better Auth rate-limit bypass, Coolify pre-deploy hook, Next build prerender/env order).

## 2026-10-07 — Wave 1 integration (channels, jobs, ops, accounts, content, shipping)

Each branch: diff + ownership reviewed, security-critical code read by the
orchestrator, then merged `--no-ff` with the post-M1 migrations regenerated
into one `packages/db/drizzle/0001_m2_schema.sql` (16 new tables). Reviews:
- channels: SHA-256 token hash + prefix lookup + `timingSafeEqual`; handoff
  consumed by one atomic UPDATE; origin https-only (http for localhost) without
  path, return path rejects `//` and backslashes → no open redirect. Branch
  re-run: lint/typecheck/build 0, Vitest 28, Playwright 12, check-spec PASS.
- jobs: `FOR UPDATE SKIP LOCKED` with leases; its finding that an orders test
  assumed the wrong invariant was confirmed and the test fixed (one successful
  cancel, single restock; 5/5 green).
- ops: inbound `x-request-id` strictly formatted but client-controllable →
  trust flag moved to T-29.
- accounts: invitation row locked `FOR UPDATE`, email-bound, single use;
  password 8–128 hashed with Better Auth's `hashPassword`.
- content: media keys server-derived with a strict regex plus a
  path-confinement check; bytes sniffed; `nosniff` on responses.
- shipping: staged diff scanned for API keys, key-bearing URLs and phone
  numbers — only the shared dummy `081234567890` appears.

Integration bugs found by the full e2e run on `main` and fixed:
- Super Admin header overflowed 30px at 320px after the "Ongkir" nav link
  (my M2-prep change); a failing suspend test left `toko-b` suspended and
  cascaded into four more failures. Header now wraps.
- The accounts recovery spec reset `staff-a@`'s password and broke later specs;
  it now uses a dedicated seed user `recovery-a@`.
- An orders assertion matched Next's route announcer (`role=alert`); scoped to `<main>`.

Results on `main` after all merges: typecheck 0, lint 0, Vitest 88 passed,
`pnpm build` 0, Playwright 41 passed + 1 skipped (DB-outage check runs on
desktop only). Docs: 17 system-map rows got real locators, M2 additional
locators section, task statuses T-16/18/19/22–26/32/34 updated.
Wave 2a launched from `d7a32f5`: `checkout2` (T-34 phase 2, T-35, T-30),
`catalog` (T-14, T-31), `hardening` (T-29).

## 2026-10-07 — Wave 2a integration (hardening, catalog, checkout2)

- hardening (T-29): branch e2e re-run 3/3 green (46 passed) — the agent's
  one-off 30/48 failure did not reproduce (likely host load from parallel
  suites). CSP read line by line; no inline `style=` in app code. Added a CSP
  guard to the shared `evidence()` helper so every screenshot step fails on a
  violation. Main: 88 unit, 46 e2e.
- catalog (T-14, T-31): drift check clean; hand-written `0003` kept verbatim.
  Accepted the removal of `s/[store]/loading.tsx` — its Suspense boundary made
  storefront redirects and 404s return HTTP 200 (soft 404). Main: 92 unit, 48 e2e.
- checkout2 (T-34 p2, T-35, T-30): conflicts resolved in `checkout.ts`
  (`cartLines()` now carries `variantCatalogId`), `schema.ts`, `storefront.ts`;
  branch migrations (generated only) replaced by `0004_checkout2_shipping_cod_abuse.sql`;
  dev DB migrated (0 orders). Main: Vitest 104 passed, build 0, Playwright 56
  passed + 2 skipped.
- Decision D-9: migrations append-only; NOT NULL on populated tables must be
  expand/backfill/contract after the first deployment.

## 2026-10-07 — Wave 2b started; RLS design

- `pnpm verify:docker` on `main` after wave 2a: health 200, `/s/nope` 404,
  login 200, HEALTHCHECK healthy, user app, media writable; cleanup confirmed.
- Wave 2b launched from `b7150ee`: `notify` (T-36), `signals` (T-38, no real
  ad-platform calls), `ui` (T-28).
- ADR-0005 (Proposed): RLS with owner/app/platform roles, transaction-local
  store context, platform pool limited to named cross-store resolvers; T-27 in wave 3.

## 2026-10-07 — Wave 2b integration (notify, signals, ui) and wave 3 start

- notify (T-36): reviewed link signing (expiry + constant-time HMAC) and HTML
  escaping. Integration fixes: specs use a fresh buyer phone per order
  (`testPhone()`), because the shared number hit the per-phone order limit
  (T-30) — the limit itself worked as designed; channels spec names its channel
  per project (a revoked same-named row from the other viewport satisfied the
  assertion early; revoke denial is also proven in `channels.test.ts`).
- signals (T-38): reviewed simulation default (`SIGNALS_LIVE=1` required for any
  network call) and AES-256-GCM with AAD. Migration regenerated as `0006`.
  Integration fixes: unit tests count only `signal.*` jobs; Playwright sets a
  per-run `INTEGRATION_TOKEN_KEY` (the page correctly fails closed without one);
  e2e tops up the seeded Kaos stock (sold out mid-suite and silently switched
  the default variant); orders spec selects rows by exact order link and
  over-decrements relative to current stock.
- ui (T-28): conflicts resolved (seller nav keeps Pemasaran in the new NavItem
  shape; orders.ts keeps notify + signals hooks and the Indonesian status label;
  channels spec accepts the new revoke confirmation).
- Results on `main` (`3e53efe`): lint 0, typecheck 0, Vitest 129 passed,
  build 0, Playwright 72 passed + 2 skipped.
- Wave 3: track `rls` (T-27, ADR-0005) launched from `ef809e0`.
- `pnpm verify:docker` on `main` after wave 2b: health 200, `/s/nope` 404,
  login 200, HEALTHCHECK healthy, user app, media writable; cleanup confirmed.

## 2026-10-07 — Wave 3 integration (rls, T-27)

- Reviewed `0007_rls.sql` and `tenant.ts`: transaction-local `set_config`,
  `nullif` for the empty-string GUC after a transaction (verified by the track
  on PG17), store switch inside one transaction throws, 26 policies with FORCE.
- Dev DB upgrade on `main`: `scripts/db-roles.sh bukalaris` + `pnpm db:migrate`.
  Found and fixed: the script did not transfer the `public` schema, so a
  database whose `public` was recreated by another role failed migration 0007
  with 3F000. After the fix: migrations applied, 26 policies.
- `.env` on `main`: appended `MIGRATION_DATABASE_URL` and `PLATFORM_DATABASE_URL`
  (local placeholders). Editing the existing `DATABASE_URL` line is blocked by
  the env deny rule — it still uses the superuser (bypasses RLS in `pnpm dev`);
  the owner must switch it to `bukalaris_app` by hand. Gates do not use it.
- Main results: lint 0, typecheck 0, Vitest 137 passed (app role), build 0,
  Playwright 72 passed + 2 skipped, `verify:docker` exit 0 (37 tables,
  26 policies, health 200, HEALTHCHECK healthy).
- DR gap found and fixed: backups used `--no-owner --no-acl`; restoring such a
  dump leaves `bukalaris_app` without grants (observed: permission denied for
  table product). Backups now keep owners/ACLs; the rehearsal asserts policy
  count, 0 rows without context and full reads with it — new dump rls_ok=yes,
  old dump fails (exit 1).

## 2026-10-07 — Wave 4 started (parallel)

Owner direction: continue development in parallel; scan and perfect the docs,
complete the system map, keep the logs current; add demo users/merchants with
dummy content.
- Tasks added: T-39 shipment booking + tracking (writes stay locked), T-40
  catalog feeds, T-41 seller dashboard (PR-22 accepted under the owner's
  delegation, vetoable), T-42 landing pages v1 (PR-9), T-43 buyer data
  export/redaction (T-33 mechanism). Suite checker: PASS files=42
  declarations=218 tasks=43 findings=0.
- Worktrees from `0f4801b` with role-based `.env` (app/platform/owner URLs,
  dev DBs owned by `bukalaris_owner`): `fulfillment` 3270, `feeds` 3280,
  `dashboard` 3290, `landing` 3300, `privacy` 3310, `demo` 3320.
- `docs-scan` agent on `main` (docs only, uncommitted until reviewed): system
  map vs every route, statuses for T-1..T-20, README/API/deploy/runbook/UX/
  observability sync, validators.

## 2026-10-07 — GitHub (private) and pre-publication scan

- Owner asked for a public GitHub repo. Pre-push scan of all 908 history blobs
  (patterns for keys/tokens/private keys/JWT/personal emails + byte comparison
  against 8 secret-store values, run via `secrets-env run`, values never
  printed): no credentials; one hit — the real `MENGANTAR_ORIGIN_AREA_ID` in
  `packages/db/test/fixtures/mengantar/estimate-all-cod.json`, which also holds
  the account's real negotiated prices/discounts.
- Owner decision: publish PRIVATE first. Working tree sanitized (synthetic area
  id; shipping tests 12 passed); the old value remains in history.
- Before any switch to PUBLIC: replace real account prices in fixtures, the fake
  adapter and dependent test expectations, then publish a clean history
  (owner decides rewrite vs fresh snapshot), and review PRD/business docs for
  publication.

## 2026-10-07 — Log System module map covers every route; wave 4 resumed

- Wave 4 track agents had stopped mid-task (all six worktrees uncommitted at
  `0f4801b`); relaunched in parallel: fulfillment, feeds, dashboard, landing,
  privacy, demo. Results and merges follow in a later entry.
- `packages/db/src/ops.ts` `MODULE_MAP`/`ROUTE_PREFIXES` extended from 12 to 41
  modules with the ARCH-5 page IDs (AU-02/04/05, SA-03/07, SC-01..SC-24,
  SF-02..SF-11, HTTP-02/04/05/12/13/15); `/checkout/h/invalid` → SF-10,
  products detail → SF-04 (was SF-01). New test walks `apps/web/src/app` and
  fails on any unmapped `page`/`route` (exempt: `/`, `/dev/outbox`).
- Commands (main): `vitest run test/ops.test.ts` 7 passed; `pnpm lint` 0;
  `pnpm typecheck` 0; `pnpm test` 15 files / 138 passed.
- Docs: ARCH-5 note on the runtime module map updated.

## 2026-10-07 — Wave 4 integration (dashboard, feeds, fulfillment, landing, privacy, demo)

- Tracks had stopped mid-task; resumed three at a time (six at once caused
  timing contention). Each agent reviewed the inherited diff, fixed defects and
  ran all five gates before committing on its branch. Notable fixes:
  fulfillment no longer retries create-order on timeout/5xx (double booking),
  retries reuse the attempt (double pay) and resi fetch is a separate read-only
  job; feeds got a 60/h per-store fetch limit; privacy export drops internal
  shipping cost/margin; demo seed refuses non-loopback hosts and `*_e2e`, and no
  longer writes the platform margin rule (leaked into 4 tests).
- Shared fix found by dashboard: 13 Seller nav entries overflowed at 1440px
  (`ui.spec` failed on every wave-4 branch) → `md:flex-wrap md:overflow-visible`
  in `admin-shell.tsx`, identical on all branches.
- Merges (`--no-ff`): dashboard `258b9c6`, feeds `6393c70`, fulfillment
  `1d94691`, landing `c0816b6` (storefront under `s/[store]/(shop)/`;
  `moduleForRoute` strips route groups), privacy `e580b64`, demo `c1adf27`.
  Orchestrator review: dashboard queries via `inStore` + `scope.storeId`; feed
  tokens hashed, constant-time compare, platform-pool resolver; Mengantar writes
  locked in the client; demo local-only guard.
- Migrations: track files replaced by `0008_wave4.sql` (generated; shipment,
  feed_token, landing_page, landing_page_revision, order_redaction) and
  `0009_wave4_rls.sql` (hand-written RLS kept verbatim per track); statement
  sets compared against the track files; throwaway DB 31 policies.
- Accepted ceiling D-10: `bukalaris_app` UPDATE on store-less `mail_outbox`
  (dev sink) for redaction; revisit with a real mail provider.
- Results on `main` (`c1adf27` + docs): `pnpm verify` exit 0 — lint 0,
  typecheck 0, Vitest 186 passed (21 files), build 0, Playwright 92 passed +
  2 skipped; `pnpm verify:docker` exit 0 (42 tables, 31 policies, health 200,
  HEALTHCHECK healthy). Two worker `relation "job" does not exist` lines appear
  only while e2e setup recreates its DB.
- Docs: ARCH-5 Pending rows → Implemented (+ HTTP-16 buyer export, JOB-07
  shipment jobs), TASKS T-39..T-43 Done, STATUS, DECISIONS D-10, RUNBOOK,
  DEPLOY-COOLIFY env rows, privacy/observability/UX/openapi/DEMO sync;
  `check-spec.py` PASS.
- Open: `.env.example` lacks MENGANTAR_PICKUP_ADDRESS_ID/TIME_ID,
  ALLOW_COD_BOOKING, BUYER_DATA_RETENTION_DAYS (file blocked by the local
  permission settings); `shipment` not yet in the privacy inventory; dashboard
  `(store_id, created_at)` index deferred; demo content for wave-4 features;
  track open issues in `docs/tracks/*.md` and TASKS.

## 2026-10-28 — T-51 restructure and T-70 exact-host dispatch (local, uncommitted)

- T-51 (move-only): `apps/web/src/app` moved into surface route groups; `packages/db/src` into bounded contexts (see
  AGENTS.md "Layout"); imports, `package.json` exports, tests and ARCH-5 locators updated (208 path tokens rewritten by a
  script that only rewrites a token when exactly one new location exists). Route manifest 64 before and 64 after, 0 URL
  differences; `drizzle-kit generate` → "No schema changes"; no file changed under `packages/db/drizzle`.
- Regressions found and fixed on the way: a reserved-slug edit dropped `body` from `pageInput` (`content.spec` showed
  `Unrecognized key: "body"`); `ops.spec` seeded through the old `src/ops.ts` path; the `ops.test.ts` route walk and the
  `landing.test.ts` route-group case used the flat paths. Catalog: product ids and `<slug>-<catalogId>` lookups in
  `seller/commerce/catalog.ts` with a new case in `catalog.test.ts`.
- T-70: `platform/host.ts` (reserved labels, `resolveHostSurface`, pure `dispatchHostPath`, per-surface origins and cookie
  names), `proxy.ts` on top of it, one Better Auth instance per surface (`lib/auth.ts`), host-selected auth route with
  Origin / Fetch-Metadata checks, `__Host-` names for store and cart cookies, per-surface link origins (feeds, invitations,
  order-status links, checkout handoff, product URL). Owner console renamed from "Bos" to "Owner" in titles and shell.
- Findings while verifying: `NextResponse.rewrite` to `/_not-found` yields a real 404 (checked over HTTP); my bare
  `/o/` and `/r/` prefix tests silently never matched (caught by the golden table); the CSRF guard rejected the e2e
  helper `enrolTotpViaApi` because `page.request` sends no `Origin` (helper now sends it; the guard is the intended
  behaviour); the host-mode server first used `E2E_PORT + 1`, which `ops.spec` also uses (now `+ 3`).
- Results (working tree after the last edit): `pnpm map:check` ok (64 route files, 72 rows); `pnpm lint` and
  `pnpm typecheck` clean; `pnpm --filter @bukalaris/db test` 22 files / 229 tests passed; `pnpm build` ok;
  `pnpm --filter @bukalaris/web e2e` 101 passed, 2 skipped (11.3 min) including the new `host-mode` project.
- Not run / open: `pnpm verify:docker`; session-bound CSRF tokens; custom-domain resolver cache (T-15); pre-activation
  check for existing stores on reserved labels; narrative docs still citing pre-move flat paths; nothing committed.

## 2026-10-28 — T-61 variant weight and parcel weight (local, uncommitted)

- `variant.weight_grams` (migration `0010`, backfill 1000 g, default dropped), required in the seller forms and service
  input; `parcelWeightKg` is the single weight rule for quote, order snapshot and booking (old "1 kg per cart line" rule
  and `CartForShipping.items` removed).
- Behaviour change on purpose: a line of 2 units now weighs 2 kg (fake JNE COD fee Rp 22.500, was 17.500). Five unit
  tests and three e2e specs (`purchase`, `channels`, `catalog`) were moved to the new numbers after checking each
  difference against the rule, not by copying received values.
- Results: lint, typecheck clean; `drizzle-kit generate` no further diff; DB 22 files / 232 tests passed; Playwright full
  run before the spec updates 93 passed / 8 failed; affected specs re-run green afterwards; `privacy.spec` had an
  ambiguous `getByRole("alert")` (form error plus Next route announcer) that failed intermittently on mobile-320 and is now
  scoped to `main`. The full suite was not re-run after the fixes.
- Open: Mengantar rounding and minimum weight UNVERIFIED; Storefront API weight not exposed; nothing committed.

## 2026-10-28 — Documentation gate before more code (docs only, uncommitted)

- Owner confirmations recorded as DECISIONS D-20 (T-59, T-60, T-61, T-70 accepted; ADR-0006..0010 accepted, ADR-0011/0012
  still Proposed; operator tables separate; OPEN-F4 and OPEN-B1 decided; quality bar versus Tokophi). Code backup outside the
  repo: `~/Documents/work/notes/bukalaris-code-wip-2026-10-28/`.
- Mechanical doc repairs (authorised): review ids `CR-<fam>-nn` → `CR<fam>-nn` (159 occurrences, 13 files), 5 malformed
  tables, one-line `Done when:` for 20 tasks. `check-traceability.py` legacy findings 92 → 0; planning stage 114 → 22
  (all in `CONTEXT-RECORD.md` claim metadata and `ARCH-1` review metadata). `check-spec.py` PASS, `map:check` ok.
- Semantic review by two read-only scouts found stale text; D-20 propagation applied (billing, UX, data model, IAM, ADR-0006,
  DEPLOY, routing, task headings). Not applied, awaiting owner approval: PR status updates, D-15 stale hybrid/System A text
  in 02-PRD, ADR-0006:13 and ADR-0009:93, T-48 title, multi-app table in 04, SLA disclaimers, `BETTER_AUTH_URL` in RUNBOOK,
  "Super Admin" residues, `mail_outbox` data-model entry, `CONTEXT-RECORD.md` CTX-5 (says no repository exists).

## 2026-10-28 — Document alignment A-L applied, 99ribu studied (docs only, uncommitted)

- Owner approved A-K and accepted ADR-0011/0012 (DECISIONS D-21). 99ribu was surveyed read-only by four scouts: it has no RLS, a
  single-tenant consignment model and no Mengantar integration; reusable patterns (unknown-outcome state, `markDispatched`
  fence, evidence anti-reuse, claim lease, single-use proof, session-bound MFA, retention guards) are recorded as acceptance
  assertions on T-37, T-49, T-60, T-62 and T-74 (each needing a named test), with the do-not-copy list in D-21.
- Ledger stays single-entry (ADR-0006) with a consistency-invariants contract (DATA-7) and a future `pnpm verify:ledger`; the
  AutoLaris callback policy is verify-by-pull (ADR-0006 decision 6, BILL, DATA-7, T-49). Neither is implemented.
- Two document agents edited disjoint files; I re-checked the results: `check-traceability.py` 0 findings at legacy, research,
  planning and ready stages (was 92 at the start of the day), `check-spec.py` PASS, `map:check` ok. `mail_outbox` columns were
  compared with `schema-accounts.ts` and migrations. No code changed in this step. Nothing committed.
- Next: T-59 and T-60 (code), then T-74, T-62, T-49, T-37, T-48.

## 2026-10-28 — Goal Mode wave 1: T-59 expand, T-60, T-74 (uncommitted working tree)

- Delivered by three isolated child tasks (T59Rls, T60Capabilities, T74Jobs), integrated one at a time by the conductor (order
  T-59 → T-74 → T-60) into ONE migration `0011_chain_a_foundation.sql` (generated structure, then the hand-written T-59, T-74 and
  T-60 sections; `UPDATE job SET status='dead' WHERE status='failed'` right after the constraint drop). Child reports:
  `docs/tracks/t59-rls.md`, `t60-capabilities.md`, `t74-jobs.md`. The T-59 contract step stays in `packages/db/drizzle-pending/t59-contract.sql`
  (not applied by any tool; proven on a scratch schema by `rls-contract.test.ts`).
- **Independent review (separate read-only agents; the implementer never reviewed itself).** `RevRlsMigration` (security-reviewer):
  1 P1, 5 P2, 3 P3. `RevCapabilitiesJobs` (reviewer): 6 P2, 2 P3, no capability or MFA bypass found for a seller or operator.
  The P1: the platform login could write `retention_policy` and then call `retention_purge_audit_log`, erasing audit history.
- **Fixed in the tree:** P1 (platform has SELECT only on `retention_policy`; periods only through the owner-side
  `retention_set_period()` that re-checks `ops.jobs.manage` and appends `retention_policy_event`); `ops.jobs.manage` enforced in
  `requeueDeadJob`, `resolveUnknownJob`, `rebuildProjection`, `setRetentionPeriod`; approval payload readable by the approver
  (`approval_request.payload_canonical`, hash CHECK, immutable); last-holder counts standing grants only; `effect_absent`
  resets `attempts`; worker uses the database clock, calls `reconcileUnknownJobs`, health reports `skewed`; approval and break-glass
  guards are SECURITY DEFINER with a pinned search_path; break-glass approver must hold `break_glass.approve`; platform SELECT on
  `collection`, `page`, `media` (Owner store detail would have broken at the contract step); shell registry compares search_path per
  function kind; `getOrderForLink` uses `resolveOrderStore`; nested store contexts restore the outer setting; DEPLOY-COOLIFY role
  bootstrap now lists the five roles; ADR-0005 states the GUC-context limit. Regression tests: `packages/db/test/review-findings.test.ts`
  (12 cases) and a wider `rls-contract.test.ts` scenario. Vacuous assertions from the review were removed.
- **Deferred, written into TASKS (T-59, T-60, T-74, ledger):** T-59 contract application and production role bootstrap, T-59b
  (operator tables restricted), T-59c (audit-writer GUC and buyer identifiers as definer functions), log-table partitioning,
  break-glass duration CHECK, four-eyes on `shipping.margin`, retention periods, a DB-level MFA-hook test.
- **Evidence (this tree):** `pnpm lint` and `pnpm typecheck` clean; `pnpm --filter @bukalaris/db test`: 29 files, 396 passed;
  `pnpm build` ok; `pnpm verify:docker`: 54 public tables, 31/31 policies, 0 registry differences, health 200, healthcheck healthy;
  restore rehearsal on the earlier tree only (not rerun after the fixes).

## 2026-10-28 — Goal Mode wave 2: T-62, T-49, T-65, T-73 (uncommitted working tree)

- Four isolated children (T62Console, T49AutoLaris, T65Tax, T73Mailer) started from an overlay of the wave 1 tree; their
  deltas were applied one at a time. Migration artefacts were not applied: the four structural parts were regenerated once
  (`pnpm generate` over the combined schema) and the four hand-written `-- =====` sections appended in the order T-73, T-65,
  T-49, T-62 (T-62 last because its `retention_set_period` replaces the wave 1 definition and keeps the audit_log/access_event
  refusal). Every child's generated prelude was compared statement by statement with the combined output (0 differences).
  Result: one migration `0012_chain_a_wave2.sql`; the T-59 contract file was regenerated from the registry (54 grants).
- **Independent reviews (separate read-only agents).** `RevPayments` (T-49): 1 P1, 2 P2, 4 P3. `RevPlatformWave2` (T-62, T-65,
  T-73): 0 P1, 3 P2, 10 P3. P1: the platform login could rename a store to `demo-*` and call `reset_demo_payments()` to erase
  payment evidence. Fixed: no login role may execute it (the demo seed uses the owner connection), registry `execute: []`.
- **Other fixes with named tests:** app-role inserts start pending/empty on a non-COD order of the same store (definer guards),
  later payment events only from the worker role, no raw callback body for the app role (column grants), callbacks capped per
  attempt, the callback route verifies the signature before rate limiting (unsigned traffic cannot fill the shared counter),
  every transfer approval row shown is a recorded `full` access event, the database stamps the tax policy confirmation time,
  NULL-safe bracket check, review evidence only with a status change, key-id format on reseal, wider literal scan, local mail in
  production requires every surface origin on loopback, dev outbox needs a loopback host, recipient/subject header safety,
  role allow-list in `mail_enqueue`, privacy export keyed by `order_id`.
- **Deferred (in TASKS on each task):** live adapter wiring through one factory, refund obligation on cancelling a gateway-paid
  order (T-37), DB-level lock on withholding flags until T-67, staff and access screens (need T-59b), mail provider (Q-16).
- **Evidence:** before the fixes: DB 614 passed, build ok, `verify:docker` 70 tables / 38/38 policies / 0 registry differences,
  Playwright 127 passed + 2 skipped. After the fixes: lint, typecheck, `map:check` clean, DB suite 39 files / 622 tests passed;
  build, `verify:docker` and Playwright are rerun after wave 3.

## 2026-10-28 — Goal Mode wave 3: T-57, T-37, T-63, T-50 (uncommitted working tree)

- Four isolated children (T57Buyer, T37Ledger, T63Accounts, T50Subscription) started from an overlay of the wave 2 tree; deltas
  applied one at a time (rejected hunks merged by hand: registry, scoped.ts, schema/index/worker exports, seed-demo, rls-contract).
  The four structural migration parts were regenerated once and the four hand-written sections appended in the order T-57,
  T-37, T-63, T-50 (every child's generated prelude compared statement by statement with the combined output: 0 differences) =
  `0013_chain_a_wave3.sql`. T-37 stopped at its working budget (no pages, no mutation checks); a second isolated child
  (T37Finish) completed it and fixed the review findings: `0014_t37_finish.sql` (replaces nine 0013 guard definitions with
  CREATE OR REPLACE; kept as its own migration because it is a separate delta).
- **Independent reviews (separate read-only agents).** `RevLedger` (T-37): 1 P1, 1 P2, 6 P3. `RevWave3Other` (T-50, T-57, T-63): 0 P1,
  2 P2, 6 P3. P1: the release job only looked at the first 200 stores that had any pending row, so later stores never released
  their sales. P2 (ledger): a payout whose transfer outcome was unknown could be claimed again after the lease and then rejected by
  the claimant with a typed reference, re-crediting money that may have left. P2 (billing): one operator-created invoice for a far
  future period, paid at the monthly price, moved coverage years ahead (a comp without four-eyes). P2 (accounts): the platform login
  could insert a recovery link with a token hash it chose and call the MFA-reset function with any operator id.
- **Fixed with named tests:** all of the above (`t37b-review.test.ts`, `review-wave3.test.ts`, `t50-invoices/payments`), plus: a lapsed
  period cannot be paid by id, a case without a subject authorises no target, the platform login has no INSERT on
  `support_recovery_link` (`support_recovery_create()` owns creation), `console_reset_user_mfa` needs an executed four-eyes approval
  for owners and staff, `finance.read` stays usable while read-only, `wipeLocalDatabase` retries a deadlock (Playwright starts the
  worker before its global setup and the scheduler transaction raced the schema drop).
- **E2E specs changed because behaviour changed on purpose:** `orders.spec` (the seller no longer completes an order: T-37 D-14),
  `privacy.spec` (lookup key is the canonical 62… form: T-57), `t57.spec` back-dates and cancels the Toko B orders it creates so
  `dashboard.spec`'s empty store stays empty.
- **Deferred (in TASKS on each task):** T-50 one unique index per (store, period) across kinds + live-instruction check in `grantComp`,
  seller security clean-up while read-only (needs add/remove capability split), T-57 resolver flag hard-coding and platform UPDATE
  column limit, rate-limit key spellings; owner decisions: payouts while unpaid, existing-store trial, T-37 cashback/COD fee/VAT.
- **Evidence (final integrated tree):** `pnpm lint`, `pnpm typecheck`, `pnpm map:check` (89 routes), `check-spec.py` and the traceability
  checker (0 findings) clean; `pnpm --filter @bukalaris/db test`: 57 files, 1005 tests passed; `pnpm build` ok; `pnpm verify:docker`:
  107 public tables, 57/57 policies, 0 registry differences, health 200, healthcheck healthy; full Playwright: 164 passed, 1 failed
  (dashboard.spec desktop, caused by t57's Toko B orders, fixed afterwards; `t57.spec` + `dashboard.spec` rerun: 10 passed, a full rerun
  is not done after that one-line fix); restore rehearsal on the populated e2e database: 107 tables, counts match, policies 57/57/57,
  0 registry differences, rls_ok=yes; `pnpm verify:ledger` clean on test, e2e and a seeded demo database (T37Finish).

## 2026-10-28 — Goal Mode waves 4 and 5: T-46, T-48, T-68, T-45, T-47, T-52 (uncommitted working tree)

- Wave 4 (T48Mengantar, T46Promotions, T68Issues + a read-only review of the T-37 finish build) → migration `0015_chain_a_wave4.sql`.
  Wave 5 (T52Affiliate, T45T47, T48Fix + reviews of T-46/T-68, T-48, T-52, T-45/T-47) → `0016_chain_a_wave5.sql`. Both folded the same way
  (generated structure once, hand-written sections appended, every child's generated prelude compared statement by statement: 0 differences).
- **Review results:** T-37 finish 1 P2, 8 P3; T-46/T-68 1 P2, 7 P3; T-48 1 P1, 2 P2, 7 P3; T-52 2 P2, 5 P3; T-45/T-47 3 P2, 6 P3. Every P1/P2
  fixed with a named test; cheap P3s too; the rest recorded as DEFERRED on the task.
- **The P1 worth remembering:** migration 0015 failed on any database that already had orders (three compound foreign keys were validated
  before the backfill). The suite never saw it because test databases are migrated empty. Fixed with `NOT VALID` + `VALIDATE` after the
  backfill and proven on a copy of the populated dev database (64 demo orders, migrations 0011 to 0016 applied: all orders carry their
  account, registry differences 0). Open finding from the same run: orders created before migration 0013 have no financial snapshot, so
  `verify:ledger` reports them (`order_without_financials`); only dev data is affected (nothing is deployed), reseed or backfill is an owner call.
- **Other fixes:** step-up code limiter counts only failed codes (slot taken atomically first, given back on success); a double submit of one
  request returns the one order (voucher counters); free-shipping threshold never blocks a checkout; every phone spelling counts once for
  the per-buyer cap; the issue guard covers INSERT and report identity; tracking resumes by itself after an account recovery; the platform
  shipping discount is never paid by the seller (frozen on the snapshot, recomputed by `verify:ledger`); the checkout session clocks belong
  to the database; a redacted order keeps no provider free text; WhatsApp only to canonical `628…` numbers; self-referral fails closed;
  the click limiter no longer lets noise spend a link's budget.
- **Evidence:** DB suite 73 files / 1384 tests passed (before the last review fixes, whose test files were rerun: t45, t47, t52, privacy,
  fulfillment all green); `verify:docker` 133 tables, 75/75 policies, 0 registry differences; populated-database upgrade as above;
  lint, typecheck, `map:check`, `check-spec.py`, traceability (0 findings) clean. Full DB suite, build and Playwright are rerun on the
  final tree and recorded below.
- **Final evidence on the last tree (2026-10-28):** `pnpm lint`, `pnpm typecheck`, `pnpm map:check` clean; `pnpm --filter @bukalaris/db test`
  73 files / 1388 tests passed; `pnpm build` ok; full Playwright **207 passed, 2 skipped, 0 failed**; `verify:docker` (133 tables, 75/75
  policies, 0 registry differences, run before the last review fixes) and the populated-database upgrade (run before them as well) are
  not repeated on the final tree; `python3 docs/check-spec.py` and the traceability checker pass (0 findings).

## 2026-10-28 — Hosting direction, UI/UX review pass, status audit (after the Goal Mode commits `302cfa4` and `2ddf5d2`)

- **Hosting direction recorded (DECISIONS D-23, `docs/DEPLOY-COOLIFY.md`):** Vultr (Singapore) + Coolify v4 (Postgres 17) + Cloudflare; no Supabase;
  Cloudflare proxied with an Origin CA certificate, SSL Full (strict); `CF-Connecting-IP` trusted only behind a Cloudflare-only origin firewall.
  The owner chose NOT to deploy yet: polish the local build first; the domain is not bought; nothing is provisioned. The env-variable inventory
  of the deploy doc now lists the 17 variables the build reads since M3 chain A plus `CLIENT_IP_HEADER`.
- **Small hardening done locally:** `CLIENT_IP_HEADER` (`packages/db/src/platform/client-ip.ts`, test `client-ip.test.ts`, 3 cases): exactly one
  client-IP header is trusted, a typo fails loudly.
- **UI/UX review-and-polish pass** (three isolated children, rubric: repository design system + `admin-dashboard`, `ui-validation`, `design-taste`):
  `UxSeller` (Seller Admin, 21 routes), `UxConsole` (Owner console, 27 routes), `UxPublic` (storefront, checkout, order status, identity, error pages).
  Presentation, copy and accessibility only; no business logic, money math, authorization or schema changed. Reports: `docs/tracks/ux-uxs.md`,
  `ux-uxc.md`, `ux-uxp.md`; screenshots under `docs/evidence/ux/{uxs,uxc,uxp}/`. Reported results: geometry audit clean on the changed routes (the
  remaining exit codes come from the repository's two-row header and 28px/24px small buttons, listed in the reports), no horizontal overflow at
  320/390/1366/1536, no console errors, Playwright of the touched specs green per child (104 + 95 + 109 passed), `tells-scan` exit 0. Public pages:
  `design-gate.py` reached `PASS` on refs and critique but exit 1 on its external `review` step, which could not run in a worker; the design review
  by a model or by the owner is therefore NOT done and visual acceptance of the public pages stays open.
  Notable fixes: the checkout capture notice moved above the typed fields on 320px, discount rows (goods and shipping) on checkout and order pages,
  seller navigation regrouped by workflow, payment axis separated from order status, mobile priority columns, 24px minimum targets, tabular numerals,
  Indonesian copy for status and event labels, forms moved to the shared components, a visible reveal banner in the Owner console.
  `LOCAL_SEED_OPERATOR_CAPABILITIES` (local seed only) gained the money and billing capabilities so the demo operator can open every console page.
- **Status audit** (`AuditPartial`, docs only, `docs/tracks/audit-partial.md`): the old 'Partial' and 'Planned' statuses of T-2, T-3, T-4, T-5, T-6, T-7,
  T-9, T-10, T-11, T-15, T-16, T-17, T-19, T-20, T-33 were re-checked against the code of 2026-10-28; each keeps its remaining work and blocker type;
  `docs/openapi.yaml` and the ARCH-5 rows for the Storefront API and channels were synced.
- **Deferred from the UX pass:** typed recipient fields are lost on a failed non-JS checkout redirect, collection sorting and the stale-price cart banner
  (feature scope), QR rendering on the security page (dependency ceiling), live SQL for five planned dashboard cards, pointer-pick mode of 'Lapor masalah',
  a grouped Seller navigation (an existing e2e pins the single strip), invoice CSV export (T-71/T-66).
- **Not committed:** all of the above is in the working tree on top of `2ddf5d2`. The commit authorisation of this session was used up by the two commits above.
- **Evidence on the UX-polished tree (parked):** `pnpm lint`, `pnpm typecheck`, `pnpm map:check`, `check-spec.py` and the traceability checker pass;
  `pnpm --filter @bukalaris/db test` 74 files / 1391 tests passed. `pnpm build` and the FULL Playwright suite were started on this tree and stopped
  at the owner's request before they finished: the full suite is NOT verified on the UX-polished tree (each child ran the specs of the pages it touched,
  see its report). Run `pnpm build && pnpm --filter @bukalaris/web e2e` first when work resumes.

## 2026-11-01 — Portfolio scan and documentation pass (docs only, no code changed)

- **Scope:** owner asked to scan the related projects (TokoΦ first, Etalashop snapshot, 99ribu, GeraiExpress, CMSPRO,
  PunyaSitus, owner memory) and use the result to perfect the Bukalaris documents. Output and method:
  `docs/research/2026-11-portfolio-scan/README.md`, six source reports in `sources/`, four verification batches in `verification/`.
- **How:** six read-only extraction lanes (`ai-ask claude`; the Codex lanes failed because its `bwrap` sandbox cannot create
  namespaces on this host and were rerun), then 88 P1 findings verified against Bukalaris code first and docs second by four
  read-only Pi agents (`9router-fantastico/cc/claude-sonnet-5-5`, tools `read,bash`). The orchestrator re-checked every conflict
  and corrected three agent conclusions (password reset does revoke sessions; `completed` already has a single provider/four-eyes
  writer; the 30-line cart cap is enforced).
- **Checked by reading code (not executed):** every schema table is in the isolation registry (asserted both ways by `rls.test.ts`) and every
  tenant table carries `store_id`; `/api/ready` runs only `select 1`; both QRIS screens render the raw payload in a text area; no migration journal check
  and no off-box probe script exist.
- **Adopted into owners:** SEC-25 (12), DEL-2 migrator traps and the provider-fixture row (15), DR-1 monitoring and backup lessons
  (14), BILL-2 provider timeout and anomaly rules (11), UX-12 QRIS contract and the mutation outcome rule (17), RUNBOOK
  pre-production rows; tasks T-76 to T-79 (TASKS.md). Conflicts fixed: 14 `/api/ready` wording and the missing probe script,
  02-PRD Q-10, the ADR-0005 amendment status, the README scope paragraph and the STATUS header.
- **Not done:** no test, build or database run for this pass; P2/P3 findings stay in the research README; the owner-decision
  candidates (anomaly queue, per-store COD conditions, consent unbundling under PP 33/2026) are not decided.

## 2026-11-01 — Full read of TokoΦ and Etalashop (docs only)

- Owner asked for a complete read before the decision list. Twelve parallel read-only Pi lanes
  (`9router-fantastico/cc/claude-sonnet-5-5`, tools `read,bash`) read the whole TokoΦ Markdown corpus
  (`~/Projects/tokophi-consolidate`: about 63,000 lines across `BUILD-LOG`, `CHANGELOG`, `AGENTS.md`, root records,
  `specs/**`, `apps/**`) and diffed the Etalashop snapshot. Every lane has a coverage table showing lines read = lines total.
- Result: 554 new findings (139 P1). Etalashop is an older strict subset of TokoΦ. A synthesis agent reduced the P1s
  to 84 unique lessons checked against Bukalaris code and docs. The orchestrator re-verified the two new code-level gaps:
  the app role's table-wide `UPDATE` on `store` (U65) and the product edit writing `stock` (U64).
- Output: `docs/research/2026-11-portfolio-scan/full-read/` (12 lane reports plus `SYNTHESIS-P1.md`); summary in the
  research README; resume point in `STATUS.md`. Owner documents are not changed by this step. Applying the lessons waits
  for the decision list (D-24).
- Checks: traceability PASS (105 files, 0 findings) after escaping in-cell pipes and relabelling a TokoΦ ADR id in the raw
  reports; `check-spec.py` PASS; `map:check` ok. No test, build or database run.

## 2026-11-04 — Review alignment, development follow-ups and system-map guard

- Owner asked to apply review recommendations, turn missing work into development tasks, and improve the system map. Scope: documentation and map-check tooling on the dirty tree over `2ddf5d2`; no application behavior, database, live provider, credentials, deployment, commit or push changed.
- Reconciled current-status gaps while preserving dated evidence. PRD Q-1/Q-5/Q-6 and Q-12 to Q-16 distinguish decided direction from unresolved commercial/provider facts; duplicate business-question rows consolidated. Corrected stale T-52/wave review wording and completed UX subitems. D-24 records candidate dispositions without accepting unresolved business policies or ADRs.
- Added T-80 to T-94 (94 total): stock lost-update protection, store-column grants, CSRF, shared auth limits, worker/cleanup Docker proof, fresh integrated verification, spec/API reconciliation, complete research triage, and gated reservation/KPI/rate-limit/anomaly/parcel/onboarding/HSTS work. Each has one primary, dependencies, allowed paths and runnable completion criteria; sensitive implementation requires independent review. Remaining full portfolio triage is T-87, not done by this pass.
- ARCH-5: exact entry paths replace route abbreviations; HTTP-23 appears once; SA-17 links to SA-03 rather than claiming its page. Eighteen existing job/framework entries moved from the future register with local/fake/OFF qualifiers; mail delivery/purge, console bootstrap and read-only ledger verification gained JOB-34..JOB-36. JOB-33 is an hourly disabled stub that throws if enabled, not provider reconciliation. JOB-23 covers shipping reseal only. Corrected cleanup cadence (at least every 15 minutes), absent cleanup heartbeat and implemented worker scheduler in map/deploy notes.
- The map guard no longer accepts URL-only or ambiguous suffix coverage. It checks exactly one implemented owner per route, URL/path agreement, table shape, duplicate IDs, known tasks, concrete test/command locators and background source files; future rows cannot conceal code. This is structural proof, not runtime/provider/exported-symbol proof. `map:check` runs native `node:test` fixtures first; no dependency added.
- Executed: `pnpm map:check` PASS, **14 passed / 0 failed / 0 skipped**, then **102 route files / 124 current rows / 117 Implemented**. Deliberately broken fixtures prove missing/unmapped/phantom paths, duplicate IDs/owners, malformed columns, wrong URL and missing task/test/background references are caught. `python3 docs/check-spec.py` PASS (50 paths / 63 operations); installed `check-traceability.py docs` PASS (105 files / 330 declarations / 94 tasks / 0 findings). Node syntax checks and `git diff --check` scoped to this pass's tracked files PASS; checks rerun after final map edits with the same counts.
- Limits: TypeScript LSP could not initialize because workspace-root TypeScript resolution failed; packages already declare TypeScript, so configure `tsserver.path` or workspace resolution before claiming diagnostics clean. No full lint/typecheck/application DB suite/build/E2E/Docker run (T-85). Repository-wide `git diff --check` found a pre-existing blank line at EOF in untouched `docs/14-SLA-DISASTER-RECOVERY.md`; left intact. No independent runtime/design review performed.

## 2026-11-04 — Approved backlog commit/push preparation

- Owner explicitly approved commit and push of the complete pending backlog. Staged source, documentation, portfolio research and track reports; excluded `docs/evidence/**`: rewritten baseline PNGs are excluded by AGENTS.md, and new UX captures remain local pending artifact/privacy review (notably dev outbox, recovery and revealed-account screens). Nothing was discarded.
- Reviewed staged scope: 141 text files, no binary/credential files. Gitleaks 8.30.1 scanned both the tracked diff and new text files, then the complete staged diff (~1.34 MB): no leaks found. The mise shim lacked a selected version; used the already installed version directly, without changing system configuration.
- Re-ran before commit: `pnpm map:check` PASS (14 fixtures, 102 routes), `python3 docs/check-spec.py` PASS, installed traceability checker PASS (94 tasks / 0 findings), `pnpm lint` PASS and `pnpm typecheck` PASS. Full application tests/build/E2E/Docker not rerun; T-85 stays Planned. LSP workspace initialization failure does not mean the package-script typecheck failed: both package TypeScript checks passed.
- Inspected `.github/workflows/ci.yml`: push to main triggers verification/image CI, not deployment. No CI completion or remote push is claimed by this preparation entry.

## 2026-11-04 — Owner-approved repository publication

- Backlog commit `70a97c1` was pushed to `origin/main`; local HEAD and `git ls-remote origin refs/heads/main` matched `70a97c19a698719552672ee59a07e645b44db9a2`.
- Owner explicitly chose a public, not private, repository. Before the visibility change, redacted Gitleaks history scanning reported repeated generic-api-key candidates. Historical source-context classification found 203 mock/canary detections and 29 test idempotency UUID detections across six test files; matched values were not printed. This is a scoped heuristic text scan, not an exhaustive binary-artifact or credential-validity audit.
- Executed `gh repo edit ongkipro/bukalaris --visibility public --accept-visibility-change-consequences`; verified `gh repo view` returned `visibility: PUBLIC`, `isPrivate: false`. This is publication authorization, not permission to expose secrets, push subsequent development commits or deploy. Existing local screenshots and `.pi/` runtime artifacts were not committed or uploaded.

## 2026-11-04 — T-80 stock-safe variant editing (verified locally)

- Worktree `~/Projects/bukalaris-wt/t80-stock-safe-edit`, branch `task/t80-stock-safe-edit`, base `70a97c1`. Owner authorized task-by-task implementation, independent review, contract/map/log maintenance and local commits. No new push or deploy authorized.
- Traced every `updateVariant` caller and the existing `adjustStock` path. Added real PostgreSQL lock-barrier regression `preserves a sale decrement when a stale variant edit waits behind checkout`. Old code failed with expected stock 4, received 5; existing five catalog tests passed. The test follows indirect lock waiters recursively, releases its barrier in `finally` and drains pending operations rather than relying on elapsed sleeps.
- Catalog edits now validate optional legacy stock but explicitly write metadata only. Creation still requires initial stock; server actions extract it only for creation. Existing stock is read-only in the editor, linked to the existing audited signed-delta inventory flow. No migration, new dependency or provider activation. Catalog snapshots use the post-sale stock and do not invent stock-only change events.
- Focused DB checks PASS: 6 files / 59 tests (`catalog`, `orders`, `tenant-isolation`, `checkout`, `shipping`, `t50-access`), using local disposable `bukalaris_t80_test`. Existing tests prove audited, authorized, non-negative adjustments and cross-store denial. Lint initially passed. Typecheck exposed unsupported test `Promise.withResolvers`; replaced with typed ordinary promises without changing compiler targets. Typecheck then passed. LSP initialization still fails to resolve workspace TypeScript; use a valid `tsserver.path` in the LSP configuration before claiming LSP success.
- Independent read-only reviewer found the known test typing blocker and a sub-24-px inventory link. Both fixed; link is `min-h-6` and its E2E measures at least 24 px. Follow-up reviewer closed both at source level with no issues found; runtime gates remain the parent's responsibility.
- Setup evidence/limits: offline dependency install lacked a cached pinned esbuild tarball; lockfile install from registry succeeded without manifest/lock changes. The local compose DB was started and checked healthy; the first test attempt hit ECONNRESET before readiness, then real tests ran. Safety Net blocked `.env` creation; no retry or environment-file workaround was performed. Production build without an environment file passed. First browser run could not launch the pinned headless binary (16 launch failures, 2 non-browser passes), not application regression evidence. The pinned browser was installed only to the user cache, with no system packages; subsequent E2E uses disposable `bukalaris_t80_e2e`, public test-only placeholders, port 3300 and fake providers.
- Updated ARCH-5 SC-03/SC-04 and data/UX contracts without adding routes or changing ownership. Guards PASS: `pnpm map:check` (14 fixtures; 102 routes / 124 current rows / 117 implemented), API spec checker (50 paths / 63 operations), traceability (106 files / 330 declarations / 94 tasks / 0 findings, including the T-80 report). Subsequent final lint/typecheck/build PASS; browser slice PASS 18/18 at 320/1440 px. Opened both T-80 captures: static existing stock, separate initial-stock control, readable inventory link, no changed-area clipping/overflow. Initial history assertion incorrectly matched the creation stock record; scoped it to exactly one variant-update event and separately asserted the creation record remains visible. The first full DB run finished at 1372 passed / 21 failed (74 files), caused by omitted signing/fingerprint fixture values; recovery used public placeholders, with no unrelated application changes. Explicitly mutated the fixed service to write submitted stock: the named barrier test failed expected 4 / received 5. Removed the mutation and confirmed the exact pre-mutation source hash. Restored-pass/environment recovery then PASS: catalog plus all nine previously failing files, 10 files / 134 tests, using the public order-link/auth placeholder values and no unrelated source changes. Final full suite with that environment then PASS: **74 files / 1393 tests**, 683.57 s. Independent final acceptance review also opened both captures and returned visual PASS; its P2 note about stale TASKS/STATUS pending wording was fixed. T-80 is Done locally, not production-ready. Only the T-80 source/contracts/report and two reviewed new captures belong to the local commit; regenerated baselines and runtime artifacts remain unstaged. No further push or deploy authorized.

## 2026-11-04 — T-81 store-column hardening started

- T-80 committed as `dd7511e` with 14 scoped files, reviewed staged diff and redacted Gitleaks pass. Fast-forwarded local main only after proving no overlap with existing local evidence/runtime changes; they were preserved. No push or deployment.
- Created isolated `~/Projects/bukalaris-wt/t81-store-column-grants`, branch `task/t81-store-column-grants`, from `dd7511e`. Traced the two runtime store UPDATE writers: strict app-role settings (`description`, `name`, `theme`, `whatsapp`) and governed platform-role lifecycle (`status`, trigger-synchronized `suspended_at`), plus the historical owner-run suspension backfill. No store UPDATE upsert found.
- Recorded the four-column allowlist, five protected columns, migration/recovery plan and verification ledger in `docs/tracks/t81-store-column-grants.md`. The current settings writer already fits the allowlist; platform grants remain unchanged. The T-59 production contract remains explicitly gated.
- Started pinned offline install and existing RLS/contract/content/lifecycle baseline against isolated `bukalaris_t81_test`, with the complete public fixture environment, before application source changes. Result pending; T-81 remains In progress. No environment file was created or accessed for credentials.
- Corrected the residual Current outstanding work summary that still described the now-closed T-80 lost-update defect; distinguished its new 1393-test/scoped browser evidence from the historical UX-polish run and still-pending integrated T-85 verification.
- Baseline completed PASS: 4 files / 75 tests, 32.50 s; offline install reused all 640 packages. Added the named direct-SQL status denial regression: original table UPDATE grant caused the expected failure (resolved `[]`, not a permission rejection), and fixture aggregation afterward confirmed one suspended and one active store.
- Implemented the four-column registry allowlist and generated permission-only migration 0017 with pinned Drizzle Kit 0.31.11. Verified append-only journal, increasing timestamp, correct snapshot link and complete normalized snapshot equality excluding identity/linkage. Regenerated all 111 platform GRANT statements: identical to the unchanged pending T-59 contract. Effective-column shell parity and negative grant-drift tests reuse the registry; no new role, app writer, route or UI change.
- Independent R4 source review returned no actionable P0/P1/P2 findings, OK with notes; runtime tests, populated clone and Docker proof remain pending. Updated TEN-3, security/restore boundary and appended an ADR-0005 implementation note without rewriting the accepted decision. Map/spec/traceability/diff guards PASS (14 fixtures; 102 routes; 50 API paths/63 operations; 107 docs/330 declarations/94 tasks/0 findings). LSP still fails to find TypeScript; package-script typechecks are independent.
- First post-fix focused run: 81 passed / 1 failed (4 files, 50.29 s). The identity denial test hit GENERATED ALWAYS rewrite error `428C9` for invalid `id = id`, before ACL evaluation. Changed only the test expression to valid `id = DEFAULT`, retaining expected `42501`, both target stores and unchanged-row checks. Focused/static rerun and independent closure review are pending; the first chained lint/typecheck did not run after the failed test.
- First populated-copy attempt stopped before migration at the protected-field checksum because the copied dev schema lacks `suspended_at`. Catalog/journal inspection: legitimate migration 0009, 42 tables, 10 journal entries. The following parity output reflects that old schema, not T-81 regressions. Preparing only the disposable clone through the unchanged accepted dd7511e/0016 migrator; no original dev change, old-migration edit or journal manipulation.
- Docker PASS: `IMAGE_TAG=t81-store-column-grants pnpm verify:docker`, 154403 ms; web 318 MB/migrate 283 MB. Actual fresh migration and idempotent rerun, 133 public tables, 75/75 policies and zero effective-column/registry differences. Health 200, unknown storefront 404, login 200, HEALTHCHECK healthy, non-root app, media writable; own disposable resources cleaned. No worker/cleanup or whole-app E2E claim. Full DB gate started on separate `bukalaris_t81_full_test` with complete public signing/fingerprint fixtures; implementation source remains frozen pending results.
- Corrected focused gate PASS: 4 files / 82 tests (43.67 s), lint and DB/web typechecks. Independent identity-test closure found no issues and confirmed `id = DEFAULT` reaches mandatory `42501` checks without weakening the assertion.
- Populated baseline preparation PASS through unchanged accepted dd7511e/0016 migrator: 17 journal entries, 6 stores / 55 products / 64 orders preserved. T-81 then applied through the canonical runner and reran idempotently: journal 17→18→18; counts and protected-field checksum unchanged; broad app UPDATE removed, exactly four effective UPDATE columns; complete registry parity PASS. Original dev untouched; no historical migration or journal manipulation.
- Full DB PASS: 74 files / 1400 tests, 873.31 s, on separate `bukalaris_t81_full_test`. After it completed, deliberately appended table-wide UPDATE to the new migration: named status-denial test failed as expected (resolved `[]`). Restored original SQL under EXIT trap and confirmed all six reviewed source/migration SHA-256 fingerprints match. Restored focused gate PASS: 4 files / 82 tests, 68.15 s; diff check PASS. No mutation remains. T-81 is Done locally, with final evidence/commit preparation in progress; T-82 is next. No further push or deployment authorized.
- Final independent documentation acceptance review found no issues, OK with notes. Re-ran map/spec/traceability/diff guards: PASS with 14 fixtures, 102 routes/124 current rows/117 implemented, 50 paths/63 operations, 107 docs/330 declarations/94 tasks/0 findings. Reviewed 13 staged task files, including generated snapshot (normalized equality already checked), no screenshots/runtime artifacts. An optional extra staged-scope/fingerprint/schema assertion was blocked before execution by Safety Net's sensitive-basename exclusion check; it was not retried or bypassed, and no environment file was read. The separate redacted staged Gitleaks scan PASS: 604183 bytes, no leaks.

## 2026-11-04 — T-82 combined-candidate viewport checkpoint (not final acceptance)

- Closed WWW prerequisite only after b6a8a7839 technical proof, final9cf4e59a review and independent b2213c8d P2 documentation closure (no issues, CLEAR). Applied accepted WWW source/harness/specs into the existing T-82 worktree without git merge/commit; all7 transfer fingerprints identical. Registered HTTP-33. Default normalization/private-path gate and original127 transport retained; latest authority forbids commit/push/deploy, T-59/live/non-local gates remain closed.
- b75bfc25b exit0: lint, both typechecks, system-map and clean application build PASS. Requested combined replacement-cart cases320/390/1280 PASS (3 cases,12.0s): substituted capability cannot change recipient quantity1; filtered recovery Notice visible. Named host-mode case PASS (9.9s): explicit GET/HEAD308/absolute apex plus real navigation at320/390/1280. Browser stages serial and load-gated (6.13 deferred until3.09; next suite2.91); no DB integration overlap, old baseline or old hydrated-cart cohort repeat.
- Kept one new diagnostic OPEN rather than claiming clean runtime: Next logged `The destination stream closed early.` digest4188643836 between cart cases. Known worker missing-job/scheduler fixture-reset warnings remain separate, not worker acceptance. Installed RSC source aborts a request when its writable destination closes; an in-memory pending-stream destruction probe reproduced the exact message without network/data effects. This demonstrates a mechanism, not attribution of the original log.
- Test-only readiness correction now awaits matched same-path POST response.finished(), recipient reload response.finished() and native document load before teardown; all denial/state/Notice assertions and3widths preserved. No application change, framework/log suppression, arbitrary delay or weakened assertion. b8ce42677 lint/types/changed-regression gate running, explicit FAIL if early-stream-close appears; unchanged b75 application build reused. b8ce42677 subsequently FAILED exit1: lint/typesPASS;320 timeout90s,390/1280 UNRUN. Whole-response waits unproven/not an accepted fix; teardown obscures awaited position. Independent read-only lifecycle diagnosis2d686aab returned P1/BLOCK for the completion-wait candidate, with request attribution still unproven. Source review confirms document load is not Flight EOF; no application/WWW verdict or Git-object failure. Read full159line report, then applied its bounded diagnosis direction: bd86ba924 one320px case running, named5/8s phases, exact in-memory request finish/fail observations, no sensitive payload logging, preserve primary failure while independently attempting both context closes. No application/build/framework change or POST replay; load gates retained. bd86ba924 FAILED6.4s: phase B addition completion timeout5s, before teardown A finished/B failed, both cart headings visible, both contexts closed; lint/typesPASS/load1.60/2.30/3.63. Original one-off stream log remains unattributed. New one320px bd0950ad4 abort-classification probe running: bounded finish-or-fail event observation, exact browser-abort/document-cart booleans, retain all quantity-beforeNotice assertions, no EOF prerequisite for observing UI. Diagnostic still explicitly fails if any matched action did not finish. No .finished hanging promise, app/build/framework change, sensitive capture/log filter, POST replay or integration overlap. bd0950ad4 FAILED1.6s only at extra all-actions-finished diagnostic; recipientquantity1-beforefilteredNotice PASS. A-addition/refusal200 exactnet::ERR_ABORTED beforecleanup; B-addition200finished, bothcartUIvisible and contextsclosed. B documentnavigation flag includes explicitreload, not causal attribution. No earlystreamclose in either recentprobe; originalb75 log remainsunattributed. Lint/typesPASS/load0.63/1.00/1.15. Follow-up readonlyreview24d3e594 running, no further runtime beforefindings. First resume rejected for options.output beforelaunch; reported/preserved sourcefingerprint and corrected samecallonce with top-leveloutput successfully, no CLI fallback. Follow-up24d3e594 report142lines read: diagnostic P1 CLOSED; all-finished product oracle P2 unsupported, verdict OK with notes for diagnostic disposition only. Removed that assertion, retained observations/security ordering; minimum one320px b6507181d running with exactPOST-perclick/pageerror0 assertions and monotonic resource/nav/terminal timings, no blanket abort exemption or rootcause/benignity claim. Originalb75 stream log remainsunattributed. b6507181d subsequently PASS10.6s (case1.7s), lint/typesPASS, exactPOST counts/pageerror0/recipientquantity1-beforeNotice. Loads0.75/1.11/1.46. Stream-close digest4188643836 recurred between recipientreload1353→1533ms markers, beforecleanup; matchedAfetchaborted704ms, B/refusalfinished1114/1284ms, contextsclosed1611ms. Cross-process stderr order alone is not causal attribution; no clean-server/benignity/root-cause/overall acceptance. Concrete recurrence motivates one320px GET/RSC fixed-metadata probe b4bbcb1e3 running, no rawpayload/header values, app/framework change, other viewport/cohort or integration overlap. #24 retains fullremainingT82proof; #25finalreview pending. b4bbcb1e3 subsequently PASScase1.7s/total10.9s, same semantic/count/pageerror assertions and cleanup. GET/RSC/prefetch terminal-abort metadata captured safely; streamerror recurred. Reused existing onRequestError/reportRequestError and system_log schema; BEGIN READ ONLY aggregate on ownedbukalaris_t82_e2e returned one matching productGET render event (no rawIDs/paths/fields/payloads). Exactbrowsercorrelation/cancellation causeunknown. Independent22835841 report129lines read: P1/P2 CLOSED, noissues, OKwithnotes toclose boundeddiagnostic#30 only; no furtherprobe justified absent concreteproductconsequence. #30closed; #24 resumed for fullremainingT82proof and #25finalreviewpending. No claimbenign/fixedframework/overallacceptance, and no stage/commit/push/deploy.
- Next original-entry mutation experiment prepared/launching: existing cart form invokes original updateCart export, which exclusively selects cartMutation mode=set. Deliberately bypass only that mode's guard; retain add guard. Fixture stock20 allows9; expected named320px recipient assertion1→9 failure. Durable backup/manifest/run.sh at `/home/ongki/Documents/work/notes/bukalaris/t82-cart-original-export-proof/`; syntax/original+backupSHA PASS, mutation not yet applied at preflight. EXIT restoration fingerprint-gated against exact mutant/original (refuse unrelated edits/no git repair); restored build and positive case required before acceptance. No active3282/3285 listeners at preflight. Result bbd431285 exit0: guard-removal check on original updateCart (set mode only; add path kept) made the named 320px recipient check fail as intended (expected "1", received "9"). Source restored to exact SHA256 bdd6f990…ff5b, clean rebuild and the same 320px case PASS (9.5s). Logs/manifest: /home/ongki/Documents/work/notes/bukalaris/t82-cart-original-export-proof/. No residual source change.
- Checkout refusal effects (R4 gap 4, same-store part) PASS ba509ebfe (5.6s case): invalid token proven present in both the capture and the submit POST (boolean check, no payload logged); capture stored 0 contact rows, submit created 0 orders and showed the 'Muat ulang' Notice; reload with the current token captured 1 row and created exactly 1 order. First attempt bf43df1dd failed because the client re-render restored the hidden field before submit (restoredByClient=true, confirmed); the test now re-applies the value and asserts it was sent. That was a test defect, not an application bypass. Cross-store/foreign/closed-cart cookie cases are still open.
- Pending-MFA lifecycle (R4 gaps 1 and 2, pending/challenge-cookie part) PASS be301fee8 (1.6s case), seed user owner-b, disposable DB: the password step issues a challenge without a session. A duplicated challenge cookie gets 403 at issuance. A pending-class token gets 403 on sign-out, two-factor/enable and revoke-other-sessions. Verification with a missing, invalid or duplicated token gets 403 and creates no session. Verification with the current pending token creates the session. After that, the old pending token gets 403 on sign-out and the session is kept. A freshly issued session-class token is different from the pending one and signs out.
- Host-mode store cart host enforcement (R4 gap 3, cart part) PASS b62fa1594 (1.5s case). On toko-a.localhost the hydrated add and update worked (quantity 1→2). The identical captured update, carrying the valid rendered token and asking for quantity 9, left the quantity at 2 when sent with a self-consistent Host/Origin on a different port and on the sibling store host toko-b; the same request on the exact Host changed it to 9 (positive control). First attempt b36286fbb used Host≠Origin: Next.js itself refused it (500, 'Invalid Server Actions request') before the app check, then the test's reload aborted. That is recorded as a framework-layer refusal, not as proof of the app binding. Landing/checkout host-mode success flows are not separately exercised here.
- Nonstandard callers on the combined candidate (R4 gap 5, valid-transport side) PASS bdd540d14: 48/48 in 9.0m at 320px and desktop across existing specs content, t37, feeds (multipart upload), t62, t68 (issue reporting, approvals with fresh code), accounts (invite, operator TOTP enrolment/sign-in) and t37 finance step-up. This proves the legitimate paths still work with the T-82 guards; it does not add new refusal cases for those callers. Two render-side 'destination stream closed early' lines and the known worker job-table fixture errors appeared; no test failed.
- Fresh issuance (R4 gap 6) PASS b26dda1e9 (2.5s case): (1) when the token issuer returns 503 the login form sends no auth POST and shows its error; (2) when another tab signs the session out between issuance and the POST, that POST gets 403, exactly one POST is sent and nothing is replayed; (3) with that stale browser state, anonymous password recovery still sends exactly one request-password-reset POST and shows its status message.
- Invalid cart cookies (R4 gap 4, cookie part) PASS b9d7ac959 (3.7s case), all four cases executed: a toko-a cookie carrying a toko-b cart id, a random UUID, a malformed id, and a toko-a cart closed by a real in-test checkout (exactly 1 order verified). Each add issued a new own cart, never the presented id; DB line totals of the toko-b cart and the closed cart were unchanged. Earlier attempts failed only in setup: b90a5e694 built a URL from a seeded toko-b product without a slug; bc14919af used a hand-built cookie Chromium rejected; bddc1933a passed but silently skipped the closed case (closedCovered=false) and was not accepted. The case is now mandatory.
- Final independent review (05ebe330-e1c5-4a26-8e57-d6845c29bae9; report: /home/ongki/Documents/work/notes/bukalaris/t82-final-acceptance-review-retry.md) BLOCKS T-82 acceptance. Earlier parent claims that all R4 gaps were closed are withdrawn: gaps 1–6 are PARTIAL, gap 7 is CLOSED narrowly for original updateCart only. Remaining evidence includes pending challenge replacement/expiry/replay, live-session/cart duplicate-cookie mutation boundaries, configured-host landing/checkout, invalid-capability checkout/update refusal, and nonstandard-caller refusal. Existing scoped passes remain valid, but do not establish these missing cases. Review also found sensitive matcher operands, a vacuous replacement-cookie inequality, and manual-fetch rather than authPost no-replay coverage. Targeted test edits address these three findings; verification is pending. Previous reviewer b908d879 timed out after 30 minutes without a report; no acceptance is inferred.
- Review-finding verification b9705f13a PASS: lint/typecheck, three desktop cases (pending-MFA baseline, actual SecurityEnrol authPost revoked-session/no-replay, four invalid-cart-cookie cases with mandatory replacement-cookie presence and own-store quantity 7) and one host-cart case with safe boolean body comparison. This closes the three immediate test-quality findings subject to reviewer confirmation; it does not close the remaining R4 lifecycle/cookie/host/nonstandard refusal boundaries. No acceptance is inferred.

- Pending-MFA lifecycle extension PASS b5dfe2d1e (12.0s case): old challenge MAC with replacement pending cookie refused 403/no session; previous fixture challenge expired server-side (exactly one fixture verification row updated), valid MAC refused natively 401/no session; replacement challenge verified 200; independently retained consumed pending cookie+MAC replay refused natively 401/no session; session transition and fresh-token sign-out control passed. Prior b74111e35 reached replay but got native 429, not accepted. Final test waits one installed native 10s rate-limit window before verification/replay, with max=3 unchanged; no guard/config relaxation.

- Duplicate-cookie boundary proof PASS b70459018 (2.5s): identical and conflicting duplicate live-session cookies refuse token issuance/sign-out (403) and leave original seller product mutation unchanged after fresh read; exact unambiguous native multipart form persists. Identical/conflicting duplicate cart cookies leave quantity 1 unchanged after fresh read; exact unambiguous form changes it to 9. b215f432c was not evidence: URL-encoded transport unsupported by installed Next, including failed positive control. b7b175ef8 passed session checks/control but stopped at a test cookie-name regex that omitted the production __Host- prefix. Fixed to source-defined optional prefix; no app/guard change. Overall acceptance remains BLOCK.

- Direct configured checkout-host proof PASS b05dd1776 (1.8s): a cart created on toko-a.localhost was explicitly installed as an owned fixture cookie on checkout.localhost, then its real checkout form produced exactly one order and confirmation remained on the configured checkout origin. Lint/typecheck passed. This is evidence of checkout-host CSRF audience compatibility only; it is NOT evidence of automatic cross-host cart handoff. No routing, cookie-sharing, or production gate was changed. Configured store-host landing mutation/refusal proof is now being added, with the same handoff limitation explicit.

- Configured landing-host probe b6a56f0e3 FAILED during fixture creation on app.localhost: one landing_page was persisted (read-only disposable-DB count=1), but the post-submit snapshot showed login and no editor. The cause is unproven; this is an OPEN seller-host redirect observation (#31), not classified benign or accepted as merely test setup. To isolate the public store-host landing action, the next probe creates its fixture through the established single-host builder. No auth/host/redirect implementation was changed; neither this probe nor a later public-landing pass proves seller-host redirect correctness.

- Configured store-host landing original mutation PASS b7c1f6198 (3.1s): fixture built through single-host seller UI; native multipart landing form on toko-a.localhost refused forged CSRF (303 recovery, no new cart/cookie), accepted current CSRF (303 /checkout?store=toko-a, exactly one own-store cart with quantity 2). Redirect was not followed; automatic cross-host handoff remains unproven/out of scope. Seller app-host redirect observation #31 remains OPEN and will receive a bounded session/render diagnostic; no app/host/auth implementation changed.

- Seller-host redirect diagnostic ba615e88b FAILED its strict editor-render invariant (2.0s), confirming a real UI consequence, not a lost session: POST 200, beforeSession=true, afterSession=true, advertisedEditor=true, renderedEditor=false, renderedLogin=true, freshEditorGetWorks=true. A single owned fixture mutation persisted; fresh GET to its app-host editor returns revision 1. Lint/typecheck passed. #31 is a confirmed acceptance blocker; exact internal cause is still unproven. Installed Next createRedirectRenderResult uses initURL origin for a streamed redirect and filtered forwarded headers (action-handler.js); this is a hypothesis to review, not authorization for normalization/auth/transport compensation. No framework, routing, session or CSRF implementation changed.

- Independent blocker review 5e0f1649-55ca-473d-9fca-ecc0d57a5b5c keeps #31 P1/BLOCK. Correction: installed Next getForwardedHeaders does NOT filter Host; the parent's earlier 'Host filtered' explanation is withdrawn. Post-action render/auth divergence is confirmed, but internal Host loss, cookie merging, or client RSC behavior is not attributed. Whether inherited or T82-introduced is unproven. Read-only SHA-256 comparison of standalone vs installed action-handler.js and server-ipc/utils.js MATCHES both files (d759c976… / 593daddb…), removing that source-version discrepancy candidate without tracing internal runtime. No safe concrete in-scope fix is established. Await owner approval for ONE metadata-only internal-redirect proof (destination origin, received Host, selected surface, expected-cookie presence boolean, login redirect boolean); no credential/token/session-id/body/header dumps, framework patch, normalization change, forwarded-Host trust or transport bypass. Any auth/Host integration fix requires a separate decision after that proof. No diagnostic or tests are running now.

- Approved metadata proof b68c9673e (first attempt ba6cbd23d captured no metadata: Playwright ignores webServer stdout; switched to stderr, same scope). Six context.ts session resolutions on the host-mode server: every browser request carried Host=app.localhost:3285, surface=seller, expected session cookie present, session present. Exactly one request — the post-action redirect render — carried Host=localhost:3285 with x-forwarded-host=app.localhost:3285, rsc=false, surface=local, expected cookie absent, session absent → seller() redirects to login. Mechanism established by runtime + installed source: Next createRedirectRenderResult (action-handler.js:260–332) GETs the redirect target at initURL origin (next-server.js:1279–1285 builds it from fetchHostname:port), and the request Host observed by the app becomes that listener origin while the original host only survives in x-forwarded-host. Because auth surface is Host-selected (context.ts → authForHost), any successful hydrated server-action redirect on a non-local surface renders with the wrong surface. Likely inherited from the T-70 multi-host design rather than T-82 (pre-T82 listener 127.0.0.1 would also not resolve to the seller surface), but baseline runtime was not executed. Instrumentation was temporary and env-gated; source restored by fingerprint and restored build verified clean (RESTORED_BUILD_CLEAN). Logged only host strings, surface name and booleans. No safe in-scope fix: trusting x-forwarded-host is forbidden (client-suppliable), and transport/framework/normalization changes are unauthorized. Owner decision needed.

- Invalid-capability checkout refusal PASS ba8bfbe61 (3.6s): the exact hydrated checkout submission for an own toko-a cart was captured and aborted before reaching the server (0 orders). Replaying the identical body/action with a real open toko-b cart cookie created no order on it; with a toko-a cart already closed by a real checkout created no second order; the rendered cart still had 0 orders. The identical replay with its own cart created exactly one order (positive control). Lint/typecheck passed.

- Nonstandard-caller refusal proof PASS bb3d917b0 (2/2, desktop; seller case also b07b880b9). Seller: multipart upload (forged: no media row; current: +1), finance step-up setDestination (forged: no destination AND no step-up proof consumed; current: +1 held destination), current-user invitation acceptance (forged: no membership; current: +1). Console: per-button formAction approval — exact hydrated submission captured and aborted, replay with only the CSRF field forged left the request pending; identical replay with the current token approved it. Argument-only issue report — the token is an encrypted bound argument, so instead of tampering Next's blob the real component submitted after its session was revoked elsewhere and replaced: recoverable alert, no report; after reload exactly one report. Earlier attempts b38946ce9/b3ba38b54/bfbd36f4e failed only in setup: /seller/members has loading.tsx, so its form never renders without JS; the form is now read from the JS page while the mutation stays a native multipart post. Desktop only; no 320 run for these refusal cases.

- Combined verification after the #31 fix and review follow-ups PASS b5a1c4326: map:check ok (103 route files, 125 rows), lint, typecheck, clean build; all host-mode specs 33/33 (incl. strict #31 editor render, 421 refusal matrix with multi-value/case-port/127.0.0.1 rows and request id, WWW, store-host cart, configured landing and checkout); auth-csrf + t82-callers + purchase + landing + accounts 42/42 at mobile-320 and desktop in one run. Earlier failures in b5f0a99bd/bc9b5071a/bcfda240a were test-fixture defects (cross-project TOTP/membership leak on shared seed users, sign-in 3/10s window, challenge-id regex too narrow); fixed with per-project fixture stores/users and source-derived patterns, no assertion weakened, no limiter relaxed. #31 fix (proxy refuse-only 421, D-25) reviewed ACCEPT WITH NOTES (089b6b7e); notes applied. Fingerprints: proxy.ts c0ea5b06…, auth-csrf.spec.ts acb45983…, host-mode.spec.ts 62168a3a…, t82-callers.spec.ts 358a5ea2…, helpers.ts f8d2ccde…. Baseline #31 probe at 283f322 running; final independent T-82 acceptance review next.

- Baseline #31 probe b7d3ffedc at 283f322 (pre-T82, original 127.0.0.1 listener, no CSRF): seller-host landing creation persisted=true, session after=true, renderedEditor=false, renderedLogin=true — the same symptom. #31 is therefore an inherited T-70 multi-host defect, not a T-82 regression; T-82 surfaced it and D-25 fixes it. The probe ran in its own disposable DB/ports; its temporary spec was removed and the baseline worktree verified clean (BASELINE_CLEAN).

- Final review P2 follow-ups PASS bf4997347 (auth-csrf 22/22, mobile-320 + desktop): pre-expiry control, replacement sign-in 429 wait, CSRF-cause assertion on foreign/closed checkout replay. auth-csrf.spec.ts sha256 0937c4b0….
- T-82 ACCEPTED LOCALLY 2026-11-05: final independent review 4d65c038 ACCEPT WITH NOTES (no P0/P1); combined b5a1c4326 green; #31 fixed via D-25 (review 089b6b7e), inherited from T-70 per baseline b7d3ffedc. Not committed/pushed/deployed.
- (Historical) Overall T-82 remains IN PROGRESS: authority/MFA/transport/side-effect/original-callable-export mutation evidence, overall verification and final independent acceptance still required. Do not advance to T-83. No main integration, stage, commit, push or deploy.

## T-83 shared authentication rate limits (2026-11-05)

- T-83 accepted locally (2026-11-05): Better Auth's atomic rateLimit.customStorage now runs on the shared Postgres fixed-window counter (authRateLimitStorage over hit), keys auth:<surface>:<sha256(ip|path)>, client IP from the CLIENT_IP_HEADER-trusted header, Better Auth's numeric rules unchanged, counter failure refuses 429 with a one-window retry (D-26). Evidence: DB 76/76 (b620c9645); HTTP two independent production servers on one DB share one sign-in budget, uniform refusal, failing store → 429 then recovery, accounts/auth-csrf 30/30 at 320+desktop (bfd28462c); mutation proofs — per-process memory storage fails the two-server test (expected 429, received 401) and a fail-open store fails both the DB and HTTP refusal tests, each restored by fingerprint, rebuilt and rerun green (b12d202b1, bc3c52d2f; artifacts t83-shared-limit-mutation/, t83-failopen-mutation/); final gate b5180862b: no leftover mutant, map/lint/types, DB 87/87, clean build, host-mode 35/35, accounts+auth-csrf+t82-callers 34/34 at 320+desktop. Independent review d6365bea ACCEPT WITH NOTES (no P0/P1); notes applied: deploy gate CLIENT_IP_HEADER=cf-connecting-ip and no Traefik trustedIPs in xff mode, D-26 wording (pseudonymous digest), accepted ceilings (fixed-window 2x boundary, per-unique-path rows → T-90, hung-DB waits for timeout), window-aligned DB tests, fail-open mutation. Not pushed or deployed.

## T-84 worker and cleanup in verify:docker (2026-11-05)

- T-84 accepted locally (2026-11-05): `pnpm verify:docker` now runs the outbox worker and the one-shot cleanup from the built `migrate` image as `bukalaris_platform` on its scratch database and proves: process user `app`, one safe queued job (`approval.expire`, key verify-<id>) done and its fixture request expired, scheduler heartbeat, graceful SIGTERM (exit 0, `stopped` line, no process-level error lines), web image has no packages/db/src, `NODE_ENV=production` baked into the migrate image, and cleanup exit 0 removing exactly the idle fixture cart while keeping the fresh one, buyer-data retention off; bounded waits (30 s SQL polls, `docker stop -t 15`, `timeout 60`). Identity is logged (image ids, HEAD, dirty-tree digest). Evidence: b68113827 first green; review-fixed gate b3fb37e44 — VERIFY_BREAK=worker (effect=no heartbeat=no, 127 poll errors), effect (unregistered kind, effect=no) and cleanup (exit 1, carts 2->2) each fail with their named reason; clean run PASS (identity web=f5974cd2703f migrate=48416cc04261 tree=e6ffd7c dirty=5c7bbb617f13); 0 leftover containers/databases. Independent review f8972630 ACCEPT WITH NOTES; both P1 fixed (identity recorded; migrate stage now ENV NODE_ENV=production — previously a production worker from that stage would silently use local mail and the fake shipping partner) and P2s fixed (fixture through the real approval guard, idle-vs-fresh cart assertion, named cleanup container in the trap, stale docs). Docs corrected: worker/cleanup run from the `migrate` stage (`node src/worker.ts`), not the web image (DEPLOY-COOLIFY, a shared edit outside T-84's listed paths; RUNBOOK). Notes: the scheduler's own minute tick also expires the fixture, so only the queued-job half of the effect is shown failing on its own; job-level failures (e.g. shipping.credentials.reseal shipping_key_unavailable) are info-level and do not fail the gate; the worker does not fail-closed on missing ORDER_LINK_SECRET/INTEGRATION_TOKEN_KEY at start (pre-existing). The E2E `relation "job" does not exist` noise is a harness ordering effect: Playwright starts the worker webServer before globalSetup drops and re-migrates the schema; not a production defect; fix belongs to playwright.config/global-setup (outside T-84 paths), tracked as a follow-up.
