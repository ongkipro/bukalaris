# Bukalaris API Contract Scope

[openapi.yaml](openapi.yaml) is the machine-readable OpenAPI 3.1 contract.
Every operation still carries `x-status: proposed` (the checker requires it);
the ten operations that exist on `main` additionally carry an `x-implemented`
note with the real route or server action. All other paths, the proposed
`owner.`/`app.`/`checkout.bukalaris.com` origins and the `/api/v1` prefix are
design proposals, not implemented endpoints (one app serves everything,
DECISIONS D-2). HTTP schema ownership stays in that file; this document
explains boundaries, provider gaps, and acceptance. Do not create a competing
route specification.

## Implemented versus proposed (checked against `main`, 2026-10-07)

| Contract area | OpenAPI operations | On `main` |
|---|---|---|
| Storefront API v1 (headless) | `listStorefrontProducts`, `getStorefrontProduct`, `createCart`, `getCart`, `addCartItem`, `updateCartItem`, `createCheckoutHandoff` | Implemented as route handlers under `/api/storefront/v1/**` (`apps/web/src/app/api/storefront/v1/**`), bearer channel token, JSON errors `{code, message, correlation_id}`; no pagination, no `Idempotency-Key`, no rate limit (ARCH-5 HTTP-05..HTTP-11). `getStorefrontConfig`, `listStorefrontCollections`, `getStorefrontPage`, `getOrderOutcome`: not implemented |
| Channel lifecycle | `listStorefrontChannels`, `createStorefrontChannel`, `revokeStorefrontChannel` | Implemented as Seller Admin page + server actions (`/seller/channels`), not as HTTP routes |
| Hosted checkout | `quoteCheckout`, `submitCheckout`, `getHostedCheckout` | Behaviour exists as the `/checkout` server component and `submitCheckout` server action plus the handoff exchange `GET /checkout/h/{code}`; no checkout-session HTTP endpoints |
| Seller catalog/inventory/content/settings/orders | `listSellerProducts` … `requestShipment`, `getStoreSettings`, `updateTheme`, … | Behaviour exists as server components/actions under `/seller/**` (functions listed in 04-SYSTEM-ARCHITECTURE "Development function map"); no HTTP routes. Not implemented at all: `changeProductSlug` (slug edit happens through `editProduct`/`updateProduct`), `publishProduct`/`archiveProduct` (status field), `duplicateProduct`, menus (`*Menu`), domains (`*Domain`, `getRoutingSettings`, `setPrimaryDomain`), `requestShipment` (T-39) |
| Owner console (formerly Super Admin) | `listAdminStores`, `createStore`, `getAdminStore`, `transitionStore`, `listSystemLogs`, `getSystemLog` | Behaviour exists as `/admin`, `/admin/stores/**`, `/admin/logs/**` server components/actions; no HTTP routes |
| `/session` | `getSession` | Not implemented; seller context comes from `sellerContext` inside the app |
| Operational handlers (not in OpenAPI) | — | `GET /api/health`, `GET /api/ready`, `POST /api/signals`, `GET/POST /api/auth/*` (Better Auth), media `GET /s/{store}/media/{id}` and `GET /seller/products/{id}/media/{mediaId}` (ARCH-5 HTTP-01..HTTP-04, HTTP-13, HTTP-14) |

Known drift to fix in `openapi.yaml` (owner: channels/catalog tracks): the
`StorefrontProduct`/variant schemas lack the additive `catalog_id` string
fields that the implementation returns (docs/tracks/catalog.md), and the
`getStorefrontProduct` `x-implemented` note still says "numeric id" where the
URL segment is now the catalog id (D-8). The `Theme` enum is `responsive` |
`mobile` in code versus `mobile-480` in the contract (docs/tracks/content.md).

| API domain | Consumer | Contract requirements |
|---|---|---|
| Seller CMS | Seller browser | Membership scope, pagination, validation, optimistic conflict handling |
| Storefront commerce | Storefront/browser | Host/store binding, public catalog, server-authoritative cart/checkout |
| Owner console | Platform operators | Platform role, audit reason for sensitive changes, target tenant visibility |
| Provider adapters | Trusted backend only | Timeout, idempotency, stable local/provider references, sanitized errors |
| Webhook/callback | Provider to backend | Verified authenticity before parse/side effect, durable deduplication |
| Future connector | Seller system | Explicit data ownership, sync cursor, conflict/delete semantics, scoped credential |

