# Bukalaris Product Requirements Document

| Field | Value |
|---|---|
| Status | Active specification — M1, M2 and the delivered M3 tasks (chain A, early chain B, T-80 to T-85, T-95 to T-99) are implemented locally and on `main`, nothing is deployed, and the D-27 to D-33 direction is not built yet (`../STATUS.md` owns current status; per-task status in [`TASKS.md`](TASKS.md)) |
| Owner | Bukalaris product owner |
| Updated | 2026-11-14 (direction change D-27 to D-30; earlier body text dated 2026-10-27); Status row re-checked 2026-11-16 (T-122) |
| Market | Indonesia (`id-ID`, integer IDR) |
| Evidence boundary | `CONTEXT-RECORD.md`, [`../STATUS.md`](../STATUS.md), [`../BUILD-LOG.md`](../BUILD-LOG.md), [`TASKS.md`](TASKS.md) |
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

Bukalaris develops two product chains in sequence. Chain A is Owner console →
Seller Admin → Storefront: extend the existing seller-commerce foundation with
platform subscription billing, seller-owned shipping and payment accounts, digital
products and structural reorganisation. Chain B is the store affiliate programme
run by each seller (PR-28); the cross-store affiliate storefront (PR-29) is deferred.

Direction change, owner decisions of 2026-11-14 (accepted as decisions, not
implementation evidence; the code still implements the earlier model):

| Decision | What changes | Record |
|---|---|---|
| D-27 | Each store connects its own Mengantar and AutoLaris account. Buyer money and COD cash go to the seller; Bukalaris holds no seller money and earns the subscription only | [ADR-0013](adr/ADR-0013-seller-owned-shipping-and-payment-accounts.md) |
| D-28 | Platform on `bukalaris.com`; storefronts on `<store-slug>.bukalaris.id`; custom domains point at `cname.bukalaris.id`; checkout on the store host | [ADR-0014](adr/ADR-0014-two-registrable-domains-and-custom-domain-target.md) |
| D-29 | Affiliate programme run by the seller: one platform affiliate account, membership per store, commission paid by the seller and recorded | [ADR-0015](adr/ADR-0015-seller-run-store-affiliate-programme.md) |
| D-30 | Digital products beside physical ones: prepaid only, no shipment, access granted on payment | [ADR-0016](adr/ADR-0016-digital-products.md) |

Where a requirement below carries a "Decision (D-27..D-30)" line, that line
overrides any older sentence in the same requirement that conflicts with it.

New requirements marked Proposed are contracts, not implementation evidence.
Provider write approval, marketplace split settlement, and unresolved tax/legal
and affiliate funding decisions remain separate release gates.

## Scope

### Phase 1 — Seller commerce foundation

Phase naming: "Phase 1" in this section is the seller-commerce foundation. "Phase 1 (startup core)", "Phase 1.5" and "Phase 2" in PR-30, PR-31 and UX-22 are the Owner console and tax rollout phases, switched on by Compliance activation and Tax activation; the status and phase legend is in [README.md](README.md).

- Owner console staff create, approve, suspend, and support seller tenants.
- Seller configures store profile, catalog, inventory, collections, CMS pages,
  menus, branding tokens, enabled delivery/payment methods, and order handling.
- Two built-in storefront themes are available: a responsive storefront as the
  default, and a mobile-first alternative capped at 480 CSS px (PR-8).
- A storefront resolves one store by its subdomain `<store-slug>.bukalaris.id`
  (D-28); a custom domain is supported per seller through a CNAME to
  `cname.bukalaris.id`, domain ownership verification and TLS activation;
  this is a requirement, not a claim of a live integration.
- A store sells physical products, digital products or both (D-30). A digital
  product has no shipment, is prepaid, and is delivered as seller-hosted access links or
  an access note once payment is proven. Bukalaris stores no file.
- Buyer can browse, add to cart and complete friction-free checkout without a
  registration step. The server auto-detects/creates a platform buyer by canonical
  phone/WA first, then email; later portal access requires proof of possession.
- A checkout contains items from exactly one store.
- The platform calls Mengantar only from a trusted backend for estimates and
  shipment work, and AutoLaris H2H only from a trusted backend for payment
  instruction and status checks, in both cases with the store's own sealed
  account key (D-27). The platform's own AutoLaris account is used for
  subscription invoices only.
- Chain A adds the all-feature store subscription (PR-18), seller-owned shipping
  and payment accounts (PR-27) and digital products (PR-32); Chain B then adds
  the seller-run store affiliate programme (PR-28). These are accepted
  decisions, not implementation claims.

### Future scope — Storefront landing-page builder

- Decision: Support an MCP-enabled landing-page builder; landing pages belong
  inside each store's storefront, on its resolved subdomain/custom domain.
- Assumption: MCP means Model Context Protocol and allows an authorized external
  AI client to work with the Bukalaris builder. Exact integration direction and
  tool operations remain to be specified under T-11.
- This is future scope, not an addition to the Phase 1 release gate.

### Explicitly deferred

- Cross-seller cart and a combined marketplace checkout.
- Buyer wallet, stored payment credentials, escrow, cross-seller split
  settlement, external affiliate product connectors (T-56), and unconfirmed
  tax/legal policy. Since D-27 and D-29 the platform holds no seller money and
  no affiliate money: the seller ledger and payouts (PR-23) apply only to money
  Bukalaris holds, and the affiliate wallet and platform payouts are dropped.
- Cross-store affiliate storefront and discovery (PR-29), licence-key pools,
  subscriptions sold by sellers, streaming or DRM for digital goods.
- Open third-party app/plugin marketplace and free-form HTML/CSS theme code.
- Direct arbitrary access to seller-owned databases.

## Actors and outcomes

| Actor | Job | Outcome | Scope |
|---|---|---|---|
| Owner console staff (formerly Super Admin) | Operate the platform | A seller is approved/suspended with auditable reason; sellers, affiliates and user accounts are managed from one capability-gated console | Global; explicit capabilities only |
| Seller Owner/Staff | Run a store | Storefront content and sellable catalog are current | Assigned tenant/store |
| Buyer | Discover and buy | Confirmed single-store order with clear payment/shipping state | Storefront/global identity |
| Affiliate | Promote the products of stores that accepted them | Attributed outcomes and a per-store commission statement without buyer PII; paid by the seller (D-29) | One platform account, membership per store; separate portal |
| Provider service | Quote, create, reconcile | Idempotent provider interaction linked to a local record | Narrow service scope |

## Requirements

### PR-1 — Tenant lifecycle
- Status: Accepted (owner 2026-10-28, D-21)
- Owner: Bukalaris product owner
- Statement: Owner console staff shall create, approve, suspend, and reactivate a
  seller store; a suspended store shall not accept new buyer checkout.
- Acceptance: An approved seller can sign in and publish; a suspended seller
  receives a safe denial and its storefront preserves a non-purchasable state.
- Constraints: TEN-1, DATA-1, IAM-1, SEC-1, UX-1.
- Evidence: Implemented on `main` by T-26 (store creation with an existing owner account, `/admin/stores/[id]`) and T-3 (SA-02/SA-03 suspend and reactivate with reason; a suspended store blocks storefront, checkout and Seller Admin with an audit row; `e2e/super-admin.spec.ts`). The approve step and the PR-30 governance scope (T-62, T-63) are not built. The owner accepted the requirement on 2026-10-28 (D-21); that acceptance does not make the unbuilt parts implemented.

### PR-2 — Seller commerce CMS
- Decision (D-30, 2026-11-14, ADR-0016): a product is `physical` or `digital`. A digital product needs delivery content (access links to content the seller hosts, or an access note) instead of a weight, and has unlimited stock unless the seller switches counting on. Not implemented (T-111, T-112).
- Status: Accepted (owner 2026-10-28, D-21)
- Owner: Bukalaris product owner
- Statement: An authorized Seller user shall manage only its store's products,
  variants, stock, collections, CMS pages, menus, store profile, and settings.
- Acceptance: Cross-tenant reads and writes are denied server-side; a product
  cannot become sellable without required price, status, and inventory policy.
- Constraints: DATA-1, TEN-1, IAM-2, SEC-2, UX-2.
- Evidence: Implemented on `main`: products, variants, media, inventory, collections, CMS pages, settings and themes, members and catalog audit (T-21, T-24, T-25, T-28, T-31, T-17/T-22); cross-tenant denial is proven by `test/tenant-isolation.test.ts` and `test/rls.test.ts` (T-27). Menus (SC-09) and domains (SC-18) are not built. The owner accepted the requirement on 2026-10-28 (D-21); that acceptance does not make the unbuilt parts implemented.

### PR-3 — Tenant storefront
- Decision (D-28, 2026-11-14, ADR-0014): the native storefront host is `<store-slug>.bukalaris.id`; platform surfaces stay on `bukalaris.com`; platform labels are reserved on the store domain as well. Cart, checkout, confirmation and order status are served on the store host. Not implemented (T-102, T-103).
- Status: Proposed
- Owner: Bukalaris product owner
- Statement: A buyer request shall resolve exactly one active store from a
  validated host and render only that store's published content and catalog.
- Acceptance: Unknown, disabled, and mismatched hosts fail safely; a request
  cannot render another store's data.
