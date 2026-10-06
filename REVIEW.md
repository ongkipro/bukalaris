# Senior review log

Format: `- [ ] R-n (phase) finding` — worker ticks `[x]` with a one-line resolution.

## Phase 0 — accepted (2026-10-06)
Verified independently: toplevel = ~/Projects/bukalaris; docs/ identical to the
old pack except MOVED.md; check-spec.py PASS.

- [x] R-1 (P1) docs/README.md "Status" line and "Start here" still describe a
  pack with no repository. When Phase 1 lands, update it to point at the repo
  layout (apps/web, packages/db) and STATUS.md as the status owner.
  Resolution: docs/README.md Status paragraph now names the repo, apps/web +
  packages/db, STATUS.md as status owner, AGENTS.md, DECISIONS.md; step 5 no
  longer says "after the repository exists". check-spec.py still PASS.
- [x] R-2 (P1) Add .gitignore before installing (node_modules, .next, .env*,
  !.env.example, playwright artifacts) so nothing secret/heavy gets staged later.
  Resolution: root .gitignore added before install (node_modules, .next, out, .env*, !.env.example, test-results, playwright-report, blob-report, coverage, tsbuildinfo).

## Phase 1 — accepted with notes (2026-10-06)
Reviewed: schema (store-compound FKs, money/stock/total CHECKs, per-store
idempotency unique), Dockerfile (non-root standalone, separate migrate target),
.gitignore/.dockerignore keep .env out of git and image. Good work.

- [x] R-3 (P2) docker-compose publishes Postgres on 0.0.0.0:5442. Bind to
  127.0.0.1:5442 — local dev DB with a placeholder password must not be
  reachable from the LAN.
  Resolution: compose now publishes `127.0.0.1:5442:5432`; `docker compose ps` shows `127.0.0.1:5442->5432/tcp`.
- [x] R-4 (P2) Dockerfile has no `public/` copy. If any static asset folder is
  added in Phase 2, add `COPY .../apps/web/public ./apps/web/public`, and prove
  it with the docker run smoke check.
  Resolution: Phase 2 added no `public/` folder (system fonts, no static assets), so no COPY is needed. Re-proved with `docker build` + `docker run` smoke (health, storefront, host mode, sign-in) — see BUILD-LOG Phase 2. Add the COPY together with the first asset.
- [x] R-5 (P2) Last-owner protection and "every store-owned query is scoped"
  are app-level invariants. Tests must hit them through the same data-access
  functions the routes use (not raw SQL), otherwise the proof doesn't cover
  the real path.
  Resolution: every assertion goes through the functions the routes call (`sellerContext`, `getProduct`/`updateProduct`/`addVariant`/`updateVariant`, `storefrontScope`/`getPublishedProduct`/`setCartLine`/`getCart`, `placeOrder`/`getBuyerOrder`, `changeMember`, `setStoreStatus`). Raw SQL is used only for fixtures (extra membership rows) and in one deliberately DB-level test (`variant_product_fk`). Browser e2e repeats cross-store denial and suspension through the real routes.
- [x] R-6 (P2) Checkout concurrency test: use real parallel transactions
  (separate connections) against bukalaris_test, assert final stock >= 0 and
  number of successful orders <= initial stock. Use SELECT ... FOR UPDATE or a
  conditional `UPDATE ... SET stock = stock - $q WHERE stock >= $q`.
  Resolution: `placeOrder` uses a conditional `UPDATE variant SET stock = stock - q WHERE store_id=… AND id=… AND stock >= q` inside a transaction (plus CHECK stock >= 0). Test fires 12 parallel `placeOrder` calls (own transaction each, postgres.js pool of 10 connections) on stock 3 and asserts successes <= initial, == 3, final stock >= 0 and == 0; passed 5/5 consecutive runs. The parallel run also exposed a real replay race (duplicate submit after the first committed saw an empty cart), now fixed and covered.

## Phase 2 — accepted with notes (2026-10-06)
Independently re-run by reviewer: lint 0, typecheck 0, `pnpm test` 21/21,
`pnpm build` 0, `pnpm e2e` 8/8. Reviewed checkout.ts (server-derived totals,
conditional stock decrement, idempotency + request hash, race handling,
store-suspension share lock), proxy.ts (forged header stripped), scoped.ts,
auth (signup disabled, HTTP login for rate limit). Screenshots checked at
320px and desktop. Solid.

