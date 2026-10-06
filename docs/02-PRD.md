# Bukalaris Product Requirements Document

| Field | Value |
|---|---|
| Status | Draft — planning only |
| Owner | Bukalaris product owner |
| Updated | 2026-09-25 |
| Market | Indonesia (`id-ID`, integer IDR) |
| Evidence boundary | `CONTEXT-RECORD.md`; staged specification, no implemented system |
| Product name | Bukalaris |
| Primary domain | `bukalaris.com` |
| Tagline | Buka toko langsung laris |

## Product identity

Decision, 2026-09-25: Bukalaris is a new, independent product. Use the exact
brand line **bukalaris.com | Buka toko langsung laris** in brand presentation.
The domain is the selected product identity; this document does not establish
DNS configuration or a deployed site. The tagline is brand copy, not a
measurable guarantee of seller revenue.

## Decision summary

Bukalaris is a proposed commerce platform for Indonesian sellers. It first
ships a platform console, Seller CMS, and independent storefronts. The same
canonical catalog and order model must later support a curated marketplace at
`bukalaris.com`, a global buyer identity, and affiliate attribution.

This is a product proposal, not an implementation approval. Provider behavior,
merchant-account ownership, marketplace settlement, tax treatment, and the
actual Bukalaris repository remain unresolved.

## Scope

### Phase 1 — Seller commerce foundation

- Super Admin creates, approves, suspends, and supports seller tenants.
- Seller configures store profile, catalog, inventory, collections, CMS pages,
  menus, branding tokens, enabled delivery/payment methods, and order handling.
- Two built-in storefront themes are available: a responsive storefront as the
  default, and a mobile-first alternative capped at 480 CSS px (PR-8).
- A storefront resolves one store by subdomain; a custom-domain path is
  supported per seller through domain ownership verification and TLS activation;
  this is a requirement, not a claim of a live integration.
- Buyer can browse, add to cart, use guest checkout, receive an order outcome,
  and later sign into a global account without losing ownership of the order.
- A checkout contains items from exactly one store.
- The platform calls Mengantar only from a trusted backend for estimates and
  shipment work; it calls AutoLaris H2H only from a trusted backend for payment
  instruction and reconciliation.

### Future scope — Storefront landing-page builder

- Decision: Support an MCP-enabled landing-page builder; landing pages belong
  inside each store's storefront, on its resolved subdomain/custom domain.
- Assumption: MCP means Model Context Protocol and allows an authorized external
  AI client to work with the Bukalaris builder. Exact integration direction and
  tool operations remain to be specified under T-11.
- This is future scope, not an addition to the Phase 1 release gate.

### Explicitly deferred

- Cross-seller cart and a combined marketplace checkout.
- Wallet, stored payment credential, escrow, seller payout, affiliate payout,
  split settlement, and tax/legal conclusions.
- Open third-party app/plugin marketplace and free-form HTML/CSS theme code.
- Direct arbitrary access to seller-owned databases.

## Actors and outcomes

| Actor | Job | Outcome | Scope |
|---|---|---|---|
| Super Admin | Operate the platform | A seller is approved/suspended with auditable reason | Global |
| Seller Owner/Staff | Run a store | Storefront content and sellable catalog are current | Assigned tenant/store |
| Buyer | Discover and buy | Confirmed single-store order with clear payment/shipping state | Storefront/global identity |
| Affiliate | Refer traffic | Attribution is captured without exposing buyer data | Global, deferred UI |
| Provider service | Quote, create, reconcile | Idempotent provider interaction linked to a local record | Narrow service scope |

## Requirements

### PR-1 — Tenant lifecycle
- Status: Proposed
- Owner: Bukalaris product owner
- Statement: A Super Admin shall create, approve, suspend, and reactivate a
  seller store; a suspended store shall not accept new buyer checkout.
- Acceptance: An approved seller can sign in and publish; a suspended seller
  receives a safe denial and its storefront preserves a non-purchasable state.
- Constraints: TEN-1, IAM-1, SEC-1, UX-1.

### PR-2 — Seller commerce CMS
- Status: Proposed
- Owner: Bukalaris product owner
- Statement: An authorized Seller user shall manage only its store's products,
  variants, stock, collections, CMS pages, menus, store profile, and settings.
