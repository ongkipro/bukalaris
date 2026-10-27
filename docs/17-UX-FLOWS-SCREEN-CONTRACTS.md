# Bukalaris UX Flows and Screen Contracts

## Experience direction

Chain A comprises Owner console governance, Seller Admin store operations and
Storefront single-store purchase. Chain B adds the separate affiliate portal and
affiliate storefront (PR-28/PR-29), not a seller-owned affiliate screen. Navigation
follows these jobs, not copied menus or generic cards. New contracts remain
Proposed until implemented and verified; no new screen below is M2 evidence.

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
| Buyer manages a global account (Proposed) | Registration-free checkout association; separate passwordless proof then cross-seller history/profile/address book at `buyer.bukalaris.com` | Typed contact is not authentication; no prefill/account-existence leak before proof, no automatic account merge (PR-7, UX-21, ADR-0010) |

Proposal: Refine each initial journey with a narrow and wide fixture plus
loading, empty, failure, denied, stale/conflict and success variants where
applicable. Demonstrate list/detail/back persistence and keyboard focus before
accepting visual polish. CRM, balances, flash sales, analytics and account
navigation each require accepted scope before appearing in the interface.

### Existing journey ownership

| ID | Owner | Actor/job | Happy outcome | Required recovery |
|---|---|---|---|---|
| UX-1 | Bukalaris product owner | Owner console staff approve/suspend a seller | Seller state visibly changes with audit reason | Invalid transition/permission denial preserves prior state |
| UX-2 | Bukalaris product owner | Seller publishes catalog/content | Published storefront shows the intended store content | Draft, validation, conflict, and dependency errors are explicit |
| UX-3 | Bukalaris product owner | Buyer browses a host-resolved store | Catalog/content belongs to one active store | Unknown/inactive store gets safe non-commerce state |
| UX-4 | Bukalaris product owner | Buyer completes single-store checkout | Buyer receives truthful pending/paid/failed outcome | Price/stock/rate change, provider timeout, retry, and cart recovery are explicit |
| UX-5 | Bukalaris product owner | Seller submits product to marketplace | Submission becomes reviewable, not instantly public | Rejection/disable gives safe reason and resubmission path |
| UX-6 | Bukalaris product owner | Buyer uses the global Bukalaris Account | Checkout needs no registration/login; portal entry under UX-21 requires proof of possession | Identity/recovery errors reveal no account existence; phone-priority association is not a session |

### Requirements without a dedicated UX contract

Some requirements are carried by screens that sit under another contract. This table is the reverse trace; ARCH-5 holds the page ids and code locators.

| Requirement | Screens and contracts that carry it |
|---|---|
| PR-5 shipping and payment orchestration | SF-07/SF-08 checkout and SC-13 booking section (UX-4, UX-12); money screens UX-14 and UX-17 |
| PR-14 headless foundation | UX-12 (hosted checkout and external storefront handoff), SC-21 channels |
| PR-15 operator access and membership | AU-01 to AU-05 and SC-19 (Implemented screens table below); Owner staff and access screens SA-38, SA-39 (UX-22) |
| PR-19 COD risk control | SC-12/SC-13 COD confirmation, hold, reject and risk reasons (Implemented screens table below) |
| PR-20 advertising signals | SC-23 marketing destinations and health; pixels on SF-01 to SF-09 (Implemented screens table below) |
| PR-21 order notifications | SF-11 buyer order status page and the order e-mails; no seller screen |
| PR-22 seller dashboard | SC-01 (Implemented screens table below) |

## Screen inventory

| Surface | Screens/jobs | Primary data/action |
|---|---|---|
| Owner console | Seller queue/detail, marketplace review, platform operations | Target tenant, status change, reason/audit |
| Seller CMS | Overview, catalog, inventory, collections, pages, menus, store settings, orders, Landing Page Builder (future) | Scoped CRUD and publish/fulfillment actions |
| Storefront | Home, collection/search, product, cart | Discover, decide, edit cart, hand off |
| Hosted Checkout | Checkout, confirmation | Platform-owned transaction and outcome |
| Buyer account portal (`buyer.bukalaris.com`, Proposed) | Passwordless sign-in, cross-seller own orders/tracking, profile, address book | Verified buyer scope, no unverified checkout prefill or affiliate access; UX-21 |
| Affiliate portal / affiliate storefront (Chain B, Proposed) | Separate sign-in, cross-store eligible catalog, links, aggregate outcomes, wallet/payouts, own storefront | Platform-owned affiliate scope, no buyer-identifying data; UX-19/UX-20 |

### Implemented screens (checked against `main`, 2026-10-07)

Routes as served by the single Next.js app (DECISIONS D-2); contracts above
and below are unchanged. Interface copy is Bahasa Indonesia with shared status
labels (`apps/web/src/lib/status.ts`). Browser evidence is captured at 320px
and desktop by `apps/web/e2e/*.spec.ts` into `docs/evidence/m1/` (T-28 ui pass:
skip link, `aria-current` navigation, pending submit state, confirm dialogs on
destructive actions, empty/loading/error states). Full locators: ARCH-5.

| Pages | Route on `main` | State evidence | Not yet |
|---|---|---|---|
| AU-01 sign in | `/login` (password, then TOTP code or backup code) | wrong password, MFA step, redirect allowlist (`e2e/accounts.spec.ts`) | — |
| AU-02 recovery | `/account/recovery`, `/account/recovery/reset` | identical response for unknown e-mail, expired/invalid token state | real e-mail provider |
| AU-03 store selection | header switcher in `/seller` shell (no page) | multi-store seed account; suspended-store fallback | — |
| AU-04 invitation | `/invite/[token]` (invalid / expired / revoked / used / pending; signed-in match or new account) | `e2e/accounts.spec.ts` | — |
| AU-05 security / MFA | `/account/security` (enrol TOTP, backup codes; operators redirected here before `/admin`) | `e2e/accounts.spec.ts` | QR code, disable/regenerate UI |
| SA-02 store list | `/admin` (suspend/reactivate with reason, confirm dialog) | `e2e/super-admin.spec.ts`, `e2e/ui.spec.ts` | separate overview (SA-01 retired) |
| SA-03 store detail / create | `/admin/stores/[id]`, `/admin/stores/new` | `e2e/content.spec.ts`, `e2e/ui.spec.ts` | — |
| SA-05 / SA-06 Log System | `/admin/logs`, `/admin/logs/[id]` (text-labelled nav entry; filters; detail with related events and map link; "Kesegaran tidak tersedia" when empty) | denied seller/operator without grant, DB outage (`e2e/ops.spec.ts`) | stale/partial source states, export |
| SA-07 shipping margin | `/admin/shipping` (preview of the fee, audit list) | `e2e/shipping.spec.ts` | — |
| SC-01 overview | `/seller` dashboard (period switcher today / 7 / 30 days WIB, KPI tiles, COD work queue linking to awaiting orders, top products, funnel; explicit empty state) | empty store, keyboard period switch, staff access (`e2e/dashboard.spec.ts`) | custom date range |
| SC-02 / SC-03 / SC-17 products | `/seller/products`, `/seller/products/[id]`, `/seller/products/new` (catalog id with copy button, slug, storefront URL, images, change history) | keyboard-only create (`e2e/ui.spec.ts`), cross-store 404, slug rename 308 (`e2e/catalog.spec.ts`) | publish as separate action (status field instead), duplicate, revision conflicts |
| SC-04 inventory | `/seller/inventory` (signed adjustments with reason) | `e2e/orders.spec.ts` | — |
| SC-05 / SC-06 collections | `/seller/collections`, `/new`, `/[id]` | `e2e/content.spec.ts` | cover image |
| SC-07 / SC-08 pages | `/seller/pages`, `/new`, `/[id]` (markdown-lite, draft/published) | `e2e/content.spec.ts` | revisions, preview |
| SC-09 menus | — (navigation derived from published collections and pages) | — | Planned |
| SC-10 / SC-11 settings and theme | `/seller/settings` (profile, WhatsApp, theme `responsive` / `mobile`) | staff denied (`e2e/content.spec.ts`) | theme preview before publish |
| SC-12 / SC-13 orders | `/seller/orders` (status filter, cursor), `/seller/orders/[id]` (allowed actions only; COD confirm/hold/reject with risk reasons; cancel restocks; shipping needs a tracking number; "Pengiriman Mengantar" section: book, retry, refresh status, timeline, Q-17 notice for COD) | `e2e/orders.spec.ts`, `e2e/checkout2.spec.ts`, `e2e/fulfillment.spec.ts` | returns/refunds, restock on returned shipments, real provider booking (writes locked) |
| SC-14..SC-16 landing pages | `/seller/landing-pages`, `/new`, `/[id]` (settings, typed block cards with up/down/remove, publish/unpublish with confirm), `/[id]/preview` | stale tab refused, other store sees nothing (`e2e/landing.spec.ts`) | drag-and-drop, MCP (T-11, T-20), delete, revision history/restore |
| SC-18 domains | — | — | Planned (T-15) |
| SC-19 / SC-20 members | `/seller/members` (roles, remove with confirm, invitations with revoke) | last owner protected, staff read-only (`e2e/ui.spec.ts`, `e2e/accounts.spec.ts`) | member detail page (SC-20 retired) |
| SC-21 channels | `/seller/channels` (token shown once, revoke with confirm) | `e2e/channels.spec.ts` | token replacement flow |
| SC-22 shipping origin | `/seller/shipping` (area search, pickup address; staff view-only) | `e2e/shipping.spec.ts` | — |
| SC-23 marketing | `/seller/marketing` (Meta/TikTok/Google destinations, write-only tokens, health; "Feed katalog": create / regenerate / revoke token, URLs shown once) | staff read-only (`e2e/signals.spec.ts`, `e2e/feeds.spec.ts`) | shell patterns of T-28 |
| SC-24 buyer data | `/seller/privacy` (search by phone/e-mail, JSON download, redaction with checkbox selection, override + reason for open orders, confirm dialog) | open order refused without override, staff read-only (`e2e/privacy.spec.ts`) | shipment data in export/redaction |
| SF-01..SF-06 storefront | `/s/[store]` or `<slug>.<root>/`, `/collections/[slug]`, `/search`, `/products/[slug]`, `/pages/[slug]`, `/cart` | both themes at 320px, unknown/suspended store 404, two carts coexist (`e2e/content.spec.ts`, `e2e/purchase.spec.ts`) | collection filters/sorting, stale-price review in cart |
| SF-07 / SF-08 checkout | `/checkout?store=` (area search → courier options → recipient, optional e-mail, payment → submit; works without JS), `/checkout/confirmation` | tampered total ignored, no pickup area, no-COD area, rate limit message (`e2e/purchase.spec.ts`, `e2e/checkout2.spec.ts`) | changed-quote review step, payment provider states (AutoLaris fake) |
| SF-09 landing page | `/s/[store]/lp/[slug]` (no storefront shell; order section with variant + quantity only → hosted checkout) | identical in both store themes, unpublished/other store 404 (`e2e/landing.spec.ts`) | — |
| SF-10 invalid handoff | `/checkout/h/invalid` | replayed handoff (`e2e/channels.spec.ts`) | — |
| SF-11 buyer order status | `/o/[token]` (status, lines, totals, courier, tracking number; "Perjalanan paket" timeline after a Mengantar booking; no address or phone) | tampered link 404 (`e2e/notify.spec.ts`), timeline (`e2e/fulfillment.spec.ts`) | — |

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