- Constraints: DOM-1, TEN-2, SEC-3, UX-3, DATA-1, TD-2.
- Evidence: Implemented for `<slug>.<STORE_ROOT_DOMAIN>` host resolution and path mode with database row security (T-2 partial, T-27; `test/tenant-isolation.test.ts`, `e2e/content.spec.ts`). Known gaps: reserved platform labels are not enforced yet (CRSEC-01, T-70) and custom domains are not built (T-15). Status stays Proposed until the owner accepts the evidence.

### PR-4 — Single-store checkout
- Decision (D-27, D-30, 2026-11-14): checkout runs on the store host (ADR-0014). Delivery and payment eligibility come from one server function that applies the seller's courier, COD, province and payment-channel filters and is called again at submit (ADR-0013 section 4). Shipping is computed from physical lines only; an order without a physical line has no address, courier or shipping fee; any digital line makes the order prepaid and requires an e-mail (ADR-0016). Not implemented (T-103, T-105, T-106, T-111).
- Status: Accepted (owner 2026-10-28, D-21)
- Owner: Bukalaris product owner
- Statement: A cart and checkout shall be bound to one store; the server shall
  derive product price, stock, delivery eligibility, and order totals.
- Acceptance: A buyer cannot submit a mixed-store cart or client-supplied total;
  an unavailable provider result leaves the order/payment state unambiguous.
- Constraints: DATA-2, BILL-1, SEC-4, UX-4.
- Evidence: Implemented on `main`: single-store carts and checkout with server-derived totals, idempotent submit and atomic stock (M1 evidence; T-21), abuse controls (T-30), shipping quotes with margin (T-34), COD confirmation (T-35) and buyer data export and redaction (T-43). `order_financials`, the discount split and the ledger are not built (T-37, T-46). The owner accepted the requirement on 2026-10-28 (D-21); that acceptance does not make the unbuilt parts implemented.

### PR-5 — Shipping and payment orchestration
- Decision (D-27, 2026-11-14, ADR-0013): quotes, bookings, payment instructions and status checks use the store's own Mengantar and AutoLaris account keys. The buyer is charged the provider's public rate with no platform margin; submit re-quotes and refuses a stale price; booking is a seller action and an unknown provider outcome blocks rebooking until a person resolves it; a payment callback is evidence only. COD is allowed on any courier the seller enabled for COD. This overrides the D-15 line below (allow-list, platform-managed accounts). Not implemented (T-104 to T-106).
- Status: Accepted for implementation (Mengantar part, owner direction 2026-10-06); AutoLaris part Proposed
- Owner: Bukalaris product owner
- Statement: The platform shall obtain delivery eligibility from Mengantar and
  create/reconcile payment instructions with AutoLaris using stable local
  idempotency records.
- Acceptance: A physical shipment uses a quote-derived courier identifier;
  payment is marked paid only by an approved reconciliation policy, never a
  shipping callback or generic provider wording.
- Constraints: TD-3, API-2, BILL-2, SEC-5, OBS-2, DATA-2, DATA-13, UX-4.
- Evidence: Mengantar read client, quotes with platform margin (T-34) and shipment booking and tracking on the fake adapter (T-39) are implemented; every Mengantar write refuses without `MENGANTAR_WRITE_ENABLED=1`. AutoLaris has only a fake adapter (T-49 redevelops the contract) and parcel weight is T-61. No live provider call has been made.
- Decision (D-15, 2026-10-27): COD is offered only for courier services on the data-driven `courier_service_policy` allow-list (`cod_allowed` and `return_free`; currently SPX only, UNVERIFIED, a live gate); prepaid orders always pay through our AutoLaris gateway; one unified Bukalaris-managed shipping and money system, with the shipping account kind (`partner_managed` or `platform_master`) recorded per order (T-37, T-39, T-48, T-49). The earlier seller-managed system B is deleted (D-15).

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
- Source: Owner decisions 2026-10-27; [ADR-0010](adr/ADR-0010-global-buyer-identity.md); PR-28/ADR-0009 for attribution.
- Statement: One platform buyer identity shall work across all Bukalaris sellers
  without a checkout registration step. Checkout auto-detects/creates the buyer
  by canonical phone/WA number first, then email. When phone and email resolve
  to different accounts, the PHONE account wins and no automatic merge occurs.
  Association is not authentication: the buyer portal at `buyer.bukalaris.com`
  requires passwordless proof plus authorized identifier/account binding and
  confirmed-link access before any private read or mutation. Automatic identity
  association runs through the ID-only post-commit `buyer.resolve` outbox without
  OTP or signup becoming checkout prerequisites (DATA-12, T-57/T-58).
- Acceptance: Orders from two sellers using the same canonical phone resolve
  to one buyer while each order/contact/address snapshot stays store-owned.
  Equivalent phone formats cannot create duplicate identities under concurrency.
  A conflicting email cannot move an order away from the phone-selected account
  or merge accounts. Checkout stays friction-free and never returns existing
  profile, address, order history or account-existence data merely because a
  matching phone/email was typed. A verified portal session sees only confirmed
  own-account links permitted by ADR-0010; proving an attacker-observed secondary
  email cannot unlock a phone-selected victim's history. Affiliate attribution under
  PR-28 grants no buyer/order personal data and never creates buyer-login authority;
  checkout remains one store per order (PR-4, TD-5).
- Constraints: DATA-4, DATA-12, DATA-11, IAM-3, IAM-4, PRIV-2, UX-6, UX-21,
  PR-28, ADR-0010. OTP channel/provider, verified prefill, merge UX, recycled
  numbers and global deletion remain OPEN; no email/phone proof is inferred
  from submitting an order.
- Evidence: Proposed identity contract only, not an implemented buyer account.

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
- Evidence: Implemented by T-24 (`responsive` default and `mobile` themes via container queries; no horizontal overflow at 320px asserted in `e2e/content.spec.ts`). Open (T-10): keyboard-path evidence inside the themes, a 480px viewport fixture and theme preview before publish.
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
- Evidence: Landing pages v1 (typed blocks, immutable revisions, public page independent of the storefront theme) are implemented by T-42 (`test/landing.test.ts`, `e2e/landing.spec.ts`). The drag-and-drop builder and MCP are not implemented (T-11, T-20); protocol contract and runtime proof pending.
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
- Evidence: ARCH-5 is maintained by T-12 and checked by `pnpm map:check` (64 route files, 72 rows, no drift on the 2026-10-27 review revision, see the gap report); the maintenance rule stays open.
- Change history: 2026-09-18 — accepted discoverability and map maintenance.

### PR-11 — Owner console Log System
- Status: Accepted
- Owner: Bukalaris product owner
- Source: Paduka Ongki's Super Admin button request on 2026-09-18.
- Statement: The Owner console shall expose a visible Log System button leading to a
  restricted diagnostic log list and event detail view.
- Acceptance: An authorized operator can filter failures and follow a
  correlation identifier to related events and the affected module/page map.
  Unauthorized access is denied server-side; secrets and raw customer/payment
  data are absent. Empty results and an unavailable log source are distinct.
- Constraints: OBS-5, UX-9, IAM-1, IAM-5, SEC-1, NFR-4.
- Evidence: Implemented by T-23: a visible Log System navigation entry, a `logs.read`-gated list and detail, allowlisted filters, a 24 h range cap, read audit and a DB-outage proof (`test/ops.test.ts`, `e2e/ops.spec.ts`). Open: stale and partial source states, retention and an external sink.
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
- Evidence: Implemented for ids and aliases by T-14 (`catalog_id` from one sequence starting at 10000, immutable by trigger, string at every boundary, 308 from legacy ids) and for feeds by T-40. Open: Meta item and group provider verification and the OpenAPI field update.
- Change history: 2026-09-18 — accepted automatic concise IDs and ad identity.

### PR-13 — Seller custom domains
- Decision (D-28, 2026-11-14, ADR-0014): the seller is shown exactly one DNS record, a CNAME to `cname.bukalaris.id`; the default store host is `<store-slug>.bukalaris.id`. Custom domains are subdomains only until T-15 verifies apex support (D-31). Provider and lifecycle stay T-15.
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
- Statement: Initial delivery shall focus on Seller Admin, Storefront, and the Owner
  console (formerly Super Admin), backed by documented headless API contracts and shared domain services.
  Future clients shall not require duplicating commerce state or business rules.
- Acceptance: Initial surfaces map to API operations and server-owned data;
  API clients can perform the defined authorized jobs without importing UI code.
  Future LP/MCP, marketplace, buyer accounts, and affiliate scope is explicit
  and does not silently enter the initial release acceptance gate.
- Constraints: ARCH-6, API-7, TEN-1, IAM-1, PR-10, UX-12.
- Evidence: Partly implemented: Storefront API v1 subset with channel tokens and hosted-checkout handoff (T-16, T-19); pagination, idempotent replay and rate limiting are pending. The accepted initial scope is unchanged.
- Change history: 2026-09-18 — confirmed three-surface initial scope and headless contract.

### PR-15 — Operator access and membership lifecycle
- Status: Accepted (owner 2026-10-28, D-21)
- Owner: Bukalaris product owner
- Source: PR-1, PR-2, PR-14; necessary access workflow proposal.
- Statement: Sellers and platform operators authenticate through maintained
  authentication mechanisms, enter an authorized context, and receive only
  their assigned capabilities. Membership revocation terminates affected access.
- Acceptance: Login/recovery do not disclose account existence; store switching
  cannot retain previous-store data; forbidden role escalation and cross-store
  invitations are denied. Last-owner removal is prevented until ownership handoff.