- Acceptance: Cross-tenant reads and writes are denied server-side; a product
  cannot become sellable without required price, status, and inventory policy.
- Constraints: DATA-1, TEN-1, IAM-2, SEC-2, UX-2.

### PR-3 — Tenant storefront
- Status: Proposed
- Owner: Bukalaris product owner
- Statement: A buyer request shall resolve exactly one active store from a
  validated host and render only that store's published content and catalog.
- Acceptance: Unknown, disabled, and mismatched hosts fail safely; a request
  cannot render another store's data.
- Constraints: DOM-1, TEN-2, SEC-3, UX-3.

### PR-4 — Single-store checkout
- Status: Proposed
- Owner: Bukalaris product owner
- Statement: A cart and checkout shall be bound to one store; the server shall
  derive product price, stock, delivery eligibility, and order totals.
- Acceptance: A buyer cannot submit a mixed-store cart or client-supplied total;
  an unavailable provider result leaves the order/payment state unambiguous.
- Constraints: DATA-2, BILL-1, SEC-4, UX-4.

### PR-5 — Shipping and payment orchestration
- Status: Proposed
- Owner: Bukalaris product owner
- Statement: The platform shall obtain delivery eligibility from Mengantar and
  create/reconcile payment instructions with AutoLaris using stable local
  idempotency records.
- Acceptance: A physical shipment uses a quote-derived courier identifier;
  payment is marked paid only by an approved reconciliation policy, never a
  shipping callback or generic provider wording.
- Constraints: TD-3, API-2, BILL-2, SEC-5, OBS-2.

### PR-6 — Marketplace-ready catalog
- Status: Proposed
- Owner: Bukalaris product owner
- Statement: A seller may submit a product for marketplace eligibility, but it
  appears on `bukalaris.com` only after platform approval.
- Acceptance: A listing records seller, product, approval state, reviewer, and
  decision time; disabling a listing does not delete seller product data.
- Constraints: DATA-3, IAM-3, UX-5.

### PR-7 — Buyer identity and affiliate attribution
- Status: Proposed
- Owner: Bukalaris product owner
- Statement: The platform shall preserve a global buyer identity model and a
  privacy-reviewed affiliate attribution reference without requiring an account
  before checkout.
- Acceptance: Guest checkout remains available; later identity linking has an
  explicit verified ownership rule; attribution does not grant affiliate access
  to buyer/order personal data.
- Constraints: DATA-4, IAM-4, PRIV-2, UX-6.

### PR-8 — Two built-in storefront themes
- Status: Accepted
- Owner: Bukalaris product owner
- Source: Paduka Ongki's theme direction and explicit default selection on 2026-09-18.
- Statement: Bukalaris shall provide two built-in storefront themes. The default
  shall be a responsive storefront with a wider desktop layout, using Shopify
  Dawn as a visual reference for product-first presentation. The alternative
  shall be a mobile-first storefront with a maximum width of 480 CSS px.
- Acceptance: A newly configured store and the default demo use the responsive
  theme. Sellers can select the mobile-first alternative. Both themes support
  the same published catalog and buyer commerce capabilities; switching themes
  does not change store data or the platform-controlled checkout contract.
- Constraints: UI-1, UI-3, UI-4, UI-5, UX-3, NFR-3.
- Evidence: Product decision only; implementation and browser proof are pending.
- Change history: 2026-09-18 — accepted two built-in themes and responsive default;
  this decision does not approve application implementation.

### PR-9 — MCP-enabled storefront landing pages
- Status: Accepted
- Owner: Bukalaris product owner
- Source: Paduka Ongki's landing-page builder direction on 2026-09-18.
- Statement: Bukalaris shall support MCP for its future landing-page builder.
  Landing pages shall be store-owned content rendered inside the storefront,
  sharing its resolved domain, tenant context, catalog, cart, and checkout.
  Sellers shall manage pages in a dedicated Landing Page Builder feature with
  mobile-first layouts and drag-and-drop authoring. Each landing page shall own
  its presentation independently of either storefront theme.
