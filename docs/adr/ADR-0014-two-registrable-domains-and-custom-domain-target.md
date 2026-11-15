## ADR-0014: Platform on `bukalaris.com`, native storefronts on `bukalaris.id`, custom-domain target `cname.bukalaris.id`

- **Status:** Accepted (owner, 2026-11-14, DECISIONS D-28; accepted as a decision, not implementation evidence). Nothing is registered, provisioned or deployed; the code still uses one root domain.
- **Date:** 2026-11-14
- **Author:** Architecture planning
- **Deciders:** Paduka Ongki (product owner)
- **Supersedes:** the single-root host rows of [ADR-0008](ADR-0008-platform-architecture-and-routing.md) §3 and of [08-DOMAIN-ROUTING.md](../08-DOMAIN-ROUTING.md) "Platform domain map" (`<store-slug>.bukalaris.com` only). Everything else in ADR-0008 stands.
- **Related:** PR-3, PR-13, PR-16, DOM-1 to DOM-6, D-23, D-25, T-15, T-70, T-82, T-94, [ADR-0013](ADR-0013-seller-owned-shipping-and-payment-accounts.md), [ADR-0015](ADR-0015-seller-run-store-affiliate-programme.md)

## Context

The pack and the code put every host under one registrable domain: platform surfaces (`owner.`, `app.`, `checkout.`, `buyer.`, `affiliate.`, `logs.`) and native storefronts (`<store-slug>.bukalaris.com`) share `STORE_ROOT_DOMAIN`. `resolveHostSurface(host, rootDomain)` in `packages/db/src/platform/host.ts` takes that one root for both jobs, and `apps/web/src/proxy.ts`, `apps/web/src/lib/auth.ts`, `apps/web/src/lib/auth-csrf.ts` and `packages/db/src/storefront/feeds.ts` read the same variable.

In host mode today the store host answers `404` for `/checkout`, `/o` and `/feeds` (`dispatchHostPath`, `case "store"`): checkout and the order-status page are served only on `checkout.<root>`, and feeds only on the seller host. The cart cookie is host-only, and no automatic cart hand-off from a store host to the checkout host exists (STATUS.md, T-82 notes: the checkout-host proof installed the cart cookie by hand). A buyer on a store host therefore has no working path to pay; only one-host path mode (`/s/<slug>` on `localhost`) completes an order.

Owner decision (2026-11-14): seller storefronts move to their own registrable domain.

- Seller-controlled content on a sibling subdomain of the Owner console shares one site with it: a storefront at `<slug>.bukalaris.com` is same-site with `owner.bukalaris.com`. A separate registrable domain makes every storefront cross-site to every platform surface.
- A storefront domain that is abused (phishing report, blocklist entry) should not take the platform domain's reputation, mail deliverability or HSTS policy with it.
- A custom-domain CNAME target must be a stable name that no store can claim and that never has to move.

**Non-goals:** choosing the custom-domain/TLS provider (T-15, D-23 direction: Cloudflare in front of Vultr + Coolify), registering either domain, DNS, certificates, deployment.

## Decision

1. **Two registrable domains.**

   | Host | Role |
   |---|---|
   | `bukalaris.com` | Public product site, referral links `/r/…`, public report intake |
   | `owner.`, `app.`, `checkout.`, `buyer.`, `affiliate.`, `logs.` on `bukalaris.com` | Platform surfaces, unchanged from DOM-5 |
   | `<store-slug>.bukalaris.id` | Native storefront of one store |
   | `cname.bukalaris.id` | The only CNAME target a seller is told to point a custom domain at |
   | Verified seller custom domain | Same store renderer as the native host (PR-13, T-15) |

   `bukalaris.id` serves storefronts and the CNAME target only. Its apex and `www` redirect to `https://bukalaris.com` for `GET`/`HEAD`; no session surface lives on `bukalaris.id`.

2. **Two root settings, one dispatch.** The single root becomes two: `PLATFORM_ROOT_DOMAIN` (platform surfaces) and `STORE_ROOT_DOMAIN` (native storefronts and the CNAME label). Host dispatch matches exact platform hosts on the platform root first, then `<label>.<STORE_ROOT_DOMAIN>`, then a verified custom domain; anything else fails closed as today (D-25, `421`). Local development keeps one root (`localhost`) for both, so path mode and `<slug>.localhost` behave as now.

3. **Reserved labels apply to the store root.** `cname`, `www`, `api`, `mail`, `status`, `docs`, `assets`, `cdn` and every platform label (`owner`, `app`, `checkout`, `affiliate`, `buyer`, `logs`, `berkah`, `bos`) stay unclaimable as store slugs on `bukalaris.id`, so no store can impersonate a platform surface by name.

4. **Custom domains point at `cname.bukalaris.id`.** Seller instructions show exactly one record: `CNAME <their-host> → cname.bukalaris.id`. A request arriving for `cname.bukalaris.id` itself is not a store and gets the fail-closed response. Ownership verification, certificate states, apex-domain handling and the provider stay with T-15.