- Constraints: IAM-1, IAM-2, TEN-1, SEC-1, UX-22, DATA-14.
- Evidence: Implemented subset: Better Auth sign-in, recovery without account enumeration, hashed invitations, last-owner protection and operator TOTP (T-17, T-22; `test/accounts.test.ts`, `e2e/accounts.spec.ts`). Policy acceptance was given by the owner on 2026-10-28 (D-21). Open implementation work: a separate admin origin and cookie namespace (T-70 is implemented locally and uncommitted, not deployed), MFA disable and regenerate UI, shared rate-limit storage.
- Change history: 2026-09-18 — made operator access an explicit delivery concern. 2026-10-28 — accepted by the owner (D-21).

## Non-functional requirements

| ID | Statement | Owner | Evidence before release |
|---|---|---|---|
| NFR-1 | Authorization and tenant isolation fail closed for every server mutation and data read. | Security owner | Tenant-negative integration tests |
| NFR-2 | Money, stock, shipment, and payment transitions are idempotent and auditable. | Finance owner | State-transition tests and audit records |
| NFR-3 | The buyer path supports keyboard operation, reflow at 320 CSS px, and clear status/error association. | Design owner | Browser accessibility checks |
| NFR-4 | Provider credentials, payment payloads, and raw addresses never enter frontend bundles or ordinary telemetry. | Security owner | Secret/logging review and synthetic proof |
| NFR-5 | Every provider-dependent journey exposes a terminal user outcome or an explicit pending/retry state. | Operations owner | Controlled dependency-failure checks |

Numeric availability, RPO and RTO targets are decided as the startup baseline by D-19 (2026-10-27): 99.5 % availability target, hourly client-side encrypted `pg_dump` offsite (RPO 1 hour), and RTO 4 hours proven by a restore rehearsal (see [14-SLA-DISASTER-RECOVERY](14-SLA-DISASTER-RECOVERY.md), DR-1). These are internal operating targets; no SLA is promised to sellers unless the owner publishes one. The offsite encryption and restore proof are designs and scripts to be exercised before live data, not evidence yet. No numeric latency target is accepted yet, and the replica plan stays a later option.

## Success and release gates

No numerical business target is accepted yet. Before a pilot, owner must set a
cohort, period, order-completion metric, seller-activation metric, support
guardrail, and stop threshold. The first technical release requires PR-1 to
PR-5, PR-8, and PR-10 through PR-14 acceptance, operator-access policy
resolution under PR-15, provider verification in a non-production account, and
security/tenant/browser/recovery checks, plus PR-16 hosted-checkout/headless
acceptance. PR-9 (LP/MCP) remains a later milestone.

Requirements added since the 2026-10-06 decisions change that gate as follows; each row states what must hold before the feature is used with a real seller:

| Requirement | Gate before real use |
|---|---|
| PR-19 COD risk control (P0 since Q-13) | Part of the first release: confirm, hold or reject before any COD booking (T-35, implemented). |
| PR-23 seller ledger and COD remittance (T-37) | Since D-27 this gates only money Bukalaris holds; a store on seller-owned accounts is paid by its own providers and is not gated by it. For platform-held money: T-37 delivered with its Owner console payout and refund approval path (PR-30 four-eyes), the Q-17 legal review closed and an approved Mengantar write test; until then `ALLOW_COD_BOOKING` stays off. |
| PR-30 Owner console, Phase 1 startup core (T-62, T-63, T-68, T-72) | Part of the first release: it is the operator surface for store approval and for the four-eyes money actions. The Update Log (T-69) and the Compliance center (T-64) are not gate items. |
| PR-18 platform subscription billing (T-50) | The owner chose the single all-feature plan; billing is enforced for real sellers once T-49 and T-50 are accepted. OPEN (owner decision; recommended, not decided): the first pilot may run trial-only with no live invoice until T-49 and T-50 pass. |
| PR-27 seller-owned Mengantar and AutoLaris accounts (T-104 to T-107) | Needed for every store (D-27): a store takes real orders only with its own sealed, checked account keys; production calls on seller keys are switched on per provider in the Owner console after a recorded sandbox pass. The Partner Secret rotation still gates every call with platform Mengantar credentials. |
| PR-32 digital products (T-111, T-112) | Each selling store's AutoLaris account has its payment-only profile confirmed. Digital delivery uses no platform file storage. |
| PR-28, PR-29, PR-31, PR-7 buyer portal | Not part of the first technical release. PR-28 follows ADR-0015 (seller-paid, no platform money); PR-29 is deferred; the others follow ADR-0010 and ADR-0012 (startup mode: no withholding, no tax gate). |
| Hardening these depend on: T-51, T-59, T-60, T-70, T-73 | Required before the Owner console and any affiliate or buyer surface run on their own hosts and before one-time links go through a real mailer. |
| Restore and four-eyes proof | SEC-23 (a restore reapplies grants and erasure records, and the rehearsal asserts both) and the IAM-15 four-eyes matrix tests (requester cannot approve, one execution, payload hash, bank snapshot shown at approve-for-transfer, break-glass never satisfies four-eyes) pass before any real payout or refund. |

The API document is a proposed contract until implementation conformance passes.

## Open decisions

| ID | Decision | Owner | Gate |
|---|---|---|---|
| Q-1 | Platform-managed AutoLaris ownership direction decided by ADR-0006 (Accepted under D-20); commercial account, `courir_id: 1` profile, sandbox credentials and vendor response evidence remain open | Finance + integration owner | T-5/T-6/T-49 before live payment activation |
| Q-2 | Decided 2026-10-27 and refined by D-15: one unified Bukalaris-managed Partner Mengantar account per store (`partner_managed`, `platform_master` fallback); the earlier hybrid with seller-owned accounts is superseded (ADR-0007, PR-27) | Finance owner | Live-use provider gates and cashback mechanics remain UNVERIFIED |
| Q-3 | Marketplace commission, settlement, payout, refund, and COD ownership | Finance + legal owner | Before marketplace checkout |
| Q-4 | Global auto-created buyer identity and passwordless proof-of-possession direction decided 2026-10-27 (ADR-0010) | Security + privacy owner | OTP channel/provider, verified prefill, merge UX, recycled numbers and global deletion OPEN before affected paths launch |
| Q-5 | Repository, pinned stack and executable baseline established (D-1, T-1); hosting direction decided in D-23 | Architecture owner | Closed for local implementation; provisioning and fresh release evidence remain T-18/T-79/T-85 |

## Delivery phases and product boundary

Decision: Paduka Ongki prioritizes Seller Admin, Storefront, and the Owner console.

| Phase | Deliverable | Explicit boundary |
|---|---|---|
| Foundation | Auth/context, tenant isolation, numeric product identity, headless API, data constraints, page map, diagnostic foundations | No live commerce until provider/account gates pass |
| Initial seller commerce | Seller catalog/content/inventory/orders/settings/themes/domains; both storefront themes; single-store purchase; Owner console tenant lifecycle and Log System | PR-1 through PR-5, PR-8, PR-10 through PR-14; PR-15 policy resolved |
| Independent LP | Freely composed mobile-first pages, protected form contract, visual builder, shared MCP editing | PR-9; separate page layout, shared store services |
| Chain A expansion | Architecture restructure → payment adapter contract → subscription billing → seller ledger → unified Partner Mengantar shipping accounts | The build order is maintained once, in [TASKS.md](TASKS.md) (section "M3 chains A and B"); it is not repeated here |
| Chain B affiliate programme | Affiliate data/attribution → wallet/payouts (tax foundation is T-65, statements are T-71, withholding is deferred T-67) → portal/seller opt-in/operator admin → affiliate storefront | Order in TASKS.md; PR-28/PR-29; policy/funding gates apply |
| Global buyer identity and portal | Automatic cross-seller buyer resolution, verified portal orders/tracking/profile/address book | PR-7, DATA-12, UX-21, ADR-0010; checkout stays registration-free and order snapshots remain store-owned |
| Future financial expansion | Multi-seller checkout and split settlement; external connectors | BILL-3 closure required; T-56 deferred |

Headless means backend contracts and domain services are independent of a UI;
it does not require microservices, a public unauthenticated admin API, or a
separate deployment per seller. Public SDK publication, arbitrary plugins, and merchant executable code remain
deferred. Scoped storefront API/token integration is initial headless scope.

## Decision register additions

| ID | Decision | Owner | Gate |
|---|---|---|---|
| Q-6 | Better Auth selected (D-1, ADR-0004); package versions are pinned in repository manifests; hosting direction is D-23 | Architecture owner | Closed for provider selection; auth hardening remains T-17/T-59/T-82/T-83 |
| Q-7 | Catalog granularity and seller Pixel/catalog account ownership (2026-10-06: variant-level item ids with product group ids adopted with Q-15; Pixel/catalog accounts are seller-owned per store) | Integration owner | Before feed export or advertising events |
| Q-8 | Domain provider, apex support, quotas and operating cost | Platform owner | Before domain provisioning |
| Q-9 | LP form types and protected/customizable fields | Product owner | Before LP/form implementation |
| Q-10 | Stock reservation expiry and backorder policy. Late payment on a cancelled or returned order, cancellation restock and the buyer refund obligation are decided and implemented locally (BILL-5, ADR-0006 decision 8, T-49, T-37; re-checked 2026-11-01); COD confirmation is PR-19 | Finance owner | Before checkout release |
| Q-11 | Restore objectives decided by D-19 (99.5 % availability target, RPO 1 hour, RTO 4 hours; internal targets, no SLA promised to sellers). Retention durations and numeric latency targets remain open | Operations owner | Retention before pilot release |

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
- Evidence: Implemented subset: channel registration, hashed one-time tokens, one-use handoff and allowlisted return link (T-19; `test/channels.test.ts`, `e2e/channels.spec.ts`) and the security headers on checkout (T-29). Open: open-session policy on revocation (IAM-11) and API rate limits.
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
and primary domain `bukalaris.com`. Production host decisions (2026-10-27):
Owner console (formerly Super Admin / Bos) `owner.bukalaris.com`, Seller Admin
`app.bukalaris.com`, Affiliate portal `affiliate.bukalaris.com`, Buyer account
portal `buyer.bukalaris.com`, public Update Log `logs.bukalaris.com`.
The interim operator host labels `berkah` and `bos` were never deployed and are retired, not an alias or redirect contract.
These surfaces use the single Next.js App Router application with TypeScript;
operator UI uses shadcn/ui and Tailwind CSS.