- Acceptance: An authorized seller can build a landing page through the
  MCP-enabled builder and publish it at a storefront URL. Switching between
  the two storefront themes leaves the landing page's layout, typography,
  colors, width rules, and content unchanged. A page cannot expose another store's content or create
  separate commerce state. LP layout and styling are freely composed within
  the builder, independently of storefront themes; templates and sections are
  starting points, not a fixed presentation ceiling. The planned locked element
  is the platform form component, not the surrounding page. Backend transaction
  validation remains authoritative. Exact form scope is pending T-11.
- Constraints: TD-4, UI-4, UI-6, API-3, IAM-2, IAM-7, TEN-1, UX-7.
- Evidence: Product decision only; protocol contract and runtime proof pending.
- Change history: 2026-09-18 — accepted future MCP support and landing pages
  within the storefront; clarified independent LP presentation, dedicated
  builder, and mobile-first drag-and-drop authoring; implementation timing
  remains deferred.

### PR-10 — Navigable system and page map
- Status: Accepted
- Owner: Bukalaris architecture owner
- Source: Paduka Ongki's system/page mapping request on 2026-09-18.
- Statement: Maintain a canonical page-by-page system map connecting stable page
  identifiers, user-facing features, routes, code, data owners, requirements,
  tasks, and verification so AI agents and engineers can locate implementation.
- Acceptance: Every developed page resolves to real route/component/service
  files, data entities, and relevant checks at a recorded code revision. Planned
  pages explicitly identify missing code; changes update the affected map rows.
- Constraints: ARCH-5, UX-8.
- Evidence: Initial planning map only; executable code links await a repository.
- Change history: 2026-09-18 — accepted discoverability and map maintenance.

### PR-11 — Super Admin Log System
- Status: Accepted
- Owner: Bukalaris product owner
- Source: Paduka Ongki's Super Admin button request on 2026-09-18.
- Statement: Super Admin shall expose a visible Log System button leading to a
  restricted diagnostic log list and event detail view.
- Acceptance: An authorized operator can filter failures and follow a
  correlation identifier to related events and the affected module/page map.
  Unauthorized access is denied server-side; secrets and raw customer/payment
  data are absent. Empty results and an unavailable log source are distinct.
- Constraints: OBS-5, UX-9, IAM-1, IAM-5, SEC-1, NFR-4.
- Evidence: Feature requirement only; UI and log sink are not implemented.
- Change history: 2026-09-18 — accepted Super Admin log access entry point.

### PR-12 — Simple stable product identity
- Status: Accepted
- Owner: Bukalaris product owner
- Source: Paduka Ongki's product ID, slug, and Meta identity request on 2026-09-18.
- Statement: Creating a product shall automatically assign a concise numeric
  identity. Sellers shall not need to enter a slug to save a product. URL slugs
  and advertising identities shall be explicit and not confused with each other.
- Acceptance: The product editor displays a copyable stable product ID and URL;
  the ID survives title, slug, theme, and domain changes. Catalog and tracking
  identity use the same documented mapping. No long opaque ID is required for
  routine seller navigation. Variant identity is specified before feed export.
- Constraints: DATA-5, API-4, UX-10, TEN-1.
- Evidence: Product direction only; implementation pending.
- Change history: 2026-09-18 — accepted automatic concise IDs and ad identity.

### PR-13 — Seller custom domains
- Status: Accepted
- Owner: Bukalaris product owner
- Source: Paduka Ongki's per-seller custom-domain request on 2026-09-18.
- Statement: Each seller shall be able to connect its own domain to its store,
  including ordinary storefront pages and independent landing pages.
- Acceptance: Seller sees required DNS records, ownership and TLS status, and
  can choose an eligible primary domain. Unverified domains cannot serve a
  tenant. Domain changes preserve product/LP identity and content. The default
  store subdomain remains available under the primary-domain redirect policy.
- Constraints: DOM-1, DOM-2, DOM-3, UX-11, TEN-2, SEC-3.
- Evidence: Requirement only; no DNS change or provisioning executed.
- Change history: 2026-09-18 — confirmed custom domains as supported seller scope.

### PR-14 — Headless foundation and initial delivery scope
- Status: Accepted
- Owner: Bukalaris product owner
- Source: Paduka Ongki's complete development-document request on 2026-09-18.
- Statement: Initial delivery shall focus on Seller Admin, Storefront, and Super
  Admin, backed by documented headless API contracts and shared domain services.
  Future clients shall not require duplicating commerce state or business rules.
