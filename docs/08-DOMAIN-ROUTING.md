# Bukalaris Domain Routing

Decision, 2026-09-25: `bukalaris.com` is the selected primary product domain.
The routing rules below are specifications; DNS and deployment are unverified.

## DOM-1 — Host resolution

- Owner: Bukalaris platform owner

`<store-slug>.bukalaris.com` is the Phase 1 storefront shape. The platform
normalizes a received host, rejects reserved/platform labels, and resolves it to
one active store before any storefront data is fetched. `bukalaris.com` is
reserved for the platform front door (Bukalaris is an online-store platform, not
a marketplace; any future discovery surface is a separate feature).

## DOM-2 — Custom domain lifecycle

- Owner: Bukalaris platform owner

Custom domains require a separate domain record, not a `stores.custom_domain`
text field. The record needs normalized host, store, verification state,
provider reference, certificate state, failure reason, and check time.
The Store primary-domain reference owns the primary choice (see Data Model). One host belongs to one store; one store has at most one primary host.

Host binding resolver (T-70, T-15). The proxy decides what a host means before
any storefront data is fetched, but the host parser (`host.ts`) stays a pure
function with no database import (ADR-0008 section 5). A custom-domain lookup is
done by one narrow, read-only resolver that takes the normalized host and returns
only the store slug, store status and domain state of an active verified binding.
It reads through the minimal resolver grant of T-59, never through the generic
platform pool. It keeps a bounded in-process cache with positive and negative
entries and short configured lifetimes (proposed 60 s and 10 s, UNVERIFIED) and
is invalidated by an explicit routing-version bump written in the same
transaction as every domain mutation: activation, primary switch, removal,
reassignment and store suspension (storage location fixed by T-15). A database
error fails closed (503 without store data), never to a default store, and an
error is never cached as "not found". DOM-3 cache partitioning by resolved host
and store still applies.

## DOM-3 — Canonical and safety behavior

- Owner: Bukalaris platform owner

- Until an active custom primary exists, the store subdomain is primary.
- A secondary active host redirects `GET`/`HEAD` storefront HTML to primary;
  unsafe methods and API paths are not silently transformed.
- Storefront canonical URL, OpenGraph URL, sitemap and cache partitioning use
  the resolved primary origin. Checkout origin and registered return destinations
  follow DOM-4; they are not rewritten as storefront URLs.
- A host becomes primary only after ownership and browser-trusted TLS are
  verified through a selected provider. DNS/TLS provider selection is Unknown.

Provider selection, DNS targets, and deployment topology remain unconfirmed.

## Seller domain workflow

Decision: PR-13 confirms custom domains for each seller, covering both themes
and independent LP routes. Provider implementation remains a Bukalaris
architecture decision.

Proposal: Seller Settings → Domains → add hostname → receive provider-specific
DNS instructions → verify ownership → wait for TLS → activate → set primary.
Show pending DNS, ownership failure, certificate pending/failure, active, and
removed states separately, with safe retry. Do not invent DNS targets before
choosing the provider. Authorize domain mutations against store membership.

Reject reserved/platform hosts and duplicate claims; domain reassignment needs
fresh ownership proof and invalidation of prior tenant routing/caches. Existing
primary routing remains unchanged when a candidate domain fails verification.
Removal of a primary requires an atomic switch to an eligible verified domain
or the platform subdomain, followed by routing/cache invalidation.

Custom-domain changes affect origin/canonical links, not product IDs, variant
IDs, landing-page revisions, or catalog content identity. Update feed destination
URLs and permitted checkout returns to the active primary origin. Cookie/session
continuity across unrelated domains is not assumed; define cross-origin handoff
separately before launch. DNS/TLS changes require explicit deployment authority.

## Proposed lifecycle and provider evaluation

Owner: Bukalaris platform owner. Status: Proposal. Source: PR-13 and API-6.

| Local desired/observed condition | Seller message | Allowed transition |
|---|---|---|
| Provisioning requested, no confirmed provider resource | Setting up domain | Reconcile; never imply the domain is live |
| Resource known, ownership or DNS incomplete | Waiting for DNS/verification | Show exact records and retry status check |
| Ownership ready, certificate pending | Preparing certificate | Wait/reconcile; primary selection unavailable |
| Ownership, TLS and routing ready | Connected | Eligible to set primary |
| Check failed or observations stale | Needs attention / last checked | Preserve known data and previous primary; retry without duplicating resource |
| Removal requested | Disconnecting | Disable local serving; reconcile cleanup |
| Cleanup confirmed | Disconnected | Archive record; fresh claim requires fresh verification |