## UX-9 — Owner console Log System

- Owner: Bukalaris product owner
- Source: PR-11; signal and access contract: OBS-5.
- Entry: Visible Log System button on the Owner console overview plus a persistent
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
- Source: PR-12, PR-24, DATA-5, DATA-8.
- Contract: Product creation requires no manual ID/slug entry. After save, show
  the numeric product ID, copy action, editable slug, storefront URL preview,
  and the configured advertising identity/granularity. Numeric slug is the
  proposed default. Save errors preserve entered data; duplicate slug errors
  explain recovery. An explicit slug change reports the old-URL redirect.
  Never label a group ID as an individual variant catalog ID. In the product
  organization panel, display **"Kategori Google"** with a one-click
  deterministic Indonesian keyword suggestion (`"Disarankan: <path> — Terapkan"`)
  and a searchable Base-UI `Dialog` picker over `product_taxonomy` (separate
  from store collections and free-text labels).

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
| SA-02, SA-03 | Inspect tenant, approve/suspend/reactivate with reason (SA-01 is retired; the overview is SA-14 in UX-22) | Platform capability, invalid transition, stale edit, audit failure |
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
- Contract: Seller Admin shows the connected client, active store, granted content
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

Decision (2026-10-27): production hosts are Owner console (formerly Super Admin)
`owner.bukalaris.com`, Seller Admin `app.bukalaris.com`, Affiliate portal
`affiliate.bukalaris.com`, Buyer account portal `buyer.bukalaris.com`, and the
public Update Log `logs.bukalaris.com`.
The interim operator labels `berkah` and `bos` were never deployed and are retired; no alias is proposed. Keep platform,
active-store, affiliate and verified-buyer contexts distinct. Links between
surfaces and checkout identity association do not grant a shared role/session.
Use Bahasa Indonesia for interface copy, including "Buka toko langsung laris"
on public brand presentation. The earlier Astro recommendation is superseded by
ADR-0008/TD-7: one Next.js application with surface route groups and host rewrites.
This structure does not collapse role/session boundaries or change journey states.

### Log System button and navigation detail

Scope: UX-9, SA-01, SA-05 and SA-06. Status: Implemented subset on `main`
(T-23, 2026-10-07): persistent "Log System" nav entry in the Owner console shell
(`apps/web/src/app/admin/layout.tsx`), `/admin/logs` with level/module/request
id/store/time filters (default last hour, max 24 h), cursor paging, detail at
`/admin/logs/[id]` with related events and page/module mapping, denied access
for sellers and operators without `logs.read`. Not implemented: environment
filter and Page ID filter in the UI, partial/stale source states, copy
feedback for assistive technology (not verified), source links.

- On `owner.bukalaris.com/admin`, show the text-labelled **Log System** navigation
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

## UX-14 — Seller finance, ledger balance, and payouts

- Status: Proposed
- Owner: Bukalaris product owner
- Source: PR-23, BILL-4, BILL-5, DATA-7, ADR-0006.
- Contract: Seller Admin `/seller/finance` (`SC-25`) shows **one unified Bukalaris balance** (there is no System A / System B split because Bukalaris manages 100% of payments and shipping): `Saldo Tersedia` (available balance) and `Dana dalam Proses` (pending balance). `Dana dalam Proses` means "delivered but not yet reconciled" (D-14): an order appears there after delivery and moves to `Saldo Tersedia` when the Owner console reconciles it (for COD, via an approved SA-53 reconciliation batch); an order in transit, returned or cancelled shows in neither balance. The screen also shows one append-only
  ledger statement (`sale`, `cashback`, `shipping_debit`, `shipping_debit_reversal`,
  `return_reversal`, `payout`, `payout_reversal`, `adjustment`), bank account settings, and the
  store-owner-only payout request action. A manual `adjustment` row is created only by Owner
  console staff under `ledger.adjust` with four-eyes approval and is shown with its reason. Owner console `/admin/payouts` (`SA-08`)
  displays platform-wide merchant float as a liability alongside the payout
  approval/rejection queue and the buyer non-COD refund queue. Merchant and
  buyer screens show `Bukalaris Kirim` and `Bukalaris Bayar` rather than raw
  provider brands.
- Acceptance: Payout requests below `min_payout_idr`, above available balance,
  or from non-owner staff are denied with an explicit reason; Owner console
  rejection requires a reason and restores the exact debited balance; narrow
  320px and desktop viewports render ledger and payout tables without overflow.
- Decision (D-14, 2026-10-27; replaces the earlier negative-balance question OPEN-F1): no negative available balance exists, because nothing is credited before the parcel is delivered and reconciled; returns after delivery are outside the ledger scope in M3, so the screen has no negative state and no follow-up queue for it.
- Contract (unified system & affiliate eligibility): because all orders (prepaid and COD) run through Bukalaris-managed payments and shipping, every delivered and reconciled order on an opted-in product is eligible for affiliate commission (released to the affiliate wallet after `affiliate_hold_days = 3` days default, Owner-configurable). Reconciliation of delivered COD orders is shown to the seller only as the status "delivered, not yet reconciled" (`Dana dalam Proses`); the batch reconciliation screen SA-53 is Owner console only.
- Contract (documentation audit; D5 decided): each refund line shows its composition (which of goods, shipping, admin fee and COD fee were refunded, per BILL-5; the admin fee is refunded in full and the refund is disbursed by manual transfer to the destination the buyer supplies on the signed order-status page, verified by an operator, decided in D-20 which closes OPEN-F4). Payout bank destinations enforce the decided D5 controls (IAM-9): changing a bank destination or requesting a payout requires fresh step-up proof, notifies the previous contact, places a **72-hour hold** (default 72 hours, Owner-configurable) on the new or changed `payout_destination` showing a `"tujuan baru ditahan"` state with the hold end time, and checks that the bank account holder name matches the seller's registered name before payout. Owner console `/admin/money` (`SA-26`) reads the `platform_money_position` view by liability class and is not a second ledger.

## UX-15 — Abandoned checkout queue and 1-click WhatsApp recovery

- Status: Proposed
- Owner: Bukalaris product owner
- Source: PR-25, DATA-8.
- Contract: Seller Admin `/seller/customers/carts` (`SC-26`) shows a 30-day
  summary of **Abandon Rate** (`abandoned / (abandoned + orders)`) and honest
  **Recovery Rate** (`rescued / (rescued + abandoned)` where `rescued` requires
  `abandoned_at IS NOT NULL AND recovered_at IS NOT NULL`), followed by a
  prioritized queue of abandoned checkouts ranked by phone presence and
  time-decayed basket value (`subtotal / (1 + minutes_ago / 1440)`). Clicking
  the recovery button opens `wa.me` with a prefilled Bahasa Indonesia message
  containing a signed 7-day checkout resume link and stamps `"WA dibuka"` (never
  `"terkirim"`).
- Acceptance: Active in-progress checkouts are excluded from abandonment counts;
  ordinary straight-through checkouts never inflate Recovery Rate; recovery
  links never expose raw session IDs or another store's cart.

## UX-16 — Store promotions hub, vouchers, and flash sales

- Status: Proposed
- Owner: Bukalaris product owner
- Source: PR-26, DATA-8.
- Contract: Seller Admin `/seller/promotions` (`SC-27`) manages discount
  vouchers (`all`, `collection`, `product`; `percent`, `fixed`, `free_shipping`),
  store-level automatic free-shipping threshold, time-boxed `flash_sale` windows
  with per-item `sale_price_idr` and optional `stock_cap`, and the `/promo` hub
  banner/collections configuration. Storefront `/s/[store]/promo` (`SF-12`)
  renders the active promo banner, live flash-sale countdown and stock bar,
  copyable store vouchers, and discounted products; `/checkout` (`SF-07`)
  provides a voucher code input that displays applied `goods_discount` and
  `shipping_discount` lines separately.
- Acceptance: Expired, out-of-quota, or below-minimum vouchers show clear Bahasa
  Indonesia validation feedback at checkout without mutating the cart; flash-sale
  pricing reverts immediately after `ends_at` without touching base variant prices.

## UX-17 — Owner console shipping/billing setup and seller account connect

- Status: Proposed (2026-10-27)
- Owner: Bukalaris product owner
- Source: PR-27, PR-18, BILL-6, BILL-7, DATA-9, DATA-10, ADR-0007.
- Proposed ARCH-5 IDs: SA-07 and SC-22 own shipping setup and Partner-provisioned seller account status; SA-09
  `/admin/billing` owns billing settings/invoice queue and SA-10
  `/admin/billing/invoices/[id]` owns invoice detail. New IDs are Proposed only.
- Contract: Owner console shipping setup (`/admin/shipping`, SA-07) controls 100% of shipping management in one unified Bukalaris system: Partner API credential health (presence/last sanitized result, never secret values), automatic provisioning and sync status of Bukalaris-generated Partner Mengantar seller accounts (`POST /api/partner/v1/sellers`) with platform master account fallback, platform shipping margin, shipping discounts, and shipping cashback split rules (`shipping.manage`, four-eyes `shipping.margin`). There is **no `own_key` mode, no seller-pasted external API key, and no hybrid/seller-managed mode**: even if a seller previously had an external Mengantar account, their store uses the new Bukalaris-generated Partner account so all shipping management, discounts and cashback remain in Bukalaris's hands. Billing setup (SA-09) shows
  the all-feature monthly DPP, global PPN toggle and configured policy/rate,
  trial/grace days, invoice queue and explicit comp/mark-paid distinctions.
  High-impact changes require Save, target scope, confirmation and audit.
- Contract: Seller Admin shipping screen (`/seller/shipping`, SC-22) only sets the store's pickup origin/address and views the Bukalaris-provisioned Partner account status (provisioning pending, active, master-fallback active, or action needed if Mengantar requires a one-time Partner terms consent / takeover confirmation on the verified seller email). Stored consent evidence (`shipping_account_consent`) precedes the Partner API provisioning call when required. There is no key-paste input or mode selector.
- Acceptance: Staff and foreign-store direct requests cannot alter pickup settings or trigger provisioning; sellers cannot paste external keys or bypass the Bukalaris-managed account.
  Provisioning failure preserves non-secret input/consent evidence without generating duplicate remote accounts and falls back safely according to platform policy.
  A failed configuration Save in SA-07 or SA-09 leaves prior settings effective. Toggle PPN and create a new invoice: only that new
  invoice changes; operator manual mark-paid visibly grants no entitlement.
- Constraints: TEN-1, TEN-3, IAM-5, BILL-6, BILL-7, ADR-0007. White-label `Bukalaris Kirim` applies across seller, checkout, tracking and order surfaces, except the one-time Partner terms consent / takeover notice if required by Mengantar.
- Acceptance: Cover 320px and desktop, keyboard submit/return focus, loading,
  first-use provisioning, no filtered matches, denied, stale-save conflict and
  dependency-error recovery. Provider keys/secrets never appear in rendered HTML,
  returned DTOs, logs or validation messages.

## UX-18 — Seller subscription status, payment, invoices and read-only mode

