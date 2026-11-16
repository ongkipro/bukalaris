# T-103 — Checkout on the store host and link origins by link type

Status: see the T-103 block in `docs/TASKS.md` (that block owns the status). Local only: no DNS, no certificate, no deploy.

## Scope and invariant

Branch `task/t103-store-host-checkout`, worktree `../bukalaris-wt/t103-store-host-checkout`, based on `2b4d0a4` plus the uncommitted, reviewed T-102 change (copied from `../t102-two-roots`, not rewritten).

ADR-0014 decisions 5 and 7, clarification C-D1; DOM-4..DOM-6; PR-16 (hosted hand-off stays), PR-20 (first-party click ids). Invariants:

- Cart, checkout, confirmation and the signed order-status page complete on `<slug>.<store root>` with a different platform root; every buyer cookie stays host-only on that host.
- On those paths the store host serves only its own store: a `?store=`, order link, confirmation, recovery link or referral link of another store is refused (the same answer as an unknown one), never served. Seller, operator, auth, Storefront API, feed and hand-off paths stay 404 there.
- One link-origin function (`storeLinks`) builds every store-owned absolute link: feed items, order-status links in e-mails, abandoned-checkout recovery links, referral redirects, the Seller Admin product preview. It reads configuration only, never a request host.
- `checkout.<platform root>` keeps the PR-16 one-use hand-off (`/checkout/h/<code>`) and reads only a cart that arrived through it; `/checkout/h/<code>` is 404 on store hosts.
- One-host path mode on plain `localhost` and the one-root host mode keep working.

Not in scope: custom domains (T-15; `storeLinks` takes the resolver as a parameter and no caller passes one yet), HSTS per registrable domain (T-94), store affiliate membership (T-108).

## Design