- Acceptance: Initial surfaces map to API operations and server-owned data;
  API clients can perform the defined authorized jobs without importing UI code.
  Future LP/MCP, marketplace, buyer accounts, and affiliate scope is explicit
  and does not silently enter the initial release acceptance gate.
- Constraints: ARCH-6, API-7, TEN-1, IAM-1, PR-10.
- Evidence: Documentation request and accepted scope; runtime proof pending.
- Change history: 2026-09-18 — confirmed three-surface initial scope and headless contract.

### PR-15 — Operator access and membership lifecycle
- Status: Proposed
- Owner: Bukalaris product owner
- Source: PR-1, PR-2, PR-14; necessary access workflow proposal.
- Statement: Sellers and platform operators authenticate through maintained
  authentication mechanisms, enter an authorized context, and receive only
  their assigned capabilities. Membership revocation terminates affected access.
- Acceptance: Login/recovery do not disclose account existence; store switching
  cannot retain previous-store data; forbidden role escalation and cross-store
  invitations are denied. Last-owner removal is prevented until ownership handoff.
- Constraints: IAM-1, IAM-2, TEN-1, SEC-1.
- Evidence: Workflow proposal; authentication provider and policy pending.
- Change history: 2026-09-18 — made operator access an explicit delivery concern.

## Non-functional requirements

| ID | Statement | Owner | Evidence before release |
|---|---|---|---|
| NFR-1 | Authorization and tenant isolation fail closed for every server mutation and data read. | Security owner | Tenant-negative integration tests |
| NFR-2 | Money, stock, shipment, and payment transitions are idempotent and auditable. | Finance owner | State-transition tests and audit records |
| NFR-3 | The buyer path supports keyboard operation, reflow at 320 CSS px, and clear status/error association. | Design owner | Browser accessibility checks |
| NFR-4 | Provider credentials, payment payloads, and raw addresses never enter frontend bundles or ordinary telemetry. | Security owner | Secret/logging review and synthetic proof |
| NFR-5 | Every provider-dependent journey exposes a terminal user outcome or an explicit pending/retry state. | Operations owner | Controlled dependency-failure checks |

## Success and release gates

No numerical business target is accepted yet. Before a pilot, owner must set a
cohort, period, order-completion metric, seller-activation metric, support
guardrail, and stop threshold. The first technical release requires PR-1 to
PR-5, PR-8, and PR-10 through PR-14 acceptance, operator-access policy
resolution under PR-15, provider verification in a non-production account, and
security/tenant/browser/recovery checks, plus PR-16 hosted-checkout/headless
acceptance. PR-9 (LP/MCP) remains a later milestone.
The API document is a proposed contract until implementation conformance passes.

## Open decisions

| ID | Decision | Owner | Gate |
|---|---|---|---|
| Q-1 | Platform-owned versus seller-owned AutoLaris merchant account | Finance owner | Before BILL-1 approval |
| Q-2 | Platform Mengantar balance versus seller-funded shipping balance | Finance owner | Before shipment creation |
| Q-3 | Marketplace commission, settlement, payout, refund, and COD ownership | Finance + legal owner | Before marketplace checkout |
| Q-4 | Buyer account credential/recovery model | Security owner | Before PR-7 implementation |
| Q-5 | Bukalaris repository, pinned stack versions, deployment, and executable contracts | Architecture owner | Before implementation planning |

## Delivery phases and product boundary

Decision: Paduka Ongki prioritizes Seller Admin, Storefront, and Super Admin.

| Phase | Deliverable | Explicit boundary |
|---|---|---|
| Foundation | Auth/context, tenant isolation, numeric product identity, headless API, data constraints, page map, diagnostic foundations | No live commerce until provider/account gates pass |
| Initial seller commerce | Seller catalog/content/inventory/orders/settings/themes/domains; both storefront themes; single-store purchase; Super Admin tenant lifecycle and Log System | PR-1 through PR-5, PR-8, PR-10 through PR-14; PR-15 policy resolved |
| Independent LP | Freely composed mobile-first pages, protected form contract, visual builder, shared MCP editing | PR-9; separate page layout, shared store services |
| Future discovery and identity | Curated marketplace discovery, buyer account and affiliate attribution | PR-6, PR-7; separate acceptance gates |
| Future financial expansion | Marketplace checkout, settlement, payouts, commissions | Deferred; requires new accepted financial/legal requirements |