- Status: Proposed (2026-10-27)
- Owner: Bukalaris product owner
- Source: PR-18, BILL-7, DATA-10.
- Proposed ARCH-5 IDs: SC-28 `/seller/billing` owns status, Pay and invoice list;
  SC-29 `/seller/billing/invoices/[id]` owns invoice detail; SA-09/SA-10 own
  platform billing operations. Existing seller pages/SF-07 receive access-policy
  changes, not duplicate route IDs.
- Contract: Seller Admin shows the active store's `trial`, `active`, `past_due`
  or billing `suspended` banner, trial/paid/grace end instants, all-feature plan
  at Rp175.000/store/month DPP, PPN and total, and a Pay action. Subscription
  detail lists invoices by period with kind (`subscription`/`comp`), amount,
  pending/paid/void status, receipt/detail and truthful payment-source labels.
  Pending VA/QRIS instructions are reused; payment return shows awaiting
  reconciliation, never "paid" solely because the browser returned.
- Contract: billing periods follow the BILL-7 billing period formula: the anchor is the date the trial ends and each period is one calendar month from it. Example: a store created on 26 Oct 2026 with the 3-day trial has its trial end on 29 Oct and its first period is 29 Oct to 29 Nov 2026; the screen shows period dates and the next renewal from the stored `period_start` and `period_end`, never recomputed in the browser.
- Contract: From `past_due`, catalog/order/settings edits become read-only with
  an explanation and billing link; invoice viewing and authorized payment stay
  available. Existing data and storefront remain intact. Show operator
  suspension as an independent restriction: payment does not promise to clear
  it. Comp coverage is visibly a Rp0 grant, not paid revenue; manual bookkeeping
  "paid" labels do not claim a new entitlement.
- Acceptance: At trial expiry, paid-period expiry and grace expiry fixtures,
  banner/deadlines match server status; direct write requests are denied while
  payment remains possible. Double Pay and concurrent cron/operator-create
  return the same invoice and one live instruction. A recovered dependency error
  resumes that invoice rather than clones it. Accepted payment restores writes
  for an unpaid-only restriction and never clears operator suspension; lifting
  operator suspension with debt leaves Seller Admin read-only. Checkout works
  through billing-only past-due/suspension and refuses only the independent
  operator suspension (other existing checkout guards remain unchanged).
- Acceptance: Store A cannot list/open/pay B invoices by ID; wrong-role controls
  are backed by server denial. At 320px/desktop and keyboard-only, invoice
  amounts/statuses/actions remain readable without page overflow; list/detail
  Back retains filters, empty history differs from no filter matches, pending
  status is announced, and retry preserves context. No product/order/content
  deletion occurs on restriction/downgrade.
- Constraints: BILL-7, DATA-10, IAM-5, TEN-1, TEN-3. Reminder-sent feedback needs
  a real mailer delivery result; dev outbox/audit markers never mean "sent".

## UX-19 — Separate affiliate portal, outcomes, wallet and payouts

- Status: Proposed (2026-10-27)
- Owner: Bukalaris product owner
- Source: PR-28, PR-31, DATA-11, BILL-8, BILL-9, IAM-3, PRIV-2, ADR-0009, ADR-0012.
- Proposed ARCH-5 IDs: AF-09 `/affiliate/login`; AF-11 `/affiliate/apply`
  (application page, rate-limited, RL-AFF-SIGNUP in 16); AF-01 overview; AF-02
  catalog and detail; AF-03 links; AF-04 wallet; AF-05 payouts and detail; AF-06
  profile/bank/tax. AF-07 storefront editor belongs to UX-20. All are planned
  rows, not implementation locators.
- Contract: A separate affiliate login/account surface leads to application/
  approval state, cross-store opted-in catalog, link/code creation, own links and
  aggregate outcomes, own storefront editor entry, wallet statement, bank details,
  optional tax identity (TX-P2) and payout history. Seller/buyer login or membership does not grant
  affiliate access. Pending/rejected/suspended accounts see the reason/recovery
  allowed by policy, not a live promotion action or confiscated earnings.
- Contract: Catalog cards identify seller, current projected public product data,
  effective rate and unavailable status; filters/list position persist after
  detail/Back. Generating/copying a link confirms a real server-issued reference,
  never a synthetic success. Wallet separates pending attribution from released
  ledger money; readiness is derived from `eligible_at` (**decided 3-day hold**,
  `affiliate_hold_days = 3` default, Owner-configurable, after the parcel is
  delivered and the seller sale is released; all prepaid and COD orders are
  eligible because all orders run in the unified Bukalaris system), not a fake available balance. Outcomes contain no buyer name, phone,
  email, address or order-detail link. Phone/bank masking comes from the data layer.
- Contract: Payout shows gross, withholding, net and destination snapshot before
  confirmation; withholding shows 0 and net equals gross while `withholding_enabled`
  is OFF (startup default, ADR-0012). Tax identity and tax policy are
  policy-controlled (T-65): by default no tax identity is required and the
  affiliate may only submit one voluntarily (TX-P2). Only when
  `tax_identity_required_for_payout` is ON and no applicable reviewed identity
  exists, or only when `withholding_enabled` is ON and no effective confirmed
  policy version exists, does the payout give an explicit blocked reason and
  correction path, not an assumed rate. Request pending → processing →
  paid/rejected is visible;
  uncertain transfer stays processing and cannot offer a blind resend.
- Contract: Security (IAM-9, IAM-13, ADR-0011 §5; decided D5 controls protecting the affiliate wallet, which Bukalaris holds, against an account takeover followed by a payout to a thief's bank account). Changing the bank destination
  or the verified contact, and requesting a payout, ask for fresh step-up proof (the
  second factor when enrolled, otherwise a one-time proof to the contact on
  file); the screen then shows that the previous contact was notified and, while a
  new or changed destination is held (**decided 72-hour hold**, default 72 hours, Owner-configurable), states
  the exact timestamp the payout can use it. A payout whose bank account-holder name does not match
  the payee is held for review with a stated reason (decided, D5). After a credential recovery or MFA reset the same 72-hour hold applies. MFA
  (TOTP) is offered at sign-up; requiring it before the first payout is OPEN
  (recommended, not decided: required). A suspended account sees the reason and
  recovery path; its storefront is unpublished and its links are deactivated
  (IAM-13).
- Acceptance: Two affiliates cannot open each other's private link management,
  storefront editor, bank/tax records, wallet or payouts via IDs. Seller roles
  cannot enter these records. Simultaneous payout requests cannot exceed the
  released wallet; duplicate request/rejection does not reserve/refund twice.
  Returns void unpaid amounts and flag paid portions without silently lowering
  an already-paid payout. Aggregate API/render/export contains no buyer PII.
- Acceptance: First-use no links/offers/earnings has the correct next action;
  filtered-zero offers provides Reset; error/stale offer data never says empty
  or earned. At 320px/desktop and keyboard-only, inline validation receives
  focus, bank/tax input is preserved only through approved secure handling, and
  payout confirmation returns to the existing detail on duplicate/retry.
- Constraints: BILL-8, BILL-9, DATA-11, DATA-15, IAM-3, PRIV-2, PRIV-10, ADR-0009,
  ADR-0012 (tax identity and withholding follow the T-65 policy flags, UX-23 TX-P1/TX-P2). The affiliate hold period is decided at 3 days (`affiliate_hold_days = 3` default, Owner-configurable) and all orders (prepaid and COD) are eligible under the unified Bukalaris system; attribution window and platform fee remain OPEN; no UI invents values.

## UX-20 — Affiliate discovery/storefront, seller participation and operator admin

- Status: Proposed (2026-10-27)
- Owner: Bukalaris product owner
- Source: PR-6, PR-28, PR-29, DATA-11, BILL-8, ADR-0009.
- Proposed ARCH-5 IDs: AF-07 `/affiliate/storefront` and preview; AF-08
  `/a/[handle]` public storefront; HTTP-27 `GET /r/[token]` referral link and
  click capture (apex host, SEC-20); SC-30 `/seller/affiliate` seller settings;
  SA-11 `/admin/affiliates` and account detail, SA-12 `/admin/affiliates/settings`,
  SA-13 `/admin/affiliates/payouts` and payout detail. SF-07 is the existing
  seller-bound checkout, not a new affiliate checkout route.
- Contract: Affiliate storefront editor owns a draft/published storefront and
  ordered catalog references, not copied seller products. Add/remove/reorder and
  private preview precede explicit Publish. Public pages may list many sellers;
  every purchase action names its destination seller and hands off with validated
  attribution to that seller's storefront/checkout. Existing seller cart remains
  that store's cart; another seller starts a separate purchase, never a mixed
  cart, shared payment or implied split settlement.
- Contract: Seller affiliate settings are closed by default. Owner-authorized
  settings show store-default rate, per-product opt-in/override, Owner console
  bounds and individual affiliate blocks. Save validates basis points/ranges and
  updates the outbox projection; withdrawing an offer does not erase historical
  commissions. No per-affiliate seller approval is required for an open offer.
  Show commission deductions separately from shipping charges and state that all
  delivered and reconciled orders (prepaid and COD) earn commission under the
  unified Bukalaris system, released to the affiliate after the 3-day hold
  (`affiliate_hold_days = 3` default, Owner-configurable).
- Contract: Owner console affiliate admin has account application/review with
  reasoned approve/reject/suspend/reactivate, aggregate programme outcomes,
  rate bounds, `affiliate_hold_days` (default 3 days, four-eyes `affiliate.rate_bounds`) and explicit OPEN policy fields, payout review with bank/tax
  masking by capability, tax-policy version confirmation (only when withholding
  is enabled, Phase 2, ADR-0012) and paid-return review.
  Payout decisions show immutable gross/tax/net/identity/bank snapshots; operational
  status cannot forge gateway settlement or trigger an automatic paid claw-back.
- Contract: Suspending an affiliate (`affiliate.accounts.review`, reason
  required) unpublishes the public storefront (the AF-08 page returns not-found),
  deactivates the affiliate's links and codes (a deactivated link redirects the
  buyer without capturing a click; a deactivated code resolves as unknown and
  checkout continues), and stops new attribution; earned and paid money is
  untouched. Reactivation restores the last published storefront revision and the
  links that were active at suspension. Phase 1 has no per-item moderation write
  path in the console; per-item takedown is Phase 2 (`moderation.manage`).
- Acceptance: An affiliate curates offers from two sellers, publishes, and opens
  each seller's checkout: each order has one store and at most one attribution,
  with no affiliate portal/admin cookie exposed to the buyer. A valid explicit
  code overrides last eligible click; invalid/expired input and normalized-phone
  self-referral never fail checkout. Guest checkout stays available. Price/stock
  is revalidated by seller checkout, not catalog projection.
- Acceptance: Withdrawn/blocked/unpublished products cannot earn new commission
  through stale cards or edited requests; re-ordered stale outbox events cannot
  republish a withdrawal. Failed publication preserves the prior live revision.
  A seller cannot edit another store's rates/blocks; an affiliate cannot edit
  seller products/policies or another affiliate storefront; a reviewer without
  capability cannot approve account/payout/tax-policy changes by direct request.
