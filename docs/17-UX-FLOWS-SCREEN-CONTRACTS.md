# Bukalaris UX Flows and Screen Contracts

## Experience direction

The product has two operational surfaces with different jobs: Super Admin
governs platform risk; Seller CMS runs one store. Storefront optimizes a buyer's
single-store purchase. Navigation follows these jobs, not a copied Shopify menu
or generic dashboard cards. Routes, visual behavior and business workflows
remain Bukalaris proposals until implemented and verified.

## Journey contract

### Bukalaris workflow baseline

Status: Proposal, 2026-09-25. The [page map](04-SYSTEM-ARCHITECTURE.md) and
journey IDs below own Bukalaris scope and acceptance.

| Actor and job | Proposed interaction | Bukalaris completion and exception boundary |
|---|---|---|
| Seller finds and edits a product | Search/filter list, stable product/variant identity, editor, save and publish distinction | Return to retained list context; invalid fields and stock conflicts preserve recoverable input; denied edits do not mutate data |
| Seller processes an order | Queue to detail, separate payment/fulfillment state, chronological events and permitted next action | Show confirmed versus pending outcomes; a timeout does not justify repeating an uncertain provider operation |
| Seller updates store presentation | Theme selection, content/media pickers, private preview, explicit publish | Failed publish preserves live content; switching built-in themes does not change the independent LP |
| Buyer completes a purchase | Catalog to product/options to editable cart and checkout | Native or external storefront hands off to the same hosted checkout; stale price/stock requires review and payment return is not proof of payment |
| Operator governs a tenant | Tenant queue/detail, reasoned transition and audit context | Platform capability is enforced server-side; Log System exposes only permitted, redacted information |
| Buyer later manages an account | Purchase-centered history, stores, addresses and account controls | Future-phase proposal only; retain guest checkout and resolve identity/linking permissions before adopting cross-store views |

Proposal: Refine each initial journey with a narrow and wide fixture plus
loading, empty, failure, denied, stale/conflict and success variants where
applicable. Demonstrate list/detail/back persistence and keyboard focus before
accepting visual polish. CRM, balances, flash sales, analytics and account
navigation each require accepted scope before appearing in the interface.

### Existing journey ownership

| ID | Owner | Actor/job | Happy outcome | Required recovery |
|---|---|---|---|---|
| UX-1 | Bukalaris product owner | Super Admin approves/suspends a seller | Seller state visibly changes with audit reason | Invalid transition/permission denial preserves prior state |
| UX-2 | Bukalaris product owner | Seller publishes catalog/content | Published storefront shows the intended store content | Draft, validation, conflict, and dependency errors are explicit |
| UX-3 | Bukalaris product owner | Buyer browses a host-resolved store | Catalog/content belongs to one active store | Unknown/inactive store gets safe non-commerce state |
| UX-4 | Bukalaris product owner | Buyer completes single-store checkout | Buyer receives truthful pending/paid/failed outcome | Price/stock/rate change, provider timeout, retry, and cart recovery are explicit |
| UX-5 | Bukalaris product owner | Seller submits product to marketplace | Submission becomes reviewable, not instantly public | Rejection/disable gives safe reason and resubmission path |
| UX-6 | Bukalaris product owner | Buyer later uses Bukalaris Account | Account is optional and does not lose guest order progress | Identity/recovery error never discloses account existence |

## Screen inventory

| Surface | Screens/jobs | Primary data/action |
|---|---|---|
| Super Admin | Seller queue/detail, marketplace review, platform operations | Target tenant, status change, reason/audit |
| Seller CMS | Overview, catalog, inventory, collections, pages, menus, store settings, orders, Landing Page Builder (future) | Scoped CRUD and publish/fulfillment actions |
| Storefront | Home, collection/search, product, cart | Discover, decide, edit cart, hand off |
| Hosted Checkout | Checkout, confirmation | Platform-owned transaction and outcome |
| Buyer Account (later) | Orders, addresses, profile | View only owned data; controlled updates |
| Affiliate (later) | Link and aggregate earnings | No buyer-identifying data |