Primary is a separate store relationship, not a domain lifecycle state. Pending
or failed candidate setup does not replace a working primary. Revalidate target
eligibility under the same transaction/concurrency boundary as primary switching.
If an existing primary loses eligibility, stop serving through the invalid
binding and use the platform subdomain for future canonical links. A host with
broken TLS cannot be promised a working HTTP redirect; show recovery status.

Evidence reviewed 2026-09-18:

- [Cloudflare custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/)
  supports SaaS customer hostnames.
- [Cloudflare setup and readiness](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/)
  separates hostname activation from certificate activation and requires DNS
  pointing at the SaaS target. A successful TLS handshake alone is not the
  onboarding source of truth.
- [Hostname validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/)
  supplies ownership-validation approaches.
- [Apex proxying](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/apex-proxying/)
  is a separate path to assess when a customer's DNS needs A-record routing.

Recommendation (inference): Evaluate Cloudflare for SaaS as the first candidate
for centralized custom-hostname/TLS management. This does not choose Workers,
require per-seller deployments, or approve a subscription. Verify hosting/origin
compatibility, plan entitlements, cost, and apex-domain DNS support before
selection. Do not assume every DNS host supports a CNAME at the zone apex.

### Operational guardrails adopted from Etalashop (`CUSTOM_DOMAIN.md`, 2026-10-26)

When implementing `T-15` with Cloudflare for SaaS:

1. **Single authoritative CNAME target (`CUSTOM_DOMAIN_CNAME_TARGET`):** Read the
   fallback CNAME target from runtime configuration (`CUSTOM_DOMAIN_CNAME_TARGET`,
   e.g. `cname.bukalaris.com` or a dedicated fallback zone) and reserve `cname` in
   the platform's reserved-slug list so no store can ever claim it.
2. **Never verify a custom domain by comparing IP addresses:** Because the
   fallback target sits behind Cloudflare's proxy, its `A`/`AAAA` records are
   Cloudflare shared anycast IPs. A merchant who copies those IPs into `A` records
   instead of creating a `CNAME` will resolve to identical IPs while remaining
   completely unservable by Cloudflare for SaaS. Verification (`domainServable`)
   must check actual DNS `CNAME` resolution (or Cloudflare Custom Hostname
   `status === "active"` **and** `ssl.status === "active"`), never IP equality.
3. **Separate `store_domain` state from `store.primary_domain_id`:** A store may
   attach both `toko.com` and `www.toko.com`. Only a domain whose ownership and
   TLS are both `active` may be set as `store.primary_domain_id`. Secondary
   active hosts and `<slug>.<STORE_ROOT_DOMAIN>` issue a `308` redirect on
   `GET`/`HEAD` storefront and LP routes to the active primary origin while
   leaving `/checkout`, `/api/*`, and `/feeds/*` untouched.
4. **Dynamic per-request canonical and sitemap origin:** Storefront canonical
   tags, `og:url`, `og:image`, and `/sitemap.xml` resolve their base URL from the
   store's primary active origin (never a hardcoded build-time site URL).

## DOM-4 — Checkout and external storefront origins
- Owner: Bukalaris platform owner
- Source: PR-16 and ARCH-7.
- Contract: Configure one trusted checkout origin independently from native
  storefront primary hosts. `/checkout` and confirmation use platform layouts
  and host-only sessions; they are not wrapped in either storefront theme.
  Headless channel origins are registered return destinations, not native host
  routes. Native-domain primary redirects must not redirect checkout/API traffic
  into an external storefront or transform unsafe methods.
- Acceptance: External origin → Bukalaris checkout → registered return path
  works without cross-domain cookie assumptions; host spoofing and arbitrary
  return URLs cannot select another tenant or create an open redirect.

Proposal: A short-lived one-use handoff code is exchanged at `/checkout`,
followed by a redirect to a clean URL. Redact that code at the CDN/proxy as well
as the application. The recommended checkout origin is `https://checkout.bukalaris.com`;
its provisioning and handoff lifetime require deployment verification and are
not seller-editable input. Proposed lifetime:
five minutes; final value must be tested against buyer handoff/retry behavior.