5. **Checkout runs on the store host.** The buyer's cart, checkout, confirmation and signed order-status page are served on the same host as the storefront (`<store-slug>.bukalaris.id` or the verified custom domain). The cart cookie is host-only and cannot cross to `checkout.bukalaris.com`; a cross-site hand-off would add a token exchange to every order and lose the first-party advertising cookies (`_fbp`, `_fbc`, click ids) that PR-20 signals depend on. `checkout.bukalaris.com` remains the hosted checkout for independent storefronts that enter through the one-use hand-off token of PR-16.

6. **Cookies and HSTS are scoped per registrable domain.** No cookie is set on `.bukalaris.id` or `.bukalaris.com`; session and CSRF cookies stay host-only with the `__Host-` prefix (DOM-6). `includeSubDomains` on `bukalaris.id` covers storefronts only; custom domains receive the HSTS header on their own host without `includeSubDomains`. The staged rollout stays T-94.

7. **Absolute links pick their origin by link type.** Storefront, landing-page, feed, order-status and abandoned-checkout recovery links use the store's primary host (custom domain when verified and primary, otherwise `<store-slug>.bukalaris.id`). Seller Admin, Owner console, buyer portal, affiliate portal and password/invite links use the platform host. A feed or e-mail must never be built from the request host.

## Alternatives considered

- *Keep everything on `bukalaris.com`* — works today, but leaves seller content same-site with the Owner console and ties platform reputation to every store.
- *A dedicated subdomain such as `<slug>.toko.bukalaris.com`* — one domain to buy, but still same-site with platform surfaces and needs a nested wildcard certificate.
- *Checkout on `checkout.bukalaris.com` for every order* — one checkout origin to harden, but every order becomes a cross-site hand-off and first-party ad cookies are lost; kept only for PR-16.

## Consequences

- **Positive:** seller content is cross-site to all platform sessions; storefront abuse cannot damage the platform domain; one stable CNAME target; custom domains and native hosts follow the same checkout path.
- **Negative:** two domains, two wildcard certificates and two DNS zones to operate; the host dispatch, CSRF audience, feed and e-mail link builders must read two roots; every example host in docs 02, 04, 08, 12, 16, 17 and the deploy plan changes; the T-70/T-82 host tests need a two-root case.
- **Neutral:** store slugs stay platform-unique. Existing local data needs no migration, because the root domain is configuration, not stored data.

## Confirmation

- `packages/db/test/host.test.ts`: a two-root table proves that a platform label on the store root and a store slug on the platform root both fail closed, and that `cname.<store root>` is never a store.
- `apps/web/e2e/host-mode*.spec.ts`: cart, checkout and confirmation complete on the store host with two different roots configured, at 320 px and desktop.
- A link-origin test covers feeds, order-status links and recovery links for a store with and without a primary custom domain.

## Owner decisions on the former open items (2026-11-14, D-31)

The owner accepted the recommended defaults on 2026-11-14 (DECISIONS D-31). The IDs are kept so earlier references still resolve. Decided, not implemented.

| ID | Item | Decision |
|---|---|---|
| OPEN-D1 | Host of the later cross-store affiliate storefront | Deferred with T-54/T-55; no third domain is reserved |
| OPEN-D2 | Apex custom domains | Subdomain only (`www.`, `shop.` and similar). An apex domain is refused with an explanation until T-15 verifies the provider's apex support |
| OPEN-D3 | Registration and DNS for `bukalaris.id` | Registered, together with `bukalaris.com` (owner statement, 2026-11-14; not checked by an agent). No DNS record is created until the deployment work |

## Clarifications (2026-11-15, D-32; accepted by the owner)

The document alignment of 2026-11-15 found questions this ADR did not answer. Each row is the smallest answer consistent with the accepted decisions. The owner accepted every row on 2026-11-15 (D-32), with the changes marked in the rows. Decided, not implemented.

| ID | Question | Answer | Owning task |
|---|---|---|---|
| C-D1 | A referral click is recorded on `bukalaris.com`, but the cart and checkout are on the store host; a host-only cookie cannot cross | A store affiliate link points at the store's primary host (`https://<store host>/r/<token>`). The store host serves the click route for its own store and sets the host-only click cookie there. No cookie or token crosses domains. `bukalaris.com/r/…` stays reserved for the deferred cross-store stage. This narrows the `/r/…` row of decision 1 | T-103 (route on the store host), T-108 |

## Change history

- 2026-11-14: created from the owner decision of the same day.
- 2026-11-14: owner accepted the recommended defaults (D-31).
- 2026-11-15: one clarification proposed (referral click on the store host; D-32, awaiting owner confirmation).
- 2026-11-15: owner accepted C-D1 (D-32).