## Shared state rules

- Every material screen defines loading, empty, success, validation error,
  denied, dependency error, stale/conflict, and retry state where applicable.
- Seller list/detail pages retain filter, sort, pagination, and chosen store
  state in addressable navigation where shareability is useful.
- Storefront cart remains editable, visibly recalculates authoritative changes,
  and does not imply checkout success until server confirmation.
- Guest checkout remains possible unless an accepted business decision changes
  it; authentication preserves progress.
- Narrow layouts preserve data and primary actions; tables progressively expose
  priority fields rather than becoming unreadable card grids.
- All form error text is associated with inputs; async status changes are
  announced without surprise focus movement; critical flows reflow at 320px.

## Acceptance evidence

For each `UX-*`, browser verification must cover wide and narrow viewport,
keyboard path, authorized and denied state, an error/recovery fixture, Bahasa
Indonesia text expansion, and no cross-tenant content/action leakage.

## UX-7 — Future storefront landing-page authoring

- Status: Proposed
- Owner: Bukalaris product owner
- Source: PR-9.
- Statement: A seller opens the dedicated Landing Page Builder, creates or
  edits a store-owned page using composable drag-and-drop content or an authorized
  MCP client, previews its independent mobile-first layout, and publishes it
  within the same storefront.
- Acceptance: Draft previews require authorization. Published LPs use the
  existing store cart and checkout. Changing storefront themes preserves LP
  content and appearance under UI-6. Validation failure, permission denial,
  slug collision, stale edits, and publish failure preserve the last published
  revision and expose a recovery action. Dragging has button/keyboard alternatives.
- Constraints: UX-2, UX-3, UI-4, UI-6, API-3.
- Evidence: Browser verification pending implementation.
- Change history: 2026-09-18 — revised for an independent LP layout, dedicated
  builder feature, and mobile-first drag-and-drop authoring.

### Proposed feature workflow

Seller CMS → Landing Page Builder → page list → create a blank page or start from a template
or open an existing page → compose layout and content → preview → publish.

| Screen | Required information and actions | Recovery/state |
|---|---|---|
| Page list | Title, slug, draft/published state, last edit; create, edit, preview, duplicate | Empty list, loading, denied, failed load/retry; duplicate creates a draft with a new slug |
| Editor | Section library/order, canvas, selected-section fields; add, drag/reorder, duplicate/remove, undo/redo, save draft | Visible unsaved/saving/saved/error state; failed saves retain edits; simultaneous MCP/UI changes produce a revision conflict rather than overwrite |
| Preview/publish | Actual LP rendering at mobile/tablet/desktop widths, storefront URL, validation and publish result | Private draft access; invalid slug/product/section blocks publication; failed publication preserves the live revision |

Proposal: Desktop editor uses a section panel, phone-width canvas, and properties
panel. On a phone, show one working panel at a time using a drawer or sheet;
provide tap-to-add and move-up/down controls alongside touch dragging. Previewing
mobile output and comfortably editing on a phone require separate verification.
Autosave applies to drafts only, reports its state, and never publishes implicitly.
Unpublish removes public access while keeping the editable draft; the permission
model must distinguish content editing and publication.

### Acceptance plan

- Exercise create → reorder → edit → save → reopen → preview → publish with
  keyboard and touch; test 320px, 390px, 480px, tablet, and desktop.
- Compare the same published LP before/after each storefront theme switch;
  verify stable appearance and URL, plus a preserved cart and working checkout.
- Verify theme CSS/header/footer do not leak into the LP or its preview.
- Test a stale MCP revision while the seller edits, failed save/publish, revoked
  access, and cross-store product/page identifiers without losing valid content.

Unknown: Exact storefront URL pattern, reserved routes, final section catalog,
LP desktop width, protected form types/properties, and MCP publication
interaction remain under T-11. The planned form lock must not freeze the
surrounding LP layout or tie it to a storefront theme.