The earlier Astro recommendation for storefronts is superseded by owner direction
2026-10-27: keep one Next.js application with route groups and host rewrites
(ADR-0008, TD-7, D-2), including hosted checkout and the affiliate surfaces.
Keep the two-theme, independent LP, headless and phased MCP boundaries.
Architecture owns runtime/package structure; Domain Routing owns the proposed
host map. This is not a DNS/deployment or new-feature implementation claim.

## Business model and growth loop — proposal (2026-10-06)

Status: Proposal by the implementing team for owner decision. Source: owner
business direction "Indonesia Commerce Portal OS" (Shopify-like store
infrastructure plus tracking/form/data infrastructure: COD control, area
detection, pixel/tracking, dashboards) and the strategic filters
distribution, monetization, margin, compliance, data/tracking ownership.
This dated proposal is historical context. Owner decisions on 2026-10-27 below
replace its candidate plan tiers and subscription deferral. Prices are owner
product decisions, not evidence of implemented billing; cashback mechanics,
affiliate platform fees, and legal/tax conclusions remain unverified or OPEN.

Proposed positioning: the store-and-funnel OS for Indonesian sellers who sell
through paid ads and social traffic with COD — a store, ad landing pages and
hosted checkout whose orders, COD risk and conversion signals are first-party
and server-authoritative. "Laris" is delivered through conversion quality
(fast LP → checkout, fewer failed COD deliveries, accurate ad signals), never
promised as a revenue guarantee.

Proposed growth loop: seller runs ads → LP/storefront → hosted checkout →
order + server-side conversion signal back to the ad platform (better bidding)
→ COD confirmation lowers return-to-sender → seller margin improves → seller
upgrades plan / adds stores → "Ditenagai Bukalaris" footer and the later
marketplace bring new sellers.

Revenue decisions as of 2026-10-27:
| Stream | Mechanism | Dependency |
|---|---|---|
| Subscription | One all-feature plan, Rp175.000 per store per month DPP (ex-tax) | PR-18, BILL-7 |
| Payment margin | Platform-managed AutoLaris account with disclosed payment-fee margin | Q-1, BILL-1 |
| Shipping margin | Owner console-controlled margin rules on every Bukalaris-managed shipment (`partner_managed` and `platform_master`; ADR-0007 decision 2, D-15); the earlier platform-account-only margin is superseded; partner cashback/margin mechanics UNVERIFIED (`OPEN-F9`) | Q-2, PR-27, BILL-6 |
| Cashback share | Owner direction to split cashback; mechanism and receipt UNVERIFIED | ADR-0007 |
| Affiliate platform fee | OPEN; no fee is assumed or charged before a decision | PR-28, BILL-8 |

### PR-18 — Plans, entitlements and platform billing
- Decision (D-27, 2026-11-14, ADR-0013): the subscription is the platform's only revenue; there is no shipping margin, no cashback split and no fee on buyer payments. Subscription invoices are the only use of the platform's own AutoLaris account.
- Status: Proposed (revised by owner direction 2026-10-27; replaces deferral)
- Owner: Bukalaris product owner
- Source: Owner decisions 2026-10-27; BILL-7, DATA-10.
- Statement: Each store shall have one all-feature subscription at Rp175.000
  per month DPP (ex-tax), with server-enforced entitlements and separate
  platform invoices, never buyer orders or deductions from seller proceeds.
  Global PPN defaults OFF; trial and grace default to 3 days each and are
  adjustable by Owner console staff. Annual billing and first-month promotions are OPEN. PPN is switchable in the Owner console but its rate is always an effective confirmed `vat_output` policy value; no 11% is computed in startup mode and no PPN invoice or e-Faktur is issued until the company (PT) documents, PKP status and an accountant exist (D-17, T-75).
  Seller goods sales tax settings (`price_mode`, `sales_tax_rate_bps`, DATA-8) belong to the store and are separate from the platform PPN toggle on subscription invoices.
- Acceptance: Time-controlled cases exercise `trial → active` on payment,
  `trial/active → past_due` on unpaid expiry, `past_due → suspended` after
  grace, and `past_due/suspended → active` on an invoice covering the due period.
  Seller Admin is read-only from `past_due` onward except billing/payment
  actions; the storefront remains online and buyer checkout remains available.
  An independent operator `suspended_at` additionally refuses buyer checkout:
  paying cannot clear it, and lifting it cannot clear debt. Comp grants create
  auditable Rp0 `kind=comp` invoices. Entitlement restriction/downgrade never
  deletes products, orders, content or configuration; unavailable edits explain
  the restriction and preserve existing records.
- Constraints: PR-1, BILL-7, DATA-10, IAM-5, UX-18, Q-12.
- Evidence: Specification only; implementation tracked under T-50.
- Change history: 2026-10-06 — proposed, then deferred; 2026-10-27 — owner
  selected the single plan, billing lifecycle and independent suspension policy.

### PR-19 — COD risk control
- Status: Accepted for implementation — store-scoped only (owner direction Q-13, 2026-10-06; Q-14 open)
- Owner: Bukalaris product owner
- Source: Owner direction "COD control"; Q-10.
- Statement: For COD orders the platform shall support an order-confirmation
  step and risk signals (repeat unconfirmed/returned orders per phone within a
  store, address completeness, area eligibility) so sellers can confirm, hold or
  reject before shipment booking.
- Acceptance: A seller sees a confirmation state and risk reasons per COD
  order; unconfirmed COD orders are never auto-booked; risk data is store-scoped
  unless a privacy-reviewed cross-store policy is accepted (PRIV-2, Q-14).
- Constraints: PR-4, PR-5, NFR-2, PRIV-2, Q-10, Q-14.
- Evidence: Implemented by T-35: COD orders start `awaiting_confirmation`; confirm, hold or reject with a reason; store-local risk signals (repeat phone, address completeness, amount above twice the store COD median); nothing auto-books an unconfirmed order. The provider receiver score is not used.
- Change history: 2026-10-06 — proposed.

### PR-20 — Server-side advertising conversion signals
- Status: Accepted for implementation — TokoΦ/AdsBookCMS concept (owner direction Q-15, 2026-10-06)
- Owner: Bukalaris product owner
- Source: Owner direction "pixel/tracking"; PR-12 identity; Q-7.
- Statement: The platform shall send browser and server conversion events
  (view content, add to cart, initiate checkout, purchase) to the seller's
  configured Meta, TikTok and Google destinations with a shared event id for
  deduplication, the immutable catalog id (PR-12, T-14), and consent-aware
  matching data, using explicit COD and prepaid purchase definitions.
- Acceptance: Each order emits at most one purchase per destination under its
  accepted definition; retries are idempotent through an outbox; destination
  tokens are server-only; failures are visible to the seller; no buyer PII is
  sent beyond the accepted, hashed matching fields.
- Constraints: PR-12, NFR-4, PRIV-3, PRIV-5, Q-7, Q-15.
- Evidence: Implemented in simulation by T-38 (destinations with write-only AES-GCM tokens, shared event ids, server Purchase through the outbox; delivery is `simulated` unless `SIGNALS_LIVE=1`). Provider contracts must be verified against current
  official documentation before any live call.
- Change history: 2026-10-06 — proposed.

#### PR-20 signal contract (2026-10-06, from TokoΦ + AdsBookCMS review)

Reference implementations reviewed read-only: TokoΦ (`specs/decisions/0012`,
`0013`, `tracking_event_deliveries`, `store_tracking_channels`) and AdsBookCMS
(`TRACKING_SPECS.md`, `capi_event_outbox`). Neither records provider-accepted
live events; Bukalaris must verify each destination against current official
docs and a test-event code before claiming it works.