- Acceptance: Narrow 320px/desktop and keyboard fixtures cover published,
  draft/unpublished/not-found, no available offers, denied, stale price/offer,
  dependency failure, invalid rate and payout-review conflict. Preserve editor
  drafts/list filters on recoverable failure and explicitly return focus after
  confirmations. No interface promises an unverified cashback or tax treatment.
- Constraints: TD-5, BILL-3, BILL-8, DATA-11, IAM-3, PRIV-2, ADR-0009. Use the
  proposed host routing in ADR-0008, not a deployment claim. `source=bukalaris`
  only; T-56 external connectors and multi-seller checkout remain deferred.

## UX-21 — Global buyer portal and registration-free checkout identity

- Status: Proposed (2026-10-27)
- Owner: Bukalaris product owner
- Source: PR-7, DATA-4, DATA-12, UX-6, [ADR-0010](ADR-0010-global-buyer-identity.md).
- Proposed ARCH-5 IDs: BA-04 `/buyer/login`; BA-05 `/buyer` overview; BA-01
  `/buyer/orders` and `/buyer/orders/[id]` tracking/detail; BA-02
  `/buyer/addresses`; BA-03 `/buyer/profile`; BA-06 `/buyer/privacy` (rights,
  export and deletion-request entry; global deletion policy stays OPEN). The
  post-commit `buyer.resolve` outbox is JOB-10. Existing SF-07 checkout and
  SF-11 single-order status keep their existing IDs and narrower access contracts.
- Contract: Checkout collects the transaction's phone/WA and optional email
  without registration or a mandatory sign-in detour. The server resolves or
  creates the platform buyer by canonical phone first, then email. A phone/email
  account conflict chooses the phone account without an automatic merge, and an
  email match to a buyer that already has a different phone creates a new buyer
  (one live phone per buyer, ADR-0010 §4). This
  resolution returns no matched profile, address, history or account-existence
  signal to the anonymous checkout. Keep entered recipient/contact fields as the
  store's order snapshot; association does not authenticate the browser.
  Identity synchronization runs automatically after the order commits through
  `buyer.resolve`; operational lag never inserts signup/OTP into checkout.
- Contract: The separate `buyer.bukalaris.com` portal offers passwordless
  proof-of-possession sign-in, not a registration form. Enter a phone/WA number
  or email, receive generic challenge feedback, then complete the selected
  approved proof and authorized account-binding checks. A checkout-observed
  secondary alias is not a login method merely because its OTP/magic link was
  completed; a phone-keyed account needs primary-phone or accepted recovery
  proof to bind it. Pending delivery, invalid/expired proof, resend-limit and
  provider-unavailable states retain the safe identifier context but never echo
  secret proof tokens or imply a challenge was sent when it was not.
- Contract: Only a verified buyer session with authorized binding enters
  confirmed own-account history; unverified/restricted links remain unavailable.
  Each order card/detail names its seller, payment/fulfillment outcome and
  tracking source; filters and detail/Back retain state. History aggregates
  permitted orders, not seller-wide customers or another buyer's purchases.
  Signed one-order status links stay separately scoped and
  do not unlock the global portal.
- Contract: Profile and address book edit the buyer's own platform records, not
  historical store-owned order recipient/address snapshots. Identifier changes
  require proof of possession and conflict handling; typing another identity
  never links accounts or transfers orders. Address saving/use requires an
  explicit buyer action; checkout prefill from existing data remains unavailable
  until a verified-prefill policy is accepted. Refund status comes from BILL-5's
  existing order refund flow, not a buyer wallet, credit or instant refund action.
- Acceptance: Submit orders to two seller stores using equivalent canonical
  phone formats: backend association selects one buyer; unauthenticated responses
  expose only submitted transaction data, not historical PII. Supply a phone for
  A and email for B: A wins, B is not merged, and no B profile/history appears.
  Unverified identifier submission cannot open portal orders/profile/address
  endpoints, even with a guessed buyer/order/address ID.
  Submit an order with a new phone and the email of a buyer who already has a
  different phone: a new buyer is created, the existing buyer's phone is not
  changed, and neither response shows the other account (ADR-0010 §4).
- Acceptance: Successful proof plus trusted binding exposes only confirmed own
  order links across sellers. A victim-phone + attacker-email checkout followed
  by attacker-email proof cannot reveal the victim profile/history; a recycled
  number OTP cannot bypass a restricted historical link. A different buyer session
  cannot read/list/change these records. Seller A
  cannot use the portal/read model to inspect seller B's orders or global buyer
  profile. Affiliate sessions cannot read buyer profiles, identifiers, addresses
  or order details; cross-surface admin/seller/affiliate sessions do not
  substitute for buyer proof. Editing profile/address never changes old orders.
- Acceptance: Cover 320px/desktop and keyboard-only sign-in → order list →
  detail/tracking → Back → profile/address edit → sign-out. Include first-use
  no orders, filtered-zero, failed challenge delivery, wrong/expired/replayed
  proof, expired session, absent tracking, dependency error and stale-profile
  conflict. Preserve non-secret recoverable input, associate errors with controls,
  return focus after dialogs, and never render private data during loading or
  after sign-out/session loss.
- Constraints: DATA-12, IAM-4, PRIV-2, TEN-1, BILL-5, ADR-0010. OPEN: OTP
  channel/provider and recovery policy, verified prefill, manual merge UX,
  recycled-number/shared-contact treatment and global deletion/retention.
  Do not ship these unresolved paths by inventing an OTP provider, auto-merge,
  historical ownership proof or global deletion cascade. Prerequisites: magic
  links wait for the `mail_outbox` fix (T-73, 12-SECURITY SEC-24); request and
  verify limits and delivery caps follow RL-OTP-REQ and RL-OTP-VERIFY in 16.

## UX-22 — Owner console navigation and screen contracts

- Status: Proposed (owner decisions 2026-10-27; startup-phase direction change applies)
- Owner: Bukalaris product owner
- Source: PR-30, PR-1, PR-11, PR-15; IAM-15; PRIV-9; ADR-0011; UX-1, UX-9, UX-14, UX-17, UX-20; Tokophi Super Admin research (read-only reference).
- Proposed ARCH-5 IDs: SA-14 through SA-39 for the screens below, extending the registered SA-02 through SA-13; SA-50 (issue reports queue), SA-51 and SA-52 (Update Log authoring), UL-01 and UL-02 (public Update Log pages at `logs.bukalaris.com`), HTTP-23 to HTTP-25, JOB-13 and JOB-19; tax screens are SA-40 through SA-49 under UX-23. The Owner console (formerly Super Admin / Bos) is the platform operator surface at `owner.bukalaris.com`, internal prefix `/admin`; the store-level role "owner" is a different thing (ADR-0011 §1).
- Statement: One capability-gated navigation serves every platform job: store,
  affiliate and account management, money, tax entry, platform settings,
  operations and staff access. Bukalaris is an online-store platform, so
  marketplace-style compliance screens exist as a **Phase 2** Compliance center
  that is absent from the menu until activated (ADR-0011 §3). Every item is marked
  **P1** (startup core: T-62/T-63/T-68 or the owning task), **P1.5** (optional Update Log, T-69) or **P2** (later).
- Acceptance: see "Acceptance by group" below; each group is testable with
  Vitest authorization-negative cases and Playwright navigation and denial cases.
- Constraints: IAM-15, PRIV-9, SEC-11, NFR-3 (320px), ADR-0008, ARCH-5. Interface
  copy is Bahasa Indonesia; English labels below are documentation only.

### Shell and navigation behavior