## UX-8 — Engineering discovery

- Owner: Bukalaris architecture owner
- Source: PR-10; canonical map: ARCH-5 in 04-SYSTEM-ARCHITECTURE.md.
- Contract: AI agents and engineers can find a page by stable ID, title, or
  proposed/implemented URL, then follow verified code/data/task/test locators.
  A planned route or missing code is visibly labelled; implementation status
  comes from TASKS.md and repository evidence, not an inferred map entry.

## UX-9 — Super Admin Log System

- Owner: Bukalaris product owner
- Source: PR-11; signal and access contract: OBS-5.
- Entry: Visible Log System button on the Super Admin overview plus a persistent
  navigation entry for authorized operators. Direct URLs enforce the same
  server-side permissions as navigation.
- List: Filter by time range, severity, environment, module, trusted store,
  Page ID, and request/trace correlation; show time, severity, event, module/page,
  safe summary, and correlation. Preserve safe filter state in navigation.
- Detail: Show sanitized metadata and related events, with a page/module map
  link and release revision when available. No mutating recovery/replay/delete
  actions are implied by this read-only log feature.
- States: Loading, no events, no filter matches, permission denied, expired log,
  unavailable source, partial/stale results, and retry are distinct. Missing
  correlation or source-code mapping is labelled unavailable, not fabricated.
- Acceptance: Exercise button → filter → event detail → related events → map
  link; cover narrow/wide layouts, keyboard operation, denied direct access,
  sink outage, and redaction using synthetic fixtures.

## UX-10 — Product creation and discoverable identity

- Owner: Bukalaris product owner
- Source: PR-12 and DATA-5.
- Contract: Product creation requires no manual ID/slug entry. After save, show
  the numeric product ID, copy action, editable slug, storefront URL preview,
  and the configured advertising identity/granularity. Numeric slug is the
  proposed default. Save errors preserve entered data; duplicate slug errors
  explain recovery. An explicit slug change reports the old-URL redirect.
  Never label a group ID as an individual variant catalog ID.

## UX-11 — Seller domain management

- Owner: Bukalaris product owner
- Source: PR-13 and DOM-1 through DOM-3.
- Contract: Seller Settings includes Domains with the default subdomain,
  connected domains, primary marker, DNS instructions and ownership/TLS status.
  Add, verify/retry, set primary, and remove obey server permissions and explicit
  lifecycle states. Preserve the existing working primary on failure. Show
  resulting store/product/LP URL previews and explain that content IDs remain
  unchanged. DNS instructions use the selected provider's real values only.

### Product creation screen detail — SC-17 / UX-10

Proposal: Opening the screen does not allocate an ID. Seller enters a title and
optional draft content, then saves a draft. Show automatic URL generation before
save; after success show the actual numeric ID and copyable URL. Draft links
are previews requiring authorization, not a claim that the product is public.
Publishing is a separate action that checks required commerce fields.

| State | Behavior |
|---|---|
| New | Title input and draft action; ID shown as generated after save |
| Saving | Preserve all input and keep one creation key across retries |
| Saved draft | Show ID, draft status, editable slug, preview, and publish eligibility |
| Validation error | Inline errors and summary; retain unsaved values |
| Timeout/unknown result | Retry/resume the same creation; do not offer silent duplicate creation |
| Concurrent edit | Show conflict and reload/compare choice without discarding local input |
| Published | Show canonical public URL; slug changes explicitly preserve old link redirects |

### Domain screen detail — SC-18 / UX-11

Proposal: One store-scoped screen provides domain list, add form, and expandable
setup details. Display primary marker separately from ownership, TLS, DNS and
last-check status. Copy buttons copy real provider instructions only. Set-primary
is unavailable until eligible and explains why. Removal shows the replacement
primary before the seller confirms. Pending cleanup remains visible until settled.

### Planned acceptance cases for product/domain delivery

These cases are specifications, not executable-test evidence. T-14 and T-15
must bind them to real project commands once the repository exists.