## Platform domain map

| Host | Ownership and routing | Status |
|---|---|---|
| `bukalaris.com` | Public product site (front door), referral links `/r/…` and public report intake; no session surface; future discovery is a separate feature | User decision |
| `owner.bukalaris.com` | Owner console (formerly Super Admin / Bos); platform identities and operator APIs only | User decision, 2026-10-27; deployment UNVERIFIED |
| `berkah.bukalaris.com`, `bos.bukalaris.com` | Retired/reserved-unused; interim names, never deployed, kept reserved so nobody can claim them; no active Owner console alias and not claimable by sellers or affiliates | User decision, 2026-10-27 |
| `app.bukalaris.com` | Tenant admin; active store derived from membership; central commerce APIs | User decision for admin, API placement recommendation |
| `checkout.bukalaris.com` | `/checkout`, confirmation and checkout-session API | Architecture recommendation |
| `<store-slug>.bukalaris.com` | Native tenant storefront | Existing design baseline |
| Verified seller custom domain | Same tenant renderer and published content | Existing design baseline |
| `affiliate.bukalaris.com` | Separate affiliate portal/login/account role; host root rewrites to `/affiliate/…`, not seller admin | Proposed — ADR-0008, PR-28, UX-19; DNS/TLS UNVERIFIED |
| `buyer.bukalaris.com` | Separate Buyer account portal; `/buyer/…`; platform-level buyer identity under ADR-0010 and PR-7 | User decision, 2026-10-27; implementation and DNS/TLS UNVERIFIED |
| `logs.bukalaris.com` | Public product Update Log (release notes, what's new); read-only; rewrites to `/updates/…`. **Not** the internal Log System (`/admin/logs`, PR-11). Authored only in the Owner console on `owner.bukalaris.com` | User decision, 2026-10-27 ("if needed"); implementation and DNS/TLS UNVERIFIED |
| `<handle>.affiliate.bukalaris.com` | Platform-owned affiliate storefront; rewrites to `/a/<handle>/…`; selected seller checkout handoff with attribution | Proposed — ADR-0008, PR-29, UX-20; nested wildcard DNS/TLS UNVERIFIED |

Reserve `owner`, `app`, `checkout`, `affiliate`, `buyer`, `logs`,
`www`, `api`, `mail`, `status`, `docs`, `assets`, `cdn`, `cname` (the custom-domain
fallback CNAME target label, DOM-3 guardrail 1) and the retired `berkah` and `bos` from
seller claims and proposed affiliate handles. `owner` is the active Owner console host
label and is not claimable as a store slug or affiliate handle; `berkah` and `bos` are
retired/reserved-unused (interim names, never deployed, kept reserved so nobody can claim
them); `logs` is reserved for the Update Log. Reserve each new platform label before use.
Exact platform hosts are matched before affiliate/store subdomain resolution.
Proposal: Redirect `www.bukalaris.com` to the apex for public GET/HEAD only.
No host in this table is claimed to be registered, provisioned or live.

The Owner console, Seller Admin, Affiliate portal, Buyer account portal and checkout
cookies are Secure, HttpOnly and host-only; do not set a parent-domain session
cookie on `.bukalaris.com`. Buyer, seller-admin, Owner console and affiliate-portal
surfaces use separate cookie scopes and session audiences with server-side access
policy, never a shared session. A buyer session must never grant any admin
capability. Storefronts must not receive these portal/admin sessions. Allowlisted
CORS is not authorization; exact-origin and CSRF checks apply to
cookie-authenticated writes. Admin/portal surfaces and checkout are noindex;
authenticated responses are private/no-store. Session, CSRF and capability
cookies follow DOM-6 (`__Host-` prefix, per-surface names); which paths each host
serves is DOM-5.

The Update Log host (`logs`) is public and read-only: no login, session or
session audience; no session or authentication cookie; no personal data. It
serves only `GET`/`HEAD`; writes, `/checkout*` and every `/api/…` path except the
infrastructure probes are not served there (DOM-5). Content is platform-owned
published entries. It needs its own proxy profile (T-69): a static CSP without a
per-request nonce, no per-request cookie (no request-id cookie) and stable
validators, because the current proxy's nonce CSP and request-id cookie would
prevent shared caching. Freshness after publish or unpublish comes from
time-based staleness, or from the authenticated internal handler HTTP-30, never
from a public or cookie-authenticated route. UNVERIFIED until implemented.
Authoring requires the Owner console on `owner`.
Indexing policy is a product decision, not asserted here. This host is unrelated
to the Log System: it never exposes `system_log` or operator telemetry.

### Proposed affiliate and buyer namespaces and one-app dispatch

- Status: ADR-0008 and ADR-0010 accepted 2026-10-28 (D-20); host dispatch implemented locally by T-70, the rest proposed — [ADR-0008](ADR-0008-platform-architecture-and-routing.md),
  ADR-0010, PR-7, TD-7, T-51, T-54 and T-55; not evidence of implemented hosts.
- Normalize store slugs and affiliate handles to lowercase ASCII DNS labels
  (letters/digits with internal hyphens; no dots, leading/trailing hyphens or
  empty labels), maximum 63 characters. Enforce case-insensitive uniqueness
  atomically within each namespace. Check existing claims before reserving or
  activating a new label; a conflict requires owner-approved migration, never
  silent reassignment.
- Store and affiliate namespaces are distinct: the same normalized text can
  identify `<slug>.bukalaris.com` and `<handle>.affiliate.bukalaris.com` without
  ambiguity. An affiliate handle cannot claim a seller host or platform host.
  Seller custom-domain bindings cannot claim the platform-controlled affiliate
  subtree. Affiliate custom domains are not specified.
- `apps/web/src/proxy.ts` remains the single proxy (no second middleware).
  Exact platform hosts (`owner`, `app`, `affiliate`, `buyer`, `logs`, `checkout` and
  other platform reservations) precede the one-label affiliate subtree, then the
  one-label seller subtree/verified custom-domain lookup. `berkah` and `bos` remain
  unused reserved labels.
  Derive and overwrite
  internal routing headers; never trust browser-supplied store/affiliate scope.
  Unknown hosts, malformed nested labels and inactive bindings fail closed.
- Rewrite the Owner console (`owner`) to `/admin`, Seller Admin (`app`) to `/seller`,
  the affiliate portal to `/affiliate`, the buyer portal to `/buyer`, the
  affiliate storefront to `/a/<handle>` and seller storefronts to `/s/<store>`
  without double prefixes. Route groups do not appear in URLs. Buyer identity
  behavior belongs to ADR-0010 and PR-7, not this routing specification.
  Keep `/checkout`, `/checkout/…`, `/api` and `/api/…` un-rewritten (never
  surface-prefixed) on every surface; preserve the current broader `/checkout*`
  bypass during move-only T-51. Whether such a path is served at all on a given
  host is decided by DOM-5, activated by T-70: checkout only on the checkout
  host, a per-host `/api` allowlist, 404 elsewhere. Platform auth/recovery routes
  retain their intended surface. A host guard can refuse an invalid origin but
  cannot redirect an API/checkout write into storefront content.
- Affiliate product actions hand off to the selected seller's checkout at the
  configured platform origin; one store per order (TD-5), with attribution
  carried but no buyer identity or login authority in a referral selector.
  A multi-seller cart/split checkout remains deferred pending BILL-3.
- Affiliate and buyer portal cookies follow the separate host-only scopes and
  session audiences above, with independent server-side role checks.
  Portal/authenticated responses are noindex and private/no-store. Neither
  seller nor affiliate storefront receives an admin/portal session through
  a parent-domain cookie. Public affiliate storefront reads expose approved
  profile/catalog data only, never buyer PII.
- The `logs` host rewrites to `/updates` (read-only route group
  `(update-log)/updates/…`), serves only `GET`/`HEAD`, and 404s `/checkout*` and
  every `/api/…` path except the probes (DOM-5). T-51 documents this group without
  scaffolding it; T-69 owns its proxy profile.
- Existing DOM-1 through DOM-6 rules, primary-host safety and custom-domain
  ownership/TLS gates remain in force. T-51 moves existing entries without
  activating proposed hosts; T-70 activates exact-host dispatch, DOM-5 and DOM-6;
  feature changes supply host/header/origin and cross-store isolation evidence.
  Production DNS, TLS, nested wildcard support and deployed cookie/proxy
  configuration remain **UNVERIFIED**.


## DOM-5 — Host × path matrix and link origins

- Owner: Bukalaris platform owner
- Status: Proposed as a product contract; **implemented locally 2026-10-28 by T-70**
  (`packages/db/src/platform/host.ts` `dispatchHostPath`, `apps/web/src/proxy.ts`; golden
  table `packages/db/test/host.test.ts`; live-server checks `apps/web/e2e/host-mode.spec.ts`).
  Apex path mode (`/admin`, `/seller`, `/s/<store>`, `/checkout` on one host) now exists only
  on plain `localhost` with a local `STORE_ROOT_DOMAIN`; any other root domain answers 404
  for those prefixes on the apex. Not covered yet: the `/report`, `/r/<token>` and Compliance
  rows serve no route (404 or Next's own 404 until HTTP-27, SF-13 and HTTP-20 exist), the
  custom-domain column has no resolver (an unknown host is 404 until T-15), the Update Log
  host rewrites to `/updates` which has no route until T-69. Nothing is deployed; DNS and
  TLS are UNVERIFIED.
- Source: ADR-0008 sections 2 and 3; SEC-3, SEC-9, SEC-13; DOM-1, DOM-3, DOM-4.
- Contract: the table is the single answer to "does this host serve this path".
  A cell is `pass` (served as written, never surface-prefixed), `→ /x` (rewritten
  to that internal prefix; a request already carrying its surface's prefix is not
  double-prefixed), `308` (redirect) or `404` (not found, indistinguishable from
  an unknown route and with no store or account lookup). A surface's explicit
  prefix (`/admin`, `/seller`, `/affiliate`, `/buyer`, `/updates`, `/a`, `/s`) is
  served only on its own host and is 404 on every other host, the apex included.
  Unknown, inactive and reserved-but-unserved hosts (`www`, `api`, `mail`,
  `status`, `docs`, `assets`, `cdn`, `cname`, `berkah`, `bos`) return 404 for
  everything except the probes; `www` redirects `GET`/`HEAD` to the apex.
- Acceptance: T-70 ships a golden table of host × path × method derived from
  this section and a negative case for every `404` cell of a privileged or
  checkout path (ADR-0008 section 7); a change to this table and to that golden
  file land together.

Columns: Apex = `bukalaris.com`; Owner = `owner`; Seller = `app`; Checkout =
`checkout`; Aff = `affiliate`; Buyer = `buyer`; Logs = `logs`; AffStore =
`<handle>.affiliate`; Store = `<store-slug>` or a verified custom host.

| Path as requested (ARCH-5 id) | Apex | Owner | Seller | Checkout | Aff | Buyer | Logs | AffStore | Store |
|---|---|---|---|---|---|---|---|---|---|
| `/` | pass (WEB-01) | → `/admin` | → `/seller` | 404 | → `/affiliate` | → `/buyer` | → `/updates` | → `/a/<handle>` | → `/s/<store>` |
| `/login` (AU-01) | 404 | pass (operator instance) | pass (seller instance) | 404 | → `/affiliate/login` (AF-09) | → `/buyer/login` (BA-04) | 404 | 404 | 404 |
| `/account/*` (AU-02, AU-05) | 404 | pass | pass | 404 | 404 | 404 | 404 | 404 | 404 |
| `/invite/[token]` (AU-04) | 404 | 404 | pass | 404 | 404 | 404 | 404 | 404 | 404 |
| `/o/[token]` (SF-11) | 404 | 404 | 308 → Checkout origin (`GET`/`HEAD`; only for links mailed before T-70, until their 30-day lifetime ends, then 404) | pass | 404 | 404 | 404 | 404 | 404 |
| `/feeds/[token]/*` (HTTP-15) | 404 | 404 | pass | 404 | 404 | 404 | 404 | 404 | 404 |
| `/dev/outbox` (OPS-01) | 404 | pass only when `DEV_OUTBOX=1`, never in production | 404 | 404 | 404 | 404 | 404 | 404 | 404 |
| `/api/auth/*` (HTTP-01) | 404 | pass (operator instance) | pass (seller instance) | 404 | pass (affiliate instance) | pass (buyer instance) | 404 | 404 | 404 |
| `/api/health`, `/api/ready` (HTTP-02, HTTP-03) | pass | pass | pass | pass | pass | pass | pass | pass | pass (also on unknown and internal hosts; no data) |
| `/api/signals` (HTTP-04) | 404 | 404 | 404 | pass | 404 | 404 | 404 | 404 | pass |
| `/api/storefront/v1/*` (HTTP-05 to HTTP-11) | 404 | 404 | pass | 404 | 404 | 404 | 404 | 404 | 404 |
| `/api/payments/autolaris/callback` (HTTP-17), `/api/shipping/mengantar/webhook` (HTTP-26) | pass (`POST` only) | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 |
| `/api/public/reports` (HTTP-20; 404 until the Compliance center is activated) | pass | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 |
| `/api/internal/*` (HTTP-30) | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 (served only on the internal service host, which no public router targets) |
| `/checkout`, `/checkout/*` (SF-07, SF-08, SF-10, HTTP-12) | 404 | 404 | 404 | pass | 404 | 404 | 404 | 404 | 404 |
| `/r/[token]` (HTTP-27) | pass (`GET` only) | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 |
| `/report` (SF-13; 404 until activation) | pass | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 |
| `/admin/*` | 404 | pass | 404 | 404 | 404 | 404 | 404 | 404 | 404 |
| `/seller/*` | 404 | 404 | pass | 404 | 404 | 404 | 404 | 404 | 404 |
| `/affiliate/*` | 404 | 404 | 404 | 404 | pass | 404 | 404 | 404 | 404 |
| `/buyer/*` | 404 | 404 | 404 | 404 | 404 | pass | 404 | 404 | 404 |
| `/updates/*` | 404 | 404 | 404 | 404 | 404 | 404 | pass (`GET`/`HEAD`) | 404 | 404 |
| `/a/*` | 404 | 404 | 404 | 404 | 404 | 404 | 404 | pass | 404 |
| `/s/<store>/*` | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 | `308` strip when the prefix names this host's store (`GET`/`HEAD`), 404 for another store |
| any other path | 404 | surface 404 | surface 404 | 404 | surface 404 | surface 404 | surface 404 | surface 404 | storefront 404 |

Rules that apply to every cell:

- Framework static assets (`/_next/*` and the existing static exclusions) pass on
  every host. `robots` and indexing follow the surface: Owner, Seller, Checkout,
  Aff and Buyer are noindex.
- Only `Logs` and `AffStore` are `GET`/`HEAD` only (other methods are refused,
  not rewritten); `/r/[token]` is `GET` only; the two provider endpoints are
  `POST` only.
- `/api/auth/*` selects the auth instance, cookie name and session audience from
  the host's surface, never from a header, query or body value a browser sends.
- Seller-chosen third-party scripts (pixels) run only on `Store` and `Checkout`
  pages, never on an origin that carries an Owner, Seller, Aff or Buyer session,
  and not on `/o/`. Because `Checkout` hosts pixels it carries no portal or admin
  session either (it sets only the cart capability cookies of DOM-6).
- Apex path mode retirement: one-host path mode (`/admin`, `/seller`,
  `/s/<store>`, `/checkout` on one host) exists for local development, tests
  and the M1 single-host deployment. T-70 retires it for every deployment where
  `NODE_ENV=production` and `STORE_ROOT_DOMAIN` is not a local domain: the apex
  then answers 404 for those prefixes. Local development keeps path mode on
  `localhost`; host mode is exercised on `*.localhost` (T-70, T-51 evidence).
  Until T-70 lands, DEPLOY-COOLIFY keeps exactly one admin host.
- A request whose path store and host store differ, or whose host is a store
  label that is also reserved, never reaches a store lookup (ADR-0008 section 3).

### Base origin by link type

No link is built from the request's own origin or from one shared auth URL. T-70
replaces the single `BETTER_AUTH_URL` with the per-surface origins below
(DEPLOY-COOLIFY planned variables); a link built for the wrong surface is a 404
under the matrix above.

| Link or URL | Base origin | Setting |
|---|---|---|
| Owner console links, operator recovery links | Owner console origin | `OWNER_ORIGIN` |
| Seller Admin links, member invitations (`/invite/…`), seller recovery links, catalog feed URLs (`/feeds/…`) | Seller Admin origin | `APP_ORIGIN` |
| Buyer order-status links (`/o/…`) in e-mails and notifications | Checkout origin | `CHECKOUT_ORIGIN` |
| Checkout handoff (`/checkout/h/…`), checkout return, `/checkout?store=` from a storefront or landing page | Checkout origin (absolute URL, never relative) | `CHECKOUT_ORIGIN` |
| Storefront pages, canonical, sitemap, product URL preview in Seller Admin | The store's primary origin from `storeBaseUrl` (DOM-3), never `BETTER_AUTH_URL` | derived per store |
| Referral links (`/r/<token>`), provider callbacks (HTTP-17, HTTP-26), public report intake | Platform origin (apex) | `PLATFORM_ORIGIN` |
| Affiliate portal links and affiliate recovery | Affiliate portal origin | `AFFILIATE_ORIGIN` |
| Affiliate storefront | `https://<handle>.<AFFILIATE_ROOT_DOMAIN>` | `AFFILIATE_ROOT_DOMAIN` |
| Buyer portal links and buyer proof links | Buyer portal origin | `BUYER_ORIGIN` |
| Update Log permalinks and `feed.json` | Update Log origin | `LOGS_ORIGIN` |

## DOM-6 — Cookie and origin rules

- Owner: Bukalaris platform owner
- Status: Proposed as a product contract; **implemented locally 2026-10-28 by T-70** for the
  Owner, Seller, Affiliate and Buyer session cookies, the store-switch preference, store carts
  and the post-checkout cart (`surfaceCookieNames` in `host.ts`, one Better Auth instance per
  surface in `apps/web/src/lib/auth.ts`). Over plain HTTP in development and tests the names
  are unprefixed (`bl_owner`, …) as the contract allows; production uses `__Host-`. Browser
  behaviour of `__Host-` cookies on deployed hosts is UNVERIFIED (the e2e server is a
  production build over `http://*.localhost`, where Chrome accepted them). Session-bound
  CSRF tokens are **not** built: cookie-authenticated writes to `/api/auth/*` are guarded by
  Better Auth's trusted-origin check plus an exact-`Origin` match, a `Sec-Fetch-Site:
  cross-site` refusal and a refusal of a cookie request without `Origin`
  (`api/auth/[...all]/route.ts`); Next server actions keep their own Origin/Host check. The
  legacy-cookie read for open carts is not built because nothing is deployed.
- Source: ADR-0008 section 1; SEC-9; IAM-14.
- Contract:
  - Every session, CSRF and capability cookie uses the `__Host-` prefix: `Secure`,
    `Path=/`, **no `Domain` attribute**, `HttpOnly` for sessions. Names are per
    surface and a server reads only its own surface's names and ignores any
    other cookie: Owner console `__Host-bl_owner`; Seller Admin `__Host-bl_seller`
    and the store-switch preference `__Host-bl_store`; Affiliate portal
    `__Host-bl_aff`; Buyer portal `__Host-bl_buyer`; store cart
    `__Host-bl_cart_<storeId>`; post-checkout cart `__Host-bl_order_cart`; referral
    click continuity `__Host-bl_click` (`SameSite=Lax`, set only on a top-level
    `GET` navigation, ADR-0009). The Update Log host sets none.
  - Cookie tossing: scripts that run on a storefront subdomain (seller pixels,
    themes) can write `Domain=.bukalaris.com` cookies that every sibling host
    receives. A cookie carrying a `Domain` attribute can never satisfy the
    `__Host-` prefix, so a tossed value cannot replace a session, CSRF or cart
    cookie, and the server ignores non-prefixed names.
  - CSRF tokens are not cookie-only: each is bound to the session (a keyed MAC of
    the session id) and sent in a header or form field, and every
    cookie-authenticated write also passes an exact `Origin` check and rejects
    `Sec-Fetch-Site: cross-site`. A tossed cookie cannot supply both halves.
  - Local development and `*.localhost` tests over plain HTTP may use unprefixed
    names when `NODE_ENV` is not `production`; production never accepts them.
  - Cookie renames are a T-70 behaviour change: a legacy name is read once to
    carry an open cart across, then the new name is set and the old one is never
    written again.
- Residual risk: the `__Host-` prefix blocks tossing but all hosts under one
  registrable domain stay the same site, so `SameSite` does not separate a
  storefront script from the consoles. **OPEN:** whether seller and affiliate
  storefronts move to a separate registrable domain. Recommended default
  (recommended, not decided): treat `STORE_ROOT_DOMAIN` as a deployment value that
  can differ from the platform domain (it already does), decide the storefront
  domain before public launch, and keep the controls above regardless.