| Concern | Bukalaris contract (proposal accepted in direction) | Origin |
|---|---|---|
| Tenancy | One row per store × destination (meta, tiktok, google): pixel/measurement id, server token encrypted at rest (AES-GCM, key from runtime secret), enabled flags, test-event code; token write-only in UI | TokoΦ |
| Events | PageView, ViewContent, AddToCart, InitiateCheckout, Purchase on browser and server legs with a shared `event_id` | AdsBookCMS (full funnel) |
| Purchase definition | COD: at order creation; prepaid: when payment settlement is accepted (BILL-2), even if the buyer never returns | both |
| Google value quality | Additionally upload COD conversions as offline conversions only after delivery confirmation (primary), browser purchase secondary | AdsBookCMS |
| Dedup ids | Purchase `event_id` = `purchase:<order number>` issued by the server and returned to the confirmation page; funnel ids generated client-side and passed to both legs | TokoΦ + AdsBookCMS |
| Value | Goods subtotal in IDR, excluding shipping (shipping margin is not ad revenue) | TokoΦ owner ruling |
| Content ids | Variant catalog id (PR-12/T-14, ≥5 digits, string) as item id; product catalog id as group id | shared memory rule, TokoΦ ADR 0013 |
| Matching | SHA-256 of normalized phone (Indonesia → `62…` digits for Meta, `+62…` for TikTok/Google), email when real, name/city optional; fbp/fbc/ttclid/gclid/gbraid/wbraid captured first-party (last ad click wins), IP/UA stored with the order for delayed purchases and purged after 30 days | both |
| Browser init | Initialize each pixel once with advanced matching available at init; never re-`init` on Purchase | AdsBookCMS finding vs a TokoΦ risk |
| Delivery | Outbox via T-32 worker, unique (store, destination, event_id), bounded retries with backoff, permanent-failure codes (e.g. invalid token) fail fast, sanitized errors; seller sees 7-day health per destination | both |
| Consent | No consent banner in Indonesia v1; EEA/UK traffic gets denied defaults; revisit with privacy owner (PRIV-5) | AdsBookCMS |
| Abandoned forms | Half-filled checkout contacts may be saved for seller follow-up only with an explicit notice (privacy review); never sent as ad events | AdsBookCMS idea, gated |

### PR-21 — Order notifications
- Status: Accepted for implementation — email only (owner direction Q-16, 2026-10-06)
- Owner: Bukalaris product owner
- Source: Business gap analysis 2026-10-06.
- Statement: Buyers and sellers shall receive order notifications (created,
  awaiting payment, confirmed, shipped with tracking, cancelled) through email
  and, when a provider is accepted, WhatsApp, with a buyer order-status page
  reachable through a signed link.
- Acceptance: Notifications are sent after commit through an outbox, at most
  once per event and channel; the status page reveals only that order and
  expires or can be revoked; no provider credential reaches the browser.
- Constraints: PR-4, PR-7, NFR-4, NFR-5, PRIV-4, Q-16.
- Evidence: Email part implemented by T-36 with the dev mail outbox (jobs enqueued in the order transaction, at most once per event and recipient, signed `/o/…` status link). No real mail provider yet (T-73, Q-16); WhatsApp is deferred.
- Change history: 2026-10-06 — proposed.

### PR-22 — Seller performance dashboard
- Status: Accepted for implementation — by the orchestrator under the owner's delegation "sisanya kau atur" (2026-10-07); the owner may veto
- Owner: Bukalaris product owner
- Source: Business gap analysis 2026-10-06.
- Statement: The Seller Admin overview (SC-01) shall show store-scoped orders,
  revenue (integer IDR), conversion funnel, COD confirmation/return rates and
  top products for a selected period in Asia/Jakarta time.
- Acceptance: Numbers reconcile with order records for the same period;
  another store's data never appears; empty periods show an explicit empty state.
- Constraints: PR-2, TEN-1, NFR-1.
- Evidence: Implemented by T-41 (`/seller` SC-01 with KPIs reconciled to order rows; `test/dashboard.test.ts`, `e2e/dashboard.spec.ts`).
- Change history: 2026-10-06 — proposed.

### Business decisions required (2026-10-06)

| ID | Decision | Owner | Gate |
|---|---|---|---|
| Q-12 | Decided 2026-10-27: one all-feature Rp175.000/store/month DPP plan, AutoLaris VA/QRIS billing; Bukalaris-managed shipping margin and payment-fee margin | Product + finance owner | PR-18/BILL-7; annual plan and first-month promo OPEN; cashback share UNVERIFIED and affiliate platform fee OPEN |
| Q-13 | Decided: COD sellers across Indonesia; store-scoped COD controls are P0 | Product owner | PR-19; provider coverage and live COD gates remain |
| Q-14 | Whether COD risk signals may be shared across stores, and on which legal basis | Privacy + product owner | Before cross-store PR-19 features |
| Q-15 | TokoΦ/AdsBookCMS direction and PR-20 event definitions accepted; provider receipts and consent/legal review remain open | Integration + privacy owner | T-38 simulation does not establish live event acceptance |
| Q-16 | Email-first accepted; real mail provider and sender domain remain open; WhatsApp integration deferred | Product owner | T-73 before real delivery |

### Owner decisions — 2026-10-06 (Paduka Ongki)

The current Q-12 to Q-16 dispositions are maintained once in the table above; Q-2 is maintained in the earlier decision register. Their original 2026-10-06 direction was shipping-margin-first, nationwide COD sellers, TokoΦ/AdsBookCMS signals and email-first. Subscription deferral was superseded on 2026-10-27 (D-15, BILL-7); dated history does not reopen those decisions.

Mengantar-use boundary: development credentials enter only through `secrets-env`, never files or logs. Every present entry gate (including Partner Secret rotation) still applies. Shipment creation spends balance and dispatches couriers; it remains fake/disabled until the owner explicitly approves a write test. This historical record grants no new network permission.

Status changes under owner direction (2026-10-06): PR-5 (Mengantar part),
PR-19 (store-scoped scope only), PR-20 and PR-21 (email) → Accepted for
implementation. The PR-18 deferral recorded then is superseded by the
2026-10-27 owner decision below; PR-18 is Proposed, not implementation evidence.

| ID | Decision | Owner | Gate |
|---|---|---|---|
| Q-17 | COD remittance to sellers when collections land in the platform Mengantar account: ledger, payout schedule, fees, reconciliation against provider reports, and legal review of holding seller funds | Finance + legal owner | Architecture & ledger spec recorded in ADR-0006 / BILL-4 / BILL-5 (2026-10-26). Owner decision 2026-10-27, later superseding the H+1 rule: seller money is credited only when the parcel is delivered AND reconciled (D-14); the provider's settlement signal stays unverified (ADR-0006 decision 10), so reconciliation is an Owner console batch until it is verified. Legal review and live write test remain gated before the first real COD shipment |

### Owner decisions and Etalashop specification adoption — 2026-10-26 (Paduka Ongki)

| Topic | Decision | Consequence recorded in this pack |
|---|---|---|
| Shipping & COD aggregator | Mengantar remains the aggregator; ownership is unified in Bukalaris (D-15; the 2026-10-27 hybrid extension was superseded) | ADR-0007/PR-27 provision a Partner Mengantar account per store alongside ADR-0006. Buyer surfaces stay white-label; the named-provider exception for seller account-status consent is retained. |
| Subscription billing (`PR-18`, `Q-12`) | Earlier deferral superseded 2026-10-27; now Proposed | One all-feature Rp175.000/store/month DPP plan, PPN toggle OFF, 3-day trial and grace defaults; BILL-7/DATA-10/UX-18 and T-50 own the proposed implementation. |
| Etalashop pattern adoption | Adopt proven specification modules that accelerate Bukalaris development | Added canonical specifications for net seller proceeds & append-only ledger (`PR-23`, `ADR-0006`, `BILL-4`, `BILL-5`, `T-37`), standard Google Product Category taxonomy (`PR-24`, `T-44`), abandoned checkout capture & 1-click WhatsApp recovery (`PR-25`, `T-45`), store promotions/vouchers/flash sales (`PR-26`, `T-46`), Cloudflare for SaaS custom domains (`DOM-2`, `DOM-3`, `T-15`), Puck custom image/link pickers (`TD-4`, `T-11`), and Coolify zero-downtime + R2 offsite backups (`DEPLOY-COOLIFY.md`, `DR-1`). |

