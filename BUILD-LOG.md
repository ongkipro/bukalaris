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