## API-1 — Common envelope

- Owner: Bukalaris API owner
- Contract: Draft `openapi.yaml`; route and authentication decisions remain reviewable proposals.

Every implemented operation must specify an operation ID, request schema,
success state, expected validation/authorization/not-found/conflict/rate-limit
errors, idempotency behavior where it mutates money/stock/provider state, and
no-secret error format. Authentication and tenant source must be declared per
operation, not inferred from tag name.

## API-2 — Provider rules

- Owner: Bukalaris integration owner

AutoLaris creation persists local `reff_id` before request and reconciles with
provider `transaction_id`; it must not pair `/submit` with another payment
creation for the same checkout. Mengantar estimation must evaluate route and
COD eligibility fields before displaying a method. Current provider docs and a
sanitized observed sandbox response override this planning statement.

## API-3 — Future landing-page MCP boundary

- Status: Proposed
- Owner: Bukalaris API owner
- Source: PR-9.
- Statement: Specify an MCP adapter for the independent landing-page builder using
  the same store-scoped content operations as Seller CMS. Tool names, protocol
  version, transport, authentication, and SDK are Unknown until contract design
  verifies current official MCP documentation and the repository stack.
- Acceptance: The contract defines discovery of supported sections, draft
  creation/editing, validation, preview, and the publication boundary. Each
  operation checks authenticated store membership and capability server-side;
  a supplied store/page identifier alone grants no authority. Invalid section
  configuration, cross-store references, stale edits, retries, and access
  revocation have explicit outcomes. Mutations retain actor/store audit context.
  Proposed form protection applies equally to visual and MCP edits: neither
  path may rewrite protected form fields, validation, or submission behavior.
  T-11 must define which form properties are protected and which are editable.
- Proposal: MCP edits create or update drafts; publication is a separate
  capability and explicit action. MCP publication follows API-9 and requires human approval bound to the
  exact object and revision; LP form policy remains under T-11.
- Constraints: API-1, IAM-2, IAM-7, TEN-1, UI-4, SEC-2.
- Evidence: Contract planning only; no MCP endpoint or tool is implemented.
- Change history: 2026-09-18 — added the future integration boundary.

## API-4 — Advertising content identity contract

- Status: Proposed
- Owner: Bukalaris integration owner
- Source: PR-12 and DATA-5.
- Statement: Catalog exports and browser/server commerce events share one
  identity mapper scoped to the store and configured catalog granularity.
- Acceptance: For the same sellable item, exported catalog ID, browser
  content_ids, and server content_ids/contents IDs agree exactly as strings.
  Product-group events, if used, require a separately verified content_type
  contract. LP events identify the actual referenced/selected product or variant,
  never the LP ID or an invented default. Multi-item events use actual items.
- Constraints: DATA-5, TEN-1, NFR-4.
- Evidence: Contract fixtures and Meta Test Events/catalog matching pending.
- Change history: 2026-09-18 — proposed shared identity mapping.

Product content identity is distinct from event_id (one event occurrence for
browser/server deduplication) and external_id (customer/visitor identity).
Keep seller Pixel/catalog configuration store-scoped and credentials server-only.
Test create, duplicate, variants, slug rename, domain switch, storefront and LP
purchase paths against the same catalog fixtures, not isolated expected IDs.