Headless means backend contracts and domain services are independent of a UI;
it does not require microservices, a public unauthenticated admin API, or a
separate deployment per seller. Public SDK publication, arbitrary plugins, and merchant executable code remain
deferred. Scoped storefront API/token integration is initial headless scope.

## Decision register additions

| ID | Decision | Owner | Gate |
|---|---|---|---|
| Q-6 | Auth provider, hosting and package versions; framework selected and database recommended in Architecture | Architecture owner | Before implementation baseline |
| Q-7 | Catalog granularity and seller Pixel/catalog account ownership | Integration owner | Before feed export or advertising events |
| Q-8 | Domain provider, apex support, quotas and operating cost | Platform owner | Before domain provisioning |
| Q-9 | LP form types and protected/customizable fields | Product owner | Before LP/form implementation |
| Q-10 | Stock reservation expiry, late payment, order cancellation/refund and COD confirmation policy | Finance owner | Before checkout release |
| Q-11 | Operational targets, restore objectives and retention durations | Operations owner | Before pilot release |

These records keep unresolved choices visible; documentation completeness does
not turn proposed policies into accepted implementation decisions.

### PR-16 — Independent storefronts and Bukalaris hosted checkout
- Status: Accepted
- Owner: Bukalaris product owner
- Source: Paduka Ongki's Hydrogen/Oxygen-style clarification on 2026-09-18.
- Statement: Developers shall be able to build independently hosted storefronts,
  including Cloudflare deployments, using Bukalaris API and scoped tokens.
  Checkout shall run in Bukalaris's own `/checkout` surface, outside storefront
  theme/layout control, and remain the platform's transactional authority.
- Acceptance: Native themes, independent LPs, and external storefronts obtain a
  server-issued checkout URL. Buyer handoff preserves cart/store identity and
  does not require sharing cookies across unrelated origins. Checkout alone
  collects protected transaction fields and submits payment/order intent.
  Storefront tokens cannot access seller/admin APIs or arbitrary buyer orders.
- Constraints: ARCH-7, API-8, IAM-11, DOM-4, SEC-13, UX-12.
- Evidence: Accepted architecture direction; runtime proof pending.
- Change history: 2026-09-18 — standalone hosted checkout and external storefront tokens.

### PR-17 — MCP-assisted seller catalog and content
- Status: Accepted
- Owner: Bukalaris product owner
- Source: Paduka Ongki's MCP content-scope direction on 2026-09-18.
- Statement: Bukalaris shall expose store-scoped MCP resources, tools, and
  guided prompts for products, variants, categories, collections, articles,
  CMS pages, menus, media references, and store configuration. MCP shall reuse
  the same application services, validation, authorization, revisions, and
  publication lifecycle as Seller Admin.
- Acceptance: An authorized AI client can discover and read allowed store
  content, search by stable identity or slug, create and edit drafts, validate
  references, and prepare previews without accessing another store. Publishing
  requires a separately granted capability and an explicit human-approved
  action. Revoked access stops subsequent reads and writes. MCP cannot modify
  prices, inventory, checkout, payment state, provider credentials, or customer
  data through a content capability.
- Constraints: TD-6, DATA-6, API-9, IAM-12, UX-13, TEN-1, SEC-9.
- Evidence: Accepted documentation scope; no MCP server or runtime proof exists.
- Change history: 2026-09-18 — expanded MCP beyond landing pages to seller catalog and content.

## Stack and named surfaces — 2026-09-25

Decision: The product is Bukalaris, with the tagline "Buka toko langsung laris"
and primary domain `bukalaris.com`. Super Admin is `bos.bukalaris.com`; tenant
admin (Seller CMS) is `app.bukalaris.com`. Both admin applications use
Next.js App Router, TypeScript, shadcn/ui and Tailwind CSS.

Recommendation: Use Astro for the public marketing site and native storefronts;
use Next.js for hosted checkout. Keep the existing two-theme, independent LP,
headless and phased MCP boundaries. Architecture owns runtime/package choices;
Domain Routing owns the host map. This records the design baseline, not an
installed version, DNS change, or implementation approval.