Final round — fix, prove, then print "PHASE FINAL DONE — ready for review":
- [x] R-7 (P2) AGENTS.md says `forStore(storeId)` in scoped.ts; that function
  does not exist. Describe the real API (sellerContext / storefrontScope /
  operatorScope + SellerScope/StorefrontScope). Grep docs for other drift.
  Resolution: AGENTS.md now documents the real API — scope-taking functions in `packages/db/src/*.ts`, scopes created only by `sellerContext` / `storefrontScope` / `operatorScope` in `scoped.ts`, checkout store derived from the cart. Grep of all *.md for `forStore`, `Postgres 18`, `bl_cart`, stale paths: remaining drift fixed (DECISIONS D-6 cookie name, 04 locator SF-07 route, STATUS migrate image size).
- [x] R-8 (P2) One global `bl_cart` cookie: in path mode (/s/<slug>) adding an
  item in store B silently abandons the open cart of store A. Either key the
  cart cookie per store (and let /checkout know which store's cart — e.g.
  `/checkout?store=<slug>` resolved server-side, cart still verified by
  ownership) or keep it and record it as a deliberate ceiling in DECISIONS
  with the planned per-host fix. Pick the smaller correct option; add a test
  if you change behaviour.
  Resolution: per-store cart cookie `bl_cart_<storeId>` (`apps/web/src/lib/storefront.ts`); cart page links `/checkout?store=<slug>`; checkout page/action resolve the active store server-side and use the cart only if the cart row belongs to it. New e2e "carts of two stores coexist…" (both viewports) passes; mutation check: with the old single cookie restored it fails, with the fix it passes. Recorded in DECISIONS D-6.
- [x] R-9 (P3) sellerContext: if the cookie-preferred store is suspended, the
  seller is shown "suspended" even when they also belong to an active store.
  Fall back to the first active membership; keep the suspended notice when
  every store is suspended. Add a test.
  Resolution: `sellerContext` now picks the preferred store only if it is a member store and active, else the first active membership; `stores` lists active stores only; "suspended" is returned only when every membership is suspended (named after the preferred store). Test `lifecycle.test.ts` "falls back to an active one…" (fails on the old logic).
- [x] R-10 (P2, Coolify prep) Migrate image is ~1.8 GB. Slim it (e.g. a small
  stage with only packages/db + its prod deps + drizzle files, running the
  migrator with node) and record the new size. Re-prove: migrate image applies
  migrations on a fresh DB on the compose network; web image health 200.
  Resolution: new `migrate-build` stage runs `pnpm --filter @bukalaris/db deploy --prod --legacy /out`; `migrate` stage = node:24-alpine + that output, non-root, `CMD node src/migrate.ts`. `better-auth` moved to db devDependencies (seed only). Size 1.84 GB → 273 MB (node_modules 27 MB). Proven on the compose network: fresh DB → "migrations applied", re-run exit 0, then web image `/api/health` 200 and Docker HEALTHCHECK `healthy`.
- [x] R-11 (docs) DEPLOY-COOLIFY.md: make sure it states env vars required
  (DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, STORE_ROOT_DOMAIN),
  pre-deploy migrate command, healthcheck path, wildcard DNS/TLS need for store
  hosts, Postgres backup, and that nothing has been executed. Draft only.
  Resolution: DEPLOY-COOLIFY.md rewritten: "nothing executed" banner, required env vars table, exact migrate command, health check path, wildcard DNS + DNS-01 TLS need, Postgres backups/restore rehearsal. Correction from Coolify docs: its "Pre-deployment command" runs in the old container and is skipped on the first deploy, so the plan uses a separate `migrate`-target application run before the web deploy.
After the round: re-run lint, typecheck, test, build, e2e, both docker builds,
update BUILD-LOG.md, STATUS.md, docs/TASKS.md evidence.

## Final — M1 accepted locally (2026-10-06)
Reviewer re-ran from current tree: lint 0, typecheck 0, test 22/22, build 0,
e2e 10/10 (320px + desktop), both docker builds 0 (web 301 MB, migrate 273 MB),
check-spec PASS, .env ignored. R-1..R-11 closed.
Not done (by design, see STATUS.md): real providers, RLS/split DB roles,
auth recovery/invite/MFA, external storefront channel, custom domains,
Log System, Astro renderer, second theme. Nothing committed or deployed.