| Scenario | Expected outcome |
|---|---|
| Two product saves with same creation key/input | One product, same ID and result |
| Same key with different input | Conflict, no extra product |
| Simultaneous creates with different keys | Distinct numeric IDs and default slugs |
| Duplicate a published product | New draft with new product/variant identity |
| Rename slug then rename again | All retained aliases resolve directly to current canonical URL |
| Claim another product's old or numeric slug | Rejected without changing either product |
| Product ID above JavaScript safe integer range | Exact decimal string survives transport and mapping |
| Cross-store edit/read or media/variant reference | Denied; no foreign-store data mutation/disclosure |
| Catalog item versus Pixel/CAPI fixture | Same immutable identity and catalog granularity |
| Provider create timeout followed by retry | Existing resource reconciled; no duplicate hostname |
| DNS ready but TLS pending | Not eligible for primary selection |
| Two concurrent primary changes | Revision conflict or serialized outcome; exactly one primary |
| Remove primary while stale activation job returns | Fallback remains correct; removed binding stays disabled |
| Reassign a previously used hostname | Fresh proof and cache invalidation prevent prior-tenant serving |
| Custom primary domain with both themes and LP | Correct store, canonical URLs, unchanged IDs and LP appearance |
| Source unavailable or stale domain check | Truthful status and recovery; no false connected state |

## UX-12 — Headless channel and hosted checkout journey
- Owner: Bukalaris product owner
- Source: PR-16, ARCH-7, UI-10.
- Contract: SC-21 lists channel name, registered origin, status, expiry and token
  prefix. Owner can create a restricted token, copy it once, and revoke it.
  Lost-token recovery uses replacement, not reveal. The developer configures its
  server, browses products, creates a cart, and asks for a fresh checkout URL.
  Buyer navigates to the separate SF-07 hosted checkout; no account is required.
- Checkout states: handoff exchange, ready, changed quote/stock, validation error,
  submitting, provider pending, confirmed, failed, expired, and retry/recovery.
  SF-08 is the platform confirmation surface; payment return never implies paid.
  Back-to-store uses a registered origin/path. Price/stock changes require review.
- Acceptance: Exercise native themes, independent LP and a separate-origin
  headless fixture through the same hosted checkout. Verify keyboard/mobile
  behavior, no theme CSS leakage, no shared-cookie dependency, replay/expiry,
  revoked token, stale cart, and authoritative final order state.

## Initial surface workflow completion matrix

All rows are proposed screen behavior; ARCH-5 owns Page IDs and code locators.
Future screens are not counted as initial release requirements.

| Pages | Primary workflow | Required recovery and permission |
|---|---|---|
| AU-01..AU-03 | Sign in, recover, select authorized store | No account enumeration; revoked/expired session; clean context switch |
| SA-01..SA-03 | Inspect tenant, approve/suspend/reactivate with reason | Platform capability, invalid transition, stale edit, audit failure |
| SA-05..SA-06 | Log System filter/detail/correlation | Restricted read, unavailable source, safe empty result, redaction |
| SC-01 | Seller work queue and actionable order/catalog state | No fabricated metrics; partial failure preserves usable actions |
| SC-02..SC-04, SC-17 | Create/edit products and variants; adjust stock | Draft versus publish, ID/slug visibility, foreign media/variant denial, stock conflict |
| SC-05..SC-09 | Collections, CMS pages and navigation | Preview/publication distinction, invalid link, failed publish preserves live content |
| SC-10..SC-11, SC-18 | Store settings, theme, domains | Capability checks; theme preview; domain/TLS pending and safe rollback |
| SC-12..SC-13 | Find order, inspect payment and fulfillment, allowed action | State-specific actions; unknown provider outcome never repeated blindly |
| SC-19..SC-20 | Invite/change/revoke member | Owner-only privileged capability; last-owner protection; invitation/recovery adapter pending |
| SC-21 | Create/revoke external storefront channel | One-time secret; explicit origin/scope; no seller/admin grants |
| SF-01..SF-05 | Browse/search/filter product, select variant | Empty/sold-out/not-found/inactive store, stable URL, authoritative availability |
| SF-06 | Add/change/remove cart items and hand off | Cart recovery, stale prices/stock, expired capability, no client totals |
| SF-07..SF-08 | Platform checkout and outcome | UI-10 and UX-12; no storefront layout ownership |