- **Shape.** Header with the brand "Bukalaris · Owner", the signed-in staff email, a visible context chip "Owner console", sign-out and a global search entry (accounts and stores, masked). Ten groups form the primary strip; the active group shows its items as a second row (desktop) or a labelled menu (narrow screens, no horizontal clipping at 320px). The existing flat three-item strip (Toko, Ongkir, Log System) is replaced; its three destinations remain.
- **Capability gating.** A group appears if the viewer holds any child capability; an item appears only when its capability is held. P2 items are absent and their routes return not-found until activated (an audited setting records who, when and why). The same check runs server-side on every page, action and handler, as the first statement before any data read; a dashboard card never shows data its destination page would refuse.
- **Fail closed.** An unclassified route is denied. A test derives the page list from the `admin` directory and fails when a page lacks a declared capability and an ARCH-5 id.
- **Badges.** Counts on items (pending approvals, open cases, payout queue) show only for items the viewer may open, are server-derived, and show "—" with a tooltip when the source is unavailable, never 0.
- **States for every screen.** Loading (no invented rows), first-use empty, no filter matches, denied, session expired (returns to sign-in, clears protected rows), stale-write conflict (reload prompt keeps the draft), dependency error with retry, partial or stale data with last-observed time or "Freshness unavailable" (UX-9 pattern). A failing source is never labelled empty or healthy.
- **Mutations.** A mutating action shows the target, the effect and a required reason (reason code plus bounded text, no personal data), confirms, runs one server action, and reports the **outcome that was written**, not the request (for example "recovery link queued", not "user recovered"). Four-eyes actions show "Waiting for a second approver" and never a success state until executed.
- **Accessibility.** Skip link, `aria-current` on the active item, focus returned after dialogs, errors associated with controls, copy feedback announced.
- **Shell actions on every page.** Two persistent header actions, both text-labelled and keyboard reachable in the header before the account menu: **"Lapor masalah"** (visible to every staff member holding `ops.issues.report`; contract in "Issue reporting" below) and **"Apa yang baru"** (what's new indicator, Phase 1.5, absent until T-69 delivers it). On narrow screens they sit in the second header row and keep their text labels. Neither is rendered on seller, affiliate, buyer or storefront surfaces in Phase 1.

### Navigation tree

| Group (Bahasa) | Item | Route (internal) | ARCH-5 | Gating capability | Phase | Empty / error states beyond the shared set |
|---|---|---|---|---|---|---|
| Ringkasan | Dashboard | `/admin` | SA-14 | `dashboard.read` (cards gated individually) | P1 | Cards with no data show "No data yet"; unavailable card shows its own error, not the page |
| | Persetujuan (approvals) | `/admin/approvals` | SA-28 | any ◆ capability | P1 | Nothing pending; own requests visible but not approvable; expired requests listed |
| | Kasus (cases) | `/admin/cases`, `/admin/cases/[id]` | SA-20 | `cases.read` | P1 | No cases; overdue highlight; subject no longer exists |
| Toko | Daftar toko | `/admin/stores` (SA-02 moves here when SA-14 takes `/admin`) | SA-02 | `tenants.read` | P1 | No stores; no filter matches |
| | Tambah toko | `/admin/stores/new` | SA-03 | `tenants.manage` | P1 | Owner email already exists; invalid slug or reserved label |
| | Detail toko | `/admin/stores/[id]` | SA-03 | `tenants.read` | P1 | Unknown id returns not-found without existence hints |
| | Verifikasi toko (optional record) | `/admin/stores/[id]/verification` | SA-16 | `tenants.verify` | P1 | No record yet; superseded versions listed |
| | Buku besar toko | `/admin/stores/[id]/ledger` | SA-17 | `finance.read` | P1 | No entries; paged, append-only view |
| | Risiko toko | `/admin/risk` | SA-18 | `tenants.read` | P1 | No flags; acknowledged flags hidden by default with count |
| | Antrean verifikasi | `/admin/verification` | SA-15 | `tenants.verify` | P2 | Queue empty; overdue |
| | Domain | `/admin/domains` | SA-19 | `tenants.manage` | P2 (T-64 owns the screen; domain data from T-15, SC-18) | No domains; provider pending |
| Afiliasi | Pendaftar dan akun (applications and accounts; default tab pending) | `/admin/affiliates`, `/admin/affiliates/[id]` | SA-11 | `affiliate.accounts.read` | P1 (delivered by T-54) | No applications; decided-by-someone-else conflict |
| | Pengaturan afiliasi (rate bounds, policy) | `/admin/affiliates/settings` | SA-12 | `affiliate.policy.manage` | P1 (T-54) | OPEN fields shown as OPEN, never prefilled |
| | Pencairan afiliasi | `/admin/affiliates/payouts`, `…/[id]` | SA-13 | `affiliate.payout.process` | P1 (T-54) | Empty queue; processing-state conflict |
| | Sengketa dan fraud | `/admin/affiliates/disputes`, `…/[id]` | SA-21 | `affiliate.disputes.manage` | P2 | No disputes |
| | Penawaran (read-only directory) | `/admin/affiliates/offers` | SA-22 | `affiliate.accounts.read` | P2 | No offers |
| Akun pengguna | Cari akun | `/admin/accounts` | SA-23 | `accounts.read` | P1 | Query too short; no matches; rate limited |
| | Detail akun | `/admin/accounts/[kind]/[id]` (`seller`, `affiliate`, `buyer`) | SA-24 | `accounts.read` | P1 | Closed or restricted account; unknown id is not-found |
| | Permintaan identifier dan merge | `/admin/accounts/merge-requests`, `…/[id]` | SA-25 | `accounts.identifiers.review` | P1 | None pending; request needs proof of both identifiers |
| Keuangan | Ringkasan keuangan (float) | `/admin/money` | SA-26 | `finance.read` | P1 (T-37) | Ledger not yet live; freshness of provider balance |
| | Pencairan seller dan refund pembeli | `/admin/payouts` | SA-08 | `payouts.process` / `refunds.process` | P1 (T-37) | Empty queues; concurrent decision conflict |
| | Invoice langganan | `/admin/billing`, `/admin/billing/invoices/[id]` | SA-09, SA-10 | `billing.read` / `billing.manage` | P1 (T-50) | No invoices; comp versus bookkeeping labelled |
| | Ongkir, diskon & cashback Mengantar | `/admin/shipping` | SA-07 | `shipping.manage` (margin/discount/cashback rules ◆) | P1 | Credential health absent vs invalid vs disabled are distinct; Partner-provisioned seller account sync status |
| | Rekonsiliasi pembayaran | `/admin/money/reconciliation` | SA-27 | `finance.read` | P1 (T-37, T-49) | No breaks; breaks never auto-resolved |
| | Rekonsiliasi COD (queue of delivered COD awaiting release; batch detail and approval) | `/admin/money/cod-reconciliation`, `/admin/money/cod-reconciliation/[batchId]` | SA-53 (queue and batch detail) | `payouts.reconcile` (batch approval ◆) | P1 (T-37) | No delivered COD awaiting reconciliation; carrier invoice not yet imported; batch changed since approval request |
| Pajak | Pusat pajak (entry; screens under UX-23) | `/admin/tax` and children | SA-40 to SA-49 | `tax.read` (children per UX-23) | startup subset per UX-23, rest P2 | Group hidden unless a `tax.*` capability is held; dormant children not routable |
| Konten dan kepatuhan | Takedown dan laporan konten | `/admin/moderation`, `…/[id]` | SA-29 | `moderation.manage` | P2 | Queue empty; overdue |
| | Keluhan | `/admin/complaints`, `…/[id]` | SA-30 | `complaints.manage` | P2 | Empty; overdue |
| | Permintaan data pribadi | `/admin/compliance/privacy`, `…/[id]` | SA-31 | `privacy.requests.manage` | P2 | Empty; verification pending |
| | Insiden | `/admin/compliance/incidents`, `…/[id]` | SA-32 | `incidents.manage` | P2 | No incidents; clock overdue |
| | Registrasi dan retensi | `/admin/compliance/registrations` | SA-33 | `compliance.read` | P2 | Unknown values shown as "Not supplied" |
| | Review marketplace (existing later scope, PR-6) | `/admin/marketplace` | SA-04 | capability per IAM-3 (not yet named) | P2 | Not a startup item |
| Platform | Pengaturan platform | `/admin/settings` | SA-34 | `settings.manage` | P1 | Save conflict keeps prior value |
| | Provider dan kesehatan kredensial | `/admin/settings/providers` | SA-35 | `providers.read` | P1 | Never shows a secret; "present / last result / unknown" |
| | Update Log (pengumuman platform; authoring) | `/admin/updates`, `/admin/updates/new`, `/admin/updates/[id]` | SA-51, SA-52 | `updates.write` (drafts) / `updates.publish` (schedule, publish, unpublish) | P1.5 optional (T-69) | No entries; scheduled entry in the past awaiting the scheduler; stale-edit conflict keeps the draft |
| Operasional | Log System | `/admin/logs`, `/admin/logs/[id]` | SA-05, SA-06 | `logs.read` | P1 (implemented) | Per UX-9 |
| | Kesehatan sistem | `/admin/ops` | SA-36 | `ops.read` | P1 | Source unavailable vs healthy |
| | Laporan masalah (issue reports queue and function health) | `/admin/issues`, `/admin/issues/[id]` | SA-50 | `ops.issues.manage` (the Lapor masalah control itself needs `ops.issues.report`) | P1 (control in T-62, queue in T-68) | No reports; no filter matches; unmapped page ids grouped as "unmapped" |
| | Audit | `/admin/audit`, `…/[id]` | SA-37 | `audit.read` | P1 (export P2) | No rows; the read itself is audited |
| Staf dan akses | Staf dan izin | `/admin/staff`, `…/[id]` | SA-38 | `staff.read` / `staff.manage` | P1 | Last grant-holder protection |
| | Review akses | `/admin/staff/access-reviews` | SA-39 | `access.review` | P1 | No review due |

### Screen contracts (P1)

- **Dashboard (SA-14).** Honest KPIs, each derived from its authoritative source with an as-of time and gated by its own capability (cards the viewer may not see are not rendered, not blurred): store counts by lifecycle status where **slices sum to the total** (trial, active, past due, operator-suspended; operator suspension shown separately from billing state per PR-18); subscription revenue (invoiced and paid, DPP and PPN shown separately per BILL-7, comp excluded from revenue); pending approvals and open cases with age of the oldest; payout and refund queue size and oldest age; seller float split into available, pending release, COD in transit, buyer refunds owed and affiliate liabilities with the rule that float is a liability, not platform revenue (BILL-5); provider balance freshness; outbox backlog and failed-job count; top risk flags. No buyer or seller personal data appears on the dashboard. No tax KPI appears without a `tax.*` capability.
- **Store list and detail (SA-02, SA-03).** Status, subscription state (billing), operator suspension, Bukalaris-provisioned Partner shipping account status, verification record state (informational), plan, created date; masked owner contact. Detail sections: lifecycle (approve, suspend with reason, reactivate; lifting suspension never clears debt and paying never clears suspension), team summary (links to SA-24), billing state and comp (links SA-09), Partner shipping account status (read-only summary with link to SA-07), domains (later), risk flags, ledger link, cases for this store, notes. A suspended store keeps a non-purchasable storefront (PR-1).
- **Optional verification record (SA-16).** Versioned submission by staff on behalf of, or collected from, the seller: subject type, legal or personal name, contact, optional registration number, reviewer, decision (not started, in review, needs info, verified, rejected), reason, dates. It is informational in the startup phase: **no state of this record blocks store creation, approval, activation, billing or payout.** Document images are not collected unless a separate storage and retention policy is accepted (PRIV-6). Whether a verified record gates any action later is a recorded product decision (OPEN).
- **Risk queue (SA-18).** Flags derived at read time from authoritative state, each with source, rule and owner: past-due or grace expiry (from the subscription state, not the effective status), Partner shipping account provisioning failed or disabled, orders in `awaiting_balance` or `awaiting_account`, payout or refund older than the accepted age (numbers OPEN), repeated failed payments, and the **affiliate fraud flag**, whose Phase 1 source is a set of per-affiliate counters read at query time: self-referral suppressions, click refusals by rate limit, clicks-to-orders ratio and returned or voided commission ratio (thresholds OPEN; no browser fingerprint is collected, SEC-20). A flag links to the affiliate detail; the Phase 1 actions are suspension (`affiliate.accounts.review`) and a payout hold, dispute decisions are Phase 2. Operators may acknowledge a flag with a reason and expiry; acknowledgment never alters the source. Severity ordering is a fixed rule, not a free score.
- **Cases (SA-20).** A case has a subject (store, affiliate, account, order reference), category (support, verification, fraud or abuse, complaint, notice, privacy request, incident, other), status, assignee, due date, append-only notes (scrubbed of contact and URL shapes), attachments none in P1. Complaints, notices and privacy requests are plain cases with a due date until the Compliance center is active. A case reference is mandatory for any personal-data reveal (PRIV-9).
- **Accounts (SA-23, SA-24, SA-25).** Search accepts a canonical phone, an email or an internal id and returns masked hits with an account-kind badge; result counts and timing do not reveal whether an account exists to a staff member without `accounts.read`. **Buyer hits require an open case and a purpose code on the search itself**; without them the search returns seller and affiliate hits only and says that buyer results need a case and purpose, whether or not any buyer matches. An identity that has a `platform_operator` row never appears here (staff are managed in SA-38). Detail shows, per kind and masked: account status and history, roles and store memberships (seller), approval state and wallet reference counts without balances unless `affiliate.accounts.read` and `finance.read` (affiliate), restricted or closed state and the **total** count of linked orders without lines (buyer; the per-store breakdown is a reveal that needs a case and a purpose, PRIV-9), MFA enrolled yes or no, active session count, last sign-in time, open cases. Support actions: send recovery link to the contact on file (disabled until the mail fix, ADR-0011 §4), revoke all sessions, request MFA reset (four-eyes for store-owner and affiliate accounts), resend verification, suspend or restore, open case. Each requires a case and a reason; result text states what happened ("link queued to the contact on file; delivery not confirmed"). The operator never sees a link, password, OTP or token. A masked field has a "Reveal" control that asks for a purpose and case, shows the value once for the configured window and logs the access (PRIV-9). SA-25 reviews buyer identifier conflicts; **staff-executed buyer merge and store-ownership recovery are decided disabled in Phase 1** (D6: routes return not-found; locked-out sellers use self-service recovery, and buyers merge only via self-service proof of both identifiers, IAM-4, ADR-0010).
- **Approvals (SA-28).** Tabs: waiting for me, my requests, decided. Each item shows the action, target, a snapshot of the exact payload that will execute (hash shown), the requester, reason, age and expiry. Transfer approvals (seller payout, buyer refund, affiliate payout) also show the immutable bank snapshot (holder name, bank, destination) to the approver before the approve control is enabled; viewing it is logged (PRIV-9). Approve or reject needs a reason; the requester sees the approve control disabled with an explanation. Execution happens once, with the same capability gate re-checked at execution; a payload changed since request voids the approval.
- **Money (SA-26, SA-08, SA-27 with SA-09, SA-10, SA-07, SA-13, SA-53; SA-54 is retired because all payments and shipping run in one unified Bukalaris system).** Contracts for payout, refund, invoice, shipping and affiliate payout decisions stay in UX-14, UX-17 and UX-20; this entry owns the shared rules: decisions are compare-and-swap on the expected state (one writer); the second person approves **for transfer** (requested → processing) while seeing the bank snapshot, and mark-paid afterwards only records the transfer evidence (IAM-15 matrix); bookkeeping versus entitlement labels are explicit, bank values are masked by capability in the data layer, uncertain transfers stay "processing" until a confirmed outcome (never blind resend), and a manual ledger adjustment is ◆ with a case. All payout destinations enforce the decided D5 controls (step-up, old-contact notice, 72-hour hold on new/changed destination, holder-name check). The float view (SA-26) lists each liability class and its source. Shipping setup (SA-07) owns platform shipping margin, shipping discounts, cashback split rules (four-eyes `shipping.margin`) and Bukalaris-generated Partner seller account sync. Payment reconciliation (SA-27) shows unmatched provider events, late payments and COD remittance gaps; breaks are never auto-closed.
- **COD reconciliation (SA-53: queue and batch detail).** A COD sale becomes available to the seller only after it is delivered (the provider's DELIVERED status) and reconciled against the carrier's remittance. The queue lists delivered COD orders awaiting release; a **batch** page shows each line with the order reference, store, COD amount, the matching **carrier invoice line** (reference, amount, date) and the evidence reference, with differences highlighted (amount, missing line, duplicate). A staff member holding `payouts.reconcile` prepares and submits the batch with a reason; a **second** holder of the same capability approves it (four-eyes, `cod.reconcile_release`) after seeing the carrier invoice lines, and execution releases exactly the approved lines once (compare-and-swap on the batch hash). Unmatched, partial and disputed lines stay out of the batch and remain listed; nothing auto-releases. Manual completion of a COD order without DELIVERED status is a separate four-eyes action (`cod.manual_complete`) and never part of a batch.
- **Platform settings (SA-34, SA-35).** Reserved labels (read-only list with the reservation reason, `owner` (active), `berkah` and `bos` (retired) included; adding a label is audited), host and domain configuration as read-only status in P1 (changes are deploy-time), rate-limit values shown with the effective policy, provider accounts health: present or absent, last sanitized result time and outcome, enabled account kinds; **never a secret value**; credential rotation is ◆ and performed in the secret store, not typed into the console. Plan price, trial and grace settings live in SA-09 (UX-17). The **PPN switch** (`tax.manage`, SA-09 or the tax center settings; OFF by default) opens a confirmation dialog stating that new subscription invoices will add PPN, that issued invoices are untouched, and that legal and tax documents and PKP status are the Owner's responsibility; it requires a reason, needs an effective-dated rate policy value (no constant in code), has no hard PKP gate, is audited and is not four-eyes (IAM-15). There is **no feature-flag screen**: no concrete flag exists, and live-write gates (for example the Mengantar write switch) are environment-controlled and shown read-only.
- **Operations (SA-05, SA-06, SA-36, SA-37).** Log System per UX-9. Health shows outbox backlog and oldest age, failed and dead-job counts by type (with an audited requeue for replay-safe kinds under `ops.jobs.manage`; money kinds show no requeue, OBS-7), webhook receipt and signature-failure counts, provider balance freshness and last backup and restore-rehearsal times from DR-1 evidence (read-only; "unknown" when not reported). The audit viewer filters by actor, capability, target kind and id, case, outcome and time range (default last 24 hours, bounded range, cursor paging), shows masked values only, audits its own reads, and offers no delete or edit; export is P2 and ◆.
- **Staff and access (SA-38, SA-39).** Staff list with status, MFA enrolled, last sign-in and last-used grants; invite by verified email, assign preset or individual capabilities, deactivate (revokes grants, pending requests and sessions together); sensitive grants and break-glass go through approvals; a staff member's MFA is reset only here, through `staff.manage` with four-eyes (staff are never account-support targets); the first holders of `staff.manage` are created out of band and show as `system_bootstrap` or `system_recovery` events (IAM-15); the last holder of `staff.manage` cannot be removed; staff cannot change their own grants. Access review lists each grant with last use for the reviewer to confirm or revoke.
- **Issue reporting, "Lapor masalah" (control in every page header; queue SA-50).**
  - *Control and dialog.* The header action opens a modal dialog (focus moves into it, Escape and a Cancel button close it and return focus to the trigger, focus is trapped while open). Fields: (1) **What failed**, required radio group: button or function does not respond / wrong result / error message / page broken / other; (2) **Severity self-rating**, required radio group: low / medium / high / blocks my work; (3) **Description**, required, plain text, up to 2000 characters with a counter and the warning "Do not write personal data, passwords or tokens"; (4) **Affected control**, optional, picked either from a keyboard-operable list of the interactive controls currently on the page (accessible names) or by a pointer pick mode that highlights a control and records it, never an input value; there is **no screenshot or attachment field in Phase 1** (decided, see "Screenshots and attachments" below); nothing is captured automatically beyond the allowlisted context. A collapsible **"Technical data that will be sent"** shows exactly the captured context below and lets the reporter drop the recent client errors and request list.
  - *Outcome.* Submit runs one server action keyed by a client request id generated when the dialog opens (a double submit returns the same report). Success shows "Laporan #n terkirim" and returns focus to the trigger; validation errors stay attached to their fields; a rate-limit refusal or server error keeps the typed text and selections for retry; a failed context capture never blocks submit (the report is marked partial). The dialog works at 320px (full-width sheet, no horizontal overflow) and with keyboard only.
  - *Automatic context (allowlisted fields only, no secrets, no personal data).* Everything below is validated server-side against a versioned schema, unknown keys are dropped, text is scrubbed with the same rules as the Log System (`scrubText`: URLs with query parameters removed, e-mail, phone, NIK, NPWP and bank-account-number shapes, bearer tokens; PRIV-9 "Scrubbing classes"), and the whole context is capped (16 KiB proposed; oldest buffered entries are dropped first).

    | Field | Source | Trust and rule |
    |---|---|---|
    | ARCH-5 page id and route template | Server resolves the submitted pathname against the route registry (same mapping as the Log System `moduleForRoute`) | Not taken from the browser; concrete ids and query strings are stripped to the template; no match stores `unmapped`, never a guess |
    | Optional subject reference | Safe ids from route params (for example store id) | Ids only, never names or contacts |
    | Affected control id | Developer-assigned `data-control-id` on controls, mapped to an ARCH-5 id | Missing id stores the control's role and scrubbed accessible name (80 characters), never inner text of data cells, input values, `href` queries or `value` attributes |
    | Last requests (up to 20) | A small client buffer around fetches and server actions reads the `x-request-id` response header | Stores request id, route template, method, status, duration, outcome; no URLs, bodies or headers; the server resolves the ids against `system_log` and stores the matching event ids as links (client-supplied event ids are never trusted) |
    | Failed server actions (up to 10) | Same buffer | Action name and result code only, never arguments or results |
    | Recent client errors (up to 10) | `error` and `unhandledrejection` listeners and the error boundary digest | Error name, scrubbed message (500 characters), digest; no stack or source URLs |
    | Release revision | Server build identifier | Server-provided |
    | User agent and viewport | Browser | User agent capped at 200 characters, viewport width and height |
    | Timestamp | Server clock | Server-provided, never the browser time |
    | Acting operator id and capabilities | Session | Operator id and the capability names held at that moment; no e-mail |

    Never captured: cookies, storage, headers, DOM snapshots, form values, page text, URL query strings, network bodies. The reporter's description is scrubbed on the server (placeholders replace phone, e-mail, URL, NIK, NPWP and bank-number shapes) and flagged `scrubbed`.
  - *Safety.* A per-staff rate limit and request-size cap apply (values configured, defaults OPEN; proposed 10 reports per hour with a burst of 3 per minute; register row RL-ISSUE in 16-OBSERVABILITY) and refusals create no record; descriptions and context render only as text nodes (no HTML, no markdown) in the queue; CSV export neutralises cells starting with `=`, `+`, `-` or `@`. A new report notifies the engineers through the alert sink (OBS-6).
  - *Screenshots and attachments (decided 2026-10-27, owner delegated the decision).* **Phase 1 accepts no screenshot or attachment**: text, the element picker and the automatically captured allowlisted context only. Reason: a screenshot of a console page can contain revealed personal data (names, phones, bank numbers), which PR-30 says no issue report may store, and the Engineer preset (`ops.issues.manage`) holds no reveal capability; the element picker and context already locate the broken control. There is no file control, no attachment column or table (DATA-14) and no attachment handler in Phase 1. **Phase 2 option**, only when all of these exist: a PII warning in the dialog, a dedicated capability (`ops.issues.attachments`) separate from `ops.issues.manage`, opening only under the PRIV-9 purpose rules with an access event, hard byte and pixel caps checked before decoding, re-encoding to strip metadata, scrubbing or redaction review, an approved finite retention (PRIV-4), and an authenticated handler with `nosniff` and download disposition.
  - *Queue and detail (SA-50).* Filters: status, category, severity, ARCH-5 page id, assignee, date range, has linked log event, text search (parameterised, bounded); sort by newest or severity; counts per status. Detail shows the report, the labelled context key-values, the resolved page id with its ARCH-5 title and task, the control id, links to the Log System event (SA-06) and to the Log System list filtered by the first request id (SA-05, shown as links only when the viewer holds `logs.read`, otherwise as ids), related Update Log entries (T-69), possible duplicates by `dedupe_key`, and the event history. Status transitions are compare-and-swap on the expected status and each writes an event and an audit row: new → triaged, duplicate or wont_fix; triaged → in_progress, resolved, duplicate or wont_fix; in_progress → triaged, resolved or wont_fix; resolved, wont_fix and duplicate → triaged (reopen). resolved, wont_fix and duplicate require a resolution note; duplicate requires an existing non-duplicate target (no self or cycle). Assignment targets only staff holding `ops.issues.manage`. Opening the list or a detail and every export are audited.
  - *Export (HTTP-23).* CSV or JSON of the current filter for developers, capability `ops.issues.manage`, bounded row count (OPEN), no attachments, columns limited to the stored allowlisted fields, no-store, audited with the filter and row count.
  - *Function health.* SA-36 (Kesehatan sistem) lists, per ARCH-5 id, open reports (by severity), oldest open age, reports in the last 7 days and the count of `system_log` error events for the mapped module in the last 24 hours, each linking to the queue pre-filtered; unmapped reports form their own row. The dashboard (SA-14) shows a "Masalah terbuka per halaman" card with the top pages, only to viewers holding `ops.issues.manage`.
  - *Later adoption.* The control is a reusable shell component with a `surface` property (`owner` in Phase 1). Seller, affiliate and buyer surfaces may adopt it only after their own capability model, rate limit and privacy review (their reports can carry more personal data); the record already stores `surface` and the reporter kind, and page ids come from the same ARCH-5 registry.

### Update Log (Phase 1.5, optional; T-69)

Not the internal Log System (UX-9, SA-05): the Update Log is a public changelog for platform updates, comparable to Tokophi's operator `/update-log`. Public title "Pembaruan Bukalaris"; documentation name "Update Log". The host `logs.bukalaris.com` is owned by ADR-0008 and Domain Routing; the internal prefix `/updates` below is a proposal until that change lands. It may be skipped until needed; nothing in Phase 1 depends on it.

- **Authoring (SA-51 list, SA-52 editor).** Fields: title (120 characters), slug (generated, editable until first publish, then immutable), summary (plain text, 280 characters), body (restricted markdown), category (new, improved, fixed, security, deprecation), audience tags (one or more of seller, affiliate, buyer, platform), version label (public, optional), entry date (Asia/Jakarta, defaults to today), pinned/important flag, optional **release revision** (staff only, never public) and optional links to related issue reports (staff only, requires T-68; the public projection never exposes report ids or content). Editing always creates a new immutable revision with an author and change note; the editor shows a server-rendered preview using the same sanitiser as publication and a revision history from which an older revision can be restored as a new revision.
- **States.** draft → scheduled (future Asia/Jakarta time) or published; scheduled → draft (unschedule) or published (due time via JOB-19, or publish now); published → unpublished; unpublished → published (republish). Editing a published entry saves a new revision while the **previously published revision stays live** until "Publish update" promotes it, so a bad edit never reaches the public page; failed publication leaves the live revision unchanged. No hard delete in this phase (unpublish only). Schedule, publish, publish update and unpublish need `updates.publish`; unpublish needs a reason; drafts and revisions need `updates.write`. Optional four-eyes: a platform setting makes publication create an approval request (hash of the revision body) that another `updates.publish` holder executes; default off for the startup phase, and enabling it at least for `security` and `deprecation` entries is a recommendation (OPEN). Every transition is audited.
- **Restricted markdown.** Allowed: paragraphs, headings level 2 to 4, bold, italic, ordered and unordered lists, inline code, code blocks, block quotes and links. Links must be `https:` (or in-site anchors), are rendered with `rel="noopener noreferrer nofollow"`, and `javascript:`, `data:` and other schemes are dropped. Raw HTML is never passed through (it is escaped), images are not allowed in this phase (no external fetches or tracking pixels; OPEN), and the sanitised HTML snapshot is stored on the revision at save and re-sanitised on render with a maintained markdown parser and HTML sanitiser (no hand-written regex sanitiser).
- **Public read surface (UL-01, UL-02, HTTP-25).** Read-only and server-rendered; it works without JavaScript; it sets **no cookies**, runs no analytics, makes no third-party requests and carries a strict CSP and `nosniff`. It reads only the published-only projection (DATA-14 `update_log_public`), never draft or revision tables, so scheduled, draft and unpublished entries cannot appear by construction. **UL-01** lists entries newest first grouped by Asia/Jakarta date, pinned entries first, filtered by `audience` and `category` through plain GET query parameters (form works without scripts), paged with a fixed page size (OPEN) and stable "next" links; each card has a `<time datetime>`, a text category label (not colour alone), audience tags, title, summary and version label. **UL-02** `/[slug]` shows the full entry and "Diperbarui" when a later revision was published; an unknown, draft, scheduled or unpublished slug returns the same not-found page (no existence leak). 320px layout without horizontal scroll, headings in order, visible focus, language `id`.
- **Feed (HTTP-25): JSON Feed 1.1 at `/feed.json`**, optional `?audience=` and `?category=`, latest entries only (limit OPEN), published only, each item with a stable permalink `id`, `title`, `summary`, sanitised `content_html`, `date_published`, `date_modified` and `tags` (category plus audience); no author, e-mail, revision or release-revision fields. Justification: the consumers in this product are the console, seller dashboards and integrators, who read JSON through the same serialiser and sanitiser as the pages; it avoids the XML escaping and CDATA pitfalls of RSS/Atom; broad feed-reader reach is not a requirement. An Atom twin may be added later if readers demand it (OPEN). Pages carry `<link rel="alternate" type="application/feed+json">`.
- **Canonical origin.** Permalinks, the feed item `id`/`url`, `<link rel="canonical">` and the alternate-feed link are built from a configured canonical origin (`https://logs.bukalaris.com`), never from the request `Host` header; the entry paths are served only on the `logs` host and `/updates` answers 404 on the apex and every other host (12-SECURITY SEC-3 rules, SEC-21).
- **Caching.** Public responses are cacheable with validators (`ETag`/`Last-Modified`); publish, update and unpublish trigger revalidation of the list, entry and feed, and the maximum time an unpublished entry stays visible equals the configured cache staleness (value OPEN, tests use the configured value).
- **What's new indicator.** In the Owner console header, "Apa yang baru" shows a count of entries with audience `platform` published since the staff member's last-seen time (DATA-14 `update_log_seen`); opening it lists the latest entries (up to 5) with links to the public site and marks them seen; pinned important entries are highlighted; the count is omitted when zero or when the source is unavailable (never shown as 0 on failure). It reads the public projection, so it needs no capability, and it uses no cookie shared with the public host. **Extension point:** a `WhatsNew` shell component takes an `audience` and a seen-state adapter; seller, affiliate and buyer shells may adopt it later with their own per-account seen state, never a cross-host cookie.
- **Naming guard.** Docs and copy say "Update Log (public)" versus "Log System (internal diagnostics)"; the host label `logs` is reserved for the public site only.

### Screen contracts (P2, hidden until activated)

- **Verification queue (SA-15).** Cross-store queue of submitted verification records with age and overdue marker; decisions as in SA-16. Activation does not by itself introduce activation gating; any gating is a separate recorded decision.
- **Takedown notices and complaints (SA-29, SA-30).** Intake from a public report form (SF-13, `HTTP-20`) or staff entry; triage; action on the reported item through the owning service (disable a product or store with a reason visible to the seller; the seller may counter-respond; reinstatement path); due dates come from a policy the privacy or legal owner sets (numbers OPEN). Statutory duties under PP 80/2019 (notice and takedown, complaint handling) are UNVERIFIED, advisor-dependent and apply only if licensing alignment classifies the platform accordingly.
- **Privacy requests (SA-31).** Queue of data-subject requests with verification status, requested action (access, correction, erasure or restriction, consent withdrawal), due date from policy, executed outputs with expiry, and the PRIV-4 retention-conflict escalation. Export release needs a second approver (`privacy.export.approve`, `HTTP-18`). UU PDP 27/2022 periods and scope are UNVERIFIED.
- **Incident register (SA-32).** Incident with severity, detection and **awareness** timestamps, affected data classes, containment, notification checklist (subjects, authority, drafts only; no automatic sending), owner, post-incident review. The register computes a countdown from the recorded awareness time to a **configured** notification period and shows overdue. A 3x24-hour notification period appears in secondary sources and is UNVERIFIED; the configured value is an advisor decision.
- **Registrations and retention (SA-33).** Owner-supplied PSE/TDPSE and licence status, numbers, validity dates and evidence references (all OPEN until supplied, never invented), plus the approved retention table per data class and legal-hold list.

### Acceptance by group

- **Shell and gating.** With a grant set of one capability, the menu shows exactly the groups and items that capability opens; a direct URL to every other item returns the denied state with no data and an audit denial row. With no grant the operator sees "no access", not an empty console. A seller, affiliate, buyer or store-owner session on the `owner` host is rejected; an Owner session is rejected on the other hosts. A new `page.tsx` without a declared capability fails the route test. P2 routes return not-found before activation.
- **Dashboard.** Every KPI equals an independent SQL computation on a seeded fixture; the status distribution sums to the store count; a viewer without `finance.read` receives no finance values in HTML, RSC or JSON; an unavailable source shows an error on its card only.
- **Stores.** Create, approve, suspend and reactivate each require a reason, write one audit row and change state atomically; suspending via two concurrent requests yields one transition; paying an invoice does not clear operator suspension and lifting suspension does not clear debt; a store without any verification record can be created, approved and paid out; direct requests without `tenants.manage` are refused with no mutation.
- **Accounts.** A phone in `08…`, `62…` or `+62…` form finds the same masked buyer when the search carries a case and purpose; without them no buyer hit is returned and the notice does not reveal whether one exists; no response, log or audit row contains the raw query; recovery, session revoke, MFA reset request and suspend each require a case and reason and refuse without them; an identity with a `platform_operator` row is not-found for every account action; after a suspend the affected session cannot mutate from a stale tab; the operator UI, API and logs never contain a password, link, token or OTP; a reveal without purpose and case is refused, a granted reveal expires and is masked again, and the per-store breakdown of a buyer's orders is refused without a case and purpose; a seller or affiliate session cannot call any `/admin` account action; staff-executed merge and store-ownership recovery return not-found in Phase 1 (decided, D6; self-service only).
- **Approvals.** The requester cannot approve (UI and server, including a second tab), an approval executes exactly once under concurrent clicks, an expired or payload-changed request cannot execute, and revoking the requester's grant cancels their pending requests.
- **Money.** Two operators completing the same payout produce one transition and a typed conflict for the other; approve-for-transfer without a second approver does not execute, the approver cannot enable the control before the bank snapshot is shown, and mark-paid only records evidence on an already-approved payout; a payout to a bank destination inside the 72-hour hold or with a mismatched account-holder name is held; bank values appear masked without the capability; the float view's classes sum to the ledger total on a fixture. A COD reconciliation batch cannot be approved by its preparer, shows the carrier invoice lines to the approver, releases exactly the approved lines once under concurrent clicks, and leaves unmatched lines unreleased; the PPN switch needs only `tax.manage` plus the confirmation and reason.
- **Platform and operations.** No response, bundle or log contains a provider secret; the reserved-label list rejects store slugs `owner`, `bos`, `berkah` in creation tests; audit reads are themselves audited; every audit row for a mutating action exists in the same transaction (induced audit failure aborts the mutation).
- **Staff.** The last `staff.manage` holder cannot be removed; self-grant is refused; deactivating staff revokes grants, sessions and pending requests in one transaction; a stale tab of the deactivated staff cannot mutate; a staff MFA reset needs a second `staff.manage` holder and is refused through any `accounts.*` path.
- **Responsive and accessibility.** Each P1 screen is exercised at 320px and desktop with keyboard-only navigation, loading, empty, denied, conflict and dependency-error variants; focus returns after dialogs; no horizontal overflow.
- **P2 screens (when activated).** Overdue calculation follows an injected clock and the configured period; a notice, complaint or privacy request cannot be closed without a recorded decision and reason; exports are single-use, no-store and expire; an incident countdown matches the recorded awareness time.
- **Issue reporting.** Filing from two different pages stores the correct ARCH-5 id and request ids for each (server-resolved from the route template and `system_log`, not from browser claims); a context built from a page with synthetic secrets, e-mail, phone and query strings stores none of them (assert on the stored row and on the export); an oversize context is truncated to the cap; a client-supplied page id or log event id is ignored; a non-staff or seller, affiliate or buyer session cannot create or read a report (direct action and handler calls); a staff member without `ops.issues.manage` cannot open the queue, export or read an attachment; the per-staff rate limit refuses the over-limit request with no record and recovers after the window under an injected clock; a double submit with one client request id yields one report; every status transition, assignment, duplicate marking, list or detail read and export writes an audit row and an invalid or concurrent transition is refused with a typed conflict; a description containing `<script>` and `=cmd` renders as text in the queue and is neutralised in CSV; the dialog opens from the header, submits and returns focus using keyboard only at 320px; the per-page count in SA-36 equals an independent count on a fixture.
- **Update Log (when delivered).** Draft, scheduled-not-due and unpublished entries never appear in UL-01, UL-02 or the feed (also by direct slug request and with a warm cache after unpublish within the configured staleness); a scheduled entry becomes visible only at or after its time and after the scheduler runs, exactly once; markdown with `<script>`, `<img onerror>`, `javascript:` links and raw HTML renders as inert text or is dropped in page, feed and preview; the feed validates as JSON Feed 1.1 and contains only published entries; the public tables and responses contain no personal-data field (no author identity, no e-mail, no issue-report ids or release revision); every edit produces a new revision and an edit to a published entry does not change the live page until Publish update; `updates.write` cannot publish and a seller, affiliate, buyer or non-staff session cannot reach authoring; with the optional four-eyes setting on, the publisher cannot approve their own publication; the public host returns no `Set-Cookie` header; the pages pass keyboard-only and 320px checks and filters work with scripts disabled; the what's-new count matches published `platform` entries newer than last-seen and is omitted on source failure.

OPEN (owner or advisor): consented time-boxed support grant (not adopted; the masked diagnostic view is the P1 support tool); four-eyes fallback for a one-person team and any amount threshold; reveal, fresh-authentication, idle and absolute session durations; risk-flag age numbers; response-time policy numbers; whether verification ever gates an action; licensing posture that would activate the Compliance center; issue-report rate limits, size caps, screenshot size and retention; Update Log page size, feed limit, cache staleness, image support, public indexing and whether publication needs a second approver.

## UX-23 — Tax center screens (Owner console)

- Status: Proposed (2026-10-27; startup screens TX-01 to TX-03, dormant Phase 2 screens TX-04 to TX-10)
- Owner: Bukalaris product owner
- Source: PR-31, PR-30, UX-22, BILL-9, DATA-15, PRIV-10, ADR-0011, ADR-0012; owner decisions 2026-10-27.
- Statement: The Owner console has one menu group "Pajak" (Tax) under `/admin/tax`. In the startup phase it shows exactly three screens: TX-01 overview and settings (the tax mode is visibly OFF), TX-02 earnings statements and invoice registers, and TX-03 voluntary tax identities. The remaining screens (policy, withholding preview, liability ledger, remittance, documents, filing pack, period close) are specified for Phase 2 and are absent from navigation, and their URLs return the "not activated" page with no data, until the Owner activates withholding under the ADR-0012 criteria. Counterpart screens for affiliates and sellers are listed at the end.
- Acceptance: Every screen states its phase and current tax mode; no screen renders a full tax identifier (masking is applied in the data layer, UX-22/PRIV-9/PRIV-10); capability-gated controls are absent, not merely disabled, for operators without the capability; every export is audited and downloads with `Cache-Control: no-store`; no screen shows an invented rate, deadline or legal conclusion (labels show the policy's own text with its UNVERIFIED or "not advisor-confirmed" marker); each state in the contract tables is reachable and tested; the same pages work at 320 px width and by keyboard only.
- Constraints: UX-22 conventions (Owner console shell, language rule, empty/error patterns), IAM-15, PRIV-9, PRIV-10, DATA-14, DATA-15, BILL-9, T-62, T-66, T-67. Screen ids TX-nn map to ARCH-5 SA-40 through SA-49; routes below are proposed.

### Navigation and gating

| Rule | Contract |
|---|---|
| Menu visibility | "Pajak" appears when the operator holds any `tax.*` capability; startup mode lists TX-01, TX-02, TX-03 only; Phase 2 entries appear only when `withholding_enabled` is active in the current `tax_setting` version and the operator holds the screen's capability |
| Direct URL to a dormant screen | Not-activated page (HTTP 404 semantics, no data, link to TX-01 checklist); a missing capability gives the standard forbidden page |
| Language and tone | Follows UX-22; money in Rp with integer formatting; tax labels are shown exactly as stored on the policy |
| Phase badge | Every Phase 2 screen, once visible, carries "Fase 2 — diaktifkan oleh Owner" and the activation reference |

### Startup screens

| Screen | Route | Capability | Content and actions | States |
|---|---|---|---|---|
| TX-01 Overview and settings | `/admin/tax` | `tax.read` (view), `tax.manage` (edit allowed flags), `tax.approve` (activation, Phase 2) | Banner "Mode startup: platform tidak memotong atau memungut pajak". Table of flags with current value, effective date and who/why: `statements_enabled` (editable), `identity_capture_enabled` (editable; switching ON requires confirming that the PRIV-10 notice is approved, with a reason), `tax_identity_required_for_payout`, `withholding_enabled`, `pkp_gate_enabled` (locked OFF with the unmet criteria listed). Activation checklist: the eight ADR-0012 criteria, each "belum / sudah" with its evidence reference and OPEN-T item. Link to the PPN toggle in subscription configuration (BILL-7) and the version history of `tax_setting` | Default (all OFF, checklist unmet); partially configured; saving (pending); save conflict (newer version exists, shows it); forbidden; load error with retry |
| TX-02 Earnings statements and registers | `/admin/tax/statements` | `tax.read`; replace needs `tax.documents.issue` | Tab "Pernyataan penghasilan": filter by month or year, affiliate (handle or masked contact), status; row opens the statement preview with PDF and CSV download; "Terbitkan ulang" creates `revision + 1` with a reason and marks the previous `replaced`. Header shows the last statement job run (`tax.statement.generate`) with outcome. Tab "Register faktur langganan": month, invoices, DPP, PPN, total (stored snapshots only), CSV export | Empty (month not ended or no activity); job failed banner with the failed month; replaced revisions grouped under their latest; export pending/ready/failed; forbidden |
| TX-03 Tax identities | `/admin/tax/identities` | `tax.read` (list); `tax.identity.review` (Phase 2 actions) | Voluntary submissions: affiliate handle, class, id kind, masked last four, status, submitted date, duplicate flag. Startup: read-only with the note "Tidak ada tindakan diperlukan; identitas bersifat sukarela". Phase 2: approve or reject with a reason code, duplicate review, bank-holder-name-differs hint. Full value only through the PRIV-9 break-glass reveal (purpose `tax_identity_review`, case, reason, expiry); withdrawn rows show no values | Empty (capture off or none submitted); capture-off banner; Phase 2 review pending/approved/rejected; reveal denied; forbidden |

### Dormant Phase 2 screens (hidden until activation)

| Screen | Route | Capability | Content and actions | States and masking |
|---|---|---|---|---|
| TX-04 Policy | `/admin/tax/policy` | `tax.manage`; confirm `tax.approve` | Versions by tax type and category on an effective-range timeline; status chips; "not advisor-confirmed" marker for owner-decision versions; draft form for every policy field (no pre-filled rate, base, bracket or day); submit, confirm (basis, advisor reference, four-eyes), reject, retire; rollback creates a new version; fixture checker shows the computation contract on sample amounts | Overlap error from the database shown as a conflict; confirmed rows read-only; author equals approver refused; no personal data |
| TX-05 Withholding preview | `/admin/tax/withholding` | `tax.read` | Read-only: choose payee class, gross, date and an optional year-to-date; shows policy version, base, bracket steps, tax, net, rounding and clamps; "Pratinjau, tidak ada yang disimpan" watermark; blocked reasons (`no_effective_policy`, `tax_identity_missing`) | Writes nothing; payee shown by internal reference or masked contact only |
| TX-06 Liability ledger | `/admin/tax/liabilities` | `tax.read` | Outstanding liability by tax type and period (ledger sum), entry drill-down (kind, amount, source, actor, reason), corrections linked to originals, reconciliation status | Empty; period closed marker; no identifiers beyond internal references |
| TX-07 Remittance | `/admin/tax/remittance` | `tax.remit`; approve `tax.approve` | Prepare a batch for a period (amount not above outstanding minus open batches), approve (different operator), record evidence (billing code, receipt number, paid date, deposit-account label, evidence reference), void or reverse; no bank account number or credential inputs; no call to any tax-authority or provider API | Draft, approved, paid, void; over-outstanding refusal; same-person approval refused; replay of "record paid" is a no-op |
| TX-08 Documents | `/admin/tax/documents` | `tax.documents.issue`; read `tax.read` | Withholding slips, VAT documents, credit notes, annual statements: filter by kind, period, status; replace or cancel with a reason; delivery state to the payee portal; record official number and filed date supplied by the accountant | Issued, replaced, cancelled; payload read-only; identity shown as reference or masked |
| TX-09 Filing pack | `/admin/tax/filings` | `tax.read` plus purpose `tax_filing_export` | Per tax type, period and revision: summary, reconciliation checks R1 to R6 (R7 listed as information), deadlines from policy settings (an unset day shows "belum ditetapkan penasihat"), downloads of the CSV set; unsealed identity columns need four-eyes approval | Check failed (shows the failing check and rows); export audited with hash; closed period export is byte-identical on repeat |
| TX-10 Period close | `/admin/tax/periods` | `tax.period.close`; reopen `tax.approve` | Periods per type with status, revision and due dates; close checklist (R1 to R6 clean, no open correction cases); close; reopen with reason and a second approver | Close refused with reasons; closed period refuses new entries (shown on any attempted action); reopen increments revision |

### Counterpart screens (contracts only; routes assigned in ARCH-5, owned with UX-19 and UX-18)

| Screen | Where | Contract |
|---|---|---|
| TX-P1 Earnings statements | Affiliate portal, next to wallet and payouts (AF-10 `/affiliate/statements`, download HTTP-28; services T-71, screen T-66) | Own monthly and annual statements, PDF and CSV, statement revision labelled; text states it is not a tax invoice or withholding slip and that tax on commission is the affiliate's responsibility (wording OPEN-T10); Phase 2 adds own withholding slips and the annual tax statement |
| TX-P2 Tax identity (optional) | Affiliate profile, shown only when `identity_capture_enabled` | Notice (PRIV-10) before the form; class, id kind, identifier, registered name; after saving only the last four characters are shown and the value is replaced rather than read back; withdraw action; states: not submitted, submitted, withdrawn, Phase 2 under review, approved, rejected with reason code and resubmit |
| TX-P3 Invoice export | Seller billing (UX-18; SC-31 `/seller/billing/export`, download HTTP-29; services T-71, screen T-66) | Own invoices CSV by date range from stored snapshots; no other store data |

Acceptance journeys (Playwright, executed only when T-66/T-67 land): startup Owner opens `/admin/tax` and sees all flags OFF and an unmet checklist, cannot switch withholding ON, and cannot reach a dormant URL; the statement for a seeded month matches an independent ledger query and downloads as both PDF and CSV; the affiliate cannot open another affiliate's statement (not-found); with a fixture activation in a test environment the Phase 2 menu appears and the preview, remittance four-eyes refusal and period-close refusal behave as above; no HTML, RSC, JSON or export contains a full tax identifier.