Source review on 2026-09-18: [Shopify Product](https://shopify.dev/docs/api/admin-graphql/latest/objects/Product)
exposes separate handle, GraphQL ID, and numeric legacyResourceId fields;
[productByHandle](https://shopify.dev/docs/api/admin-graphql/latest/queries/productbyhandle)
describes title-derived handles. Bukalaris's short numeric default slug is its
own proposal, not a claim about Shopify's default URLs.
Meta [custom data](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/custom-data)
and [Pixel reference](https://developers.facebook.com/docs/meta-pixel/reference)
returned HTTP 429 during this research. Reverify the current official item/group
mapping and payload contract before implementation; no Graph API version is
selected here and provider acceptance is not established.

## API-5 — Proposed product authoring operations

- Status: Proposed
- Owner: Bukalaris API owner
- Source: PR-12, DATA-5, UX-10.
- Statement: Product authoring separates draft creation, editing, publication,
  and duplication. The operation names below are logical contracts, not shipped
  HTTP endpoints or a versioned OpenAPI specification.
- Acceptance: Concurrent/retried creation does not duplicate a logical product;
  slug edits cannot hijack another product or lose redirects; stale edits and
  cross-store references are rejected without overwriting valid data.
- Constraints: PR-2, DATA-1, DATA-5, API-1, IAM-2.
- Evidence: Behavioral checks below are planned, not executed.
- Change history: 2026-09-18 — detailed product authoring contract.

| Operation | Input / guard | Result and atomicity |
|---|---|---|
| Create draft | Title; explicit store-scoped catalog capability; client creation key | Allocate numeric ID, claim default numeric slug, persist draft and creation result in one transaction; return ID/slug/revision |
| Edit product | Product ID, allowed changes, expected revision | Validate ownership and typed fields; stale revision returns conflict; IDs and store ownership are immutable |
| Change slug | Product ID, normalized candidate, expected revision | Claim new route and retain previous route as alias atomically; collision returns field error with no partial rename |
| Publish product | Product ID, expected revision | Validate required content, prices and inventory policy under PR-2; change publication state only on success |
| Duplicate product | Source ID, creation key | Create a new draft with fresh product/variant identities and numeric slug; never copy publication state or catalog identity |

Creation keys are scoped to store, actor, and operation. Same key/same input
returns the original result; same key/different input conflicts. A database
constraint arbitrates concurrent retries. Key expiry and retry guarantees must
be specified before implementation. Transport loss is retried with the same
key, not a new product request. Sequence gaps are allowed.

Proposed errors distinguish validation, permission/not-found, conflict, rate
limit, and dependency failure under API-1. Public product queries derive store
from verified host and return only sellable/published content; seller read APIs
may include drafts only with capability checks.

## API-6 — Proposed seller domain operations

- Status: Proposed
- Owner: Bukalaris API owner
- Source: PR-13, DOM-2, UX-11.
- Statement: Domain operations persist a local intent and reconcile provider
  state through trusted backend work. Never hold a database transaction open
  while waiting for a DNS/TLS provider.
- Acceptance: Unknown provider outcomes do not create duplicate hostname
  resources; removed/reassigned domains cannot be reactivated by stale work.
  Only verified ready domains can become primary.
- Constraints: DOM-1, DOM-2, DOM-3, DATA-1, IAM-2, SEC-3.
- Evidence: Provider adapter and integration tests pending.
- Change history: 2026-09-18 — detailed domain operation contract.

| Operation | Input / guard | Result and recovery |
|---|---|---|
| Add domain | Hostname, creation key; domain-management capability | Normalize hostname; reserve unique claim; persist provisioning intent; return local ID and truthful pending state |
| Read status | Local domain ID; same-store permission | Return safe DNS instructions, separate verification/TLS/routing states, and last checked time |
| Refresh verification | Domain ID; bounded rate | Reconcile provider resource; repeated clicks do not create a new resource |
| Set primary | Domain ID and expected store routing revision | Require active ownership, TLS, and routing; atomically replace primary reference and record route-cache invalidation work |
| Remove domain | Domain ID and expected revision | Switch primary if needed; disable local routing and invalidate caches; reconcile provider cleanup before releasing hostname claim |

Persist provider resource ID when known and local intent generation for each
operation. Timeout means pending/unknown, not success or immediate recreation.
Reconcile the hostname with the provider before retrying a create. Jobs verify
current store, desired state, and intent generation before applying responses;
stale jobs cannot attach a domain to a different store. Authoritative routing
must reject removed/suspended bindings even if cleanup is still pending.

## API-7 — Versioned headless HTTP contract
- Status: Proposed
- Owner: Bukalaris API owner
- Source: PR-14.
- Statement: openapi.yaml owns proposed HTTP operations and JSON schemas for
  native/external storefronts, hosted checkout, Seller Admin and the Owner console.
  Use a versioned /api/v1 boundary with consistent errors and pagination.
- Acceptance: OpenAPI lint and local-reference checks pass; implementations
  must later pass request/response, permission, idempotency and concurrency
  conformance. Additive compatible changes stay within the version; breaking
  changes require a migration/deprecation plan and consumer verification.
- Constraints: ARCH-6, TEN-1, API-1, NFR-4.

Initial contract gaps remain explicit: identity-provider login/recovery/invites,
media upload, address lookup, provider callbacks/signatures, exact tax/refund/COD
policy, and future LP/MCP operations. A valid schema does not prove these flows
exist. No GraphQL layer or public SDK is required merely to resemble Shopify.

## API-8 — External storefront to hosted checkout
- Status: Proposed
- Owner: Bukalaris API owner
- Source: PR-16.
- Statement: Channel tokens and cart capabilities authorize storefront/cart
  calls. A checkout-handoff operation returns a server-issued checkout_url.
  Hosted checkout quote/submit operations require the separate checkout session;
  the external storefront never submits payment through a Seller/Admin API.
- Acceptance: An independent client can read catalog, create/edit its cart,
  request a handoff, navigate to /checkout and receive a platform-owned result.
  Token-store mismatch, stale cart, revoked grant, tampered return origin and
  repeated submit fail safely. Browser/server tracking preserves catalog identity.
- Constraints: IAM-11, DOM-4, SEC-13, DATA-5, UX-12.

Proposed developer flow: create channel in Seller Settings; store private token
in Cloudflare server secrets; call the published API with normal HTTP; retain
cart capability in the storefront backend session; request checkout_url at buyer
handoff; redirect browser; consume only an authorized outcome. Never send the
private token to browser JavaScript or construct the checkout URL manually.
Cross-origin tracking/consent continuity requires an explicit reviewed handoff;
do not assume storefront cookies exist on the checkout origin.

## API-9 — MCP catalog and content contract

- Status: Proposed
- Owner: Bukalaris API owner
- Source: PR-17, TD-6, IAM-12.
- Statement: Expose capability-filtered read resources, draft tools and guided
  prompts through one future MCP adapter over the same core services as Seller Admin.
  Resolve actor, store and revocable grant before discovery or execution. Inputs
  use validated schemas, stable object IDs and expected revisions; URLs and
  media references are constrained to authorized content.
- Acceptance: Foreign-store IDs, missing grants and revoked sessions fail closed.
  Stale revisions return conflicts without overwriting changes. Draft retries
  do not create duplicate content. Publishing requires a separate capability
  and human approval bound to object, revision and operation; editing invalidates
  earlier approval. Content grants cannot mutate price, inventory, financial
  state, customer records, credentials or platform configuration.
- Constraints: DATA-6, IAM-12, TEN-1, SEC-9, UX-13.
- Evidence: Documentation contract only. Protocol version, SDK, transport, tool
  schemas and approval transport require verification before the MCP milestone.

MCP is later scope and is not represented as a deployed endpoint in OpenAPI.
Published HTTP contracts remain owned by `openapi.yaml`.

## HTTP host ownership

Proposal: Path-level OpenAPI servers declare each proposed surface origin.
Seller Admin serves `/seller/*` and `/storefront/*`; the Owner console serves `/admin/*`; the
checkout surface (a route group of the one Next.js app on its own origin, ADR-0008) serves `/checkout/*`. Route groups must not be mounted on
other hosts by a wildcard proxy rule. Same-origin cookies authenticate each
admin surface; external storefronts use scoped server-side channel tokens on
Seller Admin. Native storefront cart endpoints are thin same-origin adapters, not
an alternative commerce API. Document provider callback origins only after
verified provider contracts establish the necessary paths and signatures.


Proposal: `/session` belongs to Seller Admin and returns seller memberships. Owner console
operator login/session lifecycle remains an auth-adapter contract to specify
under T-17; do not reuse seller membership responses as platform authority.