Every initial page requires loading/empty/error/denied/success states where
applicable, keyboard/focus and 320px reflow checks, Bahasa Indonesia labels,
and preserved input on recoverable errors. Role-hidden controls are backed by
server denial. Navigation retains safe filters; diagnostic IDs grant no access.

## UX-13 — MCP-assisted seller content review

- Status: Proposed
- Owner: Bukalaris product owner
- Source: PR-17, API-9, IAM-12.
- Contract: Tenant Admin shows the connected client, active store, granted content
  capabilities, expiry and revocation action. AI-assisted work creates drafts;
  review shows affected objects, revision, changes, validation and private
  preview. Publishing is a distinct human-approved action, bound server-side
  to the reviewed revision. Pending work never masquerades as published content.
- Acceptance: Exercise denied access, foreign references, stale revision,
  expired/revoked grant, partial batch failure and duplicate retry. Keep prior
  publication on failure. Revoking a grant prevents subsequent operations;
  editing after review requires new approval. Audit identifies client and actor.
- Constraints: UX-2, IAM-12, TEN-1, SEC-9.
- Evidence: Planned future journey only; no MCP client or server implemented.

## Named surface presentation

Decision: Super Admin is labelled Bukalaris Bos at `bos.bukalaris.com`; Seller
Admin is Bukalaris Tenant Admin at `app.bukalaris.com`. Keep platform versus
active-store context visible. Links between surfaces do not imply shared access.
Use Bahasa Indonesia for interface copy, including "Buka toko langsung laris"
on public brand presentation. Public browsing uses Astro; operator interactions
use Next.js and shadcn/ui. This rendering choice does not change journey states.


### Log System button and navigation detail

Scope: UX-9, SA-01, SA-05 and SA-06. Status: Proposed.

- On `bos.bukalaris.com/admin`, show the text-labelled **Log System** navigation
  link styled as a button for operators with `logs.read`. Its destination is
  `/admin/logs`; a matching persistent navigation entry uses the same permission.
- Default to the current environment and the last hour, with explicit start/end
  timestamps in the viewer timezone. Query timestamps are ISO instants; the API
  permits at most 24 hours per query. Freeze the range during pagination.
- Search means structured filtering by environment, severity, module, Page ID,
  trusted store and correlation ID. Apply/Reset controls are explicit; changing
  filters resets the cursor. Manual Refresh keeps filters and clears the cursor.
  There is no automatic polling or export in the initial contract.
- Row activation opens `/admin/logs/:eventId`. Provide copy actions for safe
  event/correlation IDs, a related-events link, and a map link. Source links are
  restricted to authorized engineering operators. Back restores list filters.
- Show loading without inventing events; distinguish no events, no matches,
  unavailable source, partial data and stale data. Display last-observed time
  or "Freshness unavailable". Never label a failing source as healthy/empty.
- A missing/expired event shows safe not-found feedback; permission loss clears
  protected rows and returns an access-denied state. Direct page/API requests
  independently check the same capability. IDs and filters never grant access.
- Preserve keyboard focus on navigation/return and make copy feedback available
  to assistive technology. On narrow screens, show time, severity and summary
  with labelled detail access; identifiers wrap locally without page overflow.

Acceptance: Use an authorized operator to open the button, apply a filter,
inspect a real synthetic event, follow correlation, open the mapped operation,
and return with state retained. Repeat with no capability, an expired session,
an absent event, a failed sink and partial/stale responses. No replay, delete,
provider retry or tenant mutation is available from this diagnostic surface.

