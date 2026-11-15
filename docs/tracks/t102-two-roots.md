# T-102 — Two root domains in host dispatch

Status: see the T-102 block in `docs/TASKS.md` (that block owns the status). Local only: no DNS, no certificate, no deploy.

## Scope and invariant

Branch `task/t102-two-roots`, worktree `../bukalaris-wt/t102-two-roots`, based on `2b4d0a4`. Owner instruction of 2026-11-16: continue the task order with parallel development.

ADR-0014 decisions 1 to 3 and 6, DOM-1, DOM-5, DOM-6, D-25, TEN-2. Invariants:

- `PLATFORM_ROOT_DOMAIN` (platform surfaces) and `STORE_ROOT_DOMAIN` (native storefronts, `cname.`) are read separately. An unset platform root falls back to the store root, so one root keeps the T-70 behaviour unchanged (local development, CI, the `verify:docker` smoke test); the store root falls back only to `localhost`, never to the platform root, because the storefront link builders read `STORE_ROOT_DOMAIN` as well.
- With two roots, a platform or reserved label on the store root (`owner.`, `app.`, `checkout.`, `cname.`, ...) and a store slug on the platform root never resolve to a surface: both fail closed (404).
- `cname.<store root>` is never a store.
- The store-root apex and `www.<store root>` answer `GET`/`HEAD` with `308` to the platform apex and 404 for every other method; they serve no session surface.
- The auth surface (session cookies, auth origin) and the cart CSRF audience are derived from the right root: platform surfaces from the platform root, the store host `<slug>.<store root>` from the store root.

Not in scope: checkout and order status on the store host, link origins by link type (T-103), custom domains (T-15), HSTS per registrable domain at the edge (T-94).

## Changes

- `packages/db/src/platform/host.ts`: `HostRoots`, `hostRoots`, `hostRootsFromEnv`, `redirectOriginForHost`; `resolveHostSurface` and `dispatchHostPath` accept one root (string) or the two roots; new surface kind `store_apex`. Resolution order (ADR-0014 §2): platform apex, store-root apex, exact platform labels and `*.affiliate.` on the platform root, one claimable label on the store root, then the custom-domain resolver; everything else `unknown`.
- `apps/web/src/proxy.ts`: dispatch and the T-82 #31 forwarded-host comparison use both roots; the store-root apex redirect goes through the same internal route as `www` (no middleware Location rewriting).
- `apps/web/src/app/(platform)/api/internal/www-redirect/route.ts`: the expected target origin is recomputed from Host and configuration (`redirectOriginForHost`) and must equal the header's origin; covers platform `www` and the store-root apex and `www`.
- `apps/web/src/lib/auth.ts`: `authSurfaceForHost` resolves on both roots, so `owner.<store root>` is never a sign-in surface.
- `apps/web/src/lib/auth-csrf.ts`: the cart CSRF audience of a store host is `<slug>.<store root>`.
- `apps/web/src/lib/security-headers.ts`: HSTS comment only (value unchanged).
- `.env.example`: commented `PLATFORM_ROOT_DOMAIN`.
- Docs: `docs/08-DOMAIN-ROUTING.md` (intro, DOM-5 implementation note, path-mode retirement wording, DOM-6 residual-risk note), `docs/DEPLOY-COOLIFY.md` (variable rows, path-mode wording).

## Tests

- `packages/db/test/host.test.ts`, describe "T-102 two root domains": platform surfaces and storefronts on their own root; platform and reserved labels on the store root fail closed; `cname` on the store root is never a store; a store slug on the platform root fails closed; store-root apex and `www` redirect only safe methods; `redirectOriginForHost` names an origin only for redirect-only hosts; one root stays valid (fallbacks, equality with the T-70 table for the same root given as two equal roots). The T-70 one-root golden table is unchanged and passes.
- `apps/web/e2e/host-mode-two-root.spec.ts` (runs in the `host-mode` project and starts its own production server on `E2E_PORT + 4` with `PLATFORM_ROOT_DOMAIN=platform.localhost`, `STORE_ROOT_DOMAIN=store.localhost`): fail-closed table over a live server, store-root apex and `www` redirects by method, and at 320 px and 1280 px a seller sign-in on `app.platform.localhost` plus a hydrated add to cart on `toko-a.store.localhost`.

## Mutation evidence

Unit level (vitest, `test/host.test.ts`), each mutation applied alone and reverted:

| Mutation | Named test that failed |
|---|---|
| A platform label on the store root resolves to the platform surface | "a platform or reserved label on the store root fails closed" |
| `cname` on the store root resolves as a store slug | "cname on the store root is never a store" (also the T-70 reserved-host case and the reserved-label case) |
| Platform label lookup through the Object prototype (review finding 1) | "Object prototype member names are never a surface label on either root, one root or two" |

After reverting: 50/50 in `host.test.ts`.

Browser level (`host-mode-two-root.spec.ts` against a rebuilt production server, each mutation alone, then a control build of the restored code):

| Mutation | Result |
|---|---|
| Cart CSRF audience built on the platform root (`<slug>.<platform root>`) | both "seller signs in on the platform root and a buyer adds to cart on the store root" cases (320 px, 1280 px) failed on a visibility assertion; the two request-level tests passed |
| Auth surface resolved on the store root only (pre-T-102 behaviour) | both browser cases failed (sign-in never completed, test timeout); the two request-level tests passed |
| Control (restored code) | 4/4 passed |

## Executed verification

See the T-102 block in `docs/TASKS.md` and `BUILD-LOG.md`.

## Independent review (separate agent, 2026-11-16)

No blocker. Findings and handling:

1. Minor, near major: the platform-label lookup used a plain object, so `constructor.<root>` and `__proto__.<root>` matched Object prototype members; `dispatchHostPath` returned `undefined` and the proxy would throw (500 instead of 404). Fixed with `Object.hasOwn`; named unit test added and proven by mutation.
2. Minor: with only `PLATFORM_ROOT_DOMAIN` set, the store root fell back to it while `storeBaseUrl` reads `STORE_ROOT_DOMAIN` raw. Fixed: the store root no longer falls back to the platform root.
3. Minor: the E2E comment overstated what add-to-cart proves. Reworded; the browser mutation above shows the test fails when the audience is built on the platform root.
4. Minor: evidence not yet recorded in `docs/TASKS.md` and `BUILD-LOG.md`. Recorded with this change.
5. Nit: roots are not validated against each other (a store root `app.bukalaris.com` would shadow the Seller host). Documented as a deployment constraint in `docs/DEPLOY-COOLIFY.md`; no start-up check.
6. Nit: the redirect keeps the request port and protocol, as the platform `www` redirect did before. Not changed: the host part is always the configured platform root.
7. Nit: no forged internal-header case on the two-root server. Added to `host-mode-two-root.spec.ts`.

## Deviations

- `apps/web/playwright.config.ts` is not in the allowed paths, so the two-root server is started by the spec itself (the pattern of `security-headers.spec.ts`) instead of a fourth `webServer` entry.
- `packages/db/src/ops/console.ts` (allowed) is unchanged: the Owner console settings page still shows the store root only, under the label "Domain induk toko", which stays correct.