- `packages/db/src/platform/host.ts`
  - `storeLinks(slug, { env?, primaryDomain? }) → { origin, storefront }`: verified primary custom domain (`https://<domain>`) → `<slug>.<store root>` (`https`, or the configured platform origin's scheme and port on a `*.localhost` root) → one-host path mode when the store root is plain `localhost` (`origin` = platform origin, `storefront` = `<platform origin>/s/<slug>`).
  - `dispatchHostPath` `case "store"`: passes `/checkout`, `/checkout/*` except the hand-off `/checkout/h/<code>` (`/checkout/h/invalid` passes: it is the recovery link's refusal page), `/o/*` (any method: the refund-destination action posts there) and `/r/*` (`GET` only, as on the apex), each with `storeSlug` so the proxy sets `x-bl-host-store`. `/feeds` stays 404 (feed downloads stay on the Seller host).
- Own-store gate, in one place: `apps/web/src/lib/storefront.ts`
  - `hostStoreScope()` (cached per request): the active store named by `x-bl-host-store` (set only by the proxy, overwritten on every request), `undefined` off a store host, `null` for an inactive store.
  - `servesStore(slug)`: true off a store host, else only when the proxy-set slug equals the order's store slug, without requiring an active store (review finding 1: a suspended store keeps its order-status page and refund form). Used by the confirmation page, the order-status page and its refund action. `checkoutCart`, the recovery route and `/r` keep the active-store requirement through `hostStoreScope`.
  - `checkoutCart(requested)`: the store and cart for the checkout page and its three actions. On a store host the `?store=`/form value may only name the host's store (absent = the host's store). The cart id is dropped unless its cart row belongs to that store (`cartStore`, open or already checked out for the T-97 replay; review finding 3). On the checkout host the cart is read only when `channelReturnTarget` finds a consumed hand-off of a live channel for it; otherwise the page shows the empty-cart state and submit has no cart. Also returns the "back to store" target (`/` on a store host).
  - The cart CSRF audience of T-102 already refuses a store host whose slug differs from the scope (`auth-csrf.ts`), so the gate is backed twice for writes.
- Recovery route `(checkout)/checkout/r/[token]`: refused on the checkout host; on a store host the redeemed session must belong to the host's store; every refusal is SF-10 without a cookie.
- Referral route `(public-services)/r/[token]` (C-D1): on a store host the capture runs in a transaction that is rolled back when the link names another store, so a foreign link leaves no click, no RL-CLICK counter and no cookie, and answers the unknown-link 404. The redirect target and the click cookie stay on the store host; RL-CLICK is unchanged (`captureReferralClick`).
- Callers of the link-origin function: `storeBaseUrl` (`storefront/feeds.ts`: feed `link`/`image_link`, the Google channel link, referral redirect, Seller Admin product preview) delegates to `storeLinks(...).storefront`; `renderMail` (`ops/jobs/notify.ts`) builds the buyer link as `storeLinks(slug).origin + /o/<token>` (the seller link stays on `APP_ORIGIN`); `openWhatsAppRecovery` (`seller/commerce/abandoned.ts`) builds `storeLinks(slug).origin + /checkout/r/<token>` and no longer takes an origin from its caller.
- `getOrderForLink` now also returns `storeSlug` (public: it names the storefront) so the order-status gate can compare it; `storeId` is still stripped.

## Tests

- `packages/db/test/host.test.ts`: the T-70 golden table's Store column updated (`/o`, `/checkout`, `/checkout/confirmation`, `/checkout/r`, `/checkout/h/invalid`, `/r` GET pass; `/checkout/h/<code>`, `/r` POST 404); describe "T-103 checkout on the store host" (4 cases: own-store passes with `storeSlug`; hand-off, feeds, unsafe referral methods, seller, operator, auth and Storefront API refused; checkout host keeps its paths; no re-targeting through `/s/<other>`); describe "T-103 link-origin unit table (storeLinks)" (7 rows: two roots with and without a primary custom domain via a stubbed resolver, resolver returning none, one root, local two roots, path mode, nothing configured; plus a no-request-host case).
- `packages/db/test/feeds.test.ts` "T-103: feed links come from the store's link origin, never from the Seller Admin host the feed is fetched on".
- `packages/db/test/notify.test.ts` "T-103: the buyer's status link is built on the store's own host from configuration; the seller's link stays on Seller Admin"; the signed-link case asserts `storeSlug`.
- `packages/db/test/t45-abandoned.test.ts`: recovery links asserted on `https://<slug>.<store root>/checkout/r/v1.`.
- `packages/db/test/t52-policy.test.ts`: the HTTP-27 dispatch case encoded "apex only"; C-D1 changes that row, so the store host is now asserted to pass `GET` with its `storeSlug` and refuse every other method.
- `apps/web/e2e/host-mode-two-root.spec.ts` (two-root server on `E2E_PORT + 4`):
  - "T-103 a buyer completes cart, checkout, confirmation and the signed order-status page on the store host" at 320 px and 1280 px, with evidence screenshots `docs/evidence/m1/host-mode-t103-two-root-{320,1280}-{checkout,confirmation,order-status}.png` (reflow and CSP checked by `evidence()`); every buyer cookie is on `toko-a.store.localhost`; the same order link, confirmation and a `?store=toko-a` on `toko-b.store.localhost` are refused.
  - "T-103 the store host still refuses the hand-off, feeds, seller, operator, auth and Storefront API paths; feed links name the store host" (the Google feed fetched on `app.platform.localhost` carries only `http://toko-a.store.localhost:<port>/products/...` links).
  - "T-103 the checkout host serves the one-use hand-off of PR-16 and refuses a cart that was not handed off".
  - "T-103 C-D1 the store host serves the referral click route for its own store only".
  - Review tests: "T-103 review 1 and 2b: a suspended store keeps its order-status page and refund form on its own host; another store's host refuses the page and the refund post" (a transfer order paid and provider-cancelled through the ledger functions, as in `t37.spec`; the foreign-host POST of the bound refund action stores nothing; the suspended store's own host saves the destination); "T-103 review 2a: a valid recovery link of another store is refused on a store host and on the checkout host, with no cart cookie" (a validly signed toko-b token: its own host redeems it, the toko-a host and `checkout.platform.localhost` answer `303 /checkout/h/invalid` without `Set-Cookie`); "T-103 review 3: another store's cart id in this store's cart cookie is never checked out through this host" (toko-b gets a pickup area for the test so the order would be possible; a current store-A token plus the toko-b cart id under A's cookie name creates no order).
- Store-host `/o` and checkout pages carry `robots: noindex, nofollow` metadata (layouts), since they are now served on indexable store origins.
- `apps/web/e2e/host-mode.spec.ts` (one root): the fail-closed table now probes `/checkout/h/abc` and `/feeds/...` on the store host and `/checkout` answers 200 there; the T-82 checkout case moved from the checkout host to the store host: "T82/T-103 store-host checkout binds the cart form to the exact configured Host and creates exactly one order" (other port, sibling store host and forged token refused with no order; the exact-Host control creates exactly one; a cart copied onto `checkout.localhost` is not read).

## Mutation evidence

Each mutation applied alone, the named test run, then reverted (`grep -c MUTATION` = 0) and the suite re-run green.

| Mutation | Named test that failed |
|---|---|
| Feed item links built from the host the feed is fetched on (`feedItems`: `base = surfaceOriginsFromEnv().appOrigin`, i.e. the Seller host the fetcher calls) | `packages/db/test/feeds.test.ts` "T-103: feed links come from the store's link origin, never from the Seller Admin host the feed is fetched on" (plus the two existing feed-link tests); 3 failed / 8 passed |
| Order-status page without the own-store gate (`(public-services)/o/[token]/page.tsx`: `if (!o) notFound()`), against a rebuilt production server | `apps/web/e2e/host-mode-two-root.spec.ts` "T-103 a buyer completes cart, checkout, confirmation and the signed order-status page on the store host" at 320 px and 1280 px, assertion "another store's order link on a store host" (expected 404); 2 failed / 7 passed |
| m1 (review 1): `servesStore` requires an active store again (`hostStoreScope`), rebuilt server | "T-103 review 1 and 2b …": the suspended store's own host answers 404 (`order-id` not found); 1 failed / 2 passed |
| m2 (review 2b): refund action without the own-store gate | "T-103 review 1 and 2b …" at "refund post on another store's host stores nothing"; 1 failed / 2 passed |
| m3 (review 2a): recovery route without the store comparison | "T-103 review 2a …" at the `toko-a.store.localhost` case (redeemed with a cart cookie); 1 failed / 2 passed |
| m4 (review 3): `checkoutCart` without the cart-store check | "T-103 review 3 …" at "no confirmation" (a toko-b order was created through the toko-a host); 1 failed / 2 passed |

## Independent review (separate agent, 2026-11-16)

No blocker. Findings and handling:

1. Major: a suspended store lost its order-status page and refund form on its own host (the gate required an active store; before T-103 these links went to the checkout host, where store status was not checked). Fixed: `servesStore` compares the proxy-set slug only. Test "T-103 review 1 and 2b …"; mutation m1 below.
2. Minor: two gates untested and one weak check: (a) the checkout-host recovery check used a malformed token, which lands on SF-10 with or without the gate; (b) the refund action's gate. Added "T-103 review 2a …" (valid foreign token on a store host and on the checkout host, positive control on its own host) and the foreign-host refund POST in "T-103 review 1 and 2b …"; mutations m2 and m3.
3. Minor: another store's cart id in this store's cart cookie validated against a current store token (null CSRF binding id) and could be checked out through this host. Fixed in `checkoutCart` (`cartStore`). Test "T-103 review 3 …"; mutation m4.
4. Minor: the apex `/r` still records clicks that can never be attributed (the click cookie lands on the platform apex; checkout runs on the store host). Not changed by instruction: the apex route belongs to the old platform affiliate model that T-108 replaces. Gap owned by T-108.
5. Docs: `docs/DEPLOY-COOLIFY.md` worker paragraph still said store-host order-status links were not implemented; corrected (small hunk).
6. Nits, recorded without code change: the local-mail loopback guard (`platform/mail-transport.ts`) checks the surface origins but not `STORE_ROOT_DOMAIN`, so a buyer e-mail can name a non-loopback store host in local mail mode; `storeLinks`' `primaryDomain` resolver errors propagate and its value is not validated (T-15 owns the resolver and its validation); `/o` and `/checkout*` had no `noindex` on indexable store origins: fixed with one metadata line in each layout.

## Observation

In the full E2E run, earlier specs enable toko-a's seller pixels, so the browser loads the Meta and TikTok scripts on the store-host checkout and those set their own third-party cookies (`.facebook.com`, `.tiktok.com`). That is the existing PR-20 pixel behaviour (unchanged; pixels already ran on path-mode checkout). It does mean the suite contacts those third-party hosts from the browser; recorded for the coordinator, not changed here. The cookie assertion of the T-103 order test covers Bukalaris cookies only.

## Deviations

- `apps/web/src/app/(public-services)/o/[token]/{page,actions}.ts`, `(public-services)/o/layout.tsx` (noindex) and `(public-services)/r/[token]/route.ts` are outside the Allowed Paths: the own-store gate of the order-status page and of the referral route (C-D1) has to sit in those handlers.
- `apps/web/src/app/(seller)/seller/customers/carts/actions.ts`: one line, it no longer passes `CHECKOUT_ORIGIN` to `openWhatsAppRecovery` (the recovery link origin now comes from the link-origin function).
- `packages/db/src/ops/jobs/notify.ts` `getOrderForLink` returns `storeSlug` (a read field, not only a link builder).
- `docs/04-SYSTEM-ARCHITECTURE.md`: the HTTP-27 and HTTP-32 ARCH-5 rows named the wrong hosts after this change; two cells edited.
- `apps/web/src/proxy.ts` unchanged: a `pass` with `storeSlug` already sets the internal header.
- Verification ran with `E2E_PORT=3500` / `BETTER_AUTH_URL=http://localhost:3500` instead of 3400: port 3400 is held by an unrelated project's long-running dev server (`clinic-dashboard`), which was left alone.