### PR-23 — Seller ledger, COD remittance, and payouts
- Decision (D-27, 2026-11-14, ADR-0013): for a store on seller-owned accounts the platform holds no money, so no `ledger_entry`, balance, payout, reconciliation batch or platform refund exists for it. `order_financials` is still frozen once per order, with `payment_fee_bearer` and `cod_fee_bearer` (`buyer` or `seller`) and no platform margin, cashback or affiliate deduction. Seller screens name Mengantar and AutoLaris; the white-label rule below no longer applies to them. The ledger rules below stay the contract for any money Bukalaris does hold. Not implemented (T-107).
- Status: Proposed
- Owner: Bukalaris finance owner
- Source: Q-17, ADR-0006, ADR-0007, and Etalashop `FINANCE.md` / `0015-net-seller-proceeds-and-shipping-reconciliation.md` (adapted for Mengantar on 2026-10-26/27).
- Statement: The platform shall freeze an immutable `order_financials` allocation per order, maintain one unified store-scoped append-only `ledger_entry` book deriving `pending` and `available` balances (including `sale` and shipping `cashback`), and release seller `sale` and `cashback` entries to `available` only when the order is delivered (`completed`) AND reconciled (D-14; `reconciled_at`, `reconciliation_source`), so that an order in transit, `returned` or `cancelled` earns no credit and no negative balance can arise; returns after delivery are outside the ledger scope in M3. It shall process store-owner payout requests (with a mandatory 72-hour hold on new/changed bank destinations, step-up proof, old-contact notice, and holder-name check, D-19) and buyer non-COD refunds with transactional locks and bank snapshots. Each store sets its goods sales tax handling in `store_tax_setting` (`price_mode` `tax_included` or `tax_added`, `sales_tax_rate_bps`; DATA-8). All shipping and payments run in one unified Bukalaris-managed system (no `own_key` external seller keys and no System A / System B split, D-15); COD is offered only for courier services on the data-driven `return_free` allow-list (currently SPX, UNVERIFIED live gate, D-15).
- Acceptance: Dashboard revenue, order list, and seller balance reconcile by construction: the sale entry is `sale_amount` (goods proceeds + included tax + added tax - affiliate commission), the seller entitlement is `sale_amount` plus `seller_cashback_idr` and the shipping debit entries, and `payable` (what the buyer pays excluding the gateway admin fee) equals `sale_amount` + commission + shipping charged + COD fee + COD-fee VAT (ADR-0006, DATA-7, BILL-4); shipping fees, platform shipping margin, platform shipping cashback, COD fees, and gateway admin fees never enter goods proceeds. Duplicate callbacks cannot double-credit/reverse, terminal-order guards remain intact, and payouts serialize under the per-store lock. Buyer and order surfaces remain 100% white-label (`Bukalaris Kirim` / `Bukalaris Bayar`), with only the one-time Partner onboarding disclosure if required by Mengantar's Partner API terms (ADR-0007).
- Constraints: BILL-1, BILL-2, BILL-4, BILL-5, BILL-6, DATA-2, DATA-7, DATA-9, TEN-1, TEN-3, NFR-2, UX-14, ADR-0006, ADR-0007.
- Evidence: Specification only; implementation tracked under T-37 and T-48.
- Change history: 2026-10-26 — specified from Etalashop finance architecture adapted to Mengantar. 2026-10-27 — COD fee base without goods sales tax, terminal-order and callback guards added; H+1 COD release replaced by delivered-and-reconciled release (D-14); interim two-systems split replaced by one unified Bukalaris-managed Partner Mengantar model with shipping `cashback` ledger (D-15) and mandatory 72-hour payout destination hold (D-19).
### PR-24 — Standard product taxonomy and catalog feed attributes
- Status: Proposed
- Owner: Bukalaris product owner
- Source: PR-12, T-40, and Etalashop `0011-product-taxonomy-google-category.md` (2026-10-26).
- Statement: The platform shall separate store collections, free-text merchant category labels, and a platform-wide reference `product_taxonomy` (Google Product Taxonomy numeric IDs and paths) with a deterministic Indonesian keyword auto-suggester and optional apparel/feed attributes (`brand`, `gtin`, `gender`, `age_group`, `color`, `size`), emitting `g:identifier_exists = no` automatically when GTIN/MPN is absent.
- Acceptance: Sellers can accept a one-click suggested Google category or search `product_taxonomy` without altering their storefront collections; Meta CSV and Google Merchant XML feeds include `google_product_category` and truthful `identifier_exists` values; stored numeric `google_category_id` values survive taxonomy refreshes.
- Constraints: PR-12, DATA-5, DATA-8, TEN-1, UX-10.
- Evidence: Specification only; implementation tracked under T-44.
- Change history: 2026-10-26 — adopted 3-layer taxonomy and feed attribute rules.

### PR-25 — Abandoned checkout capture and 1-click WhatsApp recovery
- Status: Proposed
- Owner: Bukalaris product owner
- Source: PR-4, PR-20, and Etalashop `specs/PRD.md` §5.1 (2026-10-26).
- Statement: Hosted checkout shall progressively capture in-progress buyer contact and cart context into a store-scoped `checkout_session` record as the shopper types, sweep idle sessions to `abandoned` after 60 minutes of silence without an order, rank actionable sessions in Seller Admin by phone presence and time-decayed basket value, and provide a 1-click `wa.me` recovery link carrying a signed, store-bound, expiring token.
- Acceptance: Active sessions are excluded from abandonment denominators; Recovery Rate counts only sessions where `abandoned_at IS NOT NULL AND recovered_at IS NOT NULL` (never ordinary straight-through checkouts); clicking the WhatsApp button records `"WA dibuka"` (never unobservable `"terkirim"`); the recovery URL never exposes raw session IDs or cross-store buyer PII, and `checkout_session` personal data is covered by buyer export/redaction (`PRIV-1`).
- Constraints: PR-4, DATA-8, PRIV-1, PRIV-4, TEN-1, SEC-16, UX-15.
- Evidence: Specification only; implementation tracked under T-45.
- Change history: 2026-10-26 — specified abandoned checkout capture and recovery math.

### PR-26 — Store promotions: vouchers, free-shipping threshold, flash sales, and promo hub
- Status: Proposed
- Owner: Bukalaris product owner
- Source: PR-2, PR-4, and Etalashop `PROMO_SPEC.md` (2026-10-26).
- Statement: A seller shall configure scoped discount vouchers (`all`, `collection`, `product`; `percent`, `fixed`, `free_shipping`), automatic store-level free-shipping thresholds, time-boxed `flash_sale` price overrides, and a unified storefront `/promo` hub page, with all discounts validated and split into `goods_discount` and `shipping_discount` server-side at checkout.
- Acceptance: Flash-sale prices override variant prices server-side only while `now` is within `[starts_at, ends_at]` and `stock_cap` is available without mutating base variant prices; checkout enforces voucher dates, minimum purchase, usage limits, and per-store isolation atomically; `order_financials` records `goods_discount` and `shipping_discount` separately so seller proceeds and platform shipping margin remain exact.
- Constraints: PR-2, PR-4, BILL-4, DATA-2, DATA-8, TEN-1, NFR-2, UX-16.
- Evidence: Specification only; implementation tracked under T-46.
- Change history: 2026-10-26 — specified unified promo system and checkout discount split.

### Owner decisions — 2026-10-27 (Paduka Ongki)

