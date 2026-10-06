# Bukalaris Domain Routing

Decision, 2026-09-25: `bukalaris.com` is the selected primary product domain.
The routing rules below are specifications; DNS and deployment are unverified.

## DOM-1 — Host resolution

- Owner: Bukalaris platform owner

`<store-slug>.bukalaris.com` is the Phase 1 storefront shape. The platform
normalizes a received host, rejects reserved/platform labels, and resolves it to
one active store before any storefront data is fetched. `bukalaris.com` is
reserved for the platform and future marketplace.

## DOM-2 — Custom domain lifecycle

- Owner: Bukalaris platform owner

Custom domains require a separate domain record, not a `stores.custom_domain`
text field. The record needs normalized host, store, verification state,
provider reference, certificate state, failure reason, and check time.
The Store primary-domain reference owns the primary choice (see Data Model). One host belongs to one store; one store has at most one primary host.

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
| `bukalaris.com` | Public product site; future marketplace is a separate milestone | User decision |
| `bos.bukalaris.com` | Super Admin; platform identities and operator APIs only | User decision |
| `app.bukalaris.com` | Tenant admin; active store derived from membership; central commerce APIs | User decision for admin, API placement recommendation |
| `checkout.bukalaris.com` | `/checkout`, confirmation and checkout-session API | Architecture recommendation |
| `<store-slug>.bukalaris.com` | Native tenant storefront | Existing design baseline |
| Verified seller custom domain | Same tenant renderer and published content | Existing design baseline |

Reserve `bos`, `app`, `checkout`, `www`, `api`, `mail`, `status`, `docs`,
`assets` and `cdn` from seller claims. Reserve each new platform label before
use. Exact platform hosts are matched before tenant subdomain resolution.
Proposal: Redirect `www.bukalaris.com` to the apex for public GET/HEAD only.
No host in this table is claimed to be registered, provisioned or live.

Admin and checkout cookies are Secure, HttpOnly and host-only; do not set a
parent-domain session cookie on `.bukalaris.com`. Bos and Tenant Admin use separate
session audiences and server-side access policy. A tenant storefront must not
receive either admin session. Allowlisted CORS is not authorization; exact-origin
and CSRF checks apply to cookie-authenticated writes. Both admin surfaces and
checkout are noindex; authenticated responses are private/no-store.

