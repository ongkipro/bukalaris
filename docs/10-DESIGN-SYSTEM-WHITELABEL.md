# Bukalaris Design System and White-label Boundary

## Bukalaris brand and design baseline

Decision: Product name is **Bukalaris**. Use **bukalaris.com | Buka toko langsung
laris** as the exact brand line, with the tagline kept in Bahasa Indonesia.
[Product identity](02-PRD.md#product-identity) owns the name, domain and tagline.

Status: The visual baseline below is a proposal dated 2026-09-25. Accepted
theme and checkout boundaries remain constraints for the final design.

| Design concern | Starting proposal for Bukalaris | Still to decide or verify |
|---|---|---|
| Operator shell | Persistent store/platform context, clear current location, task title and primary action; separate full-width editing only when the task needs it | Shell dimensions and builder layout in rendered fixtures |
| Tables and metrics | Readable density, aligned monetary columns and tabular numerals; distinguish zero, missing data, loading and failure | Exact type scale, cell spacing and metric definitions |
| Tokens | Shared semantic canvas, surface, text, border, action, focus and status roles; seller theme tokens cannot leak into platform checkout | Brand palette, font families, radii and contrast measurements |
| Forms and pickers | Labelled inputs, linked validation, pending-save feedback, image/library and internal-link selection when content editing needs them | Next.js and shadcn/ui selected; verify installed component APIs |
| Storefront | Product/media hierarchy, readable prices and options, stable image space and clear purchase progression | Separate responsive and max-480px compositions, actual imagery and approved typography |
| Motion | Feedback should explain state without delaying routine work; honor reduced-motion preferences | Any animation must justify its purpose; stagger, shimmer, blur and glow require a demonstrated benefit |

Proposal: Keep the clean light operator direction already recorded here.
Choose Bukalaris colors, typography and component shapes through a visual
comparison, retaining the semantic contracts and existing two-theme boundary.
Evidence boundary: No rendered Bukalaris interface has been verified. Visual
approval remains open.

## UI-1 — Platform and seller brand separation

- Owner: Bukalaris design owner

Bukalaris controls product interaction, accessibility, checkout structure,
security messaging, and platform controls. A seller controls approved store
identity tokens: logo, name, colors within contrast-safe constraints, and
published content. Seller branding cannot hide required price, availability,
payment, delivery, or legal/service status.

## UI-2 — Shared primitives

- Owner: Bukalaris design owner

All surfaces need one accessible foundation for buttons, fields, labels,
validation summaries, dialogs, menus, tables, status indicators, pagination,
empty/error states, and IDR formatting. The admin component source is shadcn/ui on Next.js, styled with Tailwind CSS
and authored in TypeScript. Verify the selected registry base and installed
APIs before composing components. Astro public surfaces use native semantic
HTML and shared tokens, adding React islands only where interaction needs them.

## UI-3 — Localization and accessibility

- Owner: Bukalaris design owner

- Default operational language is Bahasa Indonesia (`id-ID`); technical terms
  remain English only when clearer.
- IDR is rendered from integer currency values, never floating browser math.
- Product and CMS content may have a seller-owned locale policy later; no
  translation behavior is assumed now.
- Controls work by keyboard, validation links errors to fields, asynchronous
  cart/status updates are announced, and narrow layouts preserve capability.

## UI-4 — Builder ceiling

- Owner: Bukalaris product owner

Landing-page layout and styling are independently composable. Prebuilt
sections/templates are conveniences, not a fixed layout ceiling. The planned
locked element is the platform form component. This clarifies the earlier
curated-builder proposal following Paduka Ongki's direction on 2026-09-18.

Proposal: Protect the form's required field contract, validation, and submission
behavior while allowing its placement within the LP. Exact form types and
allowed field/style customization remain Unknown under T-11. Free composition
does not by itself decide raw HTML/CSS or executable-script support; those are
separate implementation choices. Backend commerce validation remains required.

## UI-5 — Built-in theme presentation

- Status: Accepted
- Owner: Bukalaris design owner
- Source: PR-8; Paduka Ongki's direction on 2026-09-18.
- Statement: The responsive theme is the initial store and demo default. Its
  desktop layout expands beyond the mobile alternative's 480 CSS px ceiling.
  Shopify Dawn is a visual reference for product-first presentation,
  not a verified Bukalaris design or an instruction to copy branding or assets.
  The mobile-first alternative has a maximum storefront width of 480 CSS px.
- Acceptance: Both themes reflow at 320 CSS px without horizontal page overflow.
  At a wide desktop viewport, the responsive theme uses a wider layout while
  the mobile-first storefront stays within its 480 CSS px maximum. Shared
  content, accessibility, and locked checkout requirements remain available.
- Constraints: PR-8, UI-1, UI-3, UI-4, UX-3.
- Evidence: Planning decision only; rendered verification is pending.
- Change history: 2026-09-18 — recorded the two-theme direction and default.

Proposal: Center the mobile-first storefront within wider viewports. Exact
responsive desktop container width, theme names, tokens, and section layouts
remain to be designed after reference inspection.

## UI-6 — Independent mobile-first landing pages

- Status: Accepted
- Owner: Bukalaris design owner
- Source: PR-9; Paduka Ongki's clarification on 2026-09-18.
- Statement: Landing pages have their own page layout, style settings, and
  mobile-first composition. Switching the store between either built-in theme
  must not alter LP presentation. The theme-specific shell and its 480px width
  ceiling do not apply to LPs. Required platform commerce/service disclosures
  remain available.
- Acceptance: With page revision, data, and viewport held constant, switching
  storefront themes leaves LP typography, colors, spacing, media, width,
  header/footer, and section order unchanged. Reflow works at 320 CSS px.
- Constraints: PR-9, UI-1, UI-3, UI-4, UX-7.
- Evidence: Product direction only; rendered proof pending.
- Change history: 2026-09-18 — clarified LP independence from storefront themes.

Proposal for visual direction: Clean editorial/product sections, clear type
hierarchy, generous but purposeful spacing, restrained borders and shadows,
and product imagery as the main visual focus. Offer optional hero, text/media,
product offer, gallery, benefits, evidence-backed testimonials, FAQ, and action
sections alongside composable layout/content controls. Do not enforce a fixed
section arrangement or template as the ceiling for LP design.
LP-specific navigation is optional; the store theme's header/footer is not
injected. Brand settings may be copied as initial values, not live-bound to
storefront theme tokens.

Proposal for responsive behavior: Start the editor canvas at 390px, with
320px, 480px, tablet, and desktop checks. Mobile-first does not itself impose
an LP maximum width of 480px. Specify each template's independent desktop
behavior before implementation. Keep primary controls touch-friendly and
ensure sticky actions do not obscure content, keyboard focus, or form errors.
These are design proposals, not a claim that a library ships this appearance.


## UI-7 — Phase 1 operator presentation contract

- Status: Proposed; framework-neutral delivery specification.
- Owner: Bukalaris design owner.
- Scope: Seller Admin and Super Admin. Future marketplace, LP, buyer-account,
  and affiliate navigation is not shown as a working Phase 1 feature.

Use a restrained light operator surface: a persistent current-store/platform
context, task-oriented navigation, a page title, and the primary job. Product
and order queues take priority over decorative metrics. The Seller overview
links to actionable work; Super Admin prioritizes tenant governance and includes
the required Log System button. KPI definitions must name time window, timezone,
data freshness, and drill-down destination before a metric is displayed.

| Region | Wide layout | Narrow layout | Invariant |
|---|---|---|---|
| Navigation | Sidebar with current location and active context | Labelled menu opens a dismissible drawer | Location and store context remain visible; focus returns to opener |
| List toolbar | Search, filters, sort and primary action | Search plus Filters control with applied count | Filter state survives list/detail/back navigation |
| Product/stock rows | Semantic table with identity, status, price and stock | Priority fields plus expandable detail; scoped horizontal scroll for comparison | Product and variant identity remain readable |
| Order/seller queues | Table with status and relevant timestamps | Stacked labelled rows linking to detail | Status is expressed with text, not color alone |
| Editor | Main form with related settings alongside | Single column in the same reading order | Errors, unsaved state and save/publish distinction remain visible |
| Detail timeline | Summary and chronological events | Summary followed by timeline | Payment, shipping and business state remain distinct |
| Logs | Filterable table and detail view | Safe summary, timestamp and severity with detail link | Long identifiers wrap or scroll locally; never overflow the page |

Breakpoints follow content fit and are finalized with rendered fixtures; this
contract does not approve specific CSS breakpoints. Preserve native zoom and
text resizing. Charts are optional: do not add a chart until an operator
question and authoritative data definition require it.

## UI-8 — Visual ownership and component inventory

- Owner: Bukalaris design owner.
- Status: Proposed; no approved token palette or component implementation yet.

| Owner | Controls | Must not control |
|---|---|---|
| Platform admin design | Admin navigation, form states, tables, operational status and access feedback | Seller-facing commerce facts |
| Storefront theme | Store shell, product discovery composition, published content presentation | Price/stock truth, product identity, checkout validation |
| Seller brand | Approved identity and accessible brand settings | Required disclosures, semantic status and permission controls |
| Independent LP (future) | Own layout, typography, colors, width and optional shell | Platform form contract and backend transaction rules |

Define semantic roles for canvas, surface, text, muted text, border, primary
action, focus, success, warning and error. Color values, typography, spacing,
radii, and desktop container size remain design decisions awaiting a reference
review and rendered prototype. Reuse repository tokens if they already exist.
Do not adopt a library's full visual defaults as an implicit product decision.

Required reusable behaviors: labelled field/error summary, button pending
state, searchable list toolbar, pagination, accessible dialog, status with
text, unsaved-changes prompt, file upload progress/error, price formatting,
copyable identifier, empty/no-results states, and dependency-failure feedback.
Each behavior has one implementation owner under the selected stack; sharing
semantics does not require shipping admin editor code to storefront visitors.

## UI-9 — Storefront composition and verification boundary

- Owner: Bukalaris design owner.
- Status: Proposed composition within the accepted UI-5 theme direction.

| Surface | Reading/decision order | Narrow behavior |
|---|---|---|
| Home | Store identity/navigation, seller-published merchandising, discoverable catalog | No essential product discovery hidden behind an auto-advancing carousel |
| Collection/search | Title or query, result count, filters/sort, product results | Filters in accessible drawer; preserve applied values and return position |
| Product | Media, title, authoritative price, options, availability, quantity, purchase action, description/delivery context | Options/errors precede purchase action; sticky controls cannot cover content or focus |
| Cart | Product/variant, quantity and availability, authoritative subtotal, checkout action | Editable items; changed values explained beside affected line |
| Hosted checkout (UI-10, outside themes) | Contact/address, available shipping/payment choices, server-derived total, submission state | Single-column flow preserving input; summary remains discoverable |
| Hosted confirmation (outside themes) | Verified order reference and outcome, next required action | Pending remains pending; avoid success illustrations for unknown payment |

The two themes share catalog/cart behavior and hand off to the same hosted
checkout. They do not render the checkout or confirmation layout. Product images reserve space
and preserve intended aspect ratio; missing media receives an honest fallback.
Merchant content cannot introduce fabricated urgency, testimonials or delivery
promises. Buyer-facing IDs and prices remain selectable and readable.

Before visual approval, inspect the named references, record transferable
principles without copying assets, and compare rendered fixtures at narrow and
wide sizes. Verify keyboard navigation, focus, contrast, reflow, long Indonesian
labels, empty states, broken media, and both themes. Current verdict: visual
UNVERIFIED; these are planned checks, not evidence of an implemented interface.

## UI-10 — Hosted checkout presentation
- Owner: Bukalaris design owner
- Source: PR-16.
- Contract: Checkout has a separate platform layout, mobile-first form flow,
  persistent order summary, visible errors and pending outcomes. Approved store
  name/logo tokens may identify the seller; external storefront CSS/scripts and
  either native theme never control checkout. LP freedom ends at its handoff to
  this platform-owned transactional surface.

## Initial admin visual proposal

Use a restrained light operational UI with persistent surface/store context,
searchable tables, clear status labels, accessible form errors, and panels only
where they group a task. Seller overview shows actions needing attention;
Super Admin overview shows tenant/provider/system exceptions, not decorative
metrics. Narrow screens keep primary actions and use explicit detail views for
secondary columns. Next.js and shadcn/ui are selected; final brand tokens remain pending.

## Log System component mapping

Proposal within the existing Bos design: use a text-labelled link with shadcn
button styling for the entry, semantic table for event rows, labelled fields
for filters, text-plus-color severity badges and pagination controls. Detail
uses grouped metadata and a safe message region; never render log strings as
HTML. Distinguish status feedback from event severity. Pending/unavailable
feedback follows UX-9; no invented KPI counts or source-health badges. Implement
only the components the list/detail workflow needs, with keyboard and narrow
viewport checks before visual approval.