| Topic | Decision | Consequence recorded in this pack |
|---|---|---|
| Unified Partner Mengantar shipping & cashback (`Q-2`, D-15) | Bukalaris generates a new Partner-managed Mengantar seller account (`POST /api/partner/v1/sellers`) for every store — even sellers who previously had an external Mengantar account must use the new Bukalaris-generated account — with the platform master account as fallback; no `own_key` and no System A/B split; all shipping management, discounts, margin, and cashback rules are controlled in the Owner console (`SA-07`) | ADR-0007, PR-27, BILL-6, DATA-7, DATA-9, UX-17, T-37, T-48. Partner settlement/cashback sweep is gated on `OPEN-F9`. |
| Subscription (`Q-12`) | One all-feature plan, Rp175.000 per store per month DPP; PPN default OFF; adjustable trial/grace defaults 3 days each | PR-18, BILL-7, DATA-10, UX-18 and T-50 replace the deferral. Non-payment restricts Seller Admin, not storefront checkout; operator suspension is independent. Annual plan and first-month promo OPEN. |
| Affiliate programme | Platform-owned, one approved affiliate may promote many sellers; products require seller opt-in; all opted-in prepaid and COD orders are eligible | ADR-0009, PR-28/PR-29, BILL-8, DATA-11, UX-19/UX-20; separate affiliate account/portal, seller-checkout handoff, source `bukalaris` only. `affiliate_hold_days` decided at 3 days default (Owner-configurable). Window and commission platform fee OPEN. |
| Architecture and build order | Keep one Next.js app (D-2), route groups and host rewrites; reorganise DB modules by bounded context | ADR-0008, TD-7; the build order is maintained once, in [TASKS.md](TASKS.md) (section "M3 chains A and B"). Split apps only when deploy isolation is needed; external connectors T-56 deferred. |
| Production hosts | Owner console `owner.bukalaris.com`; Seller Admin `app.bukalaris.com`; Affiliate `affiliate.bukalaris.com`; Buyer `buyer.bukalaris.com`; public Update Log `logs.bukalaris.com` | ADR-0008/TD-7 and Domain Routing own host rewrites; the interim operator host labels `berkah` and `bos` were never deployed and are retired. Host selection grants no role/session authority and is not deployment evidence. |
| Global buyer identity | No registration step; canonical phone/WA priority, then email; phone wins conflicting accounts without automatic merge | PR-7, DATA-4/DATA-12, UX-21, ADR-0010: passwordless proof before portal access, no checkout prefill leak, no affiliate buyer access. OTP provider/channel, verified prefill, merge UX, recycled numbers and global deletion OPEN. |
| Operator surface name | The platform operator surface (formerly "Super Admin" / "Bos"; the interim host label `berkah` was never deployed) is the **Owner console** at `owner.bukalaris.com`; the store-level role `owner` ("Pemilik toko") is a different thing | PR-30, ADR-0011, IAM-15, UX-22. Platform side: "Owner console" / "platform owner"; store side: "store owner". Existing ids (SA-xx, `/admin`, `platform_operator`) are not renamed. |
| Owner console scope | Everything about sellers (stores: lifecycle, plan and billing, shipping account, domains, risk, optional verification), affiliates (applications, approval, suspension, rate bounds, payouts) and user accounts of every kind (seller team members, affiliates, buyers: view, support actions, suspend, recovery, merge requests, privacy requests) is managed from the Owner console | PR-30, ADR-0011, IAM-15, PRIV-9, UX-22, T-62, T-63. Support is a masked read-only diagnostic view; there is no impersonation or password handling. |
| Product posture and startup phase | Bukalaris is an online-store platform (Shopify-like), not a marketplace; each store is run by its own seller. Licensing and permit alignment will be adjusted later; for the startup phase obligations are relaxed | Seller verification is an optional record that never gates store activation; the Compliance center (takedown, complaints, privacy-request queue, incident register, registrations) is Phase 2, switched off until activation criteria hold (ADR-0011 §3, T-64). Audit, masking, MFA, purpose logging, four-eyes for money actions and session isolation are not relaxed. Statutory readings (PP 80/2019, UU PDP 27/2022, PSE registration) are UNVERIFIED advisor items, not startup blockers. |
| Tax on commissions and related items | Handled by the platform; startup mode keeps it dormant (earnings statements and optional voluntary tax identity only; sellers and affiliates handle their own tax). Tax mode: startup OFF, Phase 2 dormant, activation by an Owner console setting with advisor confirmation | PR-31, ADR-0012 (section 5), BILL-9, DATA-15, UX-23, T-65, T-66, T-67 (Phase 2, deferred); the Owner console reserves the Tax center menu group and `tax.*` capabilities. The earlier "NPWP/KTP before the first payout" rule is superseded by the policy flag `tax_identity_required_for_payout` (default OFF). Rates and legal treatment are never hard-coded and stay with a tax advisor. |
| Update Log host | The public product Update Log is served read-only at `logs.bukalaris.com` (not the internal Log System); authoring happens in the Owner console | ADR-0008 (host dispatch, `logs` reserved label), PR-30 (Update Log, Phase 1.5, optional), UX-22, T-69. The `logs` host serves `GET`/`HEAD` only, sets no cookie and exposes no draft or personal data. Not deployment evidence. |
| Issue reporting button | Every Owner console page carries a persistent "Lapor masalah" control that files a broken button or function with scrubbed technical context tied to the ARCH-5 page id | PR-30 (issue reporting), UX-22, DATA-14 `issue_report`, IAM-15 (`ops.issues.report`, `ops.issues.manage`), T-62 (control), T-68 (queue and per-page function health). Phase 1 startup core; no secret or personal field is stored. |
| Seller money release (D-14) | A seller is credited only for delivered and reconciled parcels; nothing for in transit, returned or cancelled; no negative balance by construction; returns after delivery out of ledger scope; reconciliation is an Owner console four-eyes batch until the provider signal is verified | PR-23, ADR-0006, DATA-7, UX-14, T-37, T-62/T-63. Supersedes the H+1 rule (D-11). |
| Unified shipping, COD allow-list & cashback (D-15) | Bukalaris generates a new Partner Mengantar account per store (`partner_managed`, with `platform_master` fallback; no `own_key` and no System A/B split) so 100% of shipping management, discounts, margin, and cashback are in Bukalaris's hands; COD only for courier services with `cod_allowed` and `return_free` (currently SPX, UNVERIFIED live gate); prepaid always through our AutoLaris gateway | PR-23, PR-27, ADR-0006, ADR-0007, BILL-6, DATA-7, DATA-9, T-37, T-48, T-49. |
| Affiliate commission rule (D-16) | Commission only for delivered parcels across all opted-in prepaid and COD orders: in transit, returned or cancelled earn nothing; credit after delivered and the seller sale is released, then `affiliate_hold_days = 3` days default (Owner-configurable) | PR-28, ADR-0009, BILL-8, T-52, T-53. |
| PPN (D-17) | OFF by default, switchable in the Owner console (`tax.manage`), the rate is always a confirmed policy value (no 11% computed in startup), the company (PT) legal documents are not issued so no PPN invoice or e-Faktur yet | PR-18, PR-31, BILL-7, ADR-0012, T-50, T-75 (deferred readiness). |
| Issue-report screenshots (D-18) | None in Phase 1; text and captured technical context only | PR-30, UX-22, T-68. |
| Security, recovery & SLA/DR baselines (D-19) | Mandatory 72-hour hold on new/changed payout bank destinations + step-up + old-contact notice + holder-name check; staff-executed store-ownership recovery and buyer merge disabled in Phase 1 (self-service only); startup SLA/DR baseline = 99.5% availability, hourly encrypted dumps (RPO 1 h), RTO 4 h proven by restore rehearsal | PR-23, PR-28, PR-30, BILL-5, BILL-8, IAM-9, IAM-13, IAM-15, DR-1, T-18, T-37, T-53, T-63, T-72. |

### PR-27 — Seller-owned Mengantar and AutoLaris accounts
- Status: Accepted (owner 2026-11-14, D-27); not implemented
- Owner: Bukalaris product owner
- Source: Owner decision 2026-11-14 (D-27); [ADR-0013](adr/ADR-0013-seller-owned-shipping-and-payment-accounts.md). Replaces the platform-managed Partner Mengantar requirement of 2026-10-27 (D-15, [ADR-0007](adr/ADR-0007-hybrid-mengantar-shipping-accounts.md)).
- Statement: Each store shall connect its own Mengantar account and its own AutoLaris account. The store owner enters, replaces, checks and removes each key; the platform seals it, uses it only inside server-side provider calls and never shows it again. Each account has a fixed environment (`sandbox` or `production`). The seller controls which couriers, COD options, provinces and payment channels the store offers and who bears the payment fee and the COD fee.
- Acceptance: A key change needs the store owner's capability and a fresh step-up, is audited and notifies store owners; an empty field keeps the stored key and removal is an explicit action; a failed connection check keeps the previous key. No key appears in any response, log, audit row or export. No provider URL is built from seller input. A payment or shipping method is offered only when its account is ready, and every filter of ADR-0013 section 4 is enforced at order submit, including a direct request for a hidden method and COD to an unresolved province. Foreign-store account reads, uses and changes are denied. Sandbox orders are marked as test orders.
- Constraints: PR-4, PR-5, PR-19, BILL-1, BILL-2, DATA-7, DATA-9, UX-17, TEN-1, TEN-3, SEC-3, ADR-0013.
- Decision (owner, 2026-11-15, ADR-0013 section 11): Mengantar is the only shipping aggregator and is locked; no other can be connected and AutoLaris is never used for shipping. Each store connects a new Mengantar account used only by that store. Parcel state is kept equal to Mengantar's from creation through pickup, delivery and return (a verified webhook triggers a tracking read; the read is the only writer), and Mengantar's balance and invoices are mirrored read-only, with per-parcel money figures only where the official documentation exposes them. Shipping money itself stays between the seller and Mengantar; Bukalaris is a written record of platform transactions. Not implemented (T-115).
- Evidence: Specification only; T-104, T-105, T-106, T-107 and T-113 (bank transfer to the seller's account, D-31). The delivered Partner account work (T-48) is unused for these stores and stays in the code (D-31).
- Change history: 2026-10-27 — platform-managed Partner accounts (D-15). 2026-11-14 — replaced by seller-owned accounts (D-27).

### PR-28 — Store affiliate programme run by the seller
- Status: Accepted (owner 2026-11-14, D-29); identity and attribution delivered locally in T-52, the rest not implemented
- Owner: Bukalaris product owner
- Source: Owner decision 2026-11-14 (D-29); [ADR-0015](adr/ADR-0015-seller-run-store-affiliate-programme.md). Replaces the platform-funded programme of 2026-10-27 ([ADR-0009](adr/ADR-0009-platform-owned-affiliate-programme.md)), whose identity, attribution and privacy rules stand.
- Statement: An affiliate shall register once on the platform and apply to individual stores. Each seller switches the programme on for their store, sets the commission rate (store default with product overrides, within Owner console bounds) and approves, rejects or suspends members. The system attributes orders and computes commission. A commission is the seller's obligation: the seller pays it outside Bukalaris and records the payment with proof. Bukalaris holds no affiliate money.
- Acceptance: Only an affiliate with an active membership of that store can be attributed. Checkout freezes one commission per order with its base and rate; the base is net goods after store-funded discounts, excluding shipping and gateway or platform fees, and nothing is deducted from the seller's proceeds. An explicit code beats a captured link; otherwise last click wins inside the window. Invalid codes and phone self-referrals are ignored without failing checkout. A commission becomes payable only after delivery (for a digital line, after access is granted) plus `affiliate_hold_days` (default 3, D-16); cancel or return before that voids it. A recorded payment equals the sum of the commissions it covers and cannot be edited. Seller and affiliate see the same statement. A payable commission older than `affiliate_arrears_days` (default 14) is in arrears and the Owner console can freeze that store's programme. Affiliate views never contain buyer personal data or order numbers. The application screen and the statement state that the seller, not Bukalaris, pays.
- Constraints: PR-7, PR-4, TD-5, BILL-8, DATA-11, IAM-3, PRIV-2, PRIV-7, UX-19, ADR-0009, ADR-0015. Decided defaults (D-31): rate 100 to 5000 bps, window 7 days, no platform fee, bank details visible to the paying store's finance role, auto-approval off by default.
- Evidence: T-52 (identity, links, codes, click route, attribution) delivered locally with a commission deduction that T-108 removes; T-108, T-109, T-110 planned. T-53 is superseded and T-54 re-scoped.
- Change history: 2026-10-27 — platform-owned programme with wallet and payouts. 2026-11-14 — replaced by the seller-run programme (D-29).

### PR-29 — Affiliate storefront and discovery
- Decision (D-29, 2026-11-14, ADR-0015): deferred until the seller-run programme (PR-28) has run in a pilot. Its host is decided with T-54/T-55 (D-31). T-55 is not scheduled.
- Status: Proposed
- Owner: Bukalaris product owner
- Source: Owner decisions 2026-10-27; PR-6, PR-28, [ADR-0009](adr/ADR-0009-platform-owned-affiliate-programme.md).
- Statement: An approved affiliate shall curate a platform-owned storefront from
  the `affiliate_catalog` projection of eligible opted-in seller products and
  generate attributable links. Phase 1 supports `source=bukalaris` only.
- Acceptance: A storefront can show products from two or more stores, but each
  purchase action hands off to that seller's checkout with attribution preserved.
  A mixed-store cart/split checkout is never created. Withdrawn/blocked offers
  cannot start a new affiliate purchase; current price/stock is revalidated by
  the seller checkout. Affiliate discovery reads the platform projection, never
  bypasses seller RLS, and does not alter PR-6 marketplace approval rules.
- Constraints: PR-4, PR-6, PR-7, PR-28, TD-5, BILL-3, DATA-11, IAM-3, PRIV-2,
  UX-20, ADR-0009. External connectors (T-56) and multi-seller checkout deferred.
- Evidence: Specification only; implementation tracked under T-55.

### PR-30 — Owner console (platform back-office)
- Status: Proposed (owner decisions 2026-10-27; startup-phase direction applies)
- Owner: Bukalaris product owner
- Source: Owner decisions 2026-10-27; PR-1, PR-11, PR-15; [ADR-0011](adr/ADR-0011-owner-console-scope-and-account-governance.md).
- Statement: Bukalaris staff shall operate the platform from one Owner console
  (formerly Super Admin / Bos, `owner.bukalaris.com`) that manages stores,
  affiliate accounts, user accounts of every kind, money queues, platform
  settings, operations and staff access through a capability-gated navigation
  with Phase 1 (startup core) and Phase 2 (Compliance center, later) items.
  Support never uses impersonation or password handling; personal data is masked
  by default and every action is audited with a reason.
- Acceptance: A staff member with one capability sees and can call exactly that
  capability's screens and actions; every other direct call is refused with no
  side effect and a denial audit row. Seller, affiliate, buyer and store-owner
  sessions grant no Owner capability and the reverse. Store create, approve,
  suspend and reactivate, affiliate approval and suspension, account suspend,
  recovery link, session revoke and MFA-reset request each require a case and
  reason and write one audit row atomically. The actions that need a second
  staff member are listed once, in the four-eyes matrix of IAM-15 (money
  decisions, manual adjustments, plan price and PPN policy, MFA resets, merge
  execution, ownership recovery and sensitive grants); this document does not
  repeat the list. No store state
  (creation, approval, activation, payout) is blocked by the optional
  verification record. A Phase 2 screen is absent and its route not-found until
  activated. UX-22 and IAM-15 hold the measurable per-screen acceptance.
- Statement (issue reporting, Phase 1): Every Owner console page shall carry a
  persistent "Lapor masalah" action that lets staff report a broken button or
  function with automatically captured, scrubbed technical context tied to the
  ARCH-5 page id, feeding an Operations "Issue reports" queue and a per-page
  function-health view (capabilities `ops.issues.report`, `ops.issues.manage`).
- Acceptance (issue reporting): Reports filed from two different pages carry the
  correct page id and correlation ids; no secret, token, credential or personal
  field is stored; a non-staff session cannot create or read; per-staff rate
  limit and size caps hold; queue status changes, reads and exports are audited;
  the control works at 320px and keyboard-only. UX-22 holds the screen contract
  and measurable cases; DATA-14 holds `issue_report`.
- Statement (Update Log, Phase 1.5, optional): Owner console staff may author,
  schedule, publish and unpublish platform update entries that appear on a public
  read-only site `logs.bukalaris.com` (not the internal Log System) and as a
  "What's new" indicator in the Owner console (capabilities `updates.write`,
  `updates.publish`).
- Acceptance (Update Log): Draft, scheduled-not-due and unpublished entries are
  never served on the public pages or feed; markdown cannot inject script or raw
  HTML; the feed lists only published entries; no personal-data field exists on
  entries or in the public projection; every edit keeps a revision; the public
  host sets no cookie. UX-22 holds the contract; T-69 the delivery.
- Constraints: IAM-1, IAM-5, IAM-8, IAM-10, IAM-13, IAM-15, PRIV-2, PRIV-9, SEC-11, TEN-3, UX-22, DATA-14, ADR-0011. OPEN: four-eyes fallback for a one-person team, consented support grant, session and reveal durations, licensing posture that activates the Compliance center. Naming: "Owner console" or "platform owner" for the platform; "store owner" for `membership.role = 'owner'`.
- Evidence: Specification only; implementation tracked under T-62, T-63, T-68 and T-72 (Phase 1), T-69 (Phase 1.5, optional) and T-64 (Phase 2, deferred).

### PR-31 — Platform tax workflows and earnings statements
- Status: Proposed (owner decisions 2026-10-27; startup-phase relaxation applies, Phase 2 dormant)
- Owner: Bukalaris product owner with the finance owner and qualified tax advisors
- Source: Owner decisions 2026-10-27 (tax on commissions and related items is handled by the platform; later the same day: Bukalaris is an online-store platform, sellers handle their own sales taxes, startup obligations are relaxed); [ADR-0012](adr/ADR-0012-platform-tax-workflows.md); verified DJP release SP-23/2026 (marketplace collection regime; Bukalaris not designated).
- Statement: In the startup phase the platform withholds nothing, collects nothing, gates no payout on tax identity and requires no PKP/e-Faktur or seller tax KYC; sellers handle their own sales taxes and affiliates handle tax on their own commission. The platform provides transparent earnings statements (per affiliate, per calendar month and per year, PDF and CSV), a seller invoice-register export and an Owner platform invoice register, plus optional voluntary tax identity capture. The PPN toggle on subscription invoices (BILL-7) is OFF by default and switchable in the Owner console; its rate is always an effective confirmed `vat_output` policy value, no 11% is computed in startup mode, and no PPN invoice or e-Faktur is issued until the company (PT) documents, PKP status and an accountant exist (D-17, readiness task T-75, deferred). The full tax design (versioned, effective-dated, advisor-confirmed policy engine; withholding computation at payout; append-only tax liability ledger by period; remittance batches with opaque payment evidence; tax evidence documents; monthly filing pack; period close; VAT documents; corrections) is specified as a dormant Phase 2 capability, disabled by default and activated only by an Owner setting after the ADR-0012 criteria hold.
- Acceptance: With default `tax_setting` a payout needs no tax identity and has `tax_idr = 0` and `net = gross`; no code path, seed or default contains a tax rate, base fraction, bracket or deadline; each affiliate month and year has an earnings statement whose figures equal the ledger and whose monthly values sum to the annual one; statements contain no buyer data, order identifier or full tax identifier; the Owner console shows the tax mode as off with the activation checklist; withholding cannot be switched on without an activation reference, a confirmed platform tax-entity profile and an advisor-confirmed policy version; once activated (test environment only), each payout has one immutable computation and `gross = tax + net` in integer IDR with replay safety. Marketplace collection (PMK 37/2025) is not built: Bukalaris is not a designated collector.
- Constraints: PR-18, PR-28, PR-30, BILL-7, BILL-8, BILL-9, DATA-10, DATA-11, DATA-15, IAM-15, PRIV-6, PRIV-10, UX-23, ADR-0009, ADR-0011, ADR-0012. All legal statements are UNVERIFIED secondary-source inputs until an advisor confirms them. OPEN owner inputs (ADR-0012 OPEN-T1 to T18): platform legal entity type, NPWP, PKP status, tax advisor and accountant, e-Bupot/e-Faktur access, bank accounts and billing-code procedure for tax deposits, any expectation of marketplace designation, activation timing, notice and statement wording, retention.
- Evidence: Specification only; T-65, T-71 and T-66 (startup), deferred T-67 (Phase 2) and deferred T-75 (PPN activation readiness); no implementation claim.

### PR-32 — Digital products
- Status: Accepted (owner 2026-11-14, D-30); not implemented
- Owner: Bukalaris product owner
- Source: Owner decision 2026-11-14 (D-30); [ADR-0016](adr/ADR-0016-digital-products.md).
- Statement: A store shall be able to sell digital products beside physical ones in the same catalog, cart and checkout. A digital product has no shipment and is prepaid through the store's own payment account. The buyer receives its access links (content the seller hosts elsewhere, for example Google Drive) or access note when payment is proven. Bukalaris stores no file.
- Acceptance: An order without a physical line asks for no address and has no courier or shipping fee; a mixed order quotes shipping from physical lines only. COD is refused for any order with a digital line, including a direct request. Access is granted once per digital order line in the transaction that settles the order, never from a callback alone and never before payment. Access links and the access note appear only on the signed order-status page through a valid grant, never in storefront HTML, the Storefront API, feeds, e-mails or logs; a link is `https` only, opens with no referrer and is never requested by the server. The seller can extend and revoke access, audited; cancel or refund revokes it. Revoking hides the link on Bukalaris pages; sharing permissions on the seller's host stay the seller's responsibility, and the product screen says so. A digital-only order completes when paid. Cross-store access-item and grant access is denied. A later per-store member area with embedded video and webinars is prepared in the model (typed access items, grants bound to store and buyer identity) and not built.
- Constraints: PR-2, PR-4, PR-5, PR-21, PR-27, BILL-1, BILL-2, DATA-3, TEN-1, TEN-3, SEC-3, ADR-0016. Decided defaults (D-31): 10 links per product, no default expiry, excluded from feeds, no licence-key pools; member area later on the buyer portal. Bank transfer to the seller's account is a prepaid method (ADR-0013 section 10, T-113).
- Evidence: Specification only; T-111 and T-112.
